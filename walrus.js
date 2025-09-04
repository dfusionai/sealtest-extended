import { SuiClient } from "@mysten/sui/client";
import { RetryableWalrusClientError, WalrusClient, WalrusFile } from "@mysten/walrus";
import { config } from "./config.js";

export class WalrusService {
  constructor() {
    this.suiClient = new SuiClient({ url: config.sui.rpc });

    this.walrusClient = new WalrusClient({
      network: "testnet",
      suiClient: this.suiClient,
      uploadRelay: {
        host: "https://upload-relay.testnet.walrus.space",
        sendTip: {
          max: 5_000_000, // in MIST (1 SUI = 1 billion MIST)
        },
      },
    });
  }
  

  async uploadFileViaRelayWalrus(walletKeypair, file, epochs) {
    try {
      console.log("🚀 Starting file upload process to Walrus...");

      if (!walletKeypair) {
        console.error("❌ ERROR: No wallet keypair provided.");
        throw new Error("No Sui signer/keypair is initialized");
      }
      console.log("✅ Wallet keypair is initialized");

      const senderAddress = walletKeypair.toSuiAddress();
      console.log("👤 Sender address:", senderAddress);

      // Step 1: Encode file
      console.log("🔧 Step 1: Encoding file...");
      let walrusFile;
      try {
        walrusFile = WalrusFile.from({
          // contents: new Uint8Array(file.buffer), #TODO
          contents: file,
          // identifier: file.filename, #TODO
          identifier: Date.now().toString(),
        });
        console.log("✅ File object created for Walrus");
      } catch (encodeError) {
        console.error("❌ Failed to encode file:", encodeError);
        throw encodeError;
      }

      let flow;
      try {
        flow = this.walrusClient.writeFilesFlow({ files: [walrusFile] });
        const encodedFile = await flow.encode();
        console.log("✅ File encoded successfully in flow:", encodedFile);
      } catch (flowError) {
        console.error("❌ Failed to create or encode flow:", flowError);
        throw flowError;
      }

      // Step 2: Register blob
      console.log("📦 Step 2: Registering blob on-chain...");
      let registerTx;
      try {
        registerTx = flow.register({
          epochs,
          deletable: true,
          owner: senderAddress,
        });
        registerTx.setSender(senderAddress);
        console.log("📝 Register transaction created");
      } catch (txError) {
        console.error("❌ Failed to create register transaction:", txError);
        throw txError;
      }

      // Small delay to avoid race conditions
      await new Promise((resolve) => setTimeout(resolve, 1000));

      let registerDigest;
      try {
        console.log("🔑 Signing & executing register transaction...");
        ({ digest: registerDigest } = await walletKeypair.signAndExecuteTransaction({
          transaction: registerTx,
          client: this.suiClient,
        }));
        console.log("✅ Register transaction digest walletKeypair:", registerDigest);
        
      } catch (signError) {
        console.error("❌ Failed to sign/execute register transaction:", signError);
        throw signError;
      }

      try {
        console.log("⏳ Waiting for register transaction confirmation...");
        await this.suiClient.waitForTransaction({
          digest: registerDigest,
          options: { showEffects: true },
        });
        console.log("✅ Register transaction confirmed");
      } catch (confirmError) {
        console.error("❌ Register transaction confirmation failed:", confirmError);
        throw confirmError;
      }

      // Step 3: Upload file data
      await new Promise((resolve) => setTimeout(resolve, 2000));
      console.log("📤 Step 3: Uploading file data to relay...");
      try {
        await flow.upload({ digest: registerDigest });
        console.log("✅ File data uploaded successfully");
      } catch (uploadError) {
        console.error("❌ Failed to upload file data to relay:", uploadError);
        throw uploadError;
      }

      // Step 4: Certify blob
      console.log("📜 Step 4: Certifying blob on-chain...");
      let certifyTx;
      try {
        certifyTx = flow.certify();
        certifyTx.setSender(senderAddress);
        console.log("📝 Certify transaction created");
      } catch (certifyError) {
        console.error("❌ Failed to create certify transaction:", certifyError);
        throw certifyError;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));

      let certifyDigest;
      try {
        console.log("🔑 Signing & executing certify transaction...");
        ({ digest: certifyDigest } = await walletKeypair.signAndExecuteTransaction({
          transaction: certifyTx,
          client: this.suiClient,
        }));
        console.log("✅ Certify transaction digest:", certifyDigest);
      } catch (signCertifyError) {
        console.error("❌ Failed to sign/execute certify transaction:", signCertifyError);
        throw signCertifyError;
      }

      try {
        console.log("⏳ Waiting for certify transaction confirmation...");
        await this.suiClient.waitForTransaction({
          digest: certifyDigest,
          options: { showEffects: true },
        });
        console.log("✅ Certify transaction confirmed");
      } catch (confirmCertifyError) {
        console.error("❌ Certify transaction confirmation failed:", confirmCertifyError);
        throw confirmCertifyError;
      }

      // Step 5: List uploaded files
      console.log("📋 Step 5: Retrieving uploaded file information...");
      let results;
      try {
        results = await flow.listFiles();
        console.log("✅ File upload completed successfully. Results:", results);
      } catch (listError) {
        console.error("❌ Failed to list uploaded files:", listError);
        throw listError;
      }

      return results;
    } catch (error) {
      if (error instanceof RetryableWalrusClientError) {
        console.error("⚠️ RetryableWalrusClientError: Resetting Walrus client.", error);
        this.walrusClient.reset();
      }
      console.error("❌ Upload failed:", error);
      throw new Error(`Failed to upload file to Walrus via relay: ${error.message}`);
    }
  }

  async fetchEncryptedFile(blobId) {
    const walrusUrl = `${config.walrus.aggregatorUrl}/v1/blobs/${blobId}`;

    try {
      console.log(`📥 Fetching encrypted file from ${walrusUrl}`);

      const res = await fetch(walrusUrl, {
        headers: { "Content-Type": "application/octet-stream" },
        method: "GET",
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const encryptedFile = await res.arrayBuffer();
      if (!encryptedFile) {
        throw new Error("Empty response from Walrus");
      }

      console.log(`✅ Successfully fetched encrypted file (${encryptedFile.byteLength} bytes)`);
      
      let arrayBuffer;
      if (encryptedFile instanceof ArrayBuffer) {
        console.log(`>>>>> encryptedFile is ArrayBuffer`);
        arrayBuffer = encryptedFile;
      } else if (encryptedFile.buffer instanceof ArrayBuffer) {
        console.log(`>>>>> >>>>> encryptedFile.buffer is ArrayBuffer`);
        arrayBuffer = encryptedFile.buffer;
      } else if (Buffer.isBuffer(encryptedFile)) {
        console.log(`>>>>> >>>>> >>>>> Buffer.isBuffer encryptedFile`);
        arrayBuffer = encryptedFile.buffer.slice(
          encryptedFile.byteOffset,
          encryptedFile.byteOffset + encryptedFile.byteLength
        );
      } else {
        console.error('❌ Encrypted data is not a valid ArrayBuffer');
      }
      
      return encryptedFile;
    } catch (err) {
      console.error(`❌ Failed to fetch encrypted file: ${err.message}`);
      throw new Error(`fetchEncryptedFile failed: ${err.message}`);
    }
  }
}
