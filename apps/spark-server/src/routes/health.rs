use crate::state::AppState;
use axum::extract::{Query, State};
use axum::{routing::get, Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/version", get(version))
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

/// The control plane's own version vs. the latest published release — drives the
/// dashboard's "update available" notification for the dashboard/control plane itself.
async fn version(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> Json<Value> {
    let current = env!("CARGO_PKG_VERSION");
    // `?refresh=1` forces an immediate GitHub check so a "Check for updates" click
    // surfaces a fresh release without waiting for the background poll.
    if q.get("refresh").map(|v| v == "1" || v == "true").unwrap_or(false) {
        if let Some(v) = crate::release::fetch_latest().await {
            if let Ok(mut w) = st.latest_version.write() {
                *w = v;
            }
        }
    }
    let latest = st
        .latest_version
        .read()
        .map(|g| g.clone())
        .unwrap_or_else(|_| current.to_string());
    Json(json!({
        "current": current,
        "latest": latest,
        "updateAvailable": crate::release::version_lt(current, &latest),
    }))
}
