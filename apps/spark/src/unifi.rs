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
    /// Whether the server is enabled on the controller. The spark keeps this in sync with
    /// the spark's pause state — a paused spark disables its server so clients disconnect.
    pub enabled: bool,
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
                enabled: n.get("enabled").and_then(Value::as_bool).unwrap_or(true),
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
    /// `networkconf`. The payload is the exact minimal one verified against a live
    /// controller — UniFi rejects a create without the keypair
    /// (`api.err.WireguardMissingPrivateKey`) and assigns `_id`/`wireguard_id`/
    /// `firewall_zone_id` itself. We deliberately do NOT clone an existing server: that
    /// copies per-object identifiers (`external_id`, `wireguard_id`) and causes conflicts.
    /// The full payload (private key redacted) and any error body are logged.
    pub async fn create_wg_server(
        &mut self,
        name: &str,
        subnet: Option<&str>,
        port: Option<i64>,
    ) -> Result<WgServer> {
        let networks = self.get_rest("/rest/networkconf").await?;

        // Operator-specified subnet/port win; otherwise auto-pick a free one.
        let subnet = match subnet.map(str::trim).filter(|s| !s.is_empty()) {
            Some(s) => s.to_string(),
            None => {
                let used_subnets: Vec<String> = networks
                    .iter()
                    .filter_map(|n| n.get("ip_subnet").and_then(Value::as_str).map(String::from))
                    .collect();
                pick_subnet(&used_subnets)
                    .context("no free 10.13.N.0/24 subnet available for a new VPN server")?
            }
        };
        let port = match port.filter(|p| *p > 0) {
            Some(p) => p,
            None => {
                let used_ports: Vec<i64> = networks
                    .iter()
                    .filter_map(|n| n.get("local_port").and_then(Value::as_i64))
                    .collect();
                pick_port(&used_ports)
            }
        };

        let kp = generate_keypair();

        let payload = json!({
            "name": name,
            "purpose": "remote-user-vpn",
            "vpn_type": "wireguard-server",
            "ip_subnet": subnet,
            "local_port": port,
            "wireguard_interface": "wan",
            "wireguard_local_wan_ip": "any",
            "setting_preference": "auto",
            "enabled": true,
            "wireguard_public_key": kp.public_key,
            "x_wireguard_private_key": kp.private_key,
        });

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
            enabled: true,
            raw: String::new(),
        })
    }

    /// Update a WireGuard server's mutable fields. UniFi's REST update is a full-object
    /// PUT (verified live), so we GET the current object, apply the changes, and PUT it
    /// back — leaving every field we don't touch exactly as the controller had it.
    pub async fn update_wg_server(
        &mut self,
        server_id: &str,
        name: Option<&str>,
        port: Option<i64>,
        enabled: Option<bool>,
    ) -> Result<()> {
        let path = format!("{}/rest/networkconf/{}", self.api_path(), server_id);
        let cur = self.request(reqwest::Method::GET, &path, None).await?;
        let mut obj = cur
            .get("data")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .cloned()
            .context("update WireGuard server: server not found")?;
        if let Some(o) = obj.as_object_mut() {
            if let Some(n) = name.map(str::trim).filter(|s| !s.is_empty()) {
                o.insert("name".into(), json!(n));
            }
            if let Some(p) = port.filter(|p| *p > 0) {
                o.insert("local_port".into(), json!(p));
            }
            if let Some(e) = enabled {
                o.insert("enabled".into(), json!(e));
            }
        }
        self.request(reqwest::Method::PUT, &path, Some(&obj)).await?;
        Ok(())
    }

    /// Delete a WireGuard server from the controller.
    pub async fn delete_wg_server(&mut self, server_id: &str) -> Result<()> {
        let path = format!("{}/rest/networkconf/{}", self.api_path(), server_id);
        self.request(reqwest::Method::DELETE, &path, None).await?;
        Ok(())
    }

    /// Create a client peer on a server. When `public_key` is None a keypair is generated
    /// and the private key returned so the caller can hand the client its config; when
    /// supplied, the client already holds its own key and no private key ever transits.
    /// The IP is auto-picked from a free host in the server's subnet when `ip` is None.
    /// Returns (assigned_ip, public_key, generated_private_key).
    pub async fn create_client_peer(
        &mut self,
        server_id: &str,
        name: &str,
        public_key: Option<&str>,
        ip: Option<&str>,
        allowed_ips: Vec<String>,
    ) -> Result<(String, String, Option<String>)> {
        let (pub_key, priv_key) = match public_key.map(str::trim).filter(|s| !s.is_empty()) {
            Some(pk) => (pk.to_string(), None),
            None => {
                let kp = generate_keypair();
                (kp.public_key, Some(kp.private_key))
            }
        };
        let ip = match ip.map(str::trim).filter(|s| !s.is_empty()) {
            Some(x) => x.to_string(),
            None => {
                let servers = self.list_wg_servers().await?;
                let subnet = servers
                    .iter()
                    .find(|s| s.id == server_id)
                    .map(|s| s.server_address.clone())
                    .context("create peer: server not found")?;
                let existing = self.list_peers(server_id).await?;
                pick_peer_ip(&subnet, &existing).context("create peer: no free address in the subnet")?
            }
        };
        // On the server side a peer's allowed-ips is just its own tunnel address, so an
        // unspecified list becomes the peer's /32 — never 0.0.0.0/0, which here would try
        // to route every client's traffic to this one peer.
        let allowed_ips = if allowed_ips.is_empty() {
            vec![format!("{ip}/32")]
        } else {
            allowed_ips
        };
        self.create_peer(
            server_id,
            &NewPeer {
                name: name.to_string(),
                interface_ip: ip.clone(),
                public_key: pub_key.clone(),
                preshared_key: None,
                allowed_ips,
            },
        )
        .await?;
        Ok((ip, pub_key, priv_key))
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

/// The first free host address (`.2`–`.254`) in a server's /24, skipping the gateway and
/// any address a peer already holds. `subnet` is a gateway CIDR like `10.13.0.1/24`.
fn pick_peer_ip(subnet: &str, existing: &[WgPeer]) -> Option<String> {
    let net = subnet.split('/').next().unwrap_or(subnet);
    let octets: Vec<&str> = net.split('.').collect();
    if octets.len() != 4 {
        return None;
    }
    let base = format!("{}.{}.{}", octets[0], octets[1], octets[2]);
    let taken: std::collections::HashSet<&str> = existing
        .iter()
        .map(|p| p.interface_ip.split('/').next().unwrap_or(&p.interface_ip))
        .collect();
    (2..=254)
        .map(|h| format!("{base}.{h}"))
        .find(|ip| !taken.contains(ip.as_str()))
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

    fn peer_at(ip: &str) -> WgPeer {
        WgPeer {
            id: "x".into(),
            name: "p".into(),
            public_key: "k".into(),
            interface_ip: ip.into(),
            preshared_key: None,
            allowed_ips: vec![],
        }
    }

    #[test]
    fn pick_peer_ip_takes_the_first_free_host_skipping_gateway_and_used() {
        assert_eq!(pick_peer_ip("10.13.0.1/24", &[]).as_deref(), Some("10.13.0.2"));
        let used = [peer_at("10.13.0.2"), peer_at("10.13.0.3/32")];
        assert_eq!(pick_peer_ip("10.13.0.1/24", &used).as_deref(), Some("10.13.0.4"));
        // Malformed subnet yields nothing rather than a bad address.
        assert_eq!(pick_peer_ip("not-a-subnet", &[]), None);
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
