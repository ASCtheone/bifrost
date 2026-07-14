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
use serde::Serialize;
use serde_json::{json, Value};

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
                bail!("unifi {method} {path} -> {status}");
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
                public_key: n.get("wireguard_public_key").and_then(Value::as_str).unwrap_or_default().to_string(),
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
