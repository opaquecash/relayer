//! Chain submitters: each knows how to read a job, accept it (bond), and submit the
//! revealed payload on its chain. The node selects one by the advert's chain id.

pub mod ethereum;
pub mod solana;

use anyhow::Result;

/// On-chain view of a job, enough to decide whether to bid.
#[derive(Debug, Clone)]
pub struct OnchainJob {
    pub exists: bool,
    pub accepted: bool,
    pub closed: bool,
    pub fee: u128,
    pub deadline: u64,
    pub payload_hash: [u8; 32],
}

/// A chain backend the node can act on. Object-safe (via async-trait) so the node
/// holds a heterogeneous set of them behind `dyn`.
#[async_trait::async_trait]
pub trait Submitter: Send + Sync {
    /// Wormhole-convention chain id this submitter serves.
    fn chain(&self) -> u16;

    /// The operator identity string (EVM address / Solana pubkey) that bids advertise.
    fn operator(&self) -> String;

    /// Free (unbonded) stake in base units; `None` if not registered.
    async fn free_stake(&self) -> Result<Option<u128>>;

    /// Sign a bid hash with the operator key, returning the spec §3.2 encoding
    /// (EVM: `0x` + 65-byte r‖s‖v; Solana: base58 of the 64-byte ed25519 signature).
    fn sign_bid(&self, hash: &[u8; 32]) -> Result<String>;

    /// Register (or top up) this operator with the advertised x25519 key + endpoint,
    /// staking `stake` base units. Returns the tx id.
    async fn register(&self, x25519: &[u8; 32], endpoint: &str, stake: u128) -> Result<String>;

    /// Read a job's on-chain state.
    async fn fetch_job(&self, job_id: &[u8; 32]) -> Result<OnchainJob>;

    /// Accept a job (bond the fee), then submit the revealed payload. Returns the
    /// submit transaction id. The payload is the NaCl-box plaintext: for EVM,
    /// `abi.encode(target, calldata)`; for Solana, the instruction descriptor.
    async fn accept_and_submit(&self, job_id: &[u8; 32], payload: &[u8]) -> Result<String>;
}
