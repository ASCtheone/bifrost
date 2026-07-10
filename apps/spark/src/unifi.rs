//! Minimal UniFi controller client (ported from the TS `unifi-connect`): cookie
//! + CSRF auth, WireGuard-server discovery, and WireGuard-peer CRUD via the v2 API.

use crate::config::UnifiConfig;
use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};

pub struct UnifiClient {
    http: reqwest::Client,
    base_url: String,
    site: String,
    username: String,
    password: String,
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
            username: cfg.username.clone(),
            password: cfg.password.clone(),
            csrf: None,
        })
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

    /// Authenticate; captures the session cookie (via the cookie store) and CSRF token.
    pub async fn login(&mut self) -> Result<()> {
        let url = format!("{}/api/auth/login", self.base_url);
        let resp = self
            .http
            .post(&url)
            .json(&json!({ "username": self.username, "password": self.password }))
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

    /// Authenticated request; retries once through a fresh login on 401.
    async fn request(&mut self, method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<Value> {
        for attempt in 0..2 {
            let url = format!("{}{}", self.base_url, path);
            let mut req = self.http.request(method.clone(), &url);
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
            if (resp.status() == 401 || resp.status() == 403) && attempt == 0 {
                self.login().await?;
                continue;
            }
            if !resp.status().is_success() {
                bail!("unifi {method} {path} -> {}", resp.status());
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
