//! Control-plane self-update trigger.
//!
//! The control plane never touches Docker itself. It only drops a trigger file on a shared
//! volume; the updater sidecar — the sole holder of the Docker socket — watches for it and
//! pulls the latest server image + recreates this container. This keeps host-level
//! privilege out of the internet-facing control plane.

use crate::auth::AdminAuth;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::{routing::post, Json, Router};
use serde_json::{json, Value};

pub fn routes() -> Router<AppState> {
    Router::new().route("/update-self", post(update_self))
}

fn trigger_path() -> std::path::PathBuf {
    std::env::var("BIFROST_UPDATE_TRIGGER")
        .unwrap_or_else(|_| "/run/bifrost-update/request".into())
        .into()
}

async fn update_self(AdminAuth(_auth): AdminAuth) -> AppResult<Json<Value>> {
    let path = trigger_path();
    // The parent dir is the shared volume; its absence means the sidecar isn't wired up.
    if let Some(dir) = path.parent() {
        if !dir.exists() {
            return Err(AppError::Conflict(
                "Self-update isn't configured on this deployment — the updater sidecar and its \
                 shared volume are missing"
                    .into(),
            ));
        }
    }
    std::fs::write(&path, b"update")
        .map_err(|e| AppError::Other(anyhow::anyhow!("could not signal the updater sidecar: {e}")))?;
    tracing::info!("self-update requested — signalled the updater sidecar");
    Ok(Json(json!({ "ok": true })))
}
