//! VPN config editing and force-resync (admin).

use crate::auth::AdminAuth;
use crate::error::{AppError, AppResult};
use crate::repo::{audit_repo, config_repo};
use crate::state::AppState;
use axum::extract::State;
use axum::{routing::{post, put}, Json, Router};
use serde_json::{json, Value};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/vpn-config", put(update_vpn_config))
        .route("/force-resync", post(force_resync))
}

#[derive(serde::Deserialize, Default)]
struct UpdateVpnConfigReq {
    #[serde(default)]
    server: Option<Value>,
    #[serde(default)]
    defaults: Option<Value>,
}

async fn update_vpn_config(
    State(st): State<AppState>,
    AdminAuth(auth): AdminAuth,
    body: Option<Json<UpdateVpnConfigReq>>,
) -> AppResult<Json<Value>> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    if req.server.is_none() && req.defaults.is_none() {
        return Err(AppError::BadRequest("No config fields provided".into()));
    }
    let mut fields = Vec::new();
    if req.server.is_some() {
        fields.push("server");
    }
    if req.defaults.is_some() {
        fields.push("defaults");
    }
    config_repo::update_vpn_config(&st.pool, req.server, req.defaults, &auth.sub).await?;
    audit_repo::write_audit_log(
        &st.pool,
        "config.updated",
        &auth.sub,
        "vpnConfig",
        json!({ "fields": fields }),
    )
    .await?;
    Ok(Json(json!({ "success": true })))
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ForceResyncReq {
    #[serde(default)]
    node_id: Option<String>,
}

async fn force_resync(
    State(st): State<AppState>,
    AdminAuth(auth): AdminAuth,
    body: Option<Json<ForceResyncReq>>,
) -> AppResult<Json<Value>> {
    let node_id = body.and_then(|Json(b)| b.node_id);
    config_repo::increment_config_version(&st.pool, &auth.sub).await?;
    let target = node_id.clone().unwrap_or_else(|| "all".into());
    audit_repo::write_audit_log(
        &st.pool,
        "config.force_resync",
        &auth.sub,
        &target,
        json!({ "scope": if node_id.is_some() { "single" } else { "all" } }),
    )
    .await?;
    Ok(Json(json!({ "success": true, "target": target })))
}
