//! Unauthenticated spark-agent bootstrap routes: register (adoption-code auth)
//! and await-adoption (polls for the one-time node key handoff).

use crate::error::{AppError, AppResult};
use crate::repo::node_repo;
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::{routing::{get, post}, Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/agent/register", post(register))
        .route("/agent/await-adoption", get(await_adoption))
}

// ── POST /agent/register (adoption-code auth) ───────────────────

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RegisterReq {
    #[serde(default)]
    adoption_code: Option<String>,
}

async fn register(
    State(st): State<AppState>,
    body: Option<Json<RegisterReq>>,
) -> AppResult<Json<Value>> {
    let code = body
        .and_then(|Json(b)| b.adoption_code)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("Missing adoption code".into()))?;

    let node = node_repo::get_node_by_adoption_code(&st.pool, &code)
        .await?
        .ok_or_else(|| AppError::NotFound("Invalid adoption code".into()))?;

    if let Some(exp) = &node.code_expires_at {
        if is_expired(exp) {
            return Err(AppError::Gone("Adoption code has expired".into()));
        }
    }
    if node.adoption_status != "pending" {
        return Err(AppError::Conflict(format!("Node is already {}", node.adoption_status)));
    }
    node_repo::update_adoption_status(&st.pool, &node.node_id, "available").await?;
    Ok(Json(json!({ "success": true, "nodeId": node.node_id })))
}

// ── GET /agent/await-adoption (public poll) ─────────────────────

async fn await_adoption(
    State(st): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let code = q.get("code").map(String::as_str);
    let node_id = q.get("nodeId").map(String::as_str);
    if code.is_none() && node_id.is_none() {
        return Err(AppError::BadRequest("Missing code or nodeId parameter".into()));
    }

    // Prefer nodeId (the adoption code is cleared once adopted).
    let mut node = match node_id {
        Some(id) => node_repo::get_node(&st.pool, id).await?,
        None => None,
    };
    if node.is_none() {
        if let Some(c) = code {
            node = node_repo::get_node_by_adoption_code(&st.pool, c).await?;
        }
    }
    let node = node.ok_or_else(|| AppError::NotFound("Node not found".into()))?;

    match node.adoption_status.as_str() {
        "pending" | "available" => Ok(Json(json!({ "status": "waiting" }))),
        "adopted" => {
            let pending = node_repo::get_pending_key(&st.pool, &node.node_id).await?;
            match pending {
                Some(pk) if !is_expired(&pk.expires_at) => {
                    node_repo::delete_pending_key(&st.pool, &node.node_id).await?;
                    Ok(Json(json!({ "status": "adopted", "nodeKey": pk.raw_key })))
                }
                _ => Ok(Json(json!({ "status": "adopted", "nodeKey": Value::Null }))),
            }
        }
        other => Err(AppError::BadRequest(format!("Unexpected adoption status: {other}"))),
    }
}

/// Whether an ISO-8601 timestamp is in the past.
fn is_expired(iso: &str) -> bool {
    match chrono::DateTime::parse_from_rfc3339(iso) {
        Ok(t) => t < chrono::Utc::now(),
        Err(_) => false,
    }
}
