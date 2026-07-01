//! Solana submitter (solana-sdk): reads the job, accepts (bonds), and submits the
//! revealed inner instruction to `relayer-registry`.
//!
//! The NaCl-box plaintext is a self-describing instruction descriptor:
//! `program_id(32) ‖ u32_le(n) ‖ [pubkey(32) ‖ is_writable(1)]×n ‖ u32_le(len) ‖ data`.
//! (is_signer is always false — committed as such in the hash, spec §2.3.)

use anyhow::{anyhow, Result};
use base64::Engine as _;
use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    hash::hash as sha256,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer as _},
    transaction::Transaction,
};
use std::str::FromStr;
use std::sync::Arc;

use super::{OnchainJob, Submitter, SweepRequest};
use crate::job::{solana_payload_hash, SolAccountMeta, CHAIN_SOLANA};

/// Programs a gasless sweep is allowed to touch, so co-signing as fee payer can only ever
/// pay for a bounded set of token moves — never an arbitrary (expensive) transaction.
const SWEEP_ALLOWED_PROGRAMS: [&str; 4] = [
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // SPL Token-2022
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Account
    "ComputeBudget111111111111111111111111111111", // Compute budget (fee/limit hints)
];

/// Anchor global instruction discriminator: `sha256("global:<name>")[..8]`.
fn disc(name: &str) -> [u8; 8] {
    let h = sha256(format!("global:{name}").as_bytes());
    h.to_bytes()[..8].try_into().unwrap()
}

pub struct SolanaSubmitter {
    program: Pubkey,
    keypair: Arc<Keypair>,
    rpc: String,
}

impl SolanaSubmitter {
    pub fn new(rpc: &str, program: &str, keypair_bytes: &[u8; 64]) -> Result<Self> {
        Ok(Self {
            program: Pubkey::from_str(program)?,
            keypair: Arc::new(Keypair::try_from(&keypair_bytes[..]).map_err(|e| anyhow!("{e}"))?),
            rpc: rpc.to_string(),
        })
    }

    fn client(&self) -> RpcClient {
        RpcClient::new_with_commitment(self.rpc.clone(), CommitmentConfig::confirmed())
    }

    fn relayer_pda(&self) -> Pubkey {
        Pubkey::find_program_address(&[b"relayer", self.keypair.pubkey().as_ref()], &self.program).0
    }

    fn job_pda(&self, job_id: &[u8; 32]) -> Pubkey {
        Pubkey::find_program_address(&[b"job", job_id], &self.program).0
    }
}

/// Parse the box plaintext into an inner `Instruction` and its hash-preimage metas.
fn decode_descriptor(payload: &[u8]) -> Result<(Instruction, Vec<SolAccountMeta>)> {
    if payload.len() < 36 {
        return Err(anyhow!("descriptor too short"));
    }
    let program = Pubkey::new_from_array(payload[..32].try_into().unwrap());
    let n = u32::from_le_bytes(payload[32..36].try_into().unwrap()) as usize;
    let mut off = 36;
    let mut metas = Vec::with_capacity(n);
    let mut hash_metas = Vec::with_capacity(n);
    for _ in 0..n {
        if payload.len() < off + 33 {
            return Err(anyhow!("descriptor truncated in accounts"));
        }
        let pubkey: [u8; 32] = payload[off..off + 32].try_into().unwrap();
        let is_writable = payload[off + 32] != 0;
        off += 33;
        metas.push(if is_writable {
            AccountMeta::new(Pubkey::new_from_array(pubkey), false)
        } else {
            AccountMeta::new_readonly(Pubkey::new_from_array(pubkey), false)
        });
        hash_metas.push(SolAccountMeta { pubkey, is_writable });
    }
    if payload.len() < off + 4 {
        return Err(anyhow!("descriptor missing data length"));
    }
    let len = u32::from_le_bytes(payload[off..off + 4].try_into().unwrap()) as usize;
    off += 4;
    if payload.len() != off + len {
        return Err(anyhow!("descriptor data length mismatch"));
    }
    let data = payload[off..].to_vec();
    Ok((
        Instruction { program_id: program, accounts: metas, data },
        hash_metas,
    ))
}

#[async_trait::async_trait]
impl Submitter for SolanaSubmitter {
    fn chain(&self) -> u16 {
        CHAIN_SOLANA
    }

    fn operator(&self) -> String {
        self.keypair.pubkey().to_string()
    }

    async fn free_stake(&self) -> Result<Option<u128>> {
        let pda = self.relayer_pda();
        let rpc = self.client();
        let data = tokio::task::spawn_blocking(move || rpc.get_account_data(&pda)).await??;
        // 8 disc + 32 operator + 8 stake + 8 bonded ...
        if data.len() < 56 {
            return Ok(None);
        }
        let stake = u64::from_le_bytes(data[40..48].try_into().unwrap());
        let bonded = u64::from_le_bytes(data[48..56].try_into().unwrap());
        Ok(Some((stake - bonded) as u128))
    }

    fn sign_bid(&self, hash: &[u8; 32]) -> Result<String> {
        let sig = self.keypair.sign_message(hash);
        Ok(bs58::encode(sig.as_ref()).into_string())
    }

    async fn register(&self, x25519: &[u8; 32], endpoint: &str, stake: u128) -> Result<String> {
        let operator = self.keypair.pubkey();
        let relayer_pda = self.relayer_pda();
        let program = self.program;
        // register(x25519: [u8;32], endpoint: String, stake_lamports: u64)
        let mut data = disc("register").to_vec();
        data.extend_from_slice(x25519);
        let ep = endpoint.as_bytes();
        data.extend_from_slice(&(ep.len() as u32).to_le_bytes());
        data.extend_from_slice(ep);
        data.extend_from_slice(&(stake as u64).to_le_bytes());
        let ix = Instruction {
            program_id: program,
            accounts: vec![
                AccountMeta::new(relayer_pda, false),
                AccountMeta::new(operator, true),
                AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
            ],
            data,
        };
        let keypair = self.keypair.clone();
        let rpc = self.client();
        let sig = tokio::task::spawn_blocking(move || -> Result<String> {
            let bh = rpc.get_latest_blockhash()?;
            let tx =
                Transaction::new_signed_with_payer(&[ix], Some(&operator), &[&*keypair], bh);
            Ok(rpc.send_and_confirm_transaction(&tx)?.to_string())
        })
        .await??;
        Ok(sig)
    }

    async fn fetch_job(&self, job_id: &[u8; 32]) -> Result<OnchainJob> {
        let pda = self.job_pda(job_id);
        let rpc = self.client();
        let maybe = tokio::task::spawn_blocking(move || rpc.get_account(&pda)).await?;
        let account = match maybe {
            Ok(a) => a,
            Err(_) => {
                return Ok(OnchainJob {
                    exists: false,
                    accepted: false,
                    closed: false,
                    fee: 0,
                    deadline: 0,
                    payload_hash: [0u8; 32],
                })
            }
        };
        let d = &account.data;
        // 8 disc, job_id[32]@8, creator[32]@40, relayer[32]@72, fee u64@104,
        // payload_hash[32]@112, deadline i64@144, submitted@152, closed@153.
        let relayer = Pubkey::new_from_array(d[72..104].try_into().unwrap());
        Ok(OnchainJob {
            exists: true,
            accepted: relayer != Pubkey::default(),
            closed: d[153] != 0,
            fee: u64::from_le_bytes(d[104..112].try_into().unwrap()) as u128,
            deadline: i64::from_le_bytes(d[144..152].try_into().unwrap()) as u64,
            payload_hash: d[112..144].try_into().unwrap(),
        })
    }

    async fn accept_and_submit(&self, job_id: &[u8; 32], payload: &[u8]) -> Result<String> {
        let (inner, hash_metas) = decode_descriptor(payload)?;
        // Verify the descriptor matches the on-chain commitment before bonding.
        let local_hash =
            solana_payload_hash(&inner.program_id.to_bytes(), &hash_metas, &inner.data);
        let onchain = self.fetch_job(job_id).await?;
        if local_hash != onchain.payload_hash {
            return Err(anyhow!("decoded payload does not match the job commitment"));
        }

        let job_pda = self.job_pda(job_id);
        let relayer_pda = self.relayer_pda();
        let operator = self.keypair.pubkey();
        let program = self.program;
        let job = *job_id;

        let accept_ix = Instruction {
            program_id: program,
            accounts: vec![
                AccountMeta::new(job_pda, false),
                AccountMeta::new(relayer_pda, false),
                AccountMeta::new_readonly(operator, true),
            ],
            data: [disc("accept_job").as_slice(), &job].concat(),
        };

        // submit_job(job_id, Vec<u8> data); remaining accounts = inner accounts + inner program.
        let mut submit_accounts = vec![
            AccountMeta::new(job_pda, false),
            AccountMeta::new(relayer_pda, false),
            AccountMeta::new(operator, true),
        ];
        submit_accounts.extend(inner.accounts.iter().cloned());
        submit_accounts.push(AccountMeta::new_readonly(inner.program_id, false));
        let mut submit_data = disc("submit_job").to_vec();
        submit_data.extend_from_slice(&job);
        submit_data.extend_from_slice(&(inner.data.len() as u32).to_le_bytes());
        submit_data.extend_from_slice(&inner.data);
        let submit_ix = Instruction { program_id: program, accounts: submit_accounts, data: submit_data };

        let keypair = self.keypair.clone();
        let rpc = self.client();
        let sig = tokio::task::spawn_blocking(move || -> Result<String> {
            let bh = rpc.get_latest_blockhash()?;
            let accept_tx =
                Transaction::new_signed_with_payer(&[accept_ix], Some(&operator), &[&*keypair], bh);
            rpc.send_and_confirm_transaction(&accept_tx)?;
            let bh2 = rpc.get_latest_blockhash()?;
            let submit_tx =
                Transaction::new_signed_with_payer(&[submit_ix], Some(&operator), &[&*keypair], bh2);
            Ok(rpc.send_and_confirm_transaction(&submit_tx)?.to_string())
        })
        .await??;
        Ok(sig)
    }

    async fn submit_sweep(&self, req: &SweepRequest) -> Result<String> {
        let b64 = match req {
            SweepRequest::Solana { transaction_base64 } => transaction_base64,
            _ => return Err(anyhow!("solana submitter received a non-solana sweep")),
        };
        let raw = base64::engine::general_purpose::STANDARD.decode(b64.trim())?;
        let mut tx: Transaction =
            bincode::deserialize(&raw).map_err(|e| anyhow!("not a solana transaction: {e}"))?;

        // The relayer must be the fee payer (account_keys[0]); otherwise co-signing is pointless.
        let me = self.keypair.pubkey();
        let fee_payer = *tx
            .message
            .account_keys
            .first()
            .ok_or_else(|| anyhow!("sweep transaction has no accounts"))?;
        if fee_payer != me {
            return Err(anyhow!("relayer {me} is not the fee payer of this sweep"));
        }

        // Bound our gas exposure: a sweep may only touch known token programs, never an
        // arbitrary program that could run up compute the relayer pays for.
        let allowed: Vec<Pubkey> = SWEEP_ALLOWED_PROGRAMS
            .iter()
            .map(|p| Pubkey::from_str(p).unwrap())
            .collect();
        for ix in &tx.message.instructions {
            let pid = *tx
                .message
                .account_keys
                .get(ix.program_id_index as usize)
                .ok_or_else(|| anyhow!("instruction references an out-of-range program"))?;
            if !allowed.contains(&pid) {
                return Err(anyhow!("sweep contains a disallowed program {pid}"));
            }
        }

        // Co-sign as fee payer over the SAME message the stealth key already signed (do not
        // touch the blockhash, or that signature would be invalidated) and broadcast.
        let keypair = self.keypair.clone();
        let rpc = self.client();
        let sig = tokio::task::spawn_blocking(move || -> Result<String> {
            let bh = tx.message.recent_blockhash;
            tx.try_partial_sign(&[&*keypair], bh)?;
            Ok(rpc.send_and_confirm_transaction(&tx)?.to_string())
        })
        .await??;
        Ok(sig)
    }
}
