use crate::state::AppState;
use axum::{routing::get, Json, Router};
use serde_json::{json, Value};

pub fn routes() -> Router<AppState> {
    Router::new().route("/health", get(health))
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}
