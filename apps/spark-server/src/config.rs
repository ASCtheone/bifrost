use anyhow::Context;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    #[serde(default = "default_node_id")]
    pub node_id: String,
    #[serde(default = "default_bind_addr")]
    pub bind_addr: String,
    #[serde(default = "default_api_port")]
    pub api_port: u16,
    #[serde(default = "default_database_url")]
    pub database_url: String,
    #[serde(default)]
    pub auth: AuthConfig,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AuthConfig {
    #[serde(default)]
    pub mode: AuthMode,
    /// HS256 secret for signing/verifying our own JWTs (local mode). If unset,
    /// an ephemeral secret is generated at startup (tokens won't survive a
    /// restart — set this in production).
    pub jwt_secret: Option<String>,
    /// Access-token lifetime in hours.
    #[serde(default = "default_token_ttl_hours")]
    pub token_ttl_hours: i64,
    /// Optional first-run bootstrap: if no users exist, create this superadmin.
    pub bootstrap_admin_email: Option<String>,
    pub bootstrap_admin_password: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    /// Local identity store with self-issued JWTs (no AWS dependency).
    #[default]
    Local,
}

fn default_token_ttl_hours() -> i64 {
    720 // 30 days
}

fn default_node_id() -> String {
    "control-1".into()
}
fn default_bind_addr() -> String {
    "0.0.0.0".into()
}
fn default_api_port() -> u16 {
    8443
}
fn default_database_url() -> String {
    "sqlite://data/bifrost.db".into()
}

impl Default for Config {
    fn default() -> Self {
        Config {
            node_id: default_node_id(),
            bind_addr: default_bind_addr(),
            api_port: default_api_port(),
            database_url: default_database_url(),
            auth: AuthConfig::default(),
        }
    }
}

impl Config {
    pub fn load(path: &str) -> anyhow::Result<Self> {
        if !Path::new(path).exists() {
            tracing::warn!("config {path} not found, using defaults");
            return Ok(Config::default());
        }
        let data =
            std::fs::read_to_string(path).with_context(|| format!("read config {path}"))?;
        let cfg: Config = toml::from_str(&data).with_context(|| format!("parse config {path}"))?;
        Ok(cfg)
    }
}
