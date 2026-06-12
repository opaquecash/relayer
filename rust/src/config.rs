//! Node configuration: RPC endpoints, registry addresses, operator keys, and the
//! GossipSub topic. Addresses default to the testnet deployments and can be
//! overridden via CLI flags / env.

#![allow(dead_code)] // reference crypto/wire/config surface: parts exercised by tests + the TS SDK port
use anyhow::{Context, Result};
use std::path::PathBuf;

/// GossipSub topic for the market (spec/relayer-market.md §3).
pub const TOPIC: &str = "opaque/jobs/v1";

/// Testnet `RelayerRegistry` on Ethereum Sepolia.
pub const SEPOLIA_RELAYER_REGISTRY: &str = "0x5fA252e2D22058a4ec3420573a3B3A5dca025837";
/// Testnet `relayer-registry` program on Solana devnet.
pub const DEVNET_RELAYER_REGISTRY: &str = "E4xmYaAU31dbNTbhfMfp2F24b48DAxJigvZTVbsKJREg";

#[derive(Clone)]
pub struct Config {
    pub eth_rpc: String,
    pub sol_rpc: String,
    pub eth_registry: String,
    pub sol_registry: String,
    /// EVM operator private key (0x… 32 bytes) for accept/submit on Ethereum.
    pub eth_key: Option<String>,
    /// Solana operator keypair path (JSON byte array) for accept/submit on Solana.
    pub sol_keypair: Option<PathBuf>,
    /// Minimum fee (base units) below which jobs are ignored.
    pub min_fee: u128,
    /// HTTP gateway bind address.
    pub gateway_addr: String,
    /// libp2p listen multiaddr.
    pub listen: String,
    /// Optional dial targets (other nodes' multiaddrs).
    pub peers: Vec<String>,
}

/// Read a Solana keypair JSON file (`[u8; 64]`) into raw bytes.
pub fn read_solana_keypair(path: &PathBuf) -> Result<[u8; 64]> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("reading solana keypair {}", path.display()))?;
    let bytes: Vec<u8> = serde_json::from_str(&raw)?;
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("solana keypair must be 64 bytes"))
}
