use crate::auth::validate_node_key;
use crate::error::{AppError, AppResult};
use crate::repo::device_repo;
use crate::repo::node_repo::{self, HeartbeatUpdate};
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::HeaderMap;
use axum::{
    routing::{get, put},
    Json, Router,
};
use serde_json::{json, Value};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/nodes/:nodeId/heartbeat", put(heartbeat))
        .route("/nodes/:nodeId/self", get(get_self))
        .route("/nodes/:nodeId/desired-config", get(desired_config))
}

/// GET /nodes/:nodeId/desired-config  (node-key auth)
///
/// The WireGuard peers this spark should provision on its UniFi server: one per
/// enabled device owned by the spark's owner, plus any queued peer deletions.
async fn desired_config(
    State(st): State<AppState>,
    Path(node_id): Path<String>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let key = node_key_header(&headers)?.to_string();
    validate_node_key(&st.pool, &node_id, &key).await?;

    let node = node_repo::get_node(&st.pool, &node_id)
        .await?
        .ok_or_else(|| AppError::NotFound("node not found".into()))?;
    let owner = node.owner_email.as_str();

    let peers: Vec<Value> = device_repo::query_all_devices(&st.pool)
        .await?
        .into_iter()
        .filter(|d| d.enabled && d.status != "revoked")
        .filter(|d| owner.is_empty() || d.owner_email == owner)
        .filter(|d| !d.public_key.is_empty())
        .map(|d| {
            let ip = d.assigned_ip.split('/').next().unwrap_or(&d.assigned_ip).to_string();
            json!({
                "name": d.name,
                "publicKey": d.public_key,
                "assignedIp": d.assigned_ip,
                "presharedKey": d.preshared_key,
                // On the server side a peer's allowed-ips is just its tunnel IP.
                "allowedIps": [format!("{ip}/32")],
            })
        })
        .collect();

    let pending: Vec<String> = node
        .pending_peer_deletions
        .as_ref()
        .and_then(|j| serde_json::from_value::<Vec<String>>(j.0.clone()).ok())
        .unwrap_or_default();

    // The UniFi controller this spark should drive. Configured in the dashboard and
    // handed over here — the spark no longer carries these in a local file.
    //
    // This is the one place the password is decrypted, and it goes only to a caller
    // that already proved it holds this node's key. `null` when the operator hasn't
    // filled it in yet (or the at-rest key was rotated, so the blob no longer
    // decrypts); the spark idles and says so rather than failing.
    let api_key = st
        .cipher
        .decrypt(node.unifi_api_key_enc.as_deref().unwrap_or(""))?;
    let password = st
        .cipher
        .decrypt(node.unifi_password_enc.as_deref().unwrap_or(""))?;

    // Either credential is enough. The API key is preferred — it is scoped, revocable
    // on its own, and needs no session/CSRF — with username+password kept as a
    // fallback for controllers too old to issue keys. Both are sent when both are set;
    // the spark picks the key.
    let has_login = !node.unifi_username.is_empty() && password.is_some();
    let unifi = if !node.unifi_host.is_empty() && (api_key.is_some() || has_login) {
        json!({
            "host": node.unifi_host,
            "port": node.unifi_port,
            "site": node.unifi_site,
            "apiKey": api_key,
            "username": (!node.unifi_username.is_empty()).then_some(node.unifi_username.clone()),
            "password": password,
            "insecure": node.unifi_insecure,
        })
    } else {
        Value::Null
    };

    // Queued management commands (create/update/delete server or peer) for the spark to
    // execute against the controller this cycle.
    let commands = node
        .pending_commands
        .as_ref()
        .map(|j| j.0.clone())
        .unwrap_or_else(|| json!([]));

    Ok(Json(json!({
        "vpnName": node.spark_vpn_name,
        // The id of the spark-owned server, once created — the spark selects by this.
        "vpnId": node.spark_vpn_id,
        // "Create VPN" was clicked and no server is bound yet: the spark creates one.
        "pendingVpnCreate": node.pending_vpn_create,
        // Operator pause: the spark disables its WireGuard server so clients disconnect.
        "paused": node.paused,
        "peers": peers,
        "pendingPeerDeletions": pending,
        "commands": commands,
        "unifi": unifi,
    })))
}

fn node_key_header(headers: &HeaderMap) -> AppResult<&str> {
    headers
        .get("x-node-key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("missing X-Node-Key header".into()))
}

/// PUT /nodes/:nodeId/heartbeat  (node-key auth)
async fn heartbeat(
    State(st): State<AppState>,
    Path(node_id): Path<String>,
    peer: Option<ConnectInfo<std::net::SocketAddr>>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Json<Value>> {
    let key = node_key_header(&headers)?.to_string();
    validate_node_key(&st.pool, &node_id, &key).await?;

    let b: Value = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&body)
            .map_err(|e| AppError::BadRequest(format!("invalid json body: {e}")))?
    };

    // The spark's public IP, taken from the connection rather than from the body.
    //
    // It used to self-report this after asking api.ipify.org, which meant a
    // third-party call every cycle, no IP at all on a host that can reach us but not
    // the open internet, and a value the node chose for itself. We can see the true
    // source address of this very request, so we use that. IPv4 only — see net.rs.
    //
    // `None` (an IPv6-only caller, or an unparseable header) leaves the stored value
    // untouched rather than clearing it: a working endpoint must not be dropped just
    // because one heartbeat arrived over IPv6.
    let observed_ip = crate::net::client_ipv4(&headers, peer.map(|ConnectInfo(a)| a));

    let update = HeartbeatUpdate {
        actual_config: b.get("actualConfig").cloned().unwrap_or(Value::Null),
        wan_ip: observed_ip,
        geo: b.get("geo").cloned().filter(|v| !v.is_null()),
        isp_name: b.get("ispName").and_then(Value::as_str).map(String::from),
        speed_down: b.get("speedDown").and_then(Value::as_f64),
        speed_up: b.get("speedUp").and_then(Value::as_f64),
        speed_ping: b.get("speedPing").and_then(Value::as_f64),
        spark_vpn_id: b.get("sparkVpnId").and_then(Value::as_str).map(String::from),
        pending_vpn_create: b.get("pendingVpnCreate").and_then(Value::as_bool),
        error: b
            .get("error")
            .and_then(Value::as_str)
            .map(String::from)
            .filter(|e| !e.is_empty()),
        clear_peer_deletions: b
            .get("clearPeerDeletions")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        spark_version: b.get("version").and_then(Value::as_str).map(String::from),
        backup_available: b.get("backupAvailable").and_then(Value::as_bool),
    };

    node_repo::update_heartbeat(&st.pool, &node_id, update).await?;

    // Acknowledge executed management commands: drop them from the queue and record their
    // results (id, ok, error) for the dashboard. The spark reports `commandResults` as an
    // array of { id, ok, error? }.
    if let Some(results) = b.get("commandResults").and_then(Value::as_array) {
        let executed_ids: Vec<String> = results
            .iter()
            .filter_map(|r| r.get("id").and_then(Value::as_str).map(String::from))
            .collect();
        if !executed_ids.is_empty() {
            node_repo::ack_commands(&st.pool, &node_id, &executed_ids, b.get("commandResults").unwrap())
                .await?;
        }
    }

    // Re-address any device whose IP predates our knowing this spark's subnet.
    //
    // wg::assign_ip derives a device's address from the WireGuard server's subnet, but
    // falls back to a hardcoded 192.168.8.1/24 when the server isn't known yet — which
    // is the case for any device created before the spark first heartbeated. UniFi then
    // refuses the peer outright (api.err.UserIpDoesNotBelongToNetwork) and the device
    // can never connect, with nothing in the UI to say why.
    //
    // The heartbeat is the moment we learn the real subnet, so it is the moment to fix
    // it. The allocation is deterministic in the device id, so a device keeps its host
    // octet and is simply rebased onto the right network — the same device always lands
    // on the same address.
    if let Some(node) = node_repo::get_node(&st.pool, &node_id).await? {
        if let Some(subnet) = reported_server_subnet(&node) {
            repair_device_ips(&st, &node, &subnet).await?;
        }
        reconcile_device_provisioning(&st, &node).await?;
    }

    Ok(Json(json!({ "success": true })))
}

/// Flip devices to `provisioned` once the spark confirms their WireGuard peer exists.
///
/// A device is created `pending`; only the spark can confirm the peer was actually
/// created on the UniFi controller. Each heartbeat's `actualConfig.peers` is the live
/// peer set the spark just read back ({id, publicKey, ...}). Matching a device's public
/// key against that set is the authoritative "the peer exists" signal — peer *names* are
/// sanitised (see spark `peer_name`) and can collide, the key cannot. Matched devices are
/// flipped to `provisioned` and stamped with the UniFi peer id.
///
/// Promotion only, never demotion: a heartbeat that reports an empty peer set (a UniFi
/// outage makes the spark report empty rather than fail) must not knock healthy devices
/// back to `pending`. The explicit path back to `pending` is Sync/`reset_for_resync`.
async fn reconcile_device_provisioning(st: &AppState, node: &crate::domain::Node) -> AppResult<()> {
    let Some(peers) = node
        .actual_config
        .as_ref()
        .and_then(|c| c.get("peers"))
        .and_then(Value::as_array)
    else {
        return Ok(());
    };
    // publicKey -> UniFi peer id, for the peers the controller actually has.
    let by_key: std::collections::HashMap<&str, &str> = peers
        .iter()
        .filter_map(|p| {
            Some((
                p.get("publicKey").and_then(Value::as_str)?,
                p.get("id").and_then(Value::as_str)?,
            ))
        })
        .filter(|(k, _)| !k.is_empty())
        .collect();
    if by_key.is_empty() {
        return Ok(());
    }

    let owner = node.owner_email.as_str();
    for d in device_repo::query_all_devices(&st.pool).await? {
        if d.status == "revoked" || d.public_key.is_empty() {
            continue;
        }
        if !owner.is_empty() && !d.owner_email.is_empty() && d.owner_email != owner {
            continue;
        }
        let Some(&peer_id) = by_key.get(d.public_key.as_str()) else {
            continue;
        };
        // Write only on an actual change, so a steady state doesn't rewrite every
        // device's `updated_at` on every heartbeat.
        if d.status != "provisioned" || d.unifi_peer_id.as_deref() != Some(peer_id) {
            device_repo::update_device_unifi_peer_id(&st.pool, &d.device_id, peer_id).await?;
            tracing::info!(
                device = %d.device_id, peer = %peer_id,
                "device peer confirmed on the controller — marked provisioned"
            );
        }
    }
    Ok(())
}

/// The WireGuard server subnet this spark manages, taken from what it just reported.
///
/// Prefer the named server (spark_vpn_name) when it's set, but fall back to the single
/// reported server otherwise — the name is only populated when a VPN was created via
/// the dashboard, and the IP repair must not wait on that. Returns None if there isn't
/// exactly one unambiguous server address to key off.
fn reported_server_subnet(node: &crate::domain::Node) -> Option<String> {
    if let Some(s) = crate::routes::shared::spark_server_for(node) {
        if !s.server_address.is_empty() {
            return Some(s.server_address);
        }
    }
    let servers = node.actual_config.as_ref()?.get("servers")?.as_array()?;
    if servers.len() != 1 {
        return None; // 0 = nothing yet; >1 = ambiguous, don't guess which
    }
    servers[0]
        .get("serverAddress")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
}

async fn repair_device_ips(
    st: &AppState,
    node: &crate::domain::Node,
    server_address: &str,
) -> AppResult<()> {
    let owner = node.owner_email.as_str();
    for d in device_repo::query_all_devices(&st.pool).await? {
        if d.status == "revoked" {
            continue;
        }
        if !owner.is_empty() && !d.owner_email.is_empty() && d.owner_email != owner {
            continue;
        }
        if crate::wg::ip_in_server_subnet(&d.assigned_ip, server_address) {
            continue;
        }
        let fixed = crate::wg::assign_ip(&d.device_id, Some(server_address));
        tracing::info!(
            device = %d.device_id,
            from = %d.assigned_ip,
            to = %fixed,
            subnet = %server_address,
            "device address was outside the spark's WireGuard subnet — re-addressed"
        );
        device_repo::update_device_ip(&st.pool, &d.device_id, &fixed).await?;
    }
    Ok(())
}

/// GET /nodes/:nodeId/self  (node-key auth)
async fn get_self(
    State(st): State<AppState>,
    Path(node_id): Path<String>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let key = node_key_header(&headers)?.to_string();
    validate_node_key(&st.pool, &node_id, &key).await?;

    let node = node_repo::get_node(&st.pool, &node_id)
        .await?
        .ok_or_else(|| AppError::NotFound("node not found".into()))?;

    Ok(Json(serde_json::to_value(node).map_err(|e| {
        AppError::Other(anyhow::anyhow!("serialize node: {e}"))
    })?))
}
