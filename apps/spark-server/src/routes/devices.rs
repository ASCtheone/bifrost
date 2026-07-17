//! Device (VPN client) management + connection logs.

use crate::auth::AdminAuth;
use crate::domain::Device;
use crate::error::{AppError, AppResult};
use crate::repo::{conn_log_repo, device_repo, node_repo};
use crate::routes::shared;
use crate::state::AppState;
use crate::util;
use crate::wg;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::{routing::{get, post}, Json, Router};
use serde_json::{json, Value};
use sqlx::types::Json as SqlxJson;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/devices", get(list_devices).post(create_device))
        .route("/devices/:deviceId", axum::routing::put(update_device).delete(delete_device))
        .route("/devices/:deviceId/sync", post(sync_device))
        // Router client remote update/revert (applied by the router on its next poll).
        .route("/devices/:deviceId/update", post(update_device_client))
        .route("/devices/:deviceId/revert", post(revert_device_client))
        .route("/devices/:deviceId/safe-mode", post(safe_mode_device))
        .route("/devices/:deviceId/config", get(get_device_config))
        .route("/devices/:deviceId/logs", get(get_logs).post(post_log))
}

// ── GET /devices ────────────────────────────────────────────────

async fn list_devices(State(st): State<AppState>, AdminAuth(auth): AdminAuth) -> AppResult<Json<Value>> {
    let devices = device_repo::query_all_devices(&st.pool).await?;
    let is_super = auth.is_superadmin();
    let latest = st.latest_version.read().map(|g| g.clone()).unwrap_or_default();
    let list: Vec<Value> = devices
        .into_iter()
        .filter(|d| is_super || d.owner_email == auth.email)
        .map(|d| {
            json!({
                "id": d.device_id,
                "name": d.name,
                "type": d.device_type,
                "status": d.status,
                "assignedIp": d.assigned_ip,
                "publicKey": d.public_key,
                "enabled": d.enabled,
                "nodeId": d.node_id,
                "provisionMethod": d.provision_method,
                "ownerEmail": if d.owner_email.is_empty() { Value::Null } else { json!(d.owner_email) },
                "lastSeen": d.last_seen,
                "createdAt": d.created_at,
                "expiresAt": d.expires_at,
                // Router client version + self-update state.
                "clientVersion": d.client_version,
                "latestVersion": latest,
                "updateAvailable": d.client_version.as_deref().map_or(false, |v| crate::release::version_lt(v, &latest)),
                "backupAvailable": d.device_backup_available,
                "pendingAction": d.pending_action,
                "safeMode": d.safe_mode,
            })
        })
        .collect();
    Ok(Json(json!({ "devices": list })))
}

// ── POST /devices ───────────────────────────────────────────────

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CreateDeviceReq {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    r#type: Option<String>,
    #[serde(default)]
    node_id: Option<String>,
    #[serde(default)]
    provision_method: Option<String>,
}

async fn create_device(
    State(st): State<AppState>,
    AdminAuth(auth): AdminAuth,
    body: Option<Json<CreateDeviceReq>>,
) -> AppResult<Json<Value>> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let name = req.name.filter(|s| !s.is_empty()).ok_or_else(|| AppError::BadRequest("Device name is required".into()))?;
    let device_type = req.r#type.unwrap_or_else(|| "laptop".into());
    let provision_method = req.provision_method.unwrap_or_else(|| "qrcode".into());

    let spark_owner =
        shared::resolve_spark_owner(&st.pool, &auth.email, auth.is_admin(), auth.is_superadmin()).await?;
    let all_nodes = node_repo::query_all_nodes(&st.pool).await?;
    let owner_nodes = shared::owned_nodes(&st.pool, &spark_owner, &all_nodes).await?;

    let node_id = match req.node_id.filter(|s| !s.is_empty()) {
        Some(id) => id,
        None => {
            owner_nodes
                .first()
                .map(|n| n.node_id.clone())
                .ok_or_else(|| AppError::BadRequest("No sparks available for your account".into()))?
        }
    };
    let node = node_repo::get_node(&st.pool, &node_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Spark not found".into()))?;
    let server = shared::spark_server_for(&node);

    let device_id = util::device_id();
    let kp = wg::generate_keypair();
    let now = util::now_iso();
    let assigned_ip = wg::assign_ip(&device_id, server.as_ref().map(|s| s.server_address.as_str()));
    let provision_token = util::provision_token();

    let device = Device {
        device_id: device_id.clone(),
        node_id,
        name: name.clone(),
        device_type: device_type.clone(),
        status: "pending".into(),
        provision_method: provision_method.clone(),
        provision_token: Some(provision_token.clone()),
        assigned_ip: assigned_ip.clone(),
        public_key: kp.public_key,
        private_key: kp.private_key,
        preshared_key: wg::generate_preshared_key(),
        server_public_key: server.as_ref().map(|s| s.public_key.clone()).unwrap_or_default(),
        server_endpoint: node.controller_url.clone(),
        server_port: server.as_ref().map(|s| s.server_port).unwrap_or(51830),
        dns: SqlxJson(vec!["1.1.1.1".into(), "8.8.8.8".into()]),
        allowed_ips: SqlxJson(vec!["0.0.0.0/0".into()]),
        unifi_peer_id: None,
        enabled: true,
        last_seen: None,
        created_by: auth.sub.clone(),
        owner_email: auth.email.clone(),
        created_at: now.clone(),
        updated_at: now,
        expires_at: None,
        client_version: None,
        pending_action: None,
        device_backup_available: false,
        safe_mode: false,
    };
    device_repo::put_device(&st.pool, &device).await?;

    Ok(Json(json!({
        "device": {
            "id": device_id,
            "name": name,
            "type": device_type,
            "assignedIp": assigned_ip,
            "provisionToken": provision_token,
            "provisionMethod": provision_method,
        }
    })))
}

// ── PUT /devices/{deviceId} ─────────────────────────────────────

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct UpdateDeviceReq {
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default, deserialize_with = "crate::routes::de_opt_field")]
    owner_email: Option<Option<String>>,
}

async fn update_device(
    State(st): State<AppState>,
    AdminAuth(auth): AdminAuth,
    Path(device_id): Path<String>,
    body: Option<Json<UpdateDeviceReq>>,
) -> AppResult<Json<Value>> {
    device_repo::get_device(&st.pool, &device_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Device not found".into()))?;
    let req = body.map(|Json(b)| b).unwrap_or_default();

    if let Some(enabled) = req.enabled {
        device_repo::update_device_status(&st.pool, &device_id, enabled).await?;
    }
    if let Some(owner) = req.owner_email {
        if !auth.is_superadmin() {
            return Err(AppError::Forbidden("Only superadmins can reassign devices".into()));
        }
        device_repo::set_device_owner(&st.pool, &device_id, &owner.unwrap_or_default()).await?;
    }
    Ok(Json(json!({ "success": true })))
}

// ── DELETE /devices/{deviceId} ──────────────────────────────────

async fn delete_device(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path(device_id): Path<String>,
) -> AppResult<Json<Value>> {
    let device = device_repo::get_device(&st.pool, &device_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Device not found".into()))?;
    let peer_name = format!("bifrost-{}", device.name);

    for node in node_repo::query_all_nodes(&st.pool).await? {
        if node.adoption_status != "adopted" {
            continue;
        }
        let ids: Vec<String> = node
            .actual_config
            .as_ref()
            .and_then(|c| c.get("peers").and_then(|p| p.as_array()).cloned())
            .unwrap_or_default()
            .iter()
            .filter(|p| p.get("name").and_then(|v| v.as_str()) == Some(peer_name.as_str()))
            .filter_map(|p| p.get("id").and_then(|v| v.as_str()).map(String::from))
            .collect();
        node_repo::append_pending_peer_deletions(&st.pool, &node.node_id, &ids).await?;
    }

    device_repo::delete_device(&st.pool, &device_id).await?;
    Ok(Json(json!({ "success": true })))
}

// ── POST /devices/{deviceId}/sync ───────────────────────────────

async fn sync_device(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path(device_id): Path<String>,
) -> AppResult<Json<Value>> {
    device_repo::get_device(&st.pool, &device_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Device not found".into()))?;
    device_repo::reset_for_resync(&st.pool, &device_id).await?;
    Ok(Json(json!({ "success": true })))
}

// ── Router client remote update / revert ────────────────────────

async fn update_device_client(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path(device_id): Path<String>,
) -> AppResult<Json<Value>> {
    device_repo::get_device(&st.pool, &device_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Device not found".into()))?;
    device_repo::set_pending_action(&st.pool, &device_id, "update").await?;
    Ok(Json(json!({ "ok": true })))
}

async fn revert_device_client(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path(device_id): Path<String>,
) -> AppResult<Json<Value>> {
    device_repo::get_device(&st.pool, &device_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Device not found".into()))?;
    device_repo::set_pending_action(&st.pool, &device_id, "revert").await?;
    Ok(Json(json!({ "ok": true })))
}

/// POST /devices/{deviceId}/safe-mode {"on": bool} — queue the router's unlock override
/// (safe mode) on/off. The router picks it up on its next provision poll.
async fn safe_mode_device(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path(device_id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    device_repo::get_device(&st.pool, &device_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Device not found".into()))?;
    let on = body.get("on").and_then(|v| v.as_bool()).unwrap_or(false);
    let action = if on { "unlock" } else { "resume" };
    device_repo::set_pending_action(&st.pool, &device_id, action).await?;
    Ok(Json(json!({ "ok": true, "pendingAction": action })))
}

// ── GET /devices/{deviceId}/config ──────────────────────────────

async fn get_device_config(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path(device_id): Path<String>,
) -> AppResult<Json<Value>> {
    let device = device_repo::get_device(&st.pool, &device_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Device not found".into()))?;
    let all_nodes = node_repo::query_all_nodes(&st.pool).await?;
    let configs = shared::build_device_configs(&device, &all_nodes);

    let configs_json: Vec<Value> = configs
        .iter()
        .map(|c| {
            json!({
                "nodeId": c.node_id,
                "nodeName": c.node_name,
                "serverName": c.server_name,
                "wgConfig": c.wg_config,
                "serverPublicKey": c.server_public_key,
                "endpoint": c.endpoint,
                "port": c.port,
            })
        })
        .collect();
    let primary = configs
        .iter()
        .find(|c| c.node_id == device.node_id)
        .or_else(|| configs.first())
        .map(|c| c.wg_config.clone())
        .unwrap_or_default();

    Ok(Json(json!({
        "deviceId": device.device_id,
        "name": device.name,
        "assignedIp": device.assigned_ip,
        "provisionToken": device.provision_token,
        "config": primary,
        "configs": configs_json,
    })))
}

// ── Connection logs ─────────────────────────────────────────────

async fn get_logs(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path(device_id): Path<String>,
) -> AppResult<Json<Value>> {
    let logs: Vec<Value> = conn_log_repo::recent(&st.pool, &device_id, 50)
        .await?
        .into_iter()
        .map(|l| {
            json!({
                "action": l.action,
                "sourceIp": l.source_ip,
                "location": l.location,
                "connectedNodeName": l.connected_node_name,
                "userAgent": l.user_agent,
                "timestamp": l.timestamp,
            })
        })
        .collect();
    Ok(Json(json!({ "logs": logs })))
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LogReq {
    #[serde(default)]
    action: Option<String>,
    #[serde(default)]
    connected_node_id: Option<String>,
    #[serde(default)]
    connected_node_name: Option<String>,
    #[serde(default)]
    client_ip: Option<String>,
    #[serde(default)]
    location: Option<String>,
}

async fn post_log(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path(device_id): Path<String>,
    headers: HeaderMap,
    body: Option<Json<LogReq>>,
) -> AppResult<Json<Value>> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let seq = format!("{}#{}", util::now_iso(), util::short_suffix());
    let source_ip = req
        .client_ip
        .filter(|s| !s.is_empty())
        .or_else(|| forwarded_ip(&headers))
        .unwrap_or_else(|| "unknown".into());
    let user_agent = headers.get("user-agent").and_then(|v| v.to_str().ok()).unwrap_or("unknown");

    conn_log_repo::insert(
        &st.pool,
        &device_id,
        &seq,
        req.action.as_deref().unwrap_or("connect"),
        req.connected_node_id.as_deref(),
        req.connected_node_name.as_deref(),
        &source_ip,
        req.location.as_deref(),
        user_agent,
        None,
        &util::now_iso(),
        util::now_unix() + 90 * 24 * 60 * 60,
    )
    .await?;
    Ok(Json(json!({ "success": true })))
}

fn forwarded_ip(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
