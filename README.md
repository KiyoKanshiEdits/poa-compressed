# Proof of Agent (PoA) - Compressed

> **WARNING: This software is unaudited and experimental. Use at your own risk. Not recommended for production use with real funds.**

Verifiable compute receipts for Solana AI agents using ZK compression. Every inference, tool call, or reasoning step an agent performs can be anchored on-chain as a compressed receipt — cryptographically bound to the model, inputs, outputs, and parent chain of execution.

## Program ID

| Network | Program ID |
|---------|-----------|
| Devnet  | `6oWV3RpNUrrbb2NLcWMFaBEcrVjZ5fK4EAvQUcKYTs1N` |

## Architecture

PoA uses [Light Protocol](https://www.lightprotocol.com/) ZK compression to store receipts as compressed accounts on Solana. Instead of paying ~0.002 SOL per receipt with traditional accounts, compressed accounts cost a fraction of a cent — making it viable to record every agent action on-chain.

```
Agent performs compute
        |
        v
+-------------------+
| issue_receipt()   |  Anchor program via Light SDK
| - model_hash      |  CPI to Light System Program
| - input_hash      |
| - output_hash     |  Compressed account stored in
| - receipt_hash    |  Merkle tree (ZK state proof)
+-------------------+
        |
        v
  Compressed Account
  (Solana state tree)
```

**On-chain program** (`programs/poa-compressed/src/lib.rs`):
- `issue_receipt` — Create a compressed receipt with SHA-256 integrity hash
- `invalidate_receipt` — Mark a receipt as invalid (soft delete)
- `close_receipt` — Delete the compressed account entirely

**ComputeReceipt** fields: `agent`, `receipt_id`, `model_hash`, `input_hash`, `output_hash`, `parent_receipt_hash`, `slot`, `receipt_hash`, `is_valid`

All hash fields are included in Light's Merkle leaf hash via `#[hash]`, ensuring ZK-verifiable integrity.

## SDK

### Install

```bash
npm install @proof-of-agent/sdk
```

### Quick Start

```typescript
import { PoA } from "@proof-of-agent/sdk";
import { Keypair } from "@solana/web3.js";
import crypto from "crypto";

const poa = new PoA({
  rpcUrl: "https://devnet.helius-rpc.com?api-key=YOUR_KEY",
  compressionRpcUrl: "https://devnet.helius-rpc.com?api-key=YOUR_KEY",
  proverUrl: "https://prover.helius.dev",
  agentKeypair: Keypair.generate(),
});

// Generate a unique receipt ID
const receiptId = new Uint8Array(16);
crypto.randomFillSync(receiptId);

// Issue a receipt
const sig = await poa.issueReceipt({
  receiptId,
  modelHash: crypto.createHash("sha256").update("gpt-4").digest(),
  inputHash: crypto.createHash("sha256").update("user prompt").digest(),
  outputHash: crypto.createHash("sha256").update("agent response").digest(),
  parentReceiptHash: new Uint8Array(32), // zero for root receipt
});

// Fetch the receipt from compressed state
const receipt = await poa.fetchReceipt(receiptId);

// Verify integrity client-side (recomputes SHA-256)
const valid = poa.verifyReceipt(receipt);
console.log("Receipt valid:", valid); // true

// Invalidate a receipt
await poa.invalidateReceipt(receiptId);

// Close (delete) a receipt
await poa.closeReceipt(receiptId);

// Fetch all receipts by an agent
const receipts = await poa.fetchAllReceiptsByAgent(agentPublicKey);
```

## Development

### Prerequisites

- Rust 1.75+
- Solana CLI v2.2.15
- Anchor CLI 0.31.1+
- Node.js 18+
- Light Protocol CLI (`light test-validator`)

### Build

```bash
anchor build
```

### Test (Rust integration tests)

```bash
# Start the ZK prover (required for compressed account proofs)
./prover-linux-amd64 start &

# Run tests
cargo test-sbf --manifest-path programs/poa-compressed/Cargo.toml
```

### Deploy

```bash
anchor deploy --provider.cluster devnet
```

## Spec

See the [Proof of Agent specification](https://github.com/KiyoKanshiEdits/poa-compressed/blob/main/SPEC.md) for the full protocol design.

## License

MIT
