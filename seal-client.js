import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex, toHex } from '@mysten/sui/utils';
import { EncryptedObject, SealClient as SealSDK, SessionKey } from '@mysten/seal';
import crypto from 'crypto';
import { config } from './config.js';

export class SealTestClient {
  constructor() {
    this.suiClient = new SuiClient({ url: config.sui.rpc });
    this.packageId = config.sui.packageId;
    this.module = config.sui.module;
    
    // Initialize SEAL SDK client with testnet servers
    this.sealClient = new SealSDK({
      suiClient: this.suiClient,
      serverConfigs: [
        {
          objectId: config.seal.keyServerObjId,
          weight: 1,
        }
      ],
      verifyKeyServers: false,
    });
  }

  // Create a keypair from private key
  createKeypair(privateKey) {
    return Ed25519Keypair.fromSecretKey(privateKey);
  }

  // Step 1: Create access policy
  async createAccessPolicy(walletKeypair, allowedAddresses) {
    const tx = new Transaction();
    
    tx.moveCall({
      target: `${this.packageId}::${this.module}::create_access_policy`,
      arguments: [
        tx.pure.vector("address", allowedAddresses)
      ]
    });

    const result = await this.suiClient.signAndExecuteTransaction({
      signer: walletKeypair,
      transaction: tx,
      options: { showEffects: true },
      requestType: 'WaitForLocalExecution',
    });
    
    console.log('Access Policy created:', result.digest);
    
    // Get the created policy object ID from events
    const policyObjectId = this.extractObjectIdFromResult(result, 'AccessPolicy');
    return policyObjectId;
  }

  // Step 2: Save encrypted file metadata
  async saveEncryptedFile(walletKeypair, blobId, policyObjectId, metadata = '') {
    const tx = new Transaction();
    
    tx.moveCall({
      target: `${this.packageId}::${this.module}::save_encrypted_file`,
      arguments: [
        tx.pure.vector("u8", Array.from(fromHex(blobId))),
        tx.object(policyObjectId),
        tx.pure.vector("u8", Array.from(Buffer.from(metadata, 'utf8')))
      ]
    });

    const result = await this.suiClient.signAndExecuteTransaction({
      signer: walletKeypair,
      transaction: tx,
      options: { showEffects: true },
      requestType: 'WaitForLocalExecution',
    });
    
    console.log('Encrypted file saved:', result.digest);
    
    const fileObjectId = this.extractObjectIdFromResult(result, 'EncryptedFile');
    return fileObjectId;
  }

  // Step 3: Register TEE attestation
  async registerTEEAttestation(walletKeypair, blobId, enclaveId = '', attestorAddress) {
    const tx = new Transaction();
    
    tx.moveCall({
      target: `${this.packageId}::${this.module}::register_tee_attestation`,
      arguments: [
        tx.pure.vector("u8", Array.from(Buffer.from(enclaveId, 'utf8'))),
        tx.pure.vector("u8", Array.from(fromHex(blobId))),
        tx.pure.address(attestorAddress)
      ]
    });

    const result = await this.suiClient.signAndExecuteTransaction({
      signer: walletKeypair,
      transaction: tx,
      options: { showEffects: true },
      requestType: 'WaitForLocalExecution',
    });
    
    console.log('TEE attestation registered:', result.digest);
    
    const attestationObjectId = this.extractObjectIdFromResult(result, 'TEEAttestation');
    return attestationObjectId;
  }

  // SEAL Integration: Encrypt message
  async encryptMessage(message, policyObjectId) {
    // Generate ID with policy namespace + nonce (correct way)
    const policyObjectBytes = fromHex(policyObjectId);
    const nonce = crypto.getRandomValues(new Uint8Array(5));
    const id = toHex(new Uint8Array([...policyObjectBytes, ...nonce]));
    
    const messageBytes = new Uint8Array(new TextEncoder().encode(message));
    
    const { encryptedObject: encryptedBytes } = await this.sealClient.encrypt({
      threshold: 1,
      packageId: this.packageId,
      id,
      data: messageBytes,
    });
    
    console.log('Message encrypted with SEAL');
    console.log('SEAL ID:', id);
    
    return {
      encryptedBytes: encryptedBytes,
      sealId: id
    };
  }

  // SEAL Integration: Decrypt message
  async decryptMessage(encryptedBytes, sealId, policyObjectId, sessionKey) {
    console.log(`   Decrypting for user: ${sessionKey.address}`);
    
    // Create transaction for seal_approve (simplified contract)
    const tx = new Transaction();
    tx.setGasBudget(10_000_000);
    tx.setSender(sessionKey.address);
    
    tx.moveCall({
      target: `${this.packageId}::${this.module}::seal_approve`,
      arguments: [
        tx.pure.vector("u8", Array.from(fromHex(sealId))),
        tx.object(policyObjectId)
      ]
    });

    const txBytes = await tx.build({ 
      client: this.suiClient, 
      onlyTransactionKind: true 
    });

    console.log(`   Transaction bytes length: ${txBytes.length}`);
    console.log(`   Calling SEAL decrypt for user: ${sessionKey.address}`);

    
    // only need for efficiency --> batch encryption
    // console.log(`🔐 Fetching decryption keys...`);
    // await this.sealClient.fetchKeys({
    //   ids: [tx.pure.vector("u8", Array.from(fromHex(sealId))),],
    //   txBytes,
    //   sessionKey,
    //   threshold: 1,
    // });
    
    // seal client calls EncryptedObject.parse to retrieve seal id, package id, threshold, ...
    // const encryptedObject = EncryptedObject.parse(encryptedBytes);
    // console.log('parse encryptedObject', JSON.stringify(encryptedObject));
    
    // Decrypt using SEAL
    const decryptedBytes = await this.sealClient.decrypt({
      data: encryptedBytes,
      sessionKey,
      txBytes,
    });
    
    console.log(`   SEAL decrypt succeeded for user: ${sessionKey.address}`);
    return Buffer.from(decryptedBytes).toString('utf8');
  }

  // Create session key for decryption
  async createSessionKey(walletKeypair) {
    const sessionKey = await SessionKey.create({
      address: walletKeypair.getPublicKey().toSuiAddress(),
      packageId: this.packageId,
      ttlMin: 10,
      suiClient: this.suiClient,
    });
    
    const message = sessionKey.getPersonalMessage();
    const { signature } = await walletKeypair.signPersonalMessage(Buffer.from(message));
    await sessionKey.setPersonalMessageSignature(signature);
    
    console.log('Session key created and initialized');
    return sessionKey;
  }

  // Test seal_approve function directly
  async testSealApprove(walletKeypair, blobId, fileObjectId, policyObjectId, attestationObjectId) {
    const tx = new Transaction();
    
    tx.moveCall({
      target: `${this.packageId}::${this.module}::seal_approve`,
      arguments: [
        tx.pure.vector("u8", Array.from(fromHex(blobId))),
        tx.object(fileObjectId),
        tx.object(policyObjectId),
        tx.object(attestationObjectId),
        tx.pure.address(walletKeypair.getPublicKey().toSuiAddress())
      ]
    });

    try {
      // Use dry run to test without executing
      const result = await this.suiClient.dryRunTransactionBlock({
        transactionBlock: await tx.build({ client: this.suiClient }),
      });
      
      if (result.effects.status.status === 'success') {
        console.log('✅ seal_approve check passed - access granted');
        return true;
      } else {
        console.log('❌ seal_approve check failed - access denied');
        console.log('Error:', result.effects.status.error);
        return false;
      }
    } catch (error) {
      console.log('❌ seal_approve check failed with error:', error.message);
      return false;
    }
  }

  // Utility function to extract object ID from transaction result
  extractObjectIdFromResult(result, objectType) {
    console.log(result)
    const created = result.effects?.created;
    if (created && created.length > 0) {
      return created[0].reference.objectId;
    }
    
    // Fallback: look in events
    const events = result.events || [];
    for (const event of events) {
      if (event.type.includes(objectType)) {
        return event.parsedJson?.id || event.id;
      }
    }
    
    throw new Error(`Could not find ${objectType} object ID in transaction result`);
  }

  // Get object details
  async getObject(objectId) {
    return await this.suiClient.getObject({
      id: objectId,
      options: { showContent: true }
    });
  }
}