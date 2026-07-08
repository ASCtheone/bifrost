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
    pub cognito_issuer: Option<String>,
    pub cognito_audience: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    #[default]
    Cognito,
    Local,
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
