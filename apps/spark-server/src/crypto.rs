//! Encryption at rest for stored secrets.
//!
//! Right now this protects one thing: the UniFi controller password, which the
//! dashboard writes and the spark reads back. That is a controller *admin*
//! credential, and the SQLite file it lives in ends up in backups and on VPS disks,
//! so it is not stored in plaintext.
//!
//! XChaCha20-Poly1305: AEAD (tamper-evident, not just confidential) with a 192-bit
//! nonce, which is large enough to generate randomly per encryption without birthday
//! concerns — no nonce counter to persist and get wrong.
//!
//! The key comes from `auth.jwt_secret` (SHA-256 of it) unless `secret_key` is set
//! explicitly. That means an existing deployment gets encryption with no config
//! change — but it also means **rotating the JWT secret makes stored passwords
//! undecryptable**. `decrypt` reports that as `Ok(None)` rather than an error, so the
//! UI simply shows the password as unset and you re-enter it, instead of the spark
//! failing in a way nobody can diagnose.

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, OsRng},
    AeadCore, Key, XChaCha20Poly1305, XNonce,
};
use sha2::{Digest, Sha256};

const NONCE_LEN: usize = 24;

#[derive(Clone)]
pub struct Cipher {
    key: Key,
}

impl std::fmt::Debug for Cipher {
    // Never let the key reach a log line via a derived Debug.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Cipher(<redacted>)")
    }
}

impl Cipher {
    /// Derive the data key from whatever secret material the server has.
    pub fn from_secret(secret: &str) -> Self {
        let digest = Sha256::digest(secret.as_bytes());
        Cipher {
            key: *Key::from_slice(&digest),
        }
    }

    /// -> base64(nonce || ciphertext||tag)
    pub fn encrypt(&self, plaintext: &str) -> Result<String> {
        let aead = XChaCha20Poly1305::new(&self.key);
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let ct = aead
            .encrypt(&nonce, plaintext.as_bytes())
            .map_err(|_| anyhow!("encrypt failed"))?;
        let mut blob = Vec::with_capacity(NONCE_LEN + ct.len());
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&ct);
        Ok(B64.encode(blob))
    }

    /// `Ok(None)` when the blob cannot be decrypted with the current key — a
    /// rotated secret, or a corrupted row. Callers treat that as "not set" rather
    /// than propagating an error, so one bad row can't wedge a spark's config poll.
    pub fn decrypt(&self, blob: &str) -> Result<Option<String>> {
        let raw = match B64.decode(blob) {
            Ok(r) => r,
            Err(_) => return Ok(None),
        };
        if raw.len() <= NONCE_LEN {
            return Ok(None);
        }
        let (nonce, ct) = raw.split_at(NONCE_LEN);
        let aead = XChaCha20Poly1305::new(&self.key);
        match aead.decrypt(XNonce::from_slice(nonce), ct) {
            Ok(pt) => Ok(Some(String::from_utf8(pt)?)),
            Err(_) => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let c = Cipher::from_secret("test-secret");
        let blob = c.encrypt("hunter2").unwrap();
        assert_ne!(blob, "hunter2");
        assert_eq!(c.decrypt(&blob).unwrap().as_deref(), Some("hunter2"));
    }

    #[test]
    fn nonce_is_fresh_each_time() {
        let c = Cipher::from_secret("test-secret");
        assert_ne!(c.encrypt("same").unwrap(), c.encrypt("same").unwrap());
    }

    #[test]
    fn wrong_key_is_none_not_error() {
        // The jwt_secret was rotated: old rows must read as "unset", not blow up.
        let blob = Cipher::from_secret("old").encrypt("hunter2").unwrap();
        assert_eq!(Cipher::from_secret("new").decrypt(&blob).unwrap(), None);
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let c = Cipher::from_secret("k");
        let blob = c.encrypt("hunter2").unwrap();
        let mut raw = B64.decode(&blob).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x01; // flip a bit in the tag
        assert_eq!(c.decrypt(&B64.encode(raw)).unwrap(), None);
    }

    #[test]
    fn garbage_is_none_not_error() {
        let c = Cipher::from_secret("k");
        assert_eq!(c.decrypt("not-base64!!").unwrap(), None);
        assert_eq!(c.decrypt("").unwrap(), None);
    }
}
