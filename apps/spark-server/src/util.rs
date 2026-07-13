use base64::Engine;
use chrono::{Duration, Utc};
use rand::RngCore;

/// ISO-8601 / RFC-3339 timestamp with millisecond precision and a trailing `Z`,
/// matching JavaScript's `new Date().toISOString()` used by the old handlers.
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// ISO timestamp `secs` seconds in the future (used for short-lived TTLs).
pub fn iso_in(secs: i64) -> String {
    (Utc::now() + Duration::seconds(secs)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Current unix time in seconds.
pub fn now_unix() -> i64 {
    Utc::now().timestamp()
}

/// Generate a ULID string (lexicographically sortable, time-prefixed).
pub fn ulid() -> String {
    ulid::Ulid::new().to_string()
}

/// `n` cryptographically-random bytes.
pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    buf
}

/// `n` random bytes rendered as lowercase hex (2·n chars).
pub fn random_hex(n: usize) -> String {
    hex::encode(random_bytes(n))
}

/// A node id: `node-` + 3 random bytes hex (6 hex chars).
pub fn node_id() -> String {
    format!("node-{}", random_hex(3))
}

/// A device id: `dev-` + 4 random bytes hex (8 hex chars).
pub fn device_id() -> String {
    format!("dev-{}", random_hex(4))
}

/// A raw node key: 32 random bytes hex (64 chars), matching the old handler.
pub fn node_key() -> String {
    random_hex(32)
}

/// A provision token: 24 random bytes, URL-safe base64 without padding.
pub fn provision_token() -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes(24))
}

/// A short hex suffix for connection-log sort keys (4 bytes → 8 hex chars).
pub fn short_suffix() -> String {
    random_hex(4)
}

/// A human-friendly adoption code: 9 chars from an unambiguous alphabet,
/// formatted `XXX-XXX-XXX`. Matches the old `generateAdoptionCode`.
pub fn adoption_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars, no O/0/1/I
    let bytes = random_bytes(9);
    let chars: Vec<char> = bytes
        .iter()
        .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
        .collect();
    format!(
        "{}{}{}-{}{}{}-{}{}{}",
        chars[0], chars[1], chars[2], chars[3], chars[4], chars[5], chars[6], chars[7], chars[8],
    )
}

/// A human-friendly device-pairing code: 8 chars from an unambiguous alphabet,
/// formatted `XXXX-XXXX`.
pub fn device_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars, no O/0/1/I
    let chars: Vec<char> = random_bytes(8)
        .iter()
        .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
        .collect();
    format!(
        "{}{}{}{}-{}{}{}{}",
        chars[0], chars[1], chars[2], chars[3], chars[4], chars[5], chars[6], chars[7],
    )
}
