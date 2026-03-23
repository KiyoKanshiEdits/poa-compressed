#![cfg(feature = "test-sbf")]

use anchor_lang::AnchorDeserialize;
use light_client::indexer::CompressedAccount;
use light_program_test::{
    program_test::LightProgramTest, AddressWithTree, Indexer, ProgramTestConfig, Rpc, RpcError,
};
use light_sdk::{
    address::v1::derive_address,
    instruction::{account_meta::CompressedAccountMeta, PackedAccounts, SystemAccountMetaConfig},
};
use poa_compressed::ComputeReceipt;
use solana_sdk::{
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    signature::{Keypair, Signature, Signer},
};

#[tokio::test]
async fn test_issue_receipt() {
    let config = ProgramTestConfig::new(false, Some(vec![("poa_compressed", poa_compressed::ID)]));
    let mut rpc = LightProgramTest::new(config).await.unwrap();
    let payer = rpc.get_payer().insecure_clone();

    let receipt_id: [u8; 16] = [1u8; 16];
    let model_hash: [u8; 32] = [2u8; 32];
    let input_hash: [u8; 32] = [3u8; 32];
    let output_hash: [u8; 32] = [4u8; 32];
    let parent_receipt_hash: [u8; 32] = [0u8; 32];

    let address_tree_info = rpc.get_address_tree_v1();

    let (address, _) = derive_address(
        &[b"receipt", payer.pubkey().as_ref(), &receipt_id],
        &address_tree_info.tree,
        &poa_compressed::ID,
    );

    // Test 1: Issue a receipt
    issue_receipt(
        &mut rpc,
        &payer,
        &address,
        receipt_id,
        model_hash,
        input_hash,
        output_hash,
        parent_receipt_hash,
    )
    .await
    .unwrap();

    // Verify it was created
    let receipt = get_receipt(&mut rpc, address).await;
    assert_eq!(receipt.agent, payer.pubkey());
    assert_eq!(receipt.receipt_id, receipt_id);
    assert_eq!(receipt.model_hash, model_hash);
    assert_eq!(receipt.input_hash, input_hash);
    assert_eq!(receipt.output_hash, output_hash);
    assert_eq!(receipt.parent_receipt_hash, parent_receipt_hash);
    assert!(receipt.is_valid);

    // Test 2: Invalidate the receipt
    let account = get_compressed_account(&mut rpc, address).await;
    invalidate_receipt(&mut rpc, &payer, account, &receipt)
        .await
        .unwrap();

    // Verify it was invalidated
    let receipt = get_receipt(&mut rpc, address).await;
    assert!(!receipt.is_valid);

    // Test 3: Close the invalidated receipt
    let account = get_compressed_account(&mut rpc, address).await;
    let receipt_data = get_receipt(&mut rpc, address).await;
    close_receipt(&mut rpc, &payer, account, &receipt_data)
        .await
        .unwrap();

    // Verify it was deleted
    let result = rpc.get_compressed_account(address, None).await;
    assert!(result.is_err() || result.unwrap().value.data.is_none());
}

async fn issue_receipt(
    rpc: &mut LightProgramTest,
    payer: &Keypair,
    address: &[u8; 32],
    receipt_id: [u8; 16],
    model_hash: [u8; 32],
    input_hash: [u8; 32],
    output_hash: [u8; 32],
    parent_receipt_hash: [u8; 32],
) -> Result<Signature, RpcError> {
    let config = SystemAccountMetaConfig::new(poa_compressed::ID);
    let mut remaining_accounts = PackedAccounts::default();
    remaining_accounts.add_system_accounts(config);

    let address_merkle_tree_info = rpc.get_address_tree_v1();

    let rpc_result = rpc
        .get_validity_proof(
            vec![],
            vec![AddressWithTree {
                address: *address,
                tree: address_merkle_tree_info.tree,
            }],
            None,
        )
        .await?
        .value;
    let packed_accounts = rpc_result.pack_tree_infos(&mut remaining_accounts);

    let output_tree_index = rpc
        .get_random_state_tree_info()
        .unwrap()
        .pack_output_tree_index(&mut remaining_accounts)
        .unwrap();

    let (remaining_accounts, _, _) = remaining_accounts.to_account_metas();

    let compute_ix = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let instruction = Instruction {
        program_id: poa_compressed::ID,
        accounts: [
            vec![AccountMeta::new(payer.pubkey(), true)],
            remaining_accounts,
        ]
        .concat(),
        data: {
            use anchor_lang::InstructionData;
            poa_compressed::instruction::IssueReceipt {
                proof: rpc_result.proof,
                address_tree_info: packed_accounts.address_trees[0],
                output_merkle_tree_index: output_tree_index,
                receipt_id,
                model_hash,
                input_hash,
                output_hash,
                parent_receipt_hash,
            }
            .data()
        },
    };

    rpc.create_and_send_transaction(&[compute_ix, instruction], &payer.pubkey(), &[payer])
        .await
}

async fn invalidate_receipt(
    rpc: &mut LightProgramTest,
    payer: &Keypair,
    compressed_account: CompressedAccount,
    receipt: &ComputeReceipt,
) -> Result<Signature, RpcError> {
    let mut remaining_accounts = PackedAccounts::default();
    let config = SystemAccountMetaConfig::new(poa_compressed::ID);
    remaining_accounts.add_system_accounts(config);

    let hash = compressed_account.hash;

    let rpc_result = rpc
        .get_validity_proof(vec![hash], vec![], None)
        .await?
        .value;

    let packed_tree_accounts = rpc_result
        .pack_tree_infos(&mut remaining_accounts)
        .state_trees
        .unwrap();

    let (remaining_accounts, _, _) = remaining_accounts.to_account_metas();

    let compute_ix = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let instruction = Instruction {
        program_id: poa_compressed::ID,
        accounts: [
            vec![AccountMeta::new(payer.pubkey(), true)],
            remaining_accounts,
        ]
        .concat(),
        data: {
            use anchor_lang::InstructionData;
            poa_compressed::instruction::InvalidateReceipt {
                proof: rpc_result.proof,
                account_meta: CompressedAccountMeta {
                    tree_info: packed_tree_accounts.packed_tree_infos[0],
                    address: compressed_account.address.unwrap(),
                    output_state_tree_index: packed_tree_accounts.output_tree_index,
                },
                receipt_id: receipt.receipt_id,
                model_hash: receipt.model_hash,
                input_hash: receipt.input_hash,
                output_hash: receipt.output_hash,
                parent_receipt_hash: receipt.parent_receipt_hash,
                slot: receipt.slot,
                receipt_hash: receipt.receipt_hash,
            }
            .data()
        },
    };

    rpc.create_and_send_transaction(&[compute_ix, instruction], &payer.pubkey(), &[payer])
        .await
}

async fn close_receipt(
    rpc: &mut LightProgramTest,
    payer: &Keypair,
    compressed_account: CompressedAccount,
    receipt: &ComputeReceipt,
) -> Result<Signature, RpcError> {
    let mut remaining_accounts = PackedAccounts::default();
    let config = SystemAccountMetaConfig::new(poa_compressed::ID);
    remaining_accounts.add_system_accounts(config);

    let hash = compressed_account.hash;

    let rpc_result = rpc
        .get_validity_proof(vec![hash], vec![], None)
        .await?
        .value;

    let packed_tree_accounts = rpc_result
        .pack_tree_infos(&mut remaining_accounts)
        .state_trees
        .unwrap();

    let (remaining_accounts, _, _) = remaining_accounts.to_account_metas();

    let compute_ix = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);

    let instruction = Instruction {
        program_id: poa_compressed::ID,
        accounts: [
            vec![AccountMeta::new(payer.pubkey(), true)],
            remaining_accounts,
        ]
        .concat(),
        data: {
            use anchor_lang::InstructionData;
            poa_compressed::instruction::CloseReceipt {
                proof: rpc_result.proof,
                account_meta: CompressedAccountMeta {
                    tree_info: packed_tree_accounts.packed_tree_infos[0],
                    address: compressed_account.address.unwrap(),
                    output_state_tree_index: packed_tree_accounts.output_tree_index,
                },
                receipt_id: receipt.receipt_id,
                model_hash: receipt.model_hash,
                input_hash: receipt.input_hash,
                output_hash: receipt.output_hash,
                parent_receipt_hash: receipt.parent_receipt_hash,
                slot: receipt.slot,
                receipt_hash: receipt.receipt_hash,
                is_valid: receipt.is_valid,
            }
            .data()
        },
    };

    rpc.create_and_send_transaction(&[compute_ix, instruction], &payer.pubkey(), &[payer])
        .await
}

async fn get_compressed_account(
    rpc: &mut LightProgramTest,
    address: [u8; 32],
) -> CompressedAccount {
    rpc.get_compressed_account(address, None)
        .await
        .unwrap()
        .value
}

async fn get_receipt(
    rpc: &mut LightProgramTest,
    address: [u8; 32],
) -> ComputeReceipt {
    let account = get_compressed_account(rpc, address).await;
    let data = &account.data.as_ref().unwrap().data;
    ComputeReceipt::deserialize(&mut &data[..]).unwrap()
}
