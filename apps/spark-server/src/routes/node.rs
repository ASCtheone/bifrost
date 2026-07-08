use crate::auth::validate_node_key;
use crate::error::{AppError, AppResult};
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
