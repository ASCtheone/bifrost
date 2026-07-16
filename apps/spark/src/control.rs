//! Client for the Bifrost control plane (the VPS master). Handles adoption and
//! the node-key-authenticated heartbeat + desired-config sync.

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};

pub struct Control {
    http: reqwest::Client,
    base: String,
}

/// A peer the control plane wants provisioned on the UniFi WireGuard server.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesiredPeer {
    pub name: String,
    pub public_key: String,
    pub assigned_ip: String,
    #[serde(default)]
    pub preshared_key: Option<String>,
    #[serde(default)]
    pub allowed_ips: Vec<String>,
}

/// The full desired state for this spark's UniFi WireGuard server.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesiredConfig {
    /// Name of the UniFi WireGuard server this spark manages (spark_vpn_name).
    #[serde(default)]
    pub vpn_name: Option<String>,
    /// The id of the server this spark created and owns, once it has (spark_vpn_id). The
    /// spark selects its server by this id — an exact match, never a guess among several.
    #[serde(default)]
    pub vpn_id: Option<String>,
    /// The operator asked for a VPN (via "Create VPN") and one isn't bound yet: the spark
    /// should create its own WireGuard server. Cleared once a server is reported bound.
    #[serde(default)]
    pub pending_vpn_create: bool,
    /// Operator pause. When true the spark disables its WireGuard server on the controller
    /// so clients disconnect; resuming re-enables it. Kept in sync every cycle.
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub peers: Vec<DesiredPeer>,
    /// UniFi peer ids the control plane has queued for deletion.
    #[serde(default)]
    pub pending_peer_deletions: Vec<String>,
    /// Management commands (create/update/delete server or peer) to execute this cycle.
    /// Kept as raw JSON so an unknown/new command kind doesn't fail the whole batch — each
    /// is interpreted individually by the spark, and an unrecognised one reports an error.
    #[serde(default)]
    pub commands: Vec<serde_json::Value>,
    /// The UniFi controller to drive, as configured in the dashboard. `None` until an
    /// operator fills it in — the spark then idles instead of failing.
    #[serde(default)]
    pub unifi: Option<crate::config::UnifiConfig>,
}

impl Control {
    pub fn new(master_url: &str) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .context("build control http client")?;
        Ok(Self {
            http,
            base: master_url.trim_end_matches('/').to_string(),
        })
    }

    /// POST /agent/register — exchange an adoption code for our node id.
    pub async fn register(&self, adoption_code: &str) -> Result<String> {
        let resp = self
            .http
            .post(format!("{}/agent/register", self.base))
            .json(&json!({ "adoptionCode": adoption_code }))
            .send()
            .await
            .context("register with control plane")?;
        if !resp.status().is_success() {
            bail!("register failed: {}", error_body(resp).await);
        }
        let v: Value = resp.json().await?;
        v.get("nodeId")
            .and_then(Value::as_str)
            .map(String::from)
            .context("register response missing nodeId")
    }

    /// GET /agent/await-adoption — poll until adopted; returns the node key when ready.
    pub async fn await_adoption(&self, node_id: &str, code: Option<&str>) -> Result<Option<String>> {
        let mut url = format!("{}/agent/await-adoption?nodeId={}", self.base, node_id);
        if let Some(c) = code {
            url.push_str(&format!("&code={c}"));
        }
        let resp = self.http.get(&url).send().await.context("await adoption")?;
        if !resp.status().is_success() {
            bail!("await-adoption failed: {}", error_body(resp).await);
        }
        let v: Value = resp.json().await?;
        match v.get("status").and_then(Value::as_str) {
            Some("adopted") => Ok(v.get("nodeKey").and_then(Value::as_str).map(String::from)),
            _ => Ok(None), // still waiting
        }
    }

    /// PUT /nodes/{id}/heartbeat — report status + actualConfig + wan ip.
    pub async fn heartbeat(&self, node_id: &str, node_key: &str, body: &Value) -> Result<()> {
        let resp = self
            .http
            .put(format!("{}/nodes/{}/heartbeat", self.base, node_id))
            .header("x-node-key", node_key)
            .json(body)
            .send()
            .await
            .context("heartbeat")?;
        if !resp.status().is_success() {
            bail!("heartbeat failed: {}", error_body(resp).await);
        }
        Ok(())
    }

    /// GET /nodes/{id}/desired-config — the peers this spark should provision.
    pub async fn desired_config(&self, node_id: &str, node_key: &str) -> Result<DesiredConfig> {
        let resp = self
            .http
            .get(format!("{}/nodes/{}/desired-config", self.base, node_id))
            .header("x-node-key", node_key)
            .send()
            .await
            .context("fetch desired config")?;
        if !resp.status().is_success() {
            bail!("desired-config failed: {}", error_body(resp).await);
        }
        Ok(resp.json().await?)
    }
}

async fn error_body(resp: reqwest::Response) -> String {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(String::from))
        .unwrap_or(text);
    format!("{status} {msg}")
}
