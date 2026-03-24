# POA-SPEC v0.1 — Proof of Agent (Compressed)

**Verifiable Compute Receipts for On-Chain AI Agents via ZK Compression**

| Field | Value |
|-------|-------|
| **Spec Version** | 0.1-compressed (Draft) |
| **Status** | Draft — open for community feedback |
| **Author** | Logan |
| **Chain** | Solana (reference implementation) |
| **Program ID** | `6oWV3RpNUrrbb2NLcWMFaBEcrVjZ5fK4EAvQUcKYTs1N` |
| **Network** | Devnet |
| **Compression** | Light Protocol ZK Compression |
| **License** | MIT |
| **Repository** | https://github.com/KiyoKanshiEdits/poa-compressed |

---

## 1. Abstract

Proof of Agent (PoA) defines a standard for AI agents to issue cryptographically signed compute receipts on Solana. A compute receipt is a compact, on-chain record that binds an agent's identity to a specific computation — capturing what model was used, what inputs were processed, and what outputs were produced, anchored to a specific point in time.

This implementation uses **Light Protocol ZK compression** to store receipts as compressed accounts in Solana state trees, reducing per-receipt cost from ~0.002 SOL to ~0.00002 SOL. This makes it economically viable for agents to issue receipts for every computation.

PoA does not prove computational correctness. It proves computational *commitment* — an agent publicly commits to having performed a specific computation, creating an immutable, queryable audit trail that enables trust, accountability, and reputation in the emerging agent economy.

---

## 2. Motivation

The on-chain AI agent economy has surpassed $470M in aggregate GDP (aGDP) as of early 2026. Protocols like Virtuals ACP facilitate agent-to-agent commerce — agents hire each other, exchange deliverables, and settle payments on-chain.

However, a critical verification gap exists:

- **Transaction verification exists.** Every SOL transfer, token swap, and escrow settlement is recorded on-chain and independently verifiable.
- **Compute verification does not exist.** When an agent claims "I analysed your portfolio and recommend rebalancing," there is no standard mechanism to verify that the agent actually ran that analysis, used a specific model, or processed specific data.

This gap creates three problems:

1. **No trust basis for agent-to-agent commerce.** Agent A hires Agent B to perform analysis. B returns a result. A has no way to verify B did the work versus fabricating the output.

2. **No accountability for agent behaviour.** An agent managing capital makes a bad trade. The principal can see the trade on-chain but cannot audit the decision process — what data the agent considered, what model it used, or what confidence level it had.

3. **No foundation for agent reputation.** Without verifiable compute history, agent reputation systems have no cryptographic ground truth. Reputation becomes purely social rather than evidence-based.

PoA addresses all three by establishing a minimal, extensible standard for compute receipts.

### 2.1 Why ZK Compression

Traditional Solana accounts cost ~0.002 SOL in rent per receipt (225 bytes). For an agent issuing 1,000 receipts per day, this is 2 SOL/day or ~60 SOL/month — prohibitively expensive.

ZK-compressed accounts via Light Protocol store data in Merkle trees with on-chain root verification, reducing cost to ~0.00002 SOL per receipt — a **100x reduction**. This makes high-frequency receipt issuance economically viable.

**Trade-off:** Compressed accounts require a ZK prover and compression-aware RPC (e.g., Helius) to read and write. Standard `getAccountInfo` calls do not work — the SDK handles this transparently.

---

## 3. Design Principles

1. **Minimal.** The receipt schema contains exactly what is needed to identify a computation — no more.

2. **Agent-signed.** Every receipt is signed by the agent's keypair. The agent is the authority over its own compute claims.

3. **ZK-compressed.** Receipts are stored as Light Protocol compressed accounts, enabling high-volume issuance at minimal cost.

4. **Hash-committed.** Inputs, outputs, and model identifiers are stored as hashes. The raw data remains off-chain and private unless the agent or principal chooses to reveal it.

5. **Framework-agnostic.** PoA does not prescribe how agents compute. Any agent — whether built on elizaOS, Solana Agent Kit, LangChain, or custom infrastructure — can issue receipts.

6. **Extensible.** The v0.1 schema covers the base case. Future versions can add task linking, multi-agent pipeline receipts, and cryptographic correctness proofs without breaking backward compatibility.

---

## 4. Receipt Schema

### 4.1 Compressed Account Structure

Receipts are stored as Light Protocol compressed accounts. All fields marked with `#[hash]` are included in the Merkle leaf hash, ensuring ZK-verifiable integrity.

```rust
#[derive(LightDiscriminator, LightHasher)]
pub struct ComputeReceipt {
    #[hash]
    pub agent: Pubkey,              // 32 bytes — agent's public key

    #[hash]
    pub receipt_id: [u8; 16],       // 16 bytes — unique identifier

    #[hash]
    pub model_hash: [u8; 32],       // 32 bytes — SHA-256 of model identifier

    #[hash]
    pub input_hash: [u8; 32],       // 32 bytes — SHA-256 of inputs

    #[hash]
    pub output_hash: [u8; 32],      // 32 bytes — SHA-256 of outputs

    #[hash]
    pub parent_receipt_hash: [u8; 32], // 32 bytes — receipt chain linkage

    #[hash]
    pub slot: u64,                  // 8 bytes — Solana slot timestamp

    #[hash]
    pub receipt_hash: [u8; 32],     // 32 bytes — integrity hash

    pub is_valid: bool,             // 1 byte — validity flag
}
```

**Total data size:** 217 bytes (stored compressed in Merkle tree, not as a traditional account)

### 4.2 Field Definitions

**`agent`** — The public key of the agent issuing the receipt. The agent must be the transaction signer. This establishes identity: every receipt is attributable to a specific agent.

**`receipt_id`** — A 16-byte unique identifier generated by the agent. Typically a UUID v4 or random bytes. Used as an address seed to derive the compressed account's unique address. The agent may use this to correlate receipts with internal task IDs.

**`model_hash`** — SHA-256 hash of a string identifying the model or logic used. Examples: `sha256("gpt-4-trading-v2.1")`, `sha256("custom-risk-model-7b-q4")`. The raw model identifier is not stored on-chain — only the hash. This allows verification without revealing proprietary model details. **Must be non-zero** — the program rejects all-zero hashes.

**`input_hash`** — SHA-256 hash of the JSON-serialised computation inputs. The agent hashes whatever data it consumed for the computation. **Must be non-zero.**

**`output_hash`** — SHA-256 hash of the JSON-serialised computation outputs. The agent hashes whatever results it produced. **Must be non-zero.**

**`parent_receipt_hash`** — The `receipt_hash` of a parent receipt, enabling receipt chaining for multi-step computations. Set to all zeros for root receipts (no parent). **Note (v0.1):** Parent receipt validation is stored but not verified on-chain. The program does not check that a parent receipt exists or is valid. This is by design — on-chain verification of compressed account existence requires additional proof fetching that adds cost and complexity. Clients and indexers should validate parent chains off-chain.

**`slot`** — The Solana slot number at the time the receipt was submitted on-chain. This is read from the Solana `Clock` sysvar and cannot be manipulated by the agent. It provides a trustworthy timestamp anchor.

**`receipt_hash`** — An integrity hash computed as:

```
receipt_hash = SHA-256(agent || receipt_id || model_hash || input_hash || output_hash || parent_receipt_hash || slot_le_bytes)
```

Where `||` denotes concatenation and `slot_le_bytes` is the slot as an 8-byte little-endian integer. This hash binds all fields together — any tampering with any field will produce a different `receipt_hash`, detectable by any verifier.

**`is_valid`** — A boolean flag indicating whether the receipt is still considered valid. Defaults to `true` on issuance. Can be set to `false` by the original agent via the `invalidate_receipt` instruction. Invalidation is irreversible.

### 4.3 Address Derivation

Compressed account addresses are derived using Light Protocol's address derivation:

```
seeds = ["receipt", agent_pubkey, receipt_id]
address = derive_address(seeds, address_tree, program_id)
```

This ensures:
- Deterministic address derivation — anyone can compute the address given the agent and receipt ID
- One account per receipt — no collisions
- Efficient lookup — query by address without scanning

---

## 5. Instructions

### 5.1 `issue_receipt`

Creates a new compressed compute receipt on-chain via CPI to the Light System Program.

**Arguments:**
| Name | Type | Description |
|------|------|-------------|
| `proof` | `ValidityProof` | ZK validity proof for address tree |
| `address_tree_info` | `PackedAddressTreeInfo` | Compressed address tree metadata |
| `output_merkle_tree_index` | `u8` | Index of output state tree |
| `receipt_id` | `[u8; 16]` | Unique identifier for this receipt |
| `model_hash` | `[u8; 32]` | SHA-256 of model identifier |
| `input_hash` | `[u8; 32]` | SHA-256 of serialised inputs |
| `output_hash` | `[u8; 32]` | SHA-256 of serialised outputs |
| `parent_receipt_hash` | `[u8; 32]` | Parent receipt hash (zero for root) |

**Accounts:**
| Name | Writable | Signer | Description |
|------|----------|--------|-------------|
| `signer` | Yes | Yes | The agent issuing the receipt |
| *remaining accounts* | Various | No | Light Protocol system accounts and tree accounts |

**Behaviour:**
1. Validates that `model_hash`, `input_hash`, and `output_hash` are non-zero (fails with `EmptyHash` if any are all zeros)
2. Derives the compressed account address from seeds
3. Reads the current slot from the `Clock` sysvar
4. Computes `receipt_hash = SHA-256(agent || receipt_id || model_hash || input_hash || output_hash || parent_receipt_hash || slot_le_bytes)`
5. Creates a new compressed account via Light System Program CPI
6. Emits a `ReceiptIssued` event

**Failure conditions:**
- Any of `model_hash`, `input_hash`, `output_hash` are all zeros (`EmptyHash`)
- Address already exists in the tree (duplicate `receipt_id` for this agent)
- Invalid validity proof

### 5.2 `invalidate_receipt`

Marks a receipt as invalid. Only the original agent can do this. Requires the full current state of the receipt to verify against the compressed account hash.

**Arguments:**
| Name | Type | Description |
|------|------|-------------|
| `proof` | `ValidityProof` | ZK validity proof for current state |
| `account_meta` | `CompressedAccountMeta` | Merkle tree position metadata |
| `receipt_id` | `[u8; 16]` | Current receipt_id value |
| `model_hash` | `[u8; 32]` | Current model_hash value |
| `input_hash` | `[u8; 32]` | Current input_hash value |
| `output_hash` | `[u8; 32]` | Current output_hash value |
| `parent_receipt_hash` | `[u8; 32]` | Current parent_receipt_hash value |
| `slot` | `u64` | Current slot value |
| `receipt_hash` | `[u8; 32]` | Current receipt_hash value |

**Behaviour:**
1. Reconstructs the current account state and verifies it matches the compressed account hash
2. Checks `is_valid == true` (fails with `AlreadyInvalidated` if not)
3. Sets `is_valid = false`
4. Updates the compressed account via Light System Program CPI
5. Emits a `ReceiptInvalidated` event

### 5.3 `close_receipt`

Deletes a compressed receipt account entirely. Only the original agent can do this.

**Arguments:** Same as `invalidate_receipt` plus `is_valid: bool`.

**Behaviour:**
1. Reconstructs and verifies the current account state
2. Closes (deletes) the compressed account via Light System Program CPI

**Note:** Verification is performed client-side via the SDK's `verifyReceipt()` method, which recomputes the SHA-256 integrity hash without requiring an on-chain transaction. There is no on-chain `verify_receipt` instruction — this is intentional to minimize program size and cost.

---

## 6. Events

### 6.1 `ReceiptIssued`

Emitted when a new receipt is created.

```rust
pub struct ReceiptIssued {
    pub receipt_hash: [u8; 32],
    pub agent: Pubkey,
    pub model_hash: [u8; 32],
    pub slot: u64,
}
```

### 6.2 `ReceiptInvalidated`

Emitted when a receipt is invalidated.

```rust
pub struct ReceiptInvalidated {
    pub receipt_hash: [u8; 32],
    pub agent: Pubkey,
    pub slot: u64,
}
```

Events enable off-chain indexers to track receipt issuance and invalidation in real time without polling compressed account state.

---

## 7. Verification Model

PoA operates on a **commitment-based** verification model, not a **correctness-based** one. The distinction is critical:

| Property | Commitment (PoA v0.1) | Correctness (future) |
|----------|----------------------|---------------------|
| Proves | Agent *claims* it ran computation X | Agent *actually* ran computation X |
| Mechanism | Signed hash commitments | ZK execution proofs or TEE attestations |
| Cost | ~0.00002 SOL per receipt | Orders of magnitude higher |
| Trust assumption | Agent is honest or detectable | Cryptographic — no trust needed |

### 7.1 What can be verified

Given a receipt and the raw inputs/outputs:

1. **Identity:** The agent that signed the receipt is known (on-chain signer)
2. **Timing:** The computation was committed at a specific slot (Clock sysvar)
3. **Consistency:** The input/output hashes match the claimed raw data (SHA-256 preimage check)
4. **Integrity:** No fields have been tampered with post-issuance (receipt_hash check)
5. **Validity:** The agent has not retracted the receipt (is_valid flag)
6. **ZK inclusion:** The receipt exists in a verified Merkle tree (Light Protocol state proof)

### 7.2 What cannot be verified (v0.1)

1. **Correctness:** That the agent actually executed the computation (could have fabricated outputs)
2. **Completeness:** That the agent disclosed all inputs (could have used additional undisclosed data)
3. **Exclusivity:** That this was the agent's only computation (could have run multiple and selected the most favourable)
4. **Parent chain validity:** That a referenced parent receipt exists and is valid (stored but not verified on-chain)

### 7.3 Deterrence value

Despite not proving correctness, commitment-based receipts provide significant deterrence:

- **Detectable lying.** If an agent commits to `input_hash = H(data)` but the principal later obtains the real data and finds a different hash, the agent is caught.
- **Reputation consequences.** Agents with inconsistent or retracted receipts build a negative on-chain track record.
- **Legal evidence.** In disputes, a signed receipt is a cryptographic commitment that can serve as evidence of the agent's claims at a specific time.

---

## 8. Security Considerations

### 8.1 Receipt ID uniqueness

The `receipt_id` is agent-generated. If an agent reuses a `receipt_id`, the address derivation will produce the same compressed account address and the transaction will fail. This is enforced by the Light Protocol address tree — duplicate addresses are rejected.

### 8.2 Input validation

The program requires that `model_hash`, `input_hash`, and `output_hash` are non-zero (not all zeros). This prevents agents from issuing empty receipts that commit to nothing. The `parent_receipt_hash` field is allowed to be zero (indicating a root receipt with no parent).

### 8.3 Hash function choice

SHA-256 is used for the `receipt_hash` integrity field, computed via `solana_program::hash::hash`. All receipt fields marked with `#[hash]` are additionally included in Light Protocol's Poseidon-based Merkle leaf hash, providing two layers of integrity verification.

### 8.4 Input/output privacy

Raw inputs and outputs are never stored on-chain — only their SHA-256 hashes. An observer can see that an agent issued a receipt but cannot determine what was computed without the preimage. However:

- Hash commitments are not hiding commitments — if the input space is small or predictable, an attacker could brute-force the preimage.
- For sensitive computations, agents should salt their inputs before hashing.
- Future versions may introduce Pedersen commitments or Poseidon-based hiding commitments for stronger privacy.

### 8.5 Invalidation authority

Only the original agent can invalidate its own receipts. There is no admin key, no multisig override, and no program upgrade authority that can invalidate receipts. This is by design — the agent is the sole authority over its compute claims.

### 8.6 Compression infrastructure dependency

Compressed accounts require:
- A **compression-aware RPC** (e.g., Helius) that supports `getCompressedAccount` and `getValidityProof` methods
- A **ZK prover** to generate validity proofs for state transitions
- A **Photon indexer** (or equivalent) for querying compressed account state

If these services are unavailable, receipts cannot be read or written. The on-chain state in the Merkle trees remains intact and accessible once services are restored.

---

## 9. Integration Patterns

### 9.1 Agent-to-agent escrow (Virtuals ACP)

```
Agent A creates job → Agent B performs work → B issues PoA receipt →
A verifies receipt matches expected computation → A releases escrow
```

The receipt serves as proof-of-work before payment. A can verify that B's claimed model, inputs, and outputs are consistent before releasing funds.

### 9.2 Principal oversight

```
Human principal deploys agent → Agent operates autonomously →
Agent issues receipt for every decision → Principal audits receipts periodically
```

The principal has a complete, immutable log of every computation the agent claims to have performed. At ~0.00002 SOL per receipt, even high-frequency agents can log every action.

### 9.3 Multi-agent pipeline

```
Agent A (data collection) → receipt(parent=0x00) →
Agent B (analysis) → receipt(parent=A.receipt_hash) →
Agent C (execution) → receipt(parent=B.receipt_hash) →
Full pipeline audit trail
```

Each agent in a pipeline issues its own receipt, linking to the previous via `parent_receipt_hash`. This creates a verifiable chain of computation.

### 9.4 Reputation systems

```
Indexer watches ReceiptIssued events → Builds per-agent receipt history →
Scores agents by volume, consistency, invalidation rate → Publishes reputation scores
```

PoA receipts provide the raw data layer for on-chain agent reputation.

---

## 10. Future Extensions

### 10.1 On-chain parent validation (v0.2)

Verify parent receipt existence on-chain by requiring a validity proof for the parent compressed account. This adds cost but enables trustless receipt chain verification.

### 10.2 Task linking (v0.3)

Add structured task metadata to receipts — task type, priority, deadline — enabling richer agent workflow tracking.

### 10.3 Verifiable compute proofs (v1.0+)

For high-value computations, agents can optionally attach a ZK proof or TEE attestation to the receipt, upgrading from commitment-based to correctness-based verification. This is additive — the base receipt schema remains unchanged.

### 10.4 Cross-chain receipts (v1.1+)

Portable receipt format that can be verified on EVM chains (Base, Ethereum) via bridged state proofs or independent verifier contracts.

---

## 11. Reference Implementation

The reference implementation is available at:

- **Anchor program:** `programs/poa-compressed/src/lib.rs`
- **TypeScript SDK:** `sdk/src/poa.ts` (published as `@proof-of-agent/sdk`)
- **IDL:** `target/idl/poa_compressed.json`
- **Rust tests:** `programs/poa-compressed/tests/test.rs`
- **E2E test:** `sdk/e2e-test.ts`

Install the SDK:

```bash
npm install @proof-of-agent/sdk
```

Issue a receipt:

```typescript
import { PoA } from "@proof-of-agent/sdk";

const poa = new PoA({
  rpcUrl: "https://devnet.helius-rpc.com?api-key=YOUR_KEY",
  compressionRpcUrl: "https://devnet.helius-rpc.com?api-key=YOUR_KEY",
  proverUrl: "https://prover.helius.dev",
  agentKeypair,
});

const sig = await poa.issueReceipt({
  receiptId,
  modelHash,
  inputHash,
  outputHash,
  parentReceiptHash,
});
```

**Infrastructure requirements:**
- Helius RPC (or any compression-aware RPC) for compressed account read/write
- ZK prover endpoint for validity proof generation

---

## 12. Acknowledgements

Built on Solana using Anchor and Light Protocol. Informed by research and conversations around verifiable AI agent infrastructure, ZK compression, and the emerging agent commerce protocols (Virtuals ACP, x402).

---

*This specification is a living document. Feedback, issues, and contributions are welcome via the GitHub repository.*
