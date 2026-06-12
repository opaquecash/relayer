//! Operator-key crypto: derive the bid x25519 identity, sign/verify bids, and open
//! NaCl boxes addressed to this node (spec/relayer-market.md §3.2, §3.3).

#![allow(dead_code)] // reference crypto/wire/config surface: parts exercised by tests + the TS SDK port
use anyhow::{anyhow, Result};
use crypto_box::{
    aead::{Aead, AeadCore},
    PublicKey as BoxPublicKey, SalsaBox, SecretKey as BoxSecretKey,
};
use k256::ecdsa::{RecoveryId, Signature as EcdsaSignature, SigningKey, VerifyingKey};
use sha3::{Digest, Keccak256};

use crate::job::bid_signing_hash;

/// This node's encryption identity: an x25519 keypair derived deterministically from a
/// seed (the operator key), so the advertised public key is stable across restarts.
pub struct BoxIdentity {
    secret: BoxSecretKey,
    pub public: [u8; 32],
}

impl BoxIdentity {
    /// Derive from a 32-byte seed: `x25519_secret = keccak256("opaque-relayer-box-v1" ‖ seed)`.
    pub fn from_seed(seed: &[u8]) -> Self {
        let mut h = Keccak256::new();
        h.update(b"opaque-relayer-box-v1");
        h.update(seed);
        let sk_bytes: [u8; 32] = h.finalize().into();
        let secret = BoxSecretKey::from(sk_bytes);
        let public = secret.public_key().as_bytes().to_owned();
        Self { secret, public }
    }

    /// Open a `epk(32) ‖ nonce(24) ‖ ciphertext` box addressed to this identity.
    pub fn open(&self, boxed: &[u8]) -> Result<Vec<u8>> {
        if boxed.len() < 56 {
            return Err(anyhow!("box too short"));
        }
        let epk: [u8; 32] = boxed[..32].try_into().unwrap();
        let nonce: [u8; 24] = boxed[32..56].try_into().unwrap();
        let ct = &boxed[56..];
        let sender = BoxPublicKey::from(epk);
        let salsa = SalsaBox::new(&sender, &self.secret);
        salsa
            .decrypt(&nonce.into(), ct)
            .map_err(|_| anyhow!("box decryption failed"))
    }
}

/// Seal `plaintext` to a recipient x25519 key, returning `epk ‖ nonce ‖ ct`
/// (the SDK does this in TS; included here for tests and CLI tooling).
pub fn seal(recipient: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>> {
    let mut rng = rand::rngs::OsRng;
    let eph = BoxSecretKey::generate(&mut rng);
    let epk = eph.public_key().as_bytes().to_owned();
    let salsa = SalsaBox::new(&BoxPublicKey::from(*recipient), &eph);
    let nonce = SalsaBox::generate_nonce(&mut rng);
    let ct = salsa
        .encrypt(&nonce, plaintext)
        .map_err(|_| anyhow!("box encryption failed"))?;
    let mut out = Vec::with_capacity(32 + 24 + ct.len());
    out.extend_from_slice(&epk);
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Sign a 32-byte bid hash with an EVM operator key: EIP-191 personal_sign over the
/// hash, returning a 65-byte `r ‖ s ‖ v` signature (v = 27/28).
pub fn evm_sign_prehash(eth_key: &[u8; 32], bid_hash: &[u8; 32]) -> Result<[u8; 65]> {
    let digest = personal_sign_digest(bid_hash);
    let sk = SigningKey::from_bytes(eth_key.into())?;
    let (sig, recid): (EcdsaSignature, RecoveryId) = sk.sign_prehash_recoverable(&digest)?;
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&sig.to_bytes());
    out[64] = 27 + recid.to_byte();
    Ok(out)
}

/// Sign a bid for `(job_id, x25519_pk)` with an EVM operator key.
pub fn evm_sign_bid(eth_key: &[u8; 32], job_id: &[u8; 32], x25519_pk: &[u8; 32]) -> Result<[u8; 65]> {
    evm_sign_prehash(eth_key, &bid_signing_hash(job_id, x25519_pk))
}

/// Recover the EVM address that signed a bid; used by users (and tests) to verify.
pub fn evm_recover_bidder(
    sig65: &[u8; 65],
    job_id: &[u8; 32],
    x25519_pk: &[u8; 32],
) -> Result<[u8; 20]> {
    let digest = personal_sign_digest(&bid_signing_hash(job_id, x25519_pk));
    let recid = RecoveryId::from_byte(sig65[64].wrapping_sub(27)).ok_or_else(|| anyhow!("bad v"))?;
    let sig = EcdsaSignature::from_slice(&sig65[..64])?;
    let vk = VerifyingKey::recover_from_prehash(&digest, &sig, recid)?;
    Ok(address_from_verifying_key(&vk))
}

/// `keccak256("\x19Ethereum Signed Message:\n32" ‖ hash)`.
fn personal_sign_digest(hash: &[u8; 32]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(b"\x19Ethereum Signed Message:\n32");
    h.update(hash);
    h.finalize().into()
}

fn address_from_verifying_key(vk: &VerifyingKey) -> [u8; 20] {
    let uncompressed = vk.to_encoded_point(false);
    let bytes = uncompressed.as_bytes(); // 0x04 ‖ x ‖ y
    let mut h = Keccak256::new();
    h.update(&bytes[1..]);
    let digest: [u8; 32] = h.finalize().into();
    digest[12..].try_into().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn box_roundtrip() {
        let id = BoxIdentity::from_seed(&[42u8; 32]);
        let sealed = seal(&id.public, b"hello payload").unwrap();
        assert_eq!(id.open(&sealed).unwrap(), b"hello payload");
        // A different identity cannot open it.
        let other = BoxIdentity::from_seed(&[7u8; 32]);
        assert!(other.open(&sealed).is_err());
    }

    #[test]
    fn evm_bid_signature_recovers_signer() {
        let key = [0x11u8; 32];
        let job = [1u8; 32];
        let pk = [2u8; 32];
        let sig = evm_sign_bid(&key, &job, &pk).unwrap();
        let recovered = evm_recover_bidder(&sig, &job, &pk).unwrap();

        let expected = {
            let sk = SigningKey::from_bytes((&key).into()).unwrap();
            address_from_verifying_key(sk.verifying_key())
        };
        assert_eq!(recovered, expected);
        // Tampering with the bound key breaks recovery to a different address.
        assert_ne!(evm_recover_bidder(&sig, &job, &[9u8; 32]).unwrap(), expected);
    }
}
