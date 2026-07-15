//! Cross-handler helpers: spark ownership resolution, server-snapshot lookup,
//! and building per-node WireGuard client configs for a device.

use crate::domain::{Device, Node};
use crate::error::AppResult;
use crate::repo::{device_repo, node_repo, share_repo, user_repo};
use crate::util;
use crate::wg::{self, WgConfigParams};
use sqlx::types::Json as SqlxJson;
use sqlx::SqlitePool;

/// The WireGuard server details for a node, pulled from its reported
/// `actualConfig.servers[]` entry whose name matches `spark_vpn_name`.
pub struct SparkServer {
    pub public_key: String,
    pub server_port: i64,
    pub server_address: String,
}

/// Find the spark server snapshot for a node, if the agent has reported one.
/// The UniFi WireGuard server this spark manages, from what it last reported.
///
/// If `spark_vpn_name` is set (a VPN created through the dashboard), match that
/// server by name. Otherwise fall back to the sole reported server — the name is
/// only populated by the create-VPN flow, and a device must not be denied a config
/// just because the operator picked an existing server instead of creating one
/// through us. This is what a router hits: without the fallback, `build_device_configs`
/// skips the node and the router shows "No spark available yet" despite a healthy
/// spark. With zero or several servers reported there is nothing unambiguous to pick.
pub fn spark_server_for(node: &Node) -> Option<SparkServer> {
    let servers = node.actual_config.as_ref()?.get("servers")?.as_array()?;
    // Select by the spark-owned server id — an exact match on the server the spark created
    // and reports it manages. This is the authoritative binding; the spark selects the
    // same id on its side, so the two never disagree about which server holds the peers.
    //
    // Fallbacks, in order, cover pre-id state: match by name (a dashboard-created VPN),
    // then the sole reported server (the spark reports exactly one — its own). Genuine
    // ambiguity — several reported servers, none identified — is refused rather than
    // guessed, which is what once put peers on the wrong instance.
    let by_id = node
        .spark_vpn_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .and_then(|id| servers.iter().find(|s| s.get("id").and_then(|v| v.as_str()) == Some(id)));
    let by_name = || {
        node.spark_vpn_name
            .as_deref()
            .filter(|n| !n.is_empty())
            .and_then(|name| servers.iter().find(|s| s.get("name").and_then(|v| v.as_str()) == Some(name)))
    };
    let s = match by_id.or_else(by_name) {
        Some(s) => s,
        None if servers.len() == 1 => &servers[0],
        None => return None,
    };
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

/// The host a device should put in its WireGuard `Endpoint`.
///
/// Automatic by default: the spark's public IPv4, as observed by the control plane on
/// each heartbeat (see net.rs) — so a site with a changing WAN address needs no
/// configuration and no dynamic-DNS record. `endpoint_override` wins when set, which
/// is what you want for a DDNS name or a static address.
///
/// `None` means we cannot build a config for this node at all: an endpoint we invented
/// would produce a `.conf` that silently never connects, which is worse than refusing.
/// This is also why a spark that has never heartbeated yields no device configs — it
/// has no known address yet.
pub fn node_endpoint(node: &Node) -> Option<String> {
    let overridden = node.endpoint_override.trim();
    if !overridden.is_empty() {
        return Some(overridden.to_string());
    }
    node.wan_ip
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Build a WireGuard config for `device` against every eligible node: adopted,
/// owner-compatible with the device, with a known server public key and an endpoint
/// (see `node_endpoint`). Consolidates the logic duplicated across provision-device,
/// auth-provision, and get-device-config.
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
        // From here the node is a candidate for this device, so a skip is a real reason
        // the device gets no config ("No spark available" in the UI). Log which one — the
        // three below are the only ways a healthy, adopted, owner-matched spark still
        // yields nothing, and each used to fail silently.
        let Some(server) = spark_server_for(node) else {
            tracing::info!(
                node = %node.node_id, device = %device.device_id,
                spark_vpn_name = ?node.spark_vpn_name,
                "device gets no config here: no reported WireGuard server matched (and not a single unambiguous one to fall back to)"
            );
            continue;
        };
        if server.public_key.is_empty() {
            tracing::info!(
                node = %node.node_id, device = %device.device_id,
                "device gets no config here: the reported server has an empty public key"
            );
            continue;
        }
        let Some(endpoint) = node_endpoint(node) else {
            tracing::info!(
                node = %node.node_id, device = %device.device_id,
                "device gets no config here: node has no endpoint (spark never heartbeated an IPv4 and no endpoint override is set)"
            );
            continue;
        };

        let wg_config = wg::build_config(&WgConfigParams {
            private_key: &device.private_key,
            assigned_ip: &device.assigned_ip,
            dns: &device.dns.0,
            server_public_key: &server.public_key,
            preshared_key: &device.preshared_key,
            endpoint: &endpoint,
            port: server.server_port,
            allowed_ips: &device.allowed_ips.0,
        });

        out.push(BuiltNodeConfig {
            node_id: node.node_id.clone(),
            node_name: if node.node_name.is_empty() { node.node_id.clone() } else { node.node_name.clone() },
            server_name: node.spark_vpn_name.clone().unwrap_or_default(),
            server_public_key: server.public_key,
            endpoint: endpoint.clone(),
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

/// Create a new device for an owner. Binds against their first eligible spark if
/// one exists; otherwise the device is created with an empty `node_id` and no
/// server details — it activates automatically once a spark is adopted (configs
/// are matched by owner, not by node_id). Used by device-code registration.
#[allow(clippy::too_many_arguments)]
pub async fn create_device_for_owner(
    pool: &SqlitePool,
    owner_email: &str,
    created_by: &str,
    name: &str,
    device_type: &str,
    provision_method: &str,
    expires_at: Option<String>,
) -> AppResult<Device> {
    let all_nodes = node_repo::query_all_nodes(pool).await?;
    let owner_nodes = owned_nodes(pool, owner_email, &all_nodes).await?;
    let node = owner_nodes.first();
    let server = node.and_then(spark_server_for);
    let device_id = util::device_id();
    let kp = wg::generate_keypair();
    let now = util::now_iso();
    let assigned_ip = wg::assign_ip(&device_id, server.as_ref().map(|s| s.server_address.as_str()));

    let device = Device {
        device_id,
        node_id: node.map(|n| n.node_id.clone()).unwrap_or_default(),
        name: name.to_string(),
        device_type: device_type.to_string(),
        status: "pending".into(),
        provision_method: provision_method.to_string(),
        provision_token: Some(util::provision_token()),
        assigned_ip,
        public_key: kp.public_key,
        private_key: kp.private_key,
        preshared_key: wg::generate_preshared_key(),
        server_public_key: server.as_ref().map(|s| s.public_key.clone()).unwrap_or_default(),
        server_endpoint: node.map(|n| n.controller_url.clone()).unwrap_or_default(),
        server_port: server.as_ref().map(|s| s.server_port).unwrap_or(51830),
        dns: SqlxJson(vec!["1.1.1.1".into(), "8.8.8.8".into()]),
        allowed_ips: SqlxJson(vec!["0.0.0.0/0".into()]),
        unifi_peer_id: None,
        enabled: true,
        last_seen: None,
        created_by: created_by.to_string(),
        owner_email: owner_email.to_string(),
        created_at: now.clone(),
        updated_at: now,
        expires_at,
    };
    device_repo::put_device(pool, &device).await?;
    Ok(device)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node_with(spark_vpn_name: Option<&str>, servers: serde_json::Value) -> Node {
        Node {
            spark_vpn_name: spark_vpn_name.map(String::from),
            actual_config: Some(SqlxJson(json!({ "servers": servers, "peers": [] }))),
            ..Default::default()
        }
    }

    #[test]
    fn selects_the_owned_server_by_id_over_name_and_count() {
        // Two servers reported; the spark-owned id must win, not name or "first".
        let servers = json!([
            { "id": "aaa", "name": "SPARK VPN", "publicKey": "WRONG", "serverPort": 51820, "serverAddress": "" },
            { "id": "bbb", "name": "Miguel VPN APT", "publicKey": "RIGHT", "serverPort": 51821, "serverAddress": "10.13.0.1/24" },
        ]);
        let node = Node {
            spark_vpn_id: Some("bbb".into()),
            spark_vpn_name: Some("SPARK VPN".into()), // deliberately points at the other one
            actual_config: Some(SqlxJson(json!({ "servers": servers, "peers": [] }))),
            ..Default::default()
        };
        let s = spark_server_for(&node).expect("should select by id");
        assert_eq!(s.public_key, "RIGHT");
        assert_eq!(s.server_address, "10.13.0.1/24");
    }

    fn one_server() -> serde_json::Value {
        json!([{ "name": "Miguel VPN APT", "publicKey": "PUBKEY", "serverPort": 51821, "serverAddress": "192.168.3.1/24" }])
    }

    #[test]
    fn falls_back_to_the_sole_server_when_the_name_does_not_match() {
        // The regression: "Create VPN" stored "SPARK VPN", but the spark provisions on
        // (and reports) the pre-existing "Miguel VPN APT". A strict read side returned
        // None here and the router showed "No spark available".
        let node = node_with(Some("SPARK VPN"), one_server());
        let s = spark_server_for(&node).expect("should fall back to the sole server");
        assert_eq!(s.public_key, "PUBKEY");
        assert_eq!(s.server_port, 51821);
    }

    #[test]
    fn prefers_the_named_server_when_it_matches() {
        let servers = json!([
            { "name": "other", "publicKey": "WRONG", "serverPort": 51820, "serverAddress": "" },
            { "name": "Miguel VPN APT", "publicKey": "RIGHT", "serverPort": 51821, "serverAddress": "" },
        ]);
        let node = node_with(Some("Miguel VPN APT"), servers);
        assert_eq!(spark_server_for(&node).unwrap().public_key, "RIGHT");
    }

    #[test]
    fn refuses_to_guess_among_several_unmatched_servers() {
        let servers = json!([
            { "name": "a", "publicKey": "A", "serverPort": 1, "serverAddress": "" },
            { "name": "b", "publicKey": "B", "serverPort": 2, "serverAddress": "" },
        ]);
        let node = node_with(Some("SPARK VPN"), servers);
        assert!(spark_server_for(&node).is_none());
    }

    #[test]
    fn uses_the_sole_server_when_no_name_is_set() {
        let node = node_with(None, one_server());
        assert_eq!(spark_server_for(&node).unwrap().public_key, "PUBKEY");
    }

    #[test]
    fn none_when_no_config_reported() {
        let node = Node { spark_vpn_name: Some("x".into()), actual_config: None, ..Default::default() };
        assert!(spark_server_for(&node).is_none());
    }
}
