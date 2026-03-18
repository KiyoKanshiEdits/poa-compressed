use anchor_lang::prelude::*;
use light_sdk::{
    account::LightAccount,
    address::v1::derive_address,
    cpi::{CpiAccounts, CpiInputs, CpiSigner},
    derive_light_cpi_signer,
    instruction::{account_meta::CompressedAccountMeta, PackedAddressTreeInfo, ValidityProof},
    LightDiscriminator, LightHasher,
};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

pub const LIGHT_CPI_SIGNER: CpiSigner =
    derive_light_cpi_signer!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod poa_compressed {
    use super::*;

    pub fn issue_receipt<'info>(
        ctx: Context<'_, '_, '_, 'info, GenericAnchorAccounts<'info>>,
        proof: ValidityProof,
        address_tree_info: PackedAddressTreeInfo,
        output_merkle_tree_index: u8,
        receipt_id: [u8; 16],
        model_hash: [u8; 32],
        input_hash: [u8; 32],
        output_hash: [u8; 32],
        parent_receipt_hash: [u8; 32],
    ) -> Result<()> {
        let light_cpi_accounts = CpiAccounts::new(
            ctx.accounts.signer.as_ref(),
            ctx.remaining_accounts,
            crate::LIGHT_CPI_SIGNER,
        );
        let (address, address_seed) = derive_address(
            &[b"receipt", ctx.accounts.signer.key().as_ref(), &receipt_id],
            &address_tree_info
                .get_tree_pubkey(&light_cpi_accounts)
                .map_err(|_| ErrorCode::AccountNotEnoughKeys)?,
            &crate::ID,
        );
        let new_address_params = address_tree_info.into_new_address_params_packed(address_seed);
        let agent = ctx.accounts.signer.key();
        let slot = Clock::get()?.slot;
        let mut data = Vec::with_capacity(184);
        data.extend_from_slice(agent.as_ref());
        data.extend_from_slice(&receipt_id);
        data.extend_from_slice(&model_hash);
        data.extend_from_slice(&input_hash);
        data.extend_from_slice(&output_hash);
        data.extend_from_slice(&parent_receipt_hash);
        data.extend_from_slice(&slot.to_le_bytes());
        let receipt_hash = solana_program::hash::hash(&data).to_bytes();
        let program_id = crate::ID.into();
        let mut receipt = LightAccount::<\'_, ComputeReceipt>::new_init(
            &program_id,
            Some(address),
            output_merkle_tree_index,
        );
        receipt.agent = agent;
        receipt.receipt_id = receipt_id;
        receipt.model_hash = model_hash;
        receipt.input_hash = input_hash;
        receipt.output_hash = output_hash;
        receipt.parent_receipt_hash = parent_receipt_hash;
        receipt.slot = slot;
        receipt.receipt_hash = receipt_hash;
        receipt.is_valid = true;
        let cpi = CpiInputs::new_with_address(
            proof,
            vec![receipt.to_account_info().map_err(ProgramError::from)?],
            vec![new_address_params],
        );
        cpi.invoke_light_system_program(light_cpi_accounts)
            .map_err(ProgramError::from)?;
        msg!("PoA: Compressed receipt issued by {} at slot {}", agent, slot);
        Ok(())
    }

    pub fn invalidate_receipt<'info>(
        ctx: Context<'_, '_, '_, 'info, GenericAnchorAccounts<'info>>,
        proof: ValidityProof,
        account_meta: CompressedAccountMeta,
        receipt_id: [u8; 16],
        model_hash: [u8; 32],
        input_hash: [u8; 32],
        output_hash: [u8; 32],
        parent_receipt_hash: [u8; 32],
        slot: u64,
        receipt_hash: [u8; 32],
    ) -> Result<()> {
        let agent = ctx.accounts.signer.key();
        let mut receipt = LightAccount::<\'_, ComputeReceipt>::new_mut(
            &crate::ID,
            &account_meta,
            ComputeReceipt {
                agent,
                receipt_id,
                model_hash,
                input_hash,
                output_hash,
                parent_receipt_hash,
                slot,
                receipt_hash,
                is_valid: true,
            },
        )
        .map_err(ProgramError::from)?;
        require!(receipt.is_valid, PoaError::AlreadyInvalidated);
        receipt.is_valid = false;
        let light_cpi_accounts = CpiAccounts::new(
            ctx.accounts.signer.as_ref(),
            ctx.remaining_accounts,
            crate::LIGHT_CPI_SIGNER,
        );
        let cpi = CpiInputs::new(
            proof,
            vec![receipt.to_account_info().map_err(ProgramError::from)?],
        );
        cpi.invoke_light_system_program(light_cpi_accounts)
            .map_err(ProgramError::from)?;
        msg!("PoA: Compressed receipt invalidated by {}", agent);
        Ok(())
    }

    pub fn close_receipt<'info>(
        ctx: Context<'_, '_, '_, 'info, GenericAnchorAccounts<'info>>,
        proof: ValidityProof,
        account_meta: CompressedAccountMeta,
        receipt_id: [u8; 16],
        model_hash: [u8; 32],
        input_hash: [u8; 32],
        output_hash: [u8; 32],
        parent_receipt_hash: [u8; 32],
        slot: u64,
        receipt_hash: [u8; 32],
        is_valid: bool,
    ) -> Result<()> {
        let agent = ctx.accounts.signer.key();
        let receipt = LightAccount::<\'_, ComputeReceipt>::new_close(
            &crate::ID.into(),
            &account_meta,
            ComputeReceipt {
                agent,
                receipt_id,
                model_hash,
                input_hash,
                output_hash,
                parent_receipt_hash,
                slot,
                receipt_hash,
                is_valid,
            },
        )
        .map_err(ProgramError::from)?;
        let light_cpi_accounts = CpiAccounts::new(
            ctx.accounts.signer.as_ref(),
            ctx.remaining_accounts,
            crate::LIGHT_CPI_SIGNER,
        );
        let cpi = CpiInputs::new(
            proof,
            vec![receipt.to_account_info().map_err(ProgramError::from)?],
        );
        cpi.invoke_light_system_program(light_cpi_accounts)
            .map_err(ProgramError::from)?;
        msg!("PoA: Compressed receipt closed by {}", agent);
        Ok(())
    }
}

#[event]
#[derive(Clone, Debug, Default, LightDiscriminator, LightHasher)]
pub struct ComputeReceipt {
    #[hash]
    pub agent: Pubkey,
    pub receipt_id: [u8; 16],
    pub model_hash: [u8; 32],
    pub input_hash: [u8; 32],
    pub output_hash: [u8; 32],
    pub parent_receipt_hash: [u8; 32],
    pub slot: u64,
    pub receipt_hash: [u8; 32],
    pub is_valid: bool,
}

#[derive(Accounts)]
pub struct GenericAnchorAccounts<\'info> {
    #[account(mut)]
    pub signer: Signer<\'info>,
}

#[error_code]
pub enum PoaError {
    #[msg("Receipt has already been invalidated")]
    AlreadyInvalidated,
}
