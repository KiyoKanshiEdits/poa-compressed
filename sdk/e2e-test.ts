import { PoA } from "./src/poa";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createRpc, sleep } from "@lightprotocol/stateless.js";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_API_KEY) {
  throw new Error("HELIUS_API_KEY environment variable is required");
}
const RPC_URL = `https://devnet.helius-rpc.com?api-key=${HELIUS_API_KEY}`;
const COMPRESSION_RPC_URL = RPC_URL;
const PROVER_URL = "https://prover.helius.dev";

async function main() {
  // Load the deployer keypair for signing
  const fs = require("fs");
  const path = require("os").homedir() + "/devnet-deployer.json";
  const secret = JSON.parse(fs.readFileSync(path, "utf-8"));
  const agentKeypair = Keypair.fromSecretKey(Uint8Array.from(secret));

  console.log("Agent:", agentKeypair.publicKey.toBase58());

  const poa = new PoA({
    rpcUrl: RPC_URL,
    compressionRpcUrl: COMPRESSION_RPC_URL,
    proverUrl: PROVER_URL,
    agentKeypair,
  });

  // Generate a unique receipt ID
  const receiptId = new Uint8Array(16);
  require("crypto").randomFillSync(receiptId);

  const modelHash = new Uint8Array(32).fill(0xAA);
  const inputHash = new Uint8Array(32).fill(0xBB);
  const outputHash = new Uint8Array(32).fill(0xCC);
  const parentReceiptHash = new Uint8Array(32).fill(0x00);

  console.log("Receipt ID:", Buffer.from(receiptId).toString("hex"));

  // 1. Issue receipt
  console.log("\n--- Issuing receipt ---");
  const sig = await poa.issueReceipt({
    receiptId,
    modelHash,
    inputHash,
    outputHash,
    parentReceiptHash,
  });
  console.log("TX Signature:", sig);

  // Wait for indexer
  console.log("Waiting for indexer...");
  await sleep(5000);

  // 2. Fetch receipt
  console.log("\n--- Fetching receipt ---");
  const receipt = await poa.fetchReceipt(receiptId);
  console.log("Agent:", receipt.agent.toBase58());
  console.log("Model Hash:", Buffer.from(receipt.modelHash).toString("hex"));
  console.log("Is Valid:", receipt.isValid);
  console.log("Slot:", receipt.slot.toString());

  // 3. Verify receipt
  console.log("\n--- Verifying receipt ---");
  const valid = poa.verifyReceipt(receipt);
  console.log("Receipt hash verification:", valid ? "PASSED" : "FAILED");

  console.log("\n--- E2E test complete ---");
}

main().catch((err) => {
  console.error("E2E test failed:", err);
  process.exit(1);
});
