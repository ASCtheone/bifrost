//! Cross-handler helpers: spark ownership resolution, server-snapshot lookup,
//! and building per-node WireGuard client configs for a device.

use crate::domain::{Device, Node};
use crate::error::AppResult;
use crate::repo::{share_repo, user_repo};
use crate::wg::{self, WgConfigParams};
use sqlx::SqlitePool;

/// The WireGuard server details for a node, pulled from its reported
/// `actualConfig.servers[]` entry whose name matches `spark_vpn_name`.
pub struct SparkServer {
    pub public_key: String,
    pub server_port: i64,
    pub server_address: String,
}

/// Find the spark server snapshot for a node, if the agent has reported one.
pub fn spark_server_for(node: &Node) -> Option<SparkServer> {
    let name = node.spark_vpn_name.as_deref()?;
    let cfg = node.actual_config.as_ref()?;
    let servers = cfg.get("servers")?.as_array()?;
    let s = servers
        .iter()
        .find(|s| s.get("name").and_then(|v| v.as_str()) == Some(name))?;
    Some(SparkServer {
        public_key: s.get("publicKey").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        server_port: s.get("serverPort").and_then(|v| v.as_i64()).unwrap_or(51820),
        server_address: s
            .get("serverAddress")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// "City, Country" from a node's reported geo, if present.
pub fn node_location(node: &Node) -> Option<String> {
    let geo = node.geo.as_ref()?;
    let city = geo.get("city").and_then(|v| v.as_str()).unwrap_or("");
    let country = geo.get("country").and_then(|v| v.as_str()).unwrap_or("");
    Some(format!("{city}, {country}"))
}

/// Resolve which owner-email's sparks the caller may use. A super-admin/admin
/// uses their own email; a plain user borrows their owning admin's email.
pub async fn resolve_spark_owner(
    pool: &SqlitePool,
    email: &str,
    is_admin: bool,
    is_superadmin: bool,
) -> AppResult<String> {
    if is_admin || is_superadmin {
        return Ok(email.to_string());
    }
    Ok(user_repo::get_user_owner(pool, email)
        .await?
        .unwrap_or_else(|| email.to_string()))
}

/// The adopted nodes a given owner-email may use: owned outright, or shared with
/// them via a `spark_shares` entry.
pub async fn owned_nodes(pool: &SqlitePool, owner_email: &str, all_nodes: &[Node]) -> AppResult<Vec<Node>> {
    let shared: std::collections::HashSet<String> =
        share_repo::shared_node_ids_for_email(pool, owner_email)
            .await?
            .into_iter()
            .collect();
    Ok(all_nodes
        .iter()
        .filter(|n| n.adoption_status == "adopted")
        .filter(|n| n.owner_email == owner_email || shared.contains(&n.node_id))
        .cloned()
        .collect())
}

/// A per-node WireGuard config built for a device.
pub struct BuiltNodeConfig {
    pub node_id: String,
    pub node_name: String,
    pub server_name: String,
    pub server_public_key: String,
    pub endpoint: String,
    pub port: i64,
    pub wg_config: String,
    pub location: Option<String>,
    pub role: String,
    pub isp_name: Option<String>,
    pub speed_down: Option<f64>,
    pub speed_up: Option<f64>,
}

/// Build a WireGuard config for `device` against every eligible node: adopted,
/// owner-compatible with the device, with a known server public key and a WAN
/// IP to use as the endpoint. Consolidates the logic duplicated across
/// provision-device, auth-provision, and get-device-config.
pub fn build_device_configs(device: &Device, nodes: &[Node]) -> Vec<BuiltNodeConfig> {
    let device_owner = device.owner_email.as_str();
    let mut out = Vec::new();
    for node in nodes {
        if node.adoption_status != "adopted" {
            continue;
        }
        // Owner match: only skip when both owners are set and differ.
        let node_owner = node.owner_email.as_str();
        if !node_owner.is_empty() && !device_owner.is_empty() && node_owner != device_owner {
            continue;
        }
        let Some(server) = spark_server_for(node) else { continue };
        if server.public_key.is_empty() {
            continue;
        }
        let Some(wan_ip) = node.wan_ip.as_deref().filter(|s| !s.is_empty()) else { continue };

        let wg_config = wg::build_config(&WgConfigParams {
            private_key: &device.private_key,
            assigned_ip: &device.assigned_ip,
            dns: &device.dns.0,
            server_public_key: &server.public_key,
            preshared_key: &device.preshared_key,
            endpoint: wan_ip,
            port: server.server_port,
            allowed_ips: &device.allowed_ips.0,
        });

        out.push(BuiltNodeConfig {
            node_id: node.node_id.clone(),
            node_name: if node.node_name.is_empty() { node.node_id.clone() } else { node.node_name.clone() },
            server_name: node.spark_vpn_name.clone().unwrap_or_default(),
            server_public_key: server.public_key,
            endpoint: wan_ip.to_string(),
            port: server.server_port,
            wg_config,
            location: node_location(node),
            role: node.role.clone(),
            isp_name: node.isp_name.clone(),
            speed_down: node.speed_down,
            speed_up: node.speed_up,
        });
    }
    out
}
