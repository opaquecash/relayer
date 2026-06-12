//! opaque-relayer: a permissionless node for the Opaque gas-private submission market
//! (spec/relayer-market.md). It joins the GossipSub mesh, serves an HTTP intake
//! gateway, bids on jobs it can fulfil, and on receiving the encrypted payload runs
//! accept-then-submit on the matching chain.

// solana-client's ClientError is large by design; it propagates through our Results.
#![allow(clippy::result_large_err)]

mod config;
mod crypto;
mod gateway;
mod job;
mod market;
mod p2p;
mod submitter;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use clap::{Parser, Subcommand};
use tokio::sync::mpsc;

use config::{DEVNET_RELAYER_REGISTRY, SEPOLIA_RELAYER_REGISTRY};
use crypto::BoxIdentity;
use submitter::{ethereum::EthereumSubmitter, solana::SolanaSubmitter, Submitter};

#[derive(Parser)]
#[command(name = "opaque-relayer", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,

    #[arg(long, env = "ETH_RPC", default_value = "https://ethereum-sepolia-rpc.publicnode.com")]
    eth_rpc: String,
    #[arg(long, env = "SOL_RPC", default_value = "https://api.devnet.solana.com")]
    sol_rpc: String,
    #[arg(long, env = "ETH_REGISTRY", default_value = SEPOLIA_RELAYER_REGISTRY)]
    eth_registry: String,
    #[arg(long, env = "SOL_REGISTRY", default_value = DEVNET_RELAYER_REGISTRY)]
    sol_registry: String,
    /// EVM operator private key (0x…). Enables the Ethereum chain.
    #[arg(long, env = "ETH_KEY")]
    eth_key: Option<String>,
    /// Solana operator keypair path. Enables the Solana chain.
    #[arg(long, env = "SOL_KEYPAIR")]
    sol_keypair: Option<std::path::PathBuf>,
}

#[derive(Subcommand)]
enum Command {
    /// Register (or top up) this operator's stake on the given chain(s).
    Register {
        /// Stake amount in base units (wei / lamports).
        #[arg(long)]
        stake: u128,
        /// Gateway endpoint to advertise (optional).
        #[arg(long, default_value = "")]
        endpoint: String,
    },
    /// Run the node: join the mesh, serve the gateway, bid and submit.
    Start {
        #[arg(long, default_value_t = 0.0)]
        min_fee_eth: f64,
        #[arg(long, default_value = "/ip4/0.0.0.0/tcp/0")]
        listen: String,
        #[arg(long, default_value = "127.0.0.1:8787")]
        gateway: String,
        /// Other nodes' multiaddrs to dial.
        #[arg(long)]
        peer: Vec<String>,
    },
}

fn build_submitters(cli: &Cli) -> Result<Vec<Box<dyn Submitter>>> {
    let mut subs: Vec<Box<dyn Submitter>> = Vec::new();
    if let Some(key) = &cli.eth_key {
        subs.push(Box::new(EthereumSubmitter::new(&cli.eth_rpc, &cli.eth_registry, key)?));
    }
    if let Some(path) = &cli.sol_keypair {
        let bytes = config::read_solana_keypair(path)?;
        subs.push(Box::new(SolanaSubmitter::new(&cli.sol_rpc, &cli.sol_registry, &bytes)?));
    }
    if subs.is_empty() {
        return Err(anyhow!("provide --eth-key and/or --sol-keypair"));
    }
    Ok(subs)
}

/// Derive the node's box identity from the first available operator key, so the
/// advertised x25519 key is stable and matches what is registered on-chain.
fn box_identity(cli: &Cli) -> Result<BoxIdentity> {
    if let Some(key) = &cli.eth_key {
        let bytes: [u8; 32] = hex::decode(key.trim_start_matches("0x"))?
            .try_into()
            .map_err(|_| anyhow!("eth key must be 32 bytes"))?;
        return Ok(BoxIdentity::from_seed(&bytes));
    }
    if let Some(path) = &cli.sol_keypair {
        let kp = config::read_solana_keypair(path)?;
        return Ok(BoxIdentity::from_seed(&kp[..32]));
    }
    Err(anyhow!("provide --eth-key and/or --sol-keypair"))
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "opaque_relayer=info".into()),
        )
        .init();

    let cli = Cli::parse();
    let submitters = build_submitters(&cli)?;
    let box_id = Arc::new(box_identity(&cli)?);

    match &cli.command {
        Command::Register { stake, endpoint } => {
            for s in &submitters {
                let tx = s.register(&box_id.public, endpoint, *stake).await?;
                println!(
                    "registered on chain {} (box {}): {tx}",
                    s.chain(),
                    hex::encode(box_id.public)
                );
            }
        }
        Command::Start { min_fee_eth, listen, gateway, peer } => {
            let min_fee = (*min_fee_eth * 1e18) as u128;
            let bids = Arc::new(Mutex::new(HashMap::new()));
            let (inbound_tx, mut inbound_rx) = mpsc::channel::<Vec<u8>>(256);

            let p2p = p2p::start(listen, peer, inbound_tx.clone()).await?;
            let node = Arc::new(market::Node::new(
                submitters,
                box_id.clone(),
                min_fee,
                p2p.outbound.clone(),
                bids.clone(),
            ));

            let app = gateway::router(gateway::GatewayState {
                gossip: p2p.outbound.clone(),
                local: inbound_tx.clone(),
                bids: bids.clone(),
            });
            let addr: std::net::SocketAddr = gateway.parse()?;
            tokio::spawn(async move {
                let listener = tokio::net::TcpListener::bind(addr).await.expect("bind gateway");
                tracing::info!("gateway on http://{addr}");
                axum::serve(listener, app).await.ok();
            });

            tracing::info!(
                "opaque-relayer up; box {} serving {} chain(s)",
                hex::encode(box_id.public),
                node.submitters.len()
            );

            let worker = node.clone();
            tokio::spawn(async move {
                while let Some(bytes) = inbound_rx.recv().await {
                    worker.handle(&bytes).await;
                }
            });

            tokio::signal::ctrl_c().await?;
            tracing::info!("shutting down");
        }
    }
    Ok(())
}
