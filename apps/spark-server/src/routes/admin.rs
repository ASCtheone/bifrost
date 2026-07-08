//! Mobile admin dashboard: a summary plus on-demand drill-down sections.

use crate::auth::AdminAuth;
use crate::error::AppResult;
use crate::repo::{device_repo, node_repo, user_repo};
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::{routing::get, Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;

pub fn routes() -> Router<AppState> {
    Router::new().route("/admin/dashboard", get(dashboard))
}

async fn dashboard(
    State(st): State<AppState>,
    AdminAuth(auth): AdminAuth,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    if !auth.is_superadmin() {
        return Ok(Json(json!({ "authorized": false })));
    }

    match q.get("section").map(String::as_str) {
        Some("sparks") => {
            let sparks: Vec<Value> = node_repo::query_all_nodes(&st.pool)
                .await?
                .iter()
                .map(|n| {
                    json!({
                        "id": n.node_id,
                        "name": if n.node_name.is_empty() { n.node_id.clone() } else { n.node_name.clone() },
                        "status": n.status,
                        "role": n.role,
                        "adoptionStatus": n.adoption_status,
                        "wanIp": n.wan_ip,
                        "geo": n.geo.as_ref().map(|g| g.0.clone()),
                        "ispName": n.isp_name,
                        "speedDown": n.speed_down,
                        "speedUp": n.speed_up,
                        "ownerEmail": if n.owner_email.is_empty() { Value::Null } else { json!(n.owner_email) },
                        "lastSeen": n.last_seen,
                    })
                })
                .collect();
            Ok(Json(json!({ "authorized": true, "sparks": sparks })))
        }
        Some("devices") => {
            let devices: Vec<Value> = device_repo::query_all_devices(&st.pool)
                .await?
                .iter()
                .map(|d| {
                    json!({
                        "id": d.device_id,
                        "name": d.name,
                        "type": d.device_type,
                        "status": d.status,
                        "assignedIp": d.assigned_ip,
                        "enabled": d.enabled,
                        "ownerEmail": if d.owner_email.is_empty() { Value::Null } else { json!(d.owner_email) },
                    })
                })
                .collect();
            Ok(Json(json!({ "authorized": true, "devices": devices })))
        }
        Some("users") => {
            let users: Vec<Value> = user_repo::query_all_users(&st.pool)
                .await?
                .iter()
                .map(|u| {
                    json!({
                        "username": u.username,
                        "displayName": u.display_name,
                        "email": u.email,
                        "enabled": u.enabled,
                        "groups": u.groups.0,
                        "status": u.status,
                    })
                })
                .collect();
            Ok(Json(json!({ "authorized": true, "users": users })))
        }
        _ => {
            let nodes = node_repo::query_all_nodes(&st.pool).await?;
            let devices = device_repo::query_all_devices(&st.pool).await?;
            let online = nodes.iter().filter(|n| n.status == "online").count();
            Ok(Json(json!({
                "authorized": true,
                "role": "superadmin",
                "email": auth.email,
                "counts": {
                    "sparks": nodes.len(),
                    "sparksOnline": online,
                    "devices": devices.len(),
                },
            })))
        }
    }
}
