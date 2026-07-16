//! Control-plane self-update trigger + shared status.
//!
//! The control plane never touches Docker itself. It only drops a trigger file on a shared
//! volume; the updater sidecar — the sole holder of the Docker socket — watches for it and
//! pulls the latest server image + recreates this container. This keeps host-level
//! privilege out of the internet-facing control plane.
//!
//! Alongside the trigger it writes a small status marker (same shared volume) recording the
//! target version + start time. Because the volume survives the recreate, `GET /update-status`
//! (public) lets *every* client show a blocking "update in progress" screen for the whole
//! window — and clears itself once we're running the target version, or after a timeout if
//! the update failed and rolled back.

use crate::auth::AdminAuth;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::extract::State;
use axum::{routing::{get, post}, Json, Router};
use serde_json::{json, Value};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/update-self", post(update_self))
        // Public: any client (even pre-login) polls this to show the blocking overlay.
        .route("/update-status", get(update_status))
}

fn trigger_path() -> std::path::PathBuf {
    std::env::var("BIFROST_UPDATE_TRIGGER")
        .unwrap_or_else(|_| "/run/bifrost-update/request".into())
        .into()
}

/// The status marker lives next to the trigger, on the same shared volume.
fn status_path() -> std::path::PathBuf {
    trigger_path().with_file_name("status")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Give up showing "updating" after this long — covers a failed update that rolled back
/// onto the old version, which would otherwise leave the marker (and overlay) stuck.
const UPDATE_TIMEOUT_SECS: u64 = 5 * 60;

async fn update_self(State(st): State<AppState>, AdminAuth(_auth): AdminAuth) -> AppResult<Json<Value>> {
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
    // Record the shared "update in progress" marker BEFORE the trigger, so no client can
    // observe the recreate without also seeing the blocking status.
    let target = st.latest_version.read().map(|g| g.clone()).unwrap_or_default();
    let marker = json!({ "target": target, "startedAt": now_secs() });
    let _ = std::fs::write(status_path(), marker.to_string());

    std::fs::write(&path, b"update")
        .map_err(|e| AppError::Other(anyhow::anyhow!("could not signal the updater sidecar: {e}")))?;
    tracing::info!(%target, "self-update requested — signalled the updater sidecar");
    Ok(Json(json!({ "ok": true })))
}

/// GET /update-status — public. Whether a control-plane update is in progress, so every
/// client can block the UI until it finishes. Self-clears on completion or timeout.
async fn update_status() -> Json<Value> {
    let current = env!("CARGO_PKG_VERSION");
    let path = status_path();
    let Ok(data) = std::fs::read_to_string(&path) else {
        return Json(json!({ "updating": false, "current": current }));
    };
    let marker: Value = serde_json::from_str(&data).unwrap_or_else(|_| json!({}));
    let target = marker.get("target").and_then(|v| v.as_str()).unwrap_or_default();
    let started = marker.get("startedAt").and_then(|v| v.as_u64()).unwrap_or(0);

    // Completed: we're now running the target version — done.
    if !target.is_empty() && current == target {
        let _ = std::fs::remove_file(&path);
        return Json(json!({ "updating": false, "current": current, "justCompleted": true }));
    }
    // Timed out (e.g. failed + rolled back) — stop blocking.
    if now_secs().saturating_sub(started) > UPDATE_TIMEOUT_SECS {
        let _ = std::fs::remove_file(&path);
        return Json(json!({ "updating": false, "current": current, "stale": true }));
    }
    Json(json!({ "updating": true, "current": current, "target": target, "startedAt": started }))
}
