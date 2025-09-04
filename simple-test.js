import { SealTestClient } from './seal-client.js';
import { config } from './config.js';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex } from '@mysten/sui/utils';
import crypto from 'crypto';
import { WalrusService } from './walrus.js';
import jsonFile from "./test.json" with { type: 'json' };
import { EncryptedObject } from '@mysten/seal';


async function simpleHappyPathTest() {
  console.log('Running simple SEAL happy path test...\n');

  const client = new SealTestClient();
  const alice = client.createKeypair(config.wallets.alice.privateKey);
  const aliceAddress = alice.getPublicKey().toSuiAddress();
  const unauthorized = client.createKeypair(config.wallets.unauthorized.privateKey);
  const unauthorizedAddress = unauthorized.getPublicKey().toSuiAddress();
  const walrusService = new WalrusService();
  
  console.log('Alice address (authorized):', aliceAddress);
  console.log('Unauthorized address:', unauthorizedAddress);
  console.log('Package ID:', config.sui.packageId);
  console.log();

  try {
    // Step 1: Create access policy (just Alice)
    console.log('1. Creating access policy...');
    const policyObjectId = await client.createAccessPolicy(alice, [aliceAddress]);
    console.log('   Policy created:', policyObjectId);

    // Step 2: Encrypt with SEAL to generate real ID
    console.log('2. Encrypting with SEAL to generate real ID...');
    const testMessage = "Hello SEAL!";
    // const { encryptedBytes, sealId } = await client.encryptMessage(testMessage, policyObjectId);
    
    console.log('JSON.stringify(jsonFile)', JSON.stringify(jsonFile));
    const { encryptedBytes, sealId } = await client.encryptMessage(JSON.stringify(jsonFile), policyObjectId);
    console.log('   Encrypted successfully, SEAL ID:', sealId);

    const encryptedObject = EncryptedObject.parse(encryptedBytes);
    console.log('parse encryptedObject', JSON.stringify(encryptedObject));
    
    console.log('>>>>>>>>>>>>>>>>>> upload to walrus');
    // step done in relay
    const walrusUploadResult = await walrusService.uploadFileViaRelayWalrus(
      alice,
      encryptedBytes,
      1, // epochs
    );
    console.log('>>>>>>>>>>>>>>>>>> walrusUploadResult', JSON.stringify(walrusUploadResult));
    
    console.log('>>>>>>>>>>>>>>>>>> download from walrus');
    // step done in nautilus
    const walrusDownloadResult = await walrusService.fetchEncryptedFile(walrusUploadResult[0].blobId);
    console.log('>>>>>>>>>>>>>>>>>> walrusDownloadResult', walrusDownloadResult);
    
    const encryptedDownloadObject = EncryptedObject.parse(new Uint8Array(walrusDownloadResult));
    console.log('parse walrusDownloadResult', JSON.stringify(encryptedDownloadObject));
    
    console.log('>>>>>>>>>>>>>>>>>> decrypt download from walrus');
    await testSealDecryption(client, alice, new Uint8Array(walrusDownloadResult), sealId, policyObjectId);
    return;
    
    // Step 3: Test seal_approve with real SEAL-generated ID
    console.log('3. Testing seal_approve with real SEAL ID...');
    const success = await testSealApproveWithRealId(client, alice, policyObjectId, sealId);

    if (success) {
      console.log('✅ seal_approve test passed!');
      
      // const encryptedObject = EncryptedObject.parse(encryptedBytes);
      // console.log('parse encryptedObject', JSON.stringify(encryptedObject));
      
      // Step 4: Test full SEAL decryption flow (authorized user)
      console.log('4. Testing SEAL decryption with authorized user...');
      await testSealDecryption(client, alice, encryptedBytes, sealId, policyObjectId);
      
      // Step 5: Test unauthorized user scenarios
      console.log('5. Testing unauthorized user scenarios...');
      // await testUnauthorizedUser(client, unauthorized, sealId, policyObjectId, encryptedBytes);
    }

  } catch (error) {
    console.error('Test failed:', error.message);
    console.error('Stack trace:', error.stack);
  }
}

async function testSealApproveWithRealId(client, keypair, policyObjectId, sealId) {
  const address = keypair.getPublicKey().toSuiAddress();
  
  console.log('   Testing seal_approve with real SEAL-generated ID:');
  console.log('     policy:', policyObjectId);
  console.log('     seal_id:', sealId);
  console.log('     wallet_address:', address);
  console.log('     package_id:', client.packageId);
  console.log('     module:', client.module);
  console.log('     target function:', `${client.packageId}::${client.module}::seal_approve`);
  
  // Use the real SEAL-generated ID
  const realId = Array.from(fromHex(sealId));
  console.log('     Real SEAL ID as bytes:', realId);
  
  // Validate policy object ID
  console.log('   Validating policy object ID:');
  console.log('     policyObjectId length:', policyObjectId?.length, 'valid:', policyObjectId && policyObjectId.length === 66);
  
  if (!policyObjectId || policyObjectId.length !== 66) {
    console.error('   ❌ policyObjectId is invalid:', policyObjectId);
    return false;
  }
  
  // Build the transaction
  const tx = new Transaction();
  tx.setGasBudget(10_000_000);
  tx.setSender(address);
  
  tx.moveCall({
    target: `${client.packageId}::${client.module}::seal_approve`,
    arguments: [
      tx.pure.vector("u8", realId),
      tx.object(policyObjectId)
    ]
  });

  try {
    // First, try to build the transaction to catch build errors
    console.log('   Building transaction...');
    console.log('   Transaction details:');
    console.log('     Gas budget:', 10_000_000);
    console.log('     Sender:', address);
    console.log('     Move call arguments:');
    console.log('       [0] real SEAL ID:', realId);
    console.log('       [1] policy object:', policyObjectId);
    
    const builtTx = await tx.build({ 
      client: client.suiClient
    });
    console.log('   Transaction built successfully');
    console.log('   Transaction bytes length:', builtTx.length);
    
    // Validate policy object exists on-chain before dry run
    console.log('   Validating policy object exists on-chain...');
    try {
      const policyObj = await client.suiClient.getObject({ id: policyObjectId });
      console.log('     Policy object exists:', policyObj.data ? 'YES' : 'NO');
      if (!policyObj.data) console.log('     Policy object error:', policyObj.error);
    } catch (e) {
      console.log('     Policy object validation failed:', e.message);
    }
    
    // Do a dry run to see what would happen
    console.log('   Executing dry run...');
    console.log('   Transaction bytes (first 50):', Array.from(builtTx.slice(0, 50)));
    
    let dryRunResult;
    try {
      dryRunResult = await client.suiClient.dryRunTransactionBlock({
        transactionBlock: builtTx,
      });
      console.log('   Dry run completed successfully');
    } catch (dryRunError) {
      console.log('   Dry run failed:', dryRunError.message);
      console.log('   Dry run error details:', dryRunError);
      return false;
    }
    
    console.log('   Dry run result:');
    console.log('     Status:', dryRunResult.effects.status.status);
    
    if (dryRunResult.effects.status.status === 'success') {
      console.log('     SUCCESS: seal_approve would pass');
      
      // Show any events that would be emitted
      if (dryRunResult.events && dryRunResult.events.length > 0) {
        console.log('     Events:');
        dryRunResult.events.forEach((event, i) => {
          console.log(`       Event ${i}:`, event);
        });
      }
      
      // Show gas usage
      console.log('     Gas used:', dryRunResult.effects.gasUsed);
      
      return true;
      
    } else {
      console.log('     FAILURE: seal_approve would fail');
      console.log('     Error:', dryRunResult.effects.status.error);
      
      // Try to parse the error for more details
      if (dryRunResult.effects.status.error) {
        const errorMsg = dryRunResult.effects.status.error;
        console.log('     Detailed error analysis:');
        
        if (errorMsg.includes('EAccessDenied')) {
          console.log('       - Wallet address not in policy rules');
        }
        if (errorMsg.includes('EInvalidId')) {
          console.log('       - ID prefix validation failed (namespace check)');
        }
      }
      
      return false;
    }
    
  } catch (buildError) {
    console.log('     BUILD ERROR:', buildError.message);
    
    // Common build error diagnostics
    if (buildError.message.includes('object not found')) {
      console.log('     Likely cause: One of the object IDs does not exist on chain');
      console.log('     Check that all objects were created successfully');
    }
    if (buildError.message.includes('function not found')) {
      console.log('     Likely cause: seal_approve function not found in deployed contract');
      console.log('     Check package ID and module name in config.js');
    }
    
    return false;
  }
}

async function testSealDecryption(client, keypair, encryptedBytes, sealId, policyObjectId) {
  try {
    console.log('   Creating fresh SEAL client for decryption...');
    const decryptClient = new SealTestClient();
    
    console.log('   Creating session key...');
    const sessionKey = await decryptClient.createSessionKey(keypair);
    console.log('   Session key created');
    
    console.log('   Attempting decryption...');
    const decrypted = await decryptClient.decryptMessage(
      encryptedBytes,
      sealId,
      policyObjectId,
      sessionKey
    );
    
    console.log('   Decrypted message:', decrypted);
    console.log('   ✅ SUCCESS: Full SEAL encryption/decryption flow working!');
    
  } catch (sealError) {
    console.log('   ❌ SEAL decryption failed:', sealError.message);
    
    // Detailed SEAL error analysis
    if (sealError.message.includes('InvalidParameter')) {
      console.log('   Likely cause: Recently created objects not yet indexed by key servers');
      console.log('   Solution: Wait a few seconds and retry');
    }
    if (sealError.message.includes('AccessDenied')) {
      console.log('   Likely cause: seal_approve function failed when called by key servers');
      console.log('   Solution: Check the seal_approve logic above');
    }
    if (sealError.message.includes('KeyNotFound')) {
      console.log('   Likely cause: Key servers don\'t have the encryption keys yet');
      console.log('   Solution: Wait for key servers to process the encryption');
    }
  }
}

async function testUnauthorizedUser(client, unauthorizedKeypair, sealId, policyObjectId, encryptedBytes) {
  const unauthorizedAddress = unauthorizedKeypair.getPublicKey().toSuiAddress();
  
  console.log('   Testing unauthorized user:', unauthorizedAddress);
  
  // Test 1: seal_approve should fail for unauthorized user
  console.log('   Test 1: seal_approve with unauthorized user (should fail)...');
  const approveSuccess = await testSealApproveWithRealId(client, unauthorizedKeypair, policyObjectId, sealId);
  
  if (!approveSuccess) {
    console.log('   ✅ seal_approve correctly failed for unauthorized user');
  } else {
    console.log('   ❌ ERROR: seal_approve should have failed for unauthorized user!');
  }
  
  // Test 2: SEAL decryption should fail for unauthorized user
  console.log('   Test 2: SEAL decryption with unauthorized user (should fail)...');
  try {
    console.log('   Creating fresh SEAL client for unauthorized user...');
    const unauthorizedClient = new SealTestClient();
    
    const sessionKey = await unauthorizedClient.createSessionKey(unauthorizedKeypair);
    console.log('   Session key created for unauthorized user');
    
    const decrypted = await unauthorizedClient.decryptMessage(
      encryptedBytes,
      sealId,
      policyObjectId,
      sessionKey
    );
    
    console.log('   ❌ ERROR: Decryption should have failed for unauthorized user!');
    console.log('   Decrypted message:', decrypted);
    
  } catch (decryptError) {
    console.log('   ✅ Decryption correctly failed for unauthorized user');
    console.log('   Error:', decryptError.message);
    
    // Check if it's the expected access denied error
    if (decryptError.message.includes('AccessDenied') || 
        decryptError.message.includes('EAccessDenied') ||
        decryptError.message.includes('access denied') ||
        decryptError.message.includes('User does not have access')) {
      console.log('   ✅ Got expected access denied error');
    } else {
      console.log('   ⚠️  Got different error than expected access denied');
    }
  }
  
  console.log('   ✅ Unauthorized user tests completed');
}

// if (import.meta.url === `file://${process.argv[1]}`) {
  simpleHappyPathTest().catch(console.error);
// }