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

/// Is `ip` inside the same /24 as `server_address` (a CIDR like "10.20.30.1/24")?
///
/// A peer address outside the WireGuard server's subnet is refused outright by UniFi
/// (`api.err.UserIpDoesNotBelongToNetwork`), so this is what decides whether a device's
/// stored address is still usable.
pub fn ip_in_server_subnet(ip: &str, server_address: &str) -> bool {
    fn base24(addr: &str) -> Option<String> {
        let host = addr.split('/').next()?;
        let o: Vec<&str> = host.split('.').collect();
        if o.len() < 3 {
            return None;
        }
        Some(format!("{}.{}.{}", o[0], o[1], o[2]))
    }
    match (base24(ip), base24(server_address)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

#[cfg(test)]
mod ip_tests {
    use super::*;

    #[test]
    fn same_24_is_in_subnet() {
        assert!(ip_in_server_subnet("10.20.30.155", "10.20.30.1/24"));
    }

    #[test]
    fn the_real_failure_is_caught() {
        // What UniFi rejected: allocated from the hardcoded 192.168.8.1/24 default
        // because the spark had not yet reported its server.
        assert!(!ip_in_server_subnet("192.168.8.155", "10.20.30.1/24"));
    }

    #[test]
    fn reassignment_keeps_the_host_octet_and_lands_in_subnet() {
        let ip = assign_ip("dev-abc", Some("10.20.30.1/24"));
        assert!(ip_in_server_subnet(&ip, "10.20.30.1/24"));
        // Deterministic: same device, same host octet, just rebased.
        let old = assign_ip("dev-abc", None);
        assert_eq!(
            old.rsplit('.').next().unwrap(),
            ip.rsplit('.').next().unwrap()
        );
    }

    #[test]
    fn garbage_is_not_in_subnet() {
        assert!(!ip_in_server_subnet("", "10.20.30.1/24"));
        assert!(!ip_in_server_subnet("10.20.30.5", ""));
    }
}
