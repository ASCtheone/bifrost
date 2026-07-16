use crate::state::AppState;
use axum::extract::State;
use axum::{routing::get, Json, Router};
use serde_json::{json, Value};

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
async fn version(State(st): State<AppState>) -> Json<Value> {
    let current = env!("CARGO_PKG_VERSION");
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
