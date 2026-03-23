import * as anchor from "@coral-xyz/anchor";
import { Program, web3, BN } from "@coral-xyz/anchor";
import idl from "./idl.json";
import {
  bn,
  CompressedAccountWithMerkleContext,
  createRpc,
  defaultStaticAccountsStruct,
  defaultTestStateTreeAccounts,
  deriveAddress,
  deriveAddressSeed,
  LightSystemProgram,
  Rpc,
} from "@lightprotocol/stateless.js";

export const PROGRAM_ID = new web3.PublicKey(idl.address);

export interface PoAConfig {
  rpcUrl: string;
  compressionRpcUrl: string;
  proverUrl: string;
  agentKeypair: web3.Keypair;
}

export interface ComputeReceipt {
  agent: web3.PublicKey;
  receiptId: Uint8Array;
  modelHash: Uint8Array;
  inputHash: Uint8Array;
  outputHash: Uint8Array;
  parentReceiptHash: Uint8Array;
  slot: BN;
  receiptHash: Uint8Array;
  isValid: boolean;
}

export interface IssueReceiptParams {
  receiptId: Uint8Array;
  modelHash: Uint8Array;
  inputHash: Uint8Array;
  outputHash: Uint8Array;
  parentReceiptHash: Uint8Array;
}

export class PoA {
  readonly rpc: Rpc;
  readonly program: Program;
  readonly coder: anchor.BorshCoder;
  readonly agentKeypair: web3.Keypair;

  constructor(config: PoAConfig) {
    this.rpc = createRpc(
      config.rpcUrl,
      config.compressionRpcUrl,
      config.proverUrl,
      { commitment: "confirmed" },
    );
    this.agentKeypair = config.agentKeypair;

    const provider = new anchor.AnchorProvider(
      this.rpc,
      new anchor.Wallet(config.agentKeypair),
      { commitment: "confirmed" },
    );
    this.program = new Program(
      idl as any,
      provider,
    );
    this.coder = new anchor.BorshCoder(idl as anchor.Idl);
  }

  private deriveReceiptAddress(receiptId: Uint8Array): web3.PublicKey {
    const addressTree = defaultTestStateTreeAccounts().addressTree;
    const seed = deriveAddressSeed(
      [
        new TextEncoder().encode("receipt"),
        this.agentKeypair.publicKey.toBytes(),
        receiptId,
      ],
      PROGRAM_ID,
    );
    return deriveAddress(seed, addressTree);
  }

  async issueReceipt(params: IssueReceiptParams): Promise<string> {
    const { receiptId, modelHash, inputHash, outputHash, parentReceiptHash } = params;

    const addressTree = defaultTestStateTreeAccounts().addressTree;
    const addressQueue = defaultTestStateTreeAccounts().addressQueue;
    const outputMerkleTree = defaultTestStateTreeAccounts().merkleTree;
    const address = this.deriveReceiptAddress(receiptId);

    const proofRpcResult = await this.rpc.getValidityProofV0(
      [],
      [{ tree: addressTree, queue: addressQueue, address: bn(address.toBytes()) }],
    );

    const systemAccountConfig = SystemAccountMetaConfig.new(PROGRAM_ID);
    const remainingAccounts = PackedAccounts.newWithSystemAccounts(systemAccountConfig);

    const addressMerkleTreePubkeyIndex = remainingAccounts.insertOrGet(addressTree);
    const addressQueuePubkeyIndex = remainingAccounts.insertOrGet(addressQueue);
    const packedAddressTreeInfo = {
      rootIndex: proofRpcResult.rootIndices[0],
      addressMerkleTreePubkeyIndex,
      addressQueuePubkeyIndex,
    };
    const outputStateTreeIndex = remainingAccounts.insertOrGet(outputMerkleTree);

    const proof = { 0: proofRpcResult.compressedProof };
    const computeBudgetIx = web3.ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_000_000,
    });

    const tx = await this.program.methods
      .issueReceipt(
        proof,
        packedAddressTreeInfo,
        outputStateTreeIndex,
        Array.from(receiptId) as any,
        Array.from(modelHash) as any,
        Array.from(inputHash) as any,
        Array.from(outputHash) as any,
        Array.from(parentReceiptHash) as any,
      )
      .accounts({ signer: this.agentKeypair.publicKey })
      .preInstructions([computeBudgetIx])
      .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
      .signers([this.agentKeypair])
      .transaction();

    tx.recentBlockhash = (await this.rpc.getRecentBlockhash()).blockhash;
    tx.sign(this.agentKeypair);

    const sig = await this.rpc.sendTransaction(tx, [this.agentKeypair]);
    await this.rpc.confirmTransaction(sig);
    return sig;
  }

  async fetchReceipt(receiptId: Uint8Array): Promise<ComputeReceipt> {
    const address = this.deriveReceiptAddress(receiptId);
    const account = await this.rpc.getCompressedAccount(bn(address.toBytes()));
    return this.decodeReceipt(account);
  }

  verifyReceipt(receipt: ComputeReceipt): boolean {
    // Recompute the receipt hash the same way the on-chain program does:
    // hash(agent | receipt_id | model_hash | input_hash | output_hash | parent_receipt_hash | slot_le_bytes)
    const data = Buffer.alloc(184);
    let offset = 0;
    data.set(receipt.agent.toBytes(), offset); offset += 32;
    data.set(receipt.receiptId, offset); offset += 16;
    data.set(receipt.modelHash, offset); offset += 32;
    data.set(receipt.inputHash, offset); offset += 32;
    data.set(receipt.outputHash, offset); offset += 32;
    data.set(receipt.parentReceiptHash, offset); offset += 32;

    const slotBuf = Buffer.alloc(8);
    slotBuf.writeBigUInt64LE(BigInt(receipt.slot.toString()));
    data.set(slotBuf, offset);

    // solana_program::hash::hash uses SHA-256
    const crypto = require("crypto");
    const computedHash: Buffer = crypto.createHash("sha256").update(data).digest();
    return Buffer.from(receipt.receiptHash).equals(computedHash);
  }

  async invalidateReceipt(receiptId: Uint8Array): Promise<string> {
    const address = this.deriveReceiptAddress(receiptId);
    const account = await this.rpc.getCompressedAccount(bn(address.toBytes()));
    const receipt = this.decodeReceipt(account);

    const proofRpcResult = await this.rpc.getValidityProofV0(
      [{ hash: account.hash, tree: account.treeInfo.tree, queue: account.treeInfo.queue }],
      [],
    );

    const systemAccountConfig = SystemAccountMetaConfig.new(PROGRAM_ID);
    const remainingAccounts = PackedAccounts.newWithSystemAccounts(systemAccountConfig);
    const outputMerkleTree = defaultTestStateTreeAccounts().merkleTree;

    const merkleTreePubkeyIndex = remainingAccounts.insertOrGet(account.treeInfo.tree);
    const queuePubkeyIndex = remainingAccounts.insertOrGet(account.treeInfo.queue);
    const outputStateTreeIndex = remainingAccounts.insertOrGet(outputMerkleTree);

    const compressedAccountMeta = {
      treeInfo: {
        merkleTreePubkeyIndex,
        queuePubkeyIndex,
        leafIndex: account.leafIndex,
        proveByIndex: false,
        rootIndex: proofRpcResult.rootIndices[0],
      },
      outputStateTreeIndex,
      address: account.address,
    };

    const proof = { 0: proofRpcResult.compressedProof };
    const computeBudgetIx = web3.ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_000_000,
    });

    const tx = await this.program.methods
      .invalidateReceipt(
        proof,
        compressedAccountMeta,
        Array.from(receipt.receiptId) as any,
        Array.from(receipt.modelHash) as any,
        Array.from(receipt.inputHash) as any,
        Array.from(receipt.outputHash) as any,
        Array.from(receipt.parentReceiptHash) as any,
        receipt.slot,
        Array.from(receipt.receiptHash) as any,
      )
      .accounts({ signer: this.agentKeypair.publicKey })
      .preInstructions([computeBudgetIx])
      .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
      .signers([this.agentKeypair])
      .transaction();

    tx.recentBlockhash = (await this.rpc.getRecentBlockhash()).blockhash;
    tx.sign(this.agentKeypair);

    const sig = await this.rpc.sendTransaction(tx, [this.agentKeypair]);
    await this.rpc.confirmTransaction(sig);
    return sig;
  }

  async closeReceipt(receiptId: Uint8Array): Promise<string> {
    const address = this.deriveReceiptAddress(receiptId);
    const account = await this.rpc.getCompressedAccount(bn(address.toBytes()));
    const receipt = this.decodeReceipt(account);

    const proofRpcResult = await this.rpc.getValidityProofV0(
      [{ hash: account.hash, tree: account.treeInfo.tree, queue: account.treeInfo.queue }],
      [],
    );

    const systemAccountConfig = SystemAccountMetaConfig.new(PROGRAM_ID);
    const remainingAccounts = PackedAccounts.newWithSystemAccounts(systemAccountConfig);
    const outputMerkleTree = defaultTestStateTreeAccounts().merkleTree;

    const merkleTreePubkeyIndex = remainingAccounts.insertOrGet(account.treeInfo.tree);
    const queuePubkeyIndex = remainingAccounts.insertOrGet(account.treeInfo.queue);
    const outputStateTreeIndex = remainingAccounts.insertOrGet(outputMerkleTree);

    const compressedAccountMeta = {
      treeInfo: {
        merkleTreePubkeyIndex,
        queuePubkeyIndex,
        leafIndex: account.leafIndex,
        proveByIndex: false,
        rootIndex: proofRpcResult.rootIndices[0],
      },
      outputStateTreeIndex,
      address: account.address,
    };

    const proof = { 0: proofRpcResult.compressedProof };
    const computeBudgetIx = web3.ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_000_000,
    });

    const tx = await this.program.methods
      .closeReceipt(
        proof,
        compressedAccountMeta,
        Array.from(receipt.receiptId) as any,
        Array.from(receipt.modelHash) as any,
        Array.from(receipt.inputHash) as any,
        Array.from(receipt.outputHash) as any,
        Array.from(receipt.parentReceiptHash) as any,
        receipt.slot,
        Array.from(receipt.receiptHash) as any,
        receipt.isValid,
      )
      .accounts({ signer: this.agentKeypair.publicKey })
      .preInstructions([computeBudgetIx])
      .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
      .signers([this.agentKeypair])
      .transaction();

    tx.recentBlockhash = (await this.rpc.getRecentBlockhash()).blockhash;
    tx.sign(this.agentKeypair);

    const sig = await this.rpc.sendTransaction(tx, [this.agentKeypair]);
    await this.rpc.confirmTransaction(sig);
    return sig;
  }

  async fetchAllReceiptsByAgent(
    agent?: web3.PublicKey,
  ): Promise<ComputeReceipt[]> {
    const owner = agent ?? this.agentKeypair.publicKey;
    const result = await this.rpc.getCompressedAccountsByOwner(PROGRAM_ID);
    const receipts: ComputeReceipt[] = [];

    for (const account of result.items) {
      if (!account.data) continue;
      try {
        const receipt = this.decodeReceipt(account);
        if (receipt.agent.equals(owner)) {
          receipts.push(receipt);
        }
      } catch {
        // skip accounts that don't decode as ComputeReceipt
      }
    }
    return receipts;
  }

  private decodeReceipt(
    account: CompressedAccountWithMerkleContext,
  ): ComputeReceipt {
    const decoded = this.coder.types.decode(
      "ComputeReceipt",
      account.data.data,
    );
    // BorshCoder uses snake_case field names matching the Rust struct
    return {
      agent: decoded.agent,
      receiptId: Uint8Array.from(decoded.receipt_id),
      modelHash: Uint8Array.from(decoded.model_hash),
      inputHash: Uint8Array.from(decoded.input_hash),
      outputHash: Uint8Array.from(decoded.output_hash),
      parentReceiptHash: Uint8Array.from(decoded.parent_receipt_hash),
      slot: decoded.slot,
      receiptHash: Uint8Array.from(decoded.receipt_hash),
      isValid: decoded.is_valid,
    };
  }
}

// --- Helper classes (same pattern as tests/test.ts) ---

class PackedAccounts {
  private preAccounts: web3.AccountMeta[] = [];
  private systemAccounts: web3.AccountMeta[] = [];
  private nextIndex: number = 0;
  private map: Map<string, [number, web3.AccountMeta]> = new Map();

  static newWithSystemAccounts(config: SystemAccountMetaConfig): PackedAccounts {
    const instance = new PackedAccounts();
    instance.addSystemAccounts(config);
    return instance;
  }

  addSystemAccounts(config: SystemAccountMetaConfig): void {
    this.systemAccounts.push(...getLightSystemAccountMetas(config));
  }

  insertOrGet(pubkey: web3.PublicKey): number {
    const key = pubkey.toBase58();
    const entry = this.map.get(key);
    if (entry) return entry[0];
    const index = this.nextIndex++;
    this.map.set(key, [index, { pubkey, isSigner: false, isWritable: true }]);
    return index;
  }

  toAccountMetas(): { remainingAccounts: web3.AccountMeta[] } {
    const entries = Array.from(this.map.entries());
    entries.sort((a, b) => a[1][0] - b[1][0]);
    const packed = entries.map(([, [, meta]]) => meta);
    return {
      remainingAccounts: [
        ...this.preAccounts,
        ...this.systemAccounts,
        ...packed,
      ],
    };
  }
}

class SystemAccountMetaConfig {
  selfProgram: web3.PublicKey;

  private constructor(selfProgram: web3.PublicKey) {
    this.selfProgram = selfProgram;
  }

  static new(selfProgram: web3.PublicKey): SystemAccountMetaConfig {
    return new SystemAccountMetaConfig(selfProgram);
  }
}

function getLightSystemAccountMetas(
  config: SystemAccountMetaConfig,
): web3.AccountMeta[] {
  const cpiSigner = web3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("cpi_authority")],
    config.selfProgram,
  )[0];
  const defaults = defaultStaticAccountsStruct();
  return [
    { pubkey: LightSystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: cpiSigner, isSigner: false, isWritable: false },
    { pubkey: defaults.registeredProgramPda, isSigner: false, isWritable: false },
    { pubkey: defaults.noopProgram, isSigner: false, isWritable: false },
    { pubkey: defaults.accountCompressionAuthority, isSigner: false, isWritable: false },
    { pubkey: defaults.accountCompressionProgram, isSigner: false, isWritable: false },
    { pubkey: config.selfProgram, isSigner: false, isWritable: false },
    { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
  ];
}
