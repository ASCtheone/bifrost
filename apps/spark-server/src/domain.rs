//! Domain entities, ported from the old `dynamo-schema` `entities.ts`.
//! JSON-valued columns use `sqlx::types::Json<T>` which transparently
//! (de)serialises to TEXT for storage and to the inner `T` for API output.

use serde::{Deserialize, Serialize};
use sqlx::types::Json;
use sqlx::FromRow;

// ── Shared VPN config value types ────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VpnServerConfig {
    #[serde(default)]
    pub listen_port: i64,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub dns: Vec<String>,
    #[serde(default)]
    pub mtu: i64,
    #[serde(default)]
    pub host_address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VpnPeerDefaults {
    #[serde(default)]
    pub allowed_ips: Vec<String>,
    #[serde(default)]
    pub persistent_keepalive: i64,
}

// ── Node ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub node_id: String,
    pub node_name: String,
    pub owner_id: String,
    pub owner_email: String,
    pub status: String,
    pub role: String,
    pub priority: i64,
    pub last_seen: String,
    pub tunnel_url: String,
    pub tunnel_id: String,
    pub controller_url: String,
    pub controller_api_key: Option<String>,
    /// Optional WireGuard endpoint for devices. Empty = automatic (the spark's
    /// observed public IPv4). See routes::shared::node_endpoint.
    pub endpoint_override: String,
    /// UniFi controller the spark drives. Configured in the dashboard and served to
    /// the spark over its node-key channel, so nothing is hand-edited on the box.
    pub unifi_host: String,
    pub unifi_port: i64,
    pub unifi_site: String,
    pub unifi_username: String,
    /// base64(nonce || ciphertext) — see crypto::Cipher. Never leaves the server:
    /// the dashboard gets `hasUnifiPassword`, the spark gets the plaintext.
    #[serde(skip_serializing)]
    pub unifi_password_enc: Option<String>,
    /// The preferred credential — same encryption, same rule: the dashboard only ever
    /// learns whether one is set.
    #[serde(skip_serializing)]
    pub unifi_api_key_enc: Option<String>,
    pub unifi_insecure: bool,
    pub spark_vpn_name: Option<String>,
    pub spark_vpn_id: Option<String>,
    pub pending_vpn_create: bool,
    pub sync_state: String,
    pub last_applied_version: i64,
    pub actual_config: Option<Json<serde_json::Value>>,
    pub error: Option<String>,
    pub adoption_status: String,
    pub adoption_code: Option<String>,
    pub code_expires_at: Option<String>,
    /// Operator override: when true the control plane treats the node as offline.
    pub paused: bool,
    #[serde(skip_serializing)]
    pub node_key_hash: Option<String>,
    pub key_issued_at: Option<String>,
    pub wan_ip: Option<String>,
    pub geo: Option<Json<serde_json::Value>>,
    pub isp_name: Option<String>,
    pub speed_down: Option<f64>,
    pub speed_up: Option<f64>,
    pub speed_ping: Option<f64>,
    pub pending_peer_deletions: Option<Json<serde_json::Value>>,
    /// Queued management commands for the spark (create/update/delete server or peer),
    /// a JSON array drained on the spark's next cycle. See migration 0008.
    pub pending_commands: Option<Json<serde_json::Value>>,
    /// Outcome of the most recently executed commands (id, ok, error) — for the dashboard.
    pub command_results: Option<Json<serde_json::Value>>,
    /// The spark's self-reported running version (from its heartbeat).
    pub spark_version: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// ── Pending key (adoption handoff) ───────────────────────────────

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingKey {
    pub node_id: String,
    pub raw_key: String,
    pub expires_at: String,
}

// ── Device (VPN client) ──────────────────────────────────────────

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub device_id: String,
    pub node_id: String,
    pub name: String,
    #[sqlx(rename = "type")]
    #[serde(rename = "type")]
    pub device_type: String,
    pub status: String,
    pub provision_method: String,
    pub provision_token: Option<String>,
    pub assigned_ip: String,
    pub public_key: String,
    #[serde(skip_serializing)]
    pub private_key: String,
    #[serde(skip_serializing)]
    pub preshared_key: String,
    pub server_public_key: String,
    pub server_endpoint: String,
    pub server_port: i64,
    pub dns: Json<Vec<String>>,
    pub allowed_ips: Json<Vec<String>>,
    pub unifi_peer_id: Option<String>,
    pub enabled: bool,
    pub last_seen: Option<String>,
    pub created_by: String,
    pub owner_email: String,
    pub created_at: String,
    pub updated_at: String,
    /// Optional registration expiry (ISO-8601). None = never expires. Past =
    /// the device is treated as expired and provisioning is refused.
    #[serde(default)]
    pub expires_at: Option<String>,
}

// ── Peer (WireGuard peer) ────────────────────────────────────────

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub peer_id: String,
    pub name: String,
    pub server_id: String,
    pub node_id: String,
    pub unifi_peer_id: String,
    pub public_key: String,
    #[serde(skip_serializing)]
    pub private_key_encrypted: String,
    pub preshared_key: Option<String>,
    pub assigned_ip: String,
    pub allowed_ips: Json<Vec<String>>,
    pub endpoint: String,
    pub config_version: i64,
    pub enabled: bool,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

// ── VPN config (singleton) ───────────────────────────────────────

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnConfig {
    pub config_version: i64,
    pub server: Json<VpnServerConfig>,
    pub defaults: Json<VpnPeerDefaults>,
    pub updated_at: String,
    pub updated_by: String,
}

// ── IP pool ──────────────────────────────────────────────────────

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpPool {
    pub subnet_key: String,
    pub subnet: String,
    pub gateway: String,
    pub next_available: i64,
    pub total_addresses: i64,
}

// ── User (local identity; replaces Cognito) ──────────────────────

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub user_id: String,
    pub username: String,
    pub email: String,
    pub display_name: String,
    #[serde(skip_serializing)]
    pub password_hash: String,
    pub groups: Json<Vec<String>>,
    pub enabled: bool,
    pub status: String,
    pub owner_email: String,
    pub must_change: bool,
    pub created_at: String,
    pub updated_at: String,
}

// ── Spark share (a node shared with another user) ────────────────

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SparkShare {
    pub node_id: String,
    pub shared_with_email: String,
    pub shared_by_email: String,
    pub created_at: String,
}

// ── Connection log (device connection event) ─────────────────────

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionLog {
    pub device_id: String,
    pub seq: String,
    pub action: String,
    pub connected_node_id: Option<String>,
    pub connected_node_name: Option<String>,
    pub source_ip: String,
    pub location: Option<String>,
    pub user_agent: String,
    pub user_email: Option<String>,
    pub timestamp: String,
    pub expires_at: i64,
}

// ── System config (singleton) ────────────────────────────────────

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemConfig {
    pub heartbeat_interval_seconds: i64,
    pub stale_threshold_seconds: i64,
    pub sync_timeout_seconds: i64,
    pub max_retries: i64,
    pub drift_check_interval_seconds: i64,
    pub auto_promote_enabled: bool,
    pub auto_promote_stale_seconds: i64,
}
