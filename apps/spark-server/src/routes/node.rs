use crate::auth::validate_node_key;
use crate::error::{AppError, AppResult};
use crate::repo::device_repo;
use crate::repo::node_repo::{self, HeartbeatUpdate};
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, State};
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
    let unifi = match st
        .cipher
        .decrypt(node.unifi_password_enc.as_deref().unwrap_or(""))?
    {
        Some(pw) if !node.unifi_host.is_empty() && !node.unifi_username.is_empty() => json!({
            "host": node.unifi_host,
            "port": node.unifi_port,
            "site": node.unifi_site,
            "username": node.unifi_username,
            "password": pw,
            "insecure": node.unifi_insecure,
        }),
        _ => Value::Null,
    };

    Ok(Json(json!({
        "vpnName": node.spark_vpn_name,
        "peers": peers,
        "pendingPeerDeletions": pending,
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

    let update = HeartbeatUpdate {
        actual_config: b.get("actualConfig").cloned().unwrap_or(Value::Null),
        wan_ip: b.get("wanIp").and_then(Value::as_str).map(String::from),
        geo: b.get("geo").cloned().filter(|v| !v.is_null()),
        isp_name: b.get("ispName").and_then(Value::as_str).map(String::from),
        speed_down: b.get("speedDown").and_then(Value::as_f64),
        speed_up: b.get("speedUp").and_then(Value::as_f64),
        speed_ping: b.get("speedPing").and_then(Value::as_f64),
        spark_vpn_id: b.get("sparkVpnId").and_then(Value::as_str).map(String::from),
        pending_vpn_create: b.get("pendingVpnCreate").and_then(Value::as_bool),
        clear_peer_deletions: b
            .get("clearPeerDeletions")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };

    node_repo::update_heartbeat(&st.pool, &node_id, update).await?;
    Ok(Json(json!({ "success": true })))
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
