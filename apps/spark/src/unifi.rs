//! Minimal UniFi controller client: WireGuard-server discovery and WireGuard-peer
//! CRUD via the v2 API.
//!
//! Two ways to authenticate:
//!
//!   * **API key** (preferred) — an `X-API-KEY` header on every request. No session,
//!     no CSRF token, nothing to re-auth. It's scoped and revocable on its own,
//!     rather than being a human's admin password that also unlocks the console.
//!   * **Username + password** — the classic cookie + CSRF login, kept as a fallback
//!     for controllers old enough not to issue API keys.

use crate::config::UnifiConfig;
use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::Serialize;
use serde_json::{json, Value};
use x25519_dalek::{PublicKey, StaticSecret};

/// The subnet range spark-created VPN servers are allocated from — the operator
/// reserves 10.13.0.0/16 for VPNs. A fresh server gets the first free 10.13.N.0/24.
const VPN_SUBNET_PREFIX: &str = "10.13";
/// WireGuard's conventional first listen port; server creation picks the first free
/// port at or above this.
const VPN_FIRST_PORT: i64 = 51820;

pub struct UnifiClient {
    http: reqwest::Client,
    base_url: String,
    site: String,
    api_key: Option<String>,
    username: Option<String>,
    password: Option<String>,
    csrf: Option<String>,
}

/// A WireGuard server configured on the controller.
#[derive(Debug, Clone)]
pub struct WgServer {
    pub id: String,
    pub name: String,
    pub server_address: String,
    pub server_port: i64,
    pub public_key: String,
    /// The raw controller object, compacted — logged when a field (e.g. the public
    /// key) comes back empty, so a firmware naming difference is diagnosable from the
    /// log instead of guessed at.
    pub raw: String,
}

/// A WireGuard peer (client) on a server.
#[derive(Debug, Clone)]
pub struct WgPeer {
    pub id: String,
    pub name: String,
    pub public_key: String,
    pub interface_ip: String,
    pub preshared_key: Option<String>,
    pub allowed_ips: Vec<String>,
}

impl UnifiClient {
    pub fn new(cfg: &UnifiConfig) -> Result<Self> {
        let base_url = if cfg.port == 443 {
            format!("https://{}", cfg.host)
        } else {
            format!("https://{}:{}", cfg.host, cfg.port)
        };
        let http = reqwest::Client::builder()
            .cookie_store(true)
            .danger_accept_invalid_certs(cfg.insecure)
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .context("build unifi http client")?;
        Ok(Self {
            http,
            base_url,
            site: cfg.site.clone(),
            api_key: cfg.api_key.clone().filter(|k| !k.is_empty()),
            username: cfg.username.clone().filter(|u| !u.is_empty()),
            password: cfg.password.clone().filter(|p| !p.is_empty()),
            csrf: None,
        })
    }

    fn uses_api_key(&self) -> bool {
        self.api_key.is_some()
    }

    fn api_path(&self) -> String {
        format!("/proxy/network/api/s/{}", self.site)
    }

    fn v2_users_path(&self, server_id: &str) -> String {
        format!(
            "/proxy/network/v2/api/site/{}/wireguard/{}/users",
            self.site, server_id
        )
    }

    /// Establish a session. A no-op with an API key — that auth is per-request, so
    /// there is nothing to log in to and nothing to expire.
    pub async fn login(&mut self) -> Result<()> {
        if self.uses_api_key() {
            return Ok(());
        }
        let (Some(username), Some(password)) = (&self.username, &self.password) else {
            bail!("no UniFi credentials: set an API key (or a username and password)");
        };
        let url = format!("{}/api/auth/login", self.base_url);
        let resp = self
            .http
            .post(&url)
            .json(&json!({ "username": username, "password": password }))
            .send()
            .await
            .context("connect to unifi controller")?;

        if resp.status() == 401 || resp.status() == 403 {
            bail!("unifi login failed: invalid credentials");
        }
        if !resp.status().is_success() {
            bail!("unifi login failed: status {}", resp.status());
        }
        self.csrf = resp
            .headers()
            .get("x-csrf-token")
            .or_else(|| resp.headers().get("x-updated-csrf-token"))
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        Ok(())
    }

    /// Authenticated request. With a username/password session, retries once through a
    /// fresh login on 401 (the cookie can expire). With an API key there is nothing to
    /// refresh — a 401 means the key is wrong or lacks permission, so say that plainly
    /// instead of retrying in a loop that cannot succeed.
    async fn request(&mut self, method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<Value> {
        for attempt in 0..2 {
            let url = format!("{}{}", self.base_url, path);
            let mut req = self.http.request(method.clone(), &url);
            if let Some(key) = &self.api_key {
                req = req.header("X-API-KEY", key);
            }
            if let Some(csrf) = &self.csrf {
                req = req.header("x-csrf-token", csrf);
            }
            if let Some(b) = body {
                req = req.json(b);
            }
            let resp = req.send().await.context("unifi request")?;
            // Controllers rotate the CSRF token on mutating calls.
            if let Some(tok) = resp
                .headers()
                .get("x-csrf-token")
                .and_then(|v| v.to_str().ok())
            {
                self.csrf = Some(tok.to_string());
            }
            let status = resp.status();
            if status == 401 || status == 403 {
                if self.uses_api_key() {
                    bail!(
                        "unifi {method} {path} -> {status}: the API key was rejected. \
                         Check it is valid and has permission to manage the network \
                         (UniFi Console → Settings → Control Plane → Integrations → API Keys)."
                    );
                }
                if attempt == 0 {
                    self.login().await?;
                    continue;
                }
            }
            if !status.is_success() {
                // Include the body. UniFi explains every 4xx in it ("api.err.*", a
                // validation message, the offending field) — throwing it away left a
                // bare "400 Bad Request", which says only that something is wrong, not
                // what. Debugging a rejected payload without it is pure guesswork.
                let body = resp.text().await.unwrap_or_default();
                let body = body.trim();
                if body.is_empty() {
                    bail!("unifi {method} {path} -> {status}");
                }
                let mut brief: String = body.chars().take(400).collect();
                if body.chars().count() > 400 {
                    brief.push('…');
                }
                bail!("unifi {method} {path} -> {status}: {brief}");
            }
            let text = resp.text().await.unwrap_or_default();
            return Ok(serde_json::from_str(&text).unwrap_or(Value::Null));
        }
        Err(anyhow!("unifi request failed after re-auth"))
    }

    /// The `data` array from an enveloped `{meta, data}` REST response.
    async fn get_rest(&mut self, rest_path: &str) -> Result<Vec<Value>> {
        let path = format!("{}{}", self.api_path(), rest_path);
        let v = self.request(reqwest::Method::GET, &path, None).await?;
        Ok(v.get("data").and_then(Value::as_array).cloned().unwrap_or_default())
    }

    /// Find WireGuard servers — via `networkconf` (current firmware).
    pub async fn list_wg_servers(&mut self) -> Result<Vec<WgServer>> {
        let networks = self.get_rest("/rest/networkconf").await?;
        Ok(networks
            .iter()
            .filter(|n| n.get("vpn_type").and_then(Value::as_str) == Some("wireguard-server"))
            .map(|n| WgServer {
                id: n.get("_id").and_then(Value::as_str).unwrap_or_default().to_string(),
                name: n.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                server_address: n
                    .get("ip_subnet")
                    .or_else(|| n.get("subnet_cidr"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                server_port: n.get("local_port").and_then(Value::as_i64).unwrap_or(0),
                public_key: server_public_key(n),
                raw: {
                    // Redact secret *values*, keep field *names*. A field name leaks
                    // nothing, and knowing which key fields the controller returned is
                    // exactly what diagnoses an empty public key. (These fields used to
                    // be dropped whole, which hid `x_wireguard_private_key` — the very
                    // field the public-key derivation relies on.)
                    let mut o = n.clone();
                    if let Some(map) = o.as_object_mut() {
                        for (k, v) in map.iter_mut() {
                            if k.contains("private") || k.contains("secret") {
                                *v = Value::String("<redacted>".into());
                            }
                        }
                    }
                    serde_json::to_string(&o).unwrap_or_default().chars().take(600).collect::<String>()
                },
            })
            .collect())
    }

    pub async fn list_peers(&mut self, server_id: &str) -> Result<Vec<WgPeer>> {
        let path = self.v2_users_path(server_id);
        let v = self.request(reqwest::Method::GET, &path, None).await?;
        let arr = v.as_array().cloned().unwrap_or_default();
        Ok(arr.iter().map(parse_peer).collect())
    }

    pub async fn create_peer(&mut self, server_id: &str, peer: &NewPeer) -> Result<()> {
        let path = format!("{}/batch", self.v2_users_path(server_id));
        let payload = json!([peer]);
        self.request(reqwest::Method::POST, &path, Some(&payload)).await?;
        Ok(())
    }

    pub async fn delete_peer(&mut self, server_id: &str, peer_id: &str) -> Result<()> {
        let path = format!("{}/batch_delete", self.v2_users_path(server_id));
        let payload = json!([peer_id]);
        self.request(reqwest::Method::POST, &path, Some(&payload)).await?;
        Ok(())
    }

    /// Create a WireGuard VPN server on the controller and return its id.
    ///
    /// The spark owns the server it creates: it picks a free `10.13.N.0/24` subnet and a
    /// free port, generates the server keypair, and POSTs a `wireguard-server`
    /// `networkconf`. The payload is cloned from an existing WireGuard server on this same
    /// controller when one exists — that guarantees every obscure required field matches
    /// the firmware, which assembling a payload from field names alone does not — with the
    /// subnet-derived and DHCP fields stripped so the controller re-derives them for the
    /// new subnet. On a controller with no server to template from, a minimal payload from
    /// the documented schema is used. The full payload and any error body are logged.
    pub async fn create_wg_server(&mut self, name: &str) -> Result<WgServer> {
        let networks = self.get_rest("/rest/networkconf").await?;

        let used_subnets: Vec<String> = networks
            .iter()
            .filter_map(|n| n.get("ip_subnet").and_then(Value::as_str).map(String::from))
            .collect();
        let subnet = pick_subnet(&used_subnets)
            .context("no free 10.13.N.0/24 subnet available for a new VPN server")?;

        let used_ports: Vec<i64> = networks
            .iter()
            .filter_map(|n| n.get("local_port").and_then(Value::as_i64))
            .collect();
        let port = pick_port(&used_ports);

        let kp = generate_keypair();

        // Prefer cloning an existing WireGuard server as a firmware-safe template.
        let mut payload = networks
            .iter()
            .find(|n| n.get("vpn_type").and_then(Value::as_str) == Some("wireguard-server"))
            .cloned()
            .unwrap_or_else(|| {
                json!({
                    "purpose": "remote-user-vpn",
                    "vpn_type": "wireguard-server",
                    "wireguard_interface": "wan",
                    "setting_preference": "manual",
                })
            });
        if let Some(o) = payload.as_object_mut() {
            // Identifiers and derived/subnet-tied fields must not be carried over.
            o.retain(|k, _| {
                !(k.starts_with('_')
                    || k.starts_with("attr_")
                    || k.contains("dhcp")
                    || k == "ip_subnet"
                    || k == "local_port"
                    || k == "wireguard_public_key"
                    || k == "x_wireguard_private_key")
            });
            o.insert("name".into(), json!(name));
            o.insert("purpose".into(), json!("remote-user-vpn"));
            o.insert("vpn_type".into(), json!("wireguard-server"));
            o.insert("ip_subnet".into(), json!(subnet));
            o.insert("local_port".into(), json!(port));
            o.insert("enabled".into(), json!(true));
            o.insert("wireguard_public_key".into(), json!(kp.public_key));
            o.insert("x_wireguard_private_key".into(), json!(kp.private_key));
        }

        tracing::info!(
            %name, %subnet, port, "creating WireGuard VPN server on the controller"
        );
        let path = format!("{}/rest/networkconf", self.api_path());
        let created = match self.request(reqwest::Method::POST, &path, Some(&payload)).await {
            Ok(v) => v,
            Err(e) => {
                // The payload is logged (private key redacted) so a rejected create is
                // diagnosable from the field UniFi objected to, not guessed at.
                let mut safe = payload.clone();
                if let Some(o) = safe.as_object_mut() {
                    o.insert("x_wireguard_private_key".into(), json!("<redacted>"));
                }
                tracing::warn!(
                    payload = %serde_json::to_string(&safe).unwrap_or_default(),
                    "create WireGuard server failed: {e:#}"
                );
                return Err(e);
            }
        };

        let id = created
            .get("data")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|o| o.get("_id"))
            .and_then(Value::as_str)
            .map(String::from)
            .context("create WireGuard server: response had no _id")?;

        Ok(WgServer {
            id,
            name: name.to_string(),
            server_address: subnet,
            server_port: port,
            public_key: kp.public_key,
            raw: String::new(),
        })
    }
}

/// A generated WireGuard keypair, base64-encoded (standard WireGuard format).
struct Keypair {
    private_key: String,
    public_key: String,
}

fn generate_keypair() -> Keypair {
    let mut sk = [0u8; 32];
    OsRng.fill_bytes(&mut sk);
    let secret = StaticSecret::from(sk);
    let public = PublicKey::from(&secret);
    Keypair {
        private_key: STANDARD.encode(secret.to_bytes()),
        public_key: STANDARD.encode(public.to_bytes()),
    }
}

/// The first free `10.13.N.0/24` (returned as gateway `10.13.N.1/24`) whose third octet
/// isn't already used by an existing network. `used` holds CIDRs like `10.13.4.1/24` or
/// `192.168.3.1/24`; only the reserved VPN range is considered.
fn pick_subnet(used: &[String]) -> Option<String> {
    let taken: std::collections::HashSet<u16> = used
        .iter()
        .filter_map(|s| {
            let net = s.split('/').next().unwrap_or(s);
            let rest = net.strip_prefix(VPN_SUBNET_PREFIX)?.strip_prefix('.')?;
            rest.split('.').next()?.parse::<u16>().ok()
        })
        .collect();
    (0..=255).find(|n| !taken.contains(n)).map(|n| format!("{VPN_SUBNET_PREFIX}.{n}.1/24"))
}

/// The first free port at or above the WireGuard default that no network already uses.
fn pick_port(used: &[i64]) -> i64 {
    let taken: std::collections::HashSet<i64> = used.iter().copied().collect();
    (VPN_FIRST_PORT..=65535).find(|p| !taken.contains(p)).unwrap_or(VPN_FIRST_PORT)
}

/// Payload for creating a peer on the controller.
#[derive(Debug, Serialize)]
pub struct NewPeer {
    pub name: String,
    pub interface_ip: String,
    pub public_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preshared_key: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub allowed_ips: Vec<String>,
}

/// The WireGuard server's public key, from a `/rest/networkconf` server object.
///
/// UniFi's schema names it `wireguard_public_key` (confirmed against the controller's
/// own JSON schema), but some firmware returns that field empty in the list response
/// while still returning the server's private key as `x_wireguard_private_key`. A
/// WireGuard public key is a pure function of the private key, so when the controller
/// hands us the private key but not the public one, we derive it rather than depending
/// on the controller to expose it. Without this the key is empty, the control plane
/// skips the node, and the router shows "No spark available" for a silent reason.
fn server_public_key(n: &Value) -> String {
    let direct = n
        .get("wireguard_public_key")
        .or_else(|| n.get("x_wireguard_public_key"))
        .or_else(|| n.get("public_key"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !direct.is_empty() {
        return direct.to_string();
    }
    n.get("x_wireguard_private_key")
        .and_then(Value::as_str)
        .and_then(derive_public_key)
        .unwrap_or_default()
}

/// Derive a WireGuard public key from its base64 private key (X25519 public point of
/// the secret scalar). Returns `None` if the input isn't a valid 32-byte base64 key.
fn derive_public_key(private_b64: &str) -> Option<String> {
    let raw = STANDARD.decode(private_b64.trim()).ok()?;
    let sk: [u8; 32] = raw.try_into().ok()?;
    let public = PublicKey::from(&StaticSecret::from(sk));
    Some(STANDARD.encode(public.to_bytes()))
}

fn parse_peer(u: &Value) -> WgPeer {
    WgPeer {
        id: u.get("_id").and_then(Value::as_str).unwrap_or_default().to_string(),
        name: u.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
        public_key: u.get("public_key").and_then(Value::as_str).unwrap_or_default().to_string(),
        interface_ip: u.get("interface_ip").and_then(Value::as_str).unwrap_or_default().to_string(),
        preshared_key: u.get("preshared_key").and_then(Value::as_str).map(String::from),
        allowed_ips: u
            .get("allowed_ips")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex32(h: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    #[test]
    fn derives_public_key_from_rfc7748_vector() {
        // RFC 7748 §6.1 Alice keypair (raw X25519 scalar / point), stored as WireGuard
        // stores keys: base64 of the 32 bytes. Independent of our own encode path.
        let priv_b64 = STANDARD.encode(hex32(
            "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
        ));
        let pub_b64 = STANDARD.encode(hex32(
            "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
        ));
        assert_eq!(derive_public_key(&priv_b64), Some(pub_b64));
    }

    #[test]
    fn derive_public_key_rejects_malformed_input() {
        assert_eq!(derive_public_key("not base64!!"), None);
        assert_eq!(derive_public_key(&STANDARD.encode([0u8; 16])), None); // wrong length
    }

    #[test]
    fn pick_subnet_allocates_from_the_reserved_range() {
        assert_eq!(pick_subnet(&[]).as_deref(), Some("10.13.0.1/24"));
        // Existing 10.13.x blocks are skipped; unrelated ranges are ignored.
        let used = vec![
            "10.13.0.1/24".into(),
            "10.13.1.1/24".into(),
            "192.168.3.1/24".into(),
        ];
        assert_eq!(pick_subnet(&used).as_deref(), Some("10.13.2.1/24"));
        // A non-VPN network on a different range doesn't consume a VPN block.
        assert_eq!(pick_subnet(&["192.168.8.1/24".into()]).as_deref(), Some("10.13.0.1/24"));
    }

    #[test]
    fn pick_port_takes_the_first_free_at_or_above_the_default() {
        assert_eq!(pick_port(&[]), 51820);
        assert_eq!(pick_port(&[51820]), 51821);
        assert_eq!(pick_port(&[51820, 51821, 51999]), 51822);
        // Ports below the default don't matter.
        assert_eq!(pick_port(&[443, 51820]), 51821);
    }

    #[test]
    fn generated_keypair_round_trips_through_derivation() {
        // The public key we store on create must be the real public key of the private
        // key we store — otherwise clients built against it can't handshake.
        let kp = generate_keypair();
        assert_eq!(derive_public_key(&kp.private_key).as_deref(), Some(kp.public_key.as_str()));
    }

    #[test]
    fn server_public_key_prefers_direct_then_derives() {
        // A populated public-key field wins outright — no derivation.
        assert_eq!(
            server_public_key(&json!({ "wireguard_public_key": "DIRECT_KEY" })),
            "DIRECT_KEY"
        );
        // Empty public key but a private key present → derived, non-empty.
        let priv_b64 = STANDARD.encode([7u8; 32]);
        let derived = server_public_key(&json!({
            "wireguard_public_key": "",
            "x_wireguard_private_key": priv_b64,
        }));
        assert!(!derived.is_empty());
        // Neither present → empty (caller treats this as "no key", logs the raw object).
        assert_eq!(server_public_key(&json!({})), "");
    }
}
