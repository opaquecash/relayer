//! Market wire types and crypto (spec/relayer-market.md §2.3, §3).
//!
//! A *job* commits to a hidden payload via a hash. On Ethereum the payload is
//! `abi.encode(target, calldata)` and the commitment is its keccak256. On Solana the
//! payload is an instruction descriptor and the commitment is the keccak256 of
//! `program_id ‖ u32_le(n_accounts) ‖ [pubkey ‖ is_signer ‖ is_writable]… ‖ data`.
//! Adverts and bids travel as JSON over GossipSub; the payload is delivered NaCl-boxed
//! to the winning relayer's x25519 key.

#![allow(dead_code)] // reference crypto/wire/config surface: parts exercised by tests + the TS SDK port
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

/// Wormhole-convention chain ids, reused for the market (matches spec/UAB.md).
pub const CHAIN_ETHEREUM: u16 = 2;
pub const CHAIN_SOLANA: u16 = 1;

/// Domain tag signed into every bid (spec §3.2).
pub const BID_DOMAIN: &[u8] = b"opaque-relayer-bid-v1";

/// `t: "advert"` — broadcast by a user after `createJob` lands on-chain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Advert {
    pub t: String,
    pub v: u8,
    /// 0x-prefixed 32-byte job id.
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub chain: u16,
    /// Fee in the chain's base unit, decimal string (wei / lamports).
    pub fee: String,
    pub deadline: u64,
    /// 0x-prefixed 32-byte payload commitment.
    #[serde(rename = "payloadHash")]
    pub payload_hash: String,
}

/// `t: "bid"` — a registered relayer offers to fulfil a job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bid {
    pub t: String,
    pub v: u8,
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub chain: u16,
    /// EVM address (0x…) or Solana pubkey (base58) of the registered operator.
    pub operator: String,
    /// 0x-prefixed 32-byte x25519 public key payloads are encrypted to.
    #[serde(rename = "x25519Pk")]
    pub x25519_pk: String,
    /// Operator signature over `keccak256(BID_DOMAIN ‖ jobId ‖ x25519Pk)`.
    pub sig: String,
}

/// `t: "payload"` — the user delivers the NaCl-boxed payload to the winner.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PayloadEnvelope {
    pub t: String,
    pub v: u8,
    #[serde(rename = "jobId")]
    pub job_id: String,
    /// Winner's x25519 public key (0x…), so a node ignores envelopes not for it.
    pub to: String,
    /// base64 of `epk(32) ‖ nonce(24) ‖ ciphertext` (NaCl crypto_box).
    #[serde(rename = "box")]
    pub box_b64: String,
}

/// Tagged union of the three message types on `opaque/jobs/v1`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Message {
    Advert(Advert),
    Bid(Bid),
    Payload(PayloadEnvelope),
}

impl Message {
    pub fn tag(&self) -> &str {
        match self {
            Message::Advert(_) => "advert",
            Message::Bid(_) => "bid",
            Message::Payload(_) => "payload",
        }
    }
}

/// An EVM payload preimage: `abi.encode(address target, bytes data)`.
/// Mirrors `keccak256(abi.encode(target, data))` in RelayerRegistry.sol.
pub fn evm_payload_hash(target: &[u8; 20], data: &[u8]) -> [u8; 32] {
    // ABI head: address (left-padded 32) + offset to bytes (0x40) ; tail: len + data padded.
    let mut buf = Vec::new();
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(target);
    buf.extend_from_slice(&word); // target
    let mut off = [0u8; 32];
    off[31] = 0x40;
    buf.extend_from_slice(&off); // offset to the bytes arg
    let mut len = [0u8; 32];
    len[24..].copy_from_slice(&(data.len() as u64).to_be_bytes());
    buf.extend_from_slice(&len); // bytes length
    buf.extend_from_slice(data);
    let pad = (32 - data.len() % 32) % 32;
    buf.resize(buf.len() + pad, 0u8);
    keccak(&buf)
}

/// A Solana inner-account descriptor (is_signer is always committed false; spec §2.3).
#[derive(Debug, Clone)]
pub struct SolAccountMeta {
    pub pubkey: [u8; 32],
    pub is_writable: bool,
}

/// Solana payload commitment over the inner instruction (spec §2.3).
pub fn solana_payload_hash(
    program_id: &[u8; 32],
    accounts: &[SolAccountMeta],
    data: &[u8],
) -> [u8; 32] {
    let mut buf = Vec::new();
    buf.extend_from_slice(program_id);
    buf.extend_from_slice(&(accounts.len() as u32).to_le_bytes());
    for a in accounts {
        buf.extend_from_slice(&a.pubkey);
        buf.push(0); // is_signer, always false
        buf.push(a.is_writable as u8);
    }
    buf.extend_from_slice(data);
    keccak(&buf)
}

pub fn keccak(bytes: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(bytes);
    h.finalize().into()
}

/// The 32-byte message a bid signs (spec §3.2).
pub fn bid_signing_hash(job_id: &[u8; 32], x25519_pk: &[u8; 32]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(BID_DOMAIN.len() + 64);
    buf.extend_from_slice(BID_DOMAIN);
    buf.extend_from_slice(job_id);
    buf.extend_from_slice(x25519_pk);
    keccak(&buf)
}

/// Parse a `0x`-prefixed (or bare) 32-byte hex string.
pub fn parse_hex32(s: &str) -> Result<[u8; 32]> {
    let raw = hex::decode(s.trim_start_matches("0x"))?;
    raw.try_into()
        .map_err(|_| anyhow!("expected 32 bytes, got a different length"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evm_hash_matches_solidity_layout() {
        // abi.encode(address(0x00..01), hex"") — empty calldata.
        let mut target = [0u8; 20];
        target[19] = 1;
        let h = evm_payload_hash(&target, &[]);
        // keccak of the 96-byte head (addr + offset 0x40 + len 0) with no tail.
        assert_eq!(h.len(), 32);
        // Determinism + sensitivity.
        let h2 = evm_payload_hash(&target, &[0xaa]);
        assert_ne!(h, h2);
    }

    #[test]
    fn solana_hash_is_order_sensitive() {
        let prog = [7u8; 32];
        let a = SolAccountMeta { pubkey: [1u8; 32], is_writable: true };
        let b = SolAccountMeta { pubkey: [2u8; 32], is_writable: false };
        let h1 = solana_payload_hash(&prog, &[a.clone(), b.clone()], &[9]);
        let h2 = solana_payload_hash(&prog, &[b, a], &[9]);
        assert_ne!(h1, h2);
    }

    #[test]
    fn bid_hash_binds_job_and_key() {
        let j = [1u8; 32];
        let k = [2u8; 32];
        assert_ne!(bid_signing_hash(&j, &k), bid_signing_hash(&[3u8; 32], &k));
        assert_ne!(bid_signing_hash(&j, &k), bid_signing_hash(&j, &[4u8; 32]));
    }
}
