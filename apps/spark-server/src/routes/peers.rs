//! Peer listing and deletion (admin).

use crate::auth::AdminAuth;
use crate::error::{AppError, AppResult};
use crate::repo::peer_repo;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::{routing::{delete, get}, Json, Router};
use serde_json::{json, Value};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/peers", get(list_peers))
        .route("/peers/:peerId", delete(delete_peer))
}

async fn list_peers(State(st): State<AppState>, AdminAuth(_auth): AdminAuth) -> AppResult<Json<Value>> {
    let peers: Vec<Value> = peer_repo::query_all_peers(&st.pool)
        .await?
        .into_iter()
        .map(|p| {
            json!({
                "id": p.peer_id,
                "name": p.name,
                "assignedIp": p.assigned_ip,
                "nodeId": p.node_id,
                "enabled": p.enabled,
                "createdAt": p.created_at,
            })
        })
        .collect();
    Ok(Json(json!({ "peers": peers })))
}

async fn delete_peer(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path(peer_id): Path<String>,
) -> AppResult<Json<Value>> {
    if peer_id.is_empty() {
        return Err(AppError::BadRequest("Missing peerId".into()));
    }
    peer_repo::delete_peer(&st.pool, &peer_id).await?;
    Ok(Json(json!({ "success": true })))
}
