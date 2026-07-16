//! Topology tree: user → spark → device, filtered by the caller's role.
//!
//! Superadmins see every user, the sparks each owns, and every device on those sparks.
//! A regular owner/shared user sees themselves plus the owners who shared a spark with
//! them; under each, the sparks they can reach, and only that user's own devices on them.

use crate::auth::Auth;
use crate::domain::{Device, Node};
use crate::error::AppResult;
use crate::repo::{device_repo, node_repo, share_repo, user_repo};
use crate::state::AppState;
use axum::extract::State;
use axum::{routing::get, Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;

pub fn routes() -> Router<AppState> {
    Router::new().route("/topology", get(topology))
}

async fn topology(State(st): State<AppState>, Auth(auth): Auth) -> AppResult<Json<Value>> {
    let all_nodes = node_repo::query_all_nodes(&st.pool).await?;
    let all_devices = device_repo::query_all_devices(&st.pool).await?;

    if auth.is_superadmin() {
        superadmin_view(&st, &all_nodes, &all_devices).await
    } else {
        user_view(&st, &auth.email, &all_nodes, &all_devices).await
    }
}

/// Devices physically on a node, optionally restricted to one owner.
fn devices_on<'a>(devices: &'a [Device], node_id: &str, only_owner: Option<&str>) -> Vec<&'a Device> {
    devices
        .iter()
        .filter(|d| d.node_id == node_id)
        .filter(|d| only_owner.map(|o| d.owner_email == o).unwrap_or(true))
        .collect()
}

fn device_json(d: &Device) -> Value {
    json!({
        "deviceId": d.device_id,
        "name": d.name,
        "type": d.device_type,
        "status": d.status,
        "enabled": d.enabled,
        "assignedIp": d.assigned_ip,
        "ownerEmail": if d.owner_email.is_empty() { Value::Null } else { json!(d.owner_email) },
    })
}

fn spark_json(n: &Node, shared: bool, devices: &[&Device], latest: &str) -> Value {
    json!({
        "nodeId": n.node_id,
        "name": if n.node_name.is_empty() { n.node_id.clone() } else { n.node_name.clone() },
        // A paused spark is reported offline everywhere, matching the nodes list.
        "status": if n.paused { "offline" } else { n.status.as_str() },
        "paused": n.paused,
        "adoptionStatus": n.adoption_status,
        "shared": shared,
        "ownerEmail": if n.owner_email.is_empty() { Value::Null } else { json!(n.owner_email) },
        // The extras below back the topology panel's spark management options.
        "endpointOverride": n.endpoint_override,
        "priority": n.priority,
        "sparkVersion": n.spark_version,
        "latestVersion": latest,
        "updateAvailable": n.spark_version.as_deref().map_or(false, |v| crate::release::version_lt(v, latest)),
        "backupAvailable": n.spark_backup_available,
        "devices": devices.iter().map(|d| device_json(d)).collect::<Vec<_>>(),
    })
}

/// A display role from a user's group membership.
fn role_label(groups: &[String]) -> &'static str {
    if groups.iter().any(|g| g == "superadmin") {
        "superadmin"
    } else if groups.iter().any(|g| g == "admin") {
        "admin"
    } else {
        "user"
    }
}

// ── Superadmin: every user → owned sparks → all devices on them ──

async fn superadmin_view(st: &AppState, nodes: &[Node], devices: &[Device]) -> AppResult<Json<Value>> {
    let users = user_repo::query_all_users(&st.pool).await?;
    let latest = st.latest_version.read().map(|g| g.clone()).unwrap_or_default();

    // Roles by email, so a node owner who isn't a known user still gets a sensible label.
    let role_by_email: HashMap<&str, &str> =
        users.iter().map(|u| (u.email.as_str(), role_label(&u.groups.0))).collect();
    // username + enabled, so the panel can act on the user (endpoints key on username).
    let user_by_email: HashMap<&str, &crate::domain::User> =
        users.iter().map(|u| (u.email.as_str(), u)).collect();

    // Every owner-email that actually owns a spark, plus every known user — so users with
    // no spark still appear, and a spark owned by a since-deleted user isn't hidden.
    let mut emails: Vec<String> = users.iter().map(|u| u.email.clone()).collect();
    for n in nodes {
        let owner = if n.owner_email.is_empty() { "(unassigned)".to_string() } else { n.owner_email.clone() };
        if !emails.contains(&owner) {
            emails.push(owner);
        }
    }

    let user_list: Vec<Value> = emails
        .iter()
        .map(|email| {
            let owner_match = if email == "(unassigned)" { "" } else { email.as_str() };
            let sparks: Vec<Value> = nodes
                .iter()
                .filter(|n| n.owner_email == owner_match)
                .map(|n| spark_json(n, false, &devices_on(devices, &n.node_id, None), &latest))
                .collect();
            let u = user_by_email.get(email.as_str());
            json!({
                "email": email,
                "role": role_by_email.get(email.as_str()).copied().unwrap_or("unknown"),
                "username": u.map(|u| u.username.clone()),
                "enabled": u.map(|u| u.enabled),
                "isSelf": false,
                "sparks": sparks,
            })
        })
        .collect();

    Ok(Json(json!({ "view": "superadmin", "users": user_list })))
}

// ── Owner/shared user: me + sharers → reachable sparks → my devices ──

async fn user_view(
    st: &AppState,
    me: &str,
    nodes: &[Node],
    devices: &[Device],
) -> AppResult<Json<Value>> {
    let latest = st.latest_version.read().map(|g| g.clone()).unwrap_or_default();
    let shared_ids: std::collections::HashSet<String> = share_repo::shared_node_ids_for_email(&st.pool, me)
        .await?
        .into_iter()
        .collect();

    // My own sparks — my devices on each.
    let my_sparks: Vec<Value> = nodes
        .iter()
        .filter(|n| n.owner_email == me)
        .map(|n| spark_json(n, false, &devices_on(devices, &n.node_id, Some(me)), &latest))
        .collect();

    let mut users = vec![json!({ "email": me, "role": "you", "isSelf": true, "sparks": my_sparks })];

    // Sparks shared with me, grouped by the owner who shared them. Only my devices show.
    let mut by_owner: HashMap<&str, Vec<Value>> = HashMap::new();
    for n in nodes.iter().filter(|n| shared_ids.contains(&n.node_id) && n.owner_email != me) {
        by_owner
            .entry(n.owner_email.as_str())
            .or_default()
            .push(spark_json(n, true, &devices_on(devices, &n.node_id, Some(me)), &latest));
    }
    for (owner, sparks) in by_owner {
        users.push(json!({ "email": owner, "role": "shares with you", "isSelf": false, "sparks": sparks }));
    }

    Ok(Json(json!({ "view": "user", "users": users })))
}
