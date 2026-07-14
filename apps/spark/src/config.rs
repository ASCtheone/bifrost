//! Spark configuration: how to reach the Bifrost control plane and the local
//! UniFi controller, plus persisted adoption state (node id + key).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    /// Base URL of the Bifrost control plane (your VPS), e.g. https://bifrost.example.com
    pub master_url: String,
    /// One-time adoption code (from the dashboard) — only needed for first bootstrap.
    #[serde(default)]
    pub adoption_code: Option<String>,
    /// Seconds between heartbeat + config-sync cycles.
    #[serde(default = "default_poll")]
    pub poll_interval_seconds: u64,
    /// UniFi controller settings.
    ///
    /// Optional, and normally absent: these are configured in the dashboard and
    /// delivered with each `desired-config` poll, so installing a spark doesn't mean
    /// hand-editing credentials into a file on the box. A local block still wins if
    /// present — useful for a controller the control plane shouldn't hold keys to.
    #[serde(default)]
    pub unifi: Option<UnifiConfig>,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize, PartialEq, Eq)]
pub struct UnifiConfig {
    pub host: String,
    #[serde(default = "default_unifi_port")]
    pub port: u16,
    #[serde(default = "default_site")]
    pub site: String,
    pub username: String,
    pub password: String,
    /// Accept the controller's self-signed TLS cert (typical for UniFi).
    #[serde(default = "default_true")]
    pub insecure: bool,
}

fn default_poll() -> u64 {
    30
}
fn default_unifi_port() -> u16 {
    443
}
fn default_site() -> String {
    "default".into()
}
fn default_true() -> bool {
    true
}

impl Config {
    pub fn load(path: &str) -> Result<Self> {
        let data = std::fs::read_to_string(path).with_context(|| format!("read config {path}"))?;
        let cfg: Config = toml::from_str(&data).with_context(|| format!("parse config {path}"))?;
        Ok(cfg)
    }

    pub fn master_url(&self) -> &str {
        self.master_url.trim_end_matches('/')
    }
}

/// Persisted adoption state, written once the spark receives its node key.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct State {
    pub node_id: Option<String>,
    pub node_key: Option<String>,
}

impl State {
    fn path(dir: &Path) -> PathBuf {
        dir.join("spark-state.json")
    }

    pub fn load(dir: &Path) -> State {
        std::fs::read_to_string(Self::path(dir))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(Self::path(dir), json).context("write spark state")?;
        Ok(())
    }

    pub fn is_adopted(&self) -> bool {
        self.node_id.is_some() && self.node_key.is_some()
    }
}
