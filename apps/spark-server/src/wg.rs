//! WireGuard helpers: keypair generation, preshared keys, deterministic IP
//! assignment, and the client `.conf` builder. Consolidates the `buildWgConfig`
//! template that was duplicated across four TypeScript handlers.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use md5::{Digest, Md5};
use rand::rngs::OsRng;
use rand::RngCore;
use x25519_dalek::{PublicKey, StaticSecret};

/// A generated WireGuard keypair, base64-encoded (standard WireGuard format).
pub struct Keypair {
    pub private_key: String,
    pub public_key: String,
}

/// Generate a Curve25519 keypair for a peer.
pub fn generate_keypair() -> Keypair {
    let mut sk = [0u8; 32];
    OsRng.fill_bytes(&mut sk);
    let secret = StaticSecret::from(sk);
    let public = PublicKey::from(&secret);
    Keypair {
        private_key: STANDARD.encode(secret.to_bytes()),
        public_key: STANDARD.encode(public.to_bytes()),
    }
}

/// Generate a 32-byte preshared key, base64-encoded.
pub fn generate_preshared_key() -> String {
    let mut psk = [0u8; 32];
    OsRng.fill_bytes(&mut psk);
    STANDARD.encode(psk)
}

/// Deterministically assign an IP within a server's /24 from a device id, using
/// the same md5 scheme as the original handlers: `octet4 = md5(deviceId)[0] % 250 + 2`.
/// `server_address` is a CIDR like `192.168.8.1/24`; the default is used when absent.
pub fn assign_ip(device_id: &str, server_address: Option<&str>) -> String {
    let addr = server_address.unwrap_or("192.168.8.1/24");
    let ip_part = addr.split('/').next().unwrap_or("192.168.8.1");
    let octets: Vec<&str> = ip_part.split('.').collect();
    let base = if octets.len() >= 3 {
        format!("{}.{}.{}", octets[0], octets[1], octets[2])
    } else {
        "192.168.8".to_string()
    };
    let digest = Md5::digest(device_id.as_bytes());
    let octet4 = (digest[0] as u32 % 250) + 2;
    format!("{base}.{octet4}")
}

/// Parameters for building a client WireGuard config.
pub struct WgConfigParams<'a> {
    pub private_key: &'a str,
    pub assigned_ip: &'a str,
    pub dns: &'a [String],
    pub server_public_key: &'a str,
    pub preshared_key: &'a str,
    pub endpoint: &'a str,
    pub port: i64,
    pub allowed_ips: &'a [String],
}

/// Build a standard WireGuard client `.conf` document. Identical output to the
/// original `buildWgConfig` (trailing newline preserved).
pub fn build_config(p: &WgConfigParams) -> String {
    format!(
        "[Interface]\n\
         PrivateKey = {priv_key}\n\
         Address = {ip}/32\n\
         DNS = {dns}\n\
         \n\
         [Peer]\n\
         PublicKey = {server_pub}\n\
         PresharedKey = {psk}\n\
         Endpoint = {endpoint}:{port}\n\
         AllowedIPs = {allowed}\n\
         PersistentKeepalive = 25\n",
        priv_key = p.private_key,
        ip = p.assigned_ip,
        dns = p.dns.join(", "),
        server_pub = p.server_public_key,
        psk = p.preshared_key,
        endpoint = p.endpoint,
        port = p.port,
        allowed = p.allowed_ips.join(", "),
    )
}
