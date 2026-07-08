//! Public device provisioning by token (no auth; the token is the credential).

use crate::error::{AppError, AppResult};
use crate::repo::{device_repo, node_repo};
use crate::routes::shared;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::{routing::get, Json, Router};
use serde_json::{json, Value};

pub fn routes() -> Router<AppState> {
    Router::new().route("/provision/:token", get(provision))
}

async fn provision(State(st): State<AppState>, Path(token): Path<String>) -> AppResult<Json<Value>> {
    if token.is_empty() {
        return Err(AppError::BadRequest("Missing provision token".into()));
    }
    let device = device_repo::get_device_by_token(&st.pool, &token)
        .await?
        .ok_or_else(|| AppError::NotFound("Invalid provision token".into()))?;
    if device.status == "revoked" {
        return Err(AppError::Forbidden("Device has been revoked".into()));
    }

    let all_nodes = node_repo::query_all_nodes(&st.pool).await?;
    let configs = shared::build_device_configs(&device, &all_nodes);

    let nodes: Vec<Value> = configs
        .iter()
        .map(|c| {
            json!({
                "nodeId": c.node_id,
                "name": c.node_name,
                "serverName": c.server_name,
                "endpoint": c.endpoint,
                "port": c.port,
                "wgConfig": c.wg_config,
                "location": c.location,
                "role": c.role,
                "ispName": c.isp_name,
                "speedDown": c.speed_down,
                "speedUp": c.speed_up,
            })
        })
        .collect();
    let primary = configs.first().map(|c| c.wg_config.clone()).unwrap_or_default();

    Ok(Json(json!({
        "deviceId": device.device_id,
        "name": device.name,
        "type": device.device_type,
        "assignedIp": device.assigned_ip,
        "nodes": nodes,
        "config": primary,
    })))
}
