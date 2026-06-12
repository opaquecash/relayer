//! Ethereum submitter (alloy): reads the job, accepts (bonds), and submits the
//! revealed `abi.encode(target, calldata)` payload to `RelayerRegistry`.

use alloy::network::EthereumWallet;
use alloy::primitives::{Address, Bytes, FixedBytes, U256};
use alloy::providers::ProviderBuilder;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use alloy::sol_types::SolValue;
use anyhow::{anyhow, Result};
use std::str::FromStr;

use super::{OnchainJob, Submitter};
use crate::job::CHAIN_ETHEREUM;

sol! {
    #[sol(rpc)]
    contract RelayerRegistry {
        struct Job {
            address creator;
            address relayer;
            uint96 fee;
            bytes32 payloadHash;
            uint64 deadline;
            bool submitted;
            bool closed;
        }
        function jobs(bytes32 jobId) external view returns (Job memory);
        function freeStakeOf(address relayer) external view returns (uint256);
        function register(bytes32 x25519PubKey, string endpoint) external payable;
        function acceptJob(bytes32 jobId) external;
        function submitJob(bytes32 jobId, address target, bytes calldata data) external;
    }
}

pub struct EthereumSubmitter {
    registry: Address,
    signer: PrivateKeySigner,
    key_bytes: [u8; 32],
    rpc: String,
}

impl EthereumSubmitter {
    pub fn new(rpc: &str, registry: &str, key_hex: &str) -> Result<Self> {
        let key_bytes: [u8; 32] = hex::decode(key_hex.trim_start_matches("0x"))?
            .try_into()
            .map_err(|_| anyhow!("eth key must be 32 bytes"))?;
        let signer = PrivateKeySigner::from_bytes(&key_bytes.into())?;
        Ok(Self {
            registry: Address::from_str(registry)?,
            signer,
            key_bytes,
            rpc: rpc.to_string(),
        })
    }

}

/// Build the wallet-filled HTTP provider + contract instance. A macro (not a fn) so
/// the concrete `FillProvider<…, Http<Client>, Ethereum>` type stays inferred and the
/// `sol!`-generated methods resolve their `Provider` bound.
macro_rules! contract {
    ($self:expr) => {{
        let provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from($self.signer.clone()))
            .on_http($self.rpc.parse().expect("valid eth rpc url"));
        RelayerRegistry::new($self.registry, provider)
    }};
}

#[async_trait::async_trait]
impl Submitter for EthereumSubmitter {
    fn chain(&self) -> u16 {
        CHAIN_ETHEREUM
    }

    fn operator(&self) -> String {
        format!("{:?}", self.signer.address())
    }

    async fn free_stake(&self) -> Result<Option<u128>> {
        let c = contract!(self);
        let free = c.freeStakeOf(self.signer.address()).call().await?._0;
        Ok(Some(u128::try_from(free).unwrap_or(u128::MAX)))
    }

    fn sign_bid(&self, hash: &[u8; 32]) -> Result<String> {
        let signed = crate::crypto::evm_sign_prehash(&self.key_bytes, hash)?;
        Ok(format!("0x{}", hex::encode(signed)))
    }

    async fn register(&self, x25519: &[u8; 32], endpoint: &str, stake: u128) -> Result<String> {
        let c = contract!(self);
        let receipt = c
            .register(FixedBytes::from(*x25519), endpoint.to_string())
            .value(U256::from(stake))
            .send()
            .await?
            .get_receipt()
            .await?;
        Ok(format!("{:?}", receipt.transaction_hash))
    }

    async fn fetch_job(&self, job_id: &[u8; 32]) -> Result<OnchainJob> {
        let c = contract!(self);
        let j = c.jobs(FixedBytes::from(*job_id)).call().await?._0;
        Ok(OnchainJob {
            exists: j.creator != Address::ZERO,
            accepted: j.relayer != Address::ZERO,
            closed: j.closed,
            fee: u128::try_from(U256::from(j.fee)).unwrap_or(u128::MAX),
            deadline: j.deadline,
            payload_hash: j.payloadHash.0,
        })
    }

    async fn accept_and_submit(&self, job_id: &[u8; 32], payload: &[u8]) -> Result<String> {
        // The box plaintext is abi.encode(address target, bytes data).
        let (target, data) = <(Address, Bytes)>::abi_decode_params(payload, true)
            .map_err(|e| anyhow!("payload is not abi.encode(address,bytes): {e}"))?;
        let c = contract!(self);
        let id = FixedBytes::from(*job_id);

        c.acceptJob(id).send().await?.watch().await?;
        let receipt = c.submitJob(id, target, data).send().await?.get_receipt().await?;
        Ok(format!("{:?}", receipt.transaction_hash))
    }
}
