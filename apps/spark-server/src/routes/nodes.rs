//! Admin node management: listing, creation, updates, role changes, adoption,
//! VPN creation flag, key revocation, peer-deletion queueing, and sharing.

use crate::auth::AdminAuth;
use crate::domain::Node;
use crate::error::{AppError, AppResult};
use crate::repo::{audit_repo, device_repo, node_repo, share_repo, user_repo};
use crate::state::AppState;
use crate::util;
use axum::extract::{Path, Query, State};
use axum::{
    routing::{get, post, put},
    Json, Router,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/nodes", get(list_nodes).post(create_node))
        .route("/nodes/:nodeId", put(update_node).delete(remove_node))
        .route("/nodes/:nodeId/config", get(get_node_config))
        .route("/nodes/:nodeId/adopt", post(adopt_node))
        .route("/nodes/:nodeId/reissue-code", post(reissue_code))
        .route("/nodes/:nodeId/create-vpn", post(create_vpn))
        // WireGuard server CRUD — enqueued as commands the spark executes on the controller.
        .route("/nodes/:nodeId/servers", post(create_server))
        .route("/nodes/:nodeId/servers/:serverId", put(update_server).delete(delete_server))
        // WireGuard client/peer CRUD on a given server — also enqueued as commands.
        .route("/nodes/:nodeId/servers/:serverId/peers", post(create_wg_peer))
        .route("/nodes/:nodeId/servers/:serverId/peers/:peerId", put(update_wg_peer).delete(delete_wg_peer))
        .route("/nodes/:nodeId/revoke", post(revoke_node))
        .route("/nodes/:nodeId/delete-peer", post(delete_node_peer))
        .route("/nodes/:nodeId/role", put(set_node_role))
        .route("/nodes/:nodeId/pause", post(pause_node))
        .route("/nodes/:nodeId/resume", post(resume_node))
        .route("/nodes/:nodeId/shares", get(list_shares))
        .route("/nodes/:nodeId/share", post(add_share).delete(remove_share))
}

// ── GET /nodes ──────────────────────────────────────────────────

async fn list_nodes(
    State(st): State<AppState>,
    AdminAuth(auth): AdminAuth,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let show_all = q.get("all").map(|v| v == "true").unwrap_or(false);
    let all_nodes = node_repo::query_all_nodes(&st.pool).await?;
    let shared: HashSet<String> = share_repo::shared_node_ids_for_email(&st.pool, &auth.email)
        .await?
        .into_iter()
        .collect();

    let nodes: Vec<Value> = all_nodes
        .iter()
        .filter(|n| {
            if show_all && auth.is_superadmin() {
                return true;
            }
            n.owner_id.is_empty()
                || n.owner_id == auth.sub
                || n.owner_email == auth.email
                || shared.contains(&n.node_id)
        })
        .map(|n| {
            let is_owned = n.owner_email.is_empty() || n.owner_email == auth.email;
            let is_shared = shared.contains(&n.node_id);
            node_to_list_json(n, is_shared && !is_owned)
        })
        .collect();

    Ok(Json(json!({ "nodes": nodes })))
}

fn node_to_list_json(n: &Node, shared: bool) -> Value {
    json!({
        "id": n.node_id,
        "name": if n.node_name.is_empty() { n.node_id.clone() } else { n.node_name.clone() },
        "tunnelUrl": n.tunnel_url,
        "tunnelId": n.tunnel_id,
        "controllerUrl": n.controller_url,
        "hasControllerApiKey": n.controller_api_key.as_ref().map(|k| !k.is_empty()).unwrap_or(false),
        // UniFi controller settings. The password is deliberately NOT returned —
        // only whether one is set, so the UI can show "configured" without ever
        // handing the credential back out to a browser.
        "unifiHost": n.unifi_host,
        "unifiPort": n.unifi_port,
        "unifiSite": n.unifi_site,
        "unifiUsername": n.unifi_username,
        "hasUnifiPassword": n.unifi_password_enc.as_ref().map(|k| !k.is_empty()).unwrap_or(false),
        "hasUnifiApiKey": n.unifi_api_key_enc.as_ref().map(|k| !k.is_empty()).unwrap_or(false),
        "unifiInsecure": n.unifi_insecure,
        "sparkVpnName": n.spark_vpn_name,
        "sparkVpnId": n.spark_vpn_id,
        "pendingVpnCreate": n.pending_vpn_create,
        "role": n.role,
        "priority": n.priority,
        // A paused spark is reported as offline so it's treated as disconnected
        // everywhere; `paused` distinguishes an operator pause from a real outage.
        "status": if n.paused { "offline" } else { n.status.as_str() },
        "paused": n.paused,
        "adoptionStatus": n.adoption_status,
        "adoptionCode": n.adoption_code,
        "syncState": n.sync_state,
        "lastAppliedVersion": n.last_applied_version,
        "wanIp": n.wan_ip,
        // What devices will actually dial, and why. `endpoint` is null when the spark
        // has never heartbeated and no override is set — in which case this spark can
        // build no device configs at all, and the UI should say so rather than let it
        // look configured.
        "endpointOverride": n.endpoint_override,
        "endpoint": crate::routes::shared::node_endpoint(n),
        "geo": n.geo.as_ref().map(|g| g.0.clone()),
        "ispName": n.isp_name,
        "speedDown": n.speed_down,
        "speedUp": n.speed_up,
        "error": n.error,
        "actualConfig": n.actual_config.as_ref().map(|c| c.0.clone()),
        // Management-command queue + last results, so the dashboard can show pending ops
        // and surface failures.
        "pendingCommands": n.pending_commands.as_ref().map(|c| c.0.clone()),
        "commandResults": n.command_results.as_ref().map(|c| c.0.clone()),
        // Version: what the spark reports vs. what this control plane ships (same monorepo
        // version), so the dashboard can offer a per-spark update.
        "sparkVersion": n.spark_version,
        "latestVersion": env!("CARGO_PKG_VERSION"),
        "updateAvailable": n.spark_version.as_deref().map_or(false, |v| v != env!("CARGO_PKG_VERSION")),
        "lastSeen": n.last_seen,
        "createdAt": n.created_at,
        "ownerId": if n.owner_id.is_empty() { Value::Null } else { json!(n.owner_id) },
        "ownerEmail": if n.owner_email.is_empty() { Value::Null } else { json!(n.owner_email) },
        "shared": shared,
    })
}

// ── POST /nodes ─────────────────────────────────────────────────

#[derive(serde::Deserialize, Default)]
struct CreateNodeReq {
    #[serde(default)]
    name: Option<String>,
}

async fn create_node(
    State(st): State<AppState>,
    AdminAuth(auth): AdminAuth,
    body: Option<Json<CreateNodeReq>>,
) -> AppResult<Json<Value>> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let node_id = util::node_id();
    let node_name = req.name.filter(|s| !s.is_empty()).unwrap_or_else(util::node_id);
    let adoption_code = util::adoption_code();
    let now = util::now_iso();

    let node = Node {
        node_id: node_id.clone(),
        node_name: node_name.clone(),
        owner_id: auth.sub.clone(),
        owner_email: auth.email.clone(),
        status: "offline".into(),
        role: "secondary".into(),
        priority: 100,
        last_seen: now.clone(),
        sync_state: "synced".into(),
        adoption_status: "pending".into(),
        adoption_code: Some(adoption_code.clone()),
        code_expires_at: Some(util::iso_in(24 * 60 * 60)),
        created_at: now.clone(),
        updated_at: now,
        ..Default::default()
    };
    node_repo::put_node_if_not_exists(&st.pool, &node).await?;

    Ok(Json(json!({
        "nodeId": node_id,
        "nodeName": node_name,
        "adoptionCode": adoption_code,
    })))
}

// ── PUT /nodes/{nodeId} ─────────────────────────────────────────

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct UpdateNodeReq {
    name: Option<String>,
    controller_url: Option<String>,
    controller_api_key: Option<String>,
    tunnel_url: Option<String>,
    tunnel_id: Option<String>,
    priority: Option<i64>,
    #[serde(default, deserialize_with = "crate::routes::de_opt_field")]
    assign_to_email: Option<Option<String>>,
    // UniFi controller, configured here rather than in a file on the spark.
    unifi_host: Option<String>,
    unifi_port: Option<i64>,
    unifi_site: Option<String>,
    unifi_username: Option<String>,
    unifi_password: Option<String>,
    unifi_api_key: Option<String>,
    unifi_insecure: Option<bool>,
    /// Empty string clears it (back to automatic); absent leaves it alone.
    endpoint_override: Option<String>,
}

async fn update_node(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path(node_id): Path<String>,
    body: Option<Json<UpdateNodeReq>>,
) -> AppResult<Json<Value>> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    node_repo::get_node(&st.pool, &node_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Node not found".into()))?;

    if let Some(p) = req.unifi_port {
        if !(1..=65535).contains(&p) {
            return Err(AppError::BadRequest("unifiPort must be 1-65535".into()));
        }
    }
    // Encrypt here, so the plaintext never reaches the repo layer or a query. An
    // empty string means "clear it"; absent means "leave it alone" — otherwise the
    // UI could not distinguish "don't touch the password" from "unset it", and every
    // unrelated save would wipe it.
    let unifi_password_enc = match req.unifi_password.as_deref() {
        None => None,
        Some("") => Some(String::new()),
        Some(pw) => Some(st.cipher.encrypt(pw)?),
    };
    let unifi_api_key_enc = match req.unifi_api_key.as_deref() {
        None => None,
        Some("") => Some(String::new()),
        Some(k) => Some(st.cipher.encrypt(k)?),
    };

    let owner = req.assign_to_email.map(|opt| opt.unwrap_or_default()); // null → "" (unassign)
    let patch = node_repo::NodePatch {
        node_name: req.name,
        controller_url: req.controller_url,
        controller_api_key: req.controller_api_key,
        tunnel_url: req.tunnel_url,
        tunnel_id: req.tunnel_id,
        priority: req.priority,
        owner,
        unifi_host: req.unifi_host,
        unifi_port: req.unifi_port,
        unifi_site: req.unifi_site,
        unifi_username: req.unifi_username,
        unifi_password_enc,
        unifi_api_key_enc,
        unifi_insecure: req.unifi_insecure,
        endpoint_override: req.endpoint_override,
    };
    if patch.is_empty() {
        return Err(AppError::BadRequest("No fields to update".into()));
    }
    node_repo::patch_node(&st.pool, &node_id, patch).await?;
    Ok(Json(json!({ "success": true })))
}

// ── DELETE /nodes/{nodeId} ──────────────────────────────────────

async fn remove_node(
    State(st): State<AppState>,
    AdminAuth(auth): AdminAuth,
    Path(node_id): Path<String>,
) -> AppResult<Json<Value>> {
    let node = node_repo::get_node(&st.pool, &node_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Node {node_id} not found")))?;
    if node.role == "primary" {
        return Err(AppError::Conflict(
            "Cannot remove primary node. Promote another node first.".into(),
        ));
    }
    node_repo::delete_node(&st.pool, &node_id).await?;
    audit_repo::write_audit_log(
        &st.pool,
        "node.removed",
        &auth.sub,
        &node_id,
        json!({ "tunnelId": node.tunnel_id }),
    )
    .await?;
    Ok(Json(json!({ "success": true })))
}

// ── GET /nodes/{nodeId}/config (bootstrap config for un-adopted node) ──

async fn get_node_config(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path(node_id): Path<String>,
) -> AppResult<Json<Value>> {
    let node = node_repo::get_node(&st.pool, &node_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Node not found".into()))?;
    if node.adoption_status != "pending" && node.adoption_status != "available" {
        return Err(AppError::BadRequest("Node has already been adopted".into()));
    }
    Ok(Json(json!({
        "nodeId": node.node_id,
        "nodeName": node.node_name,
        "adoptionCode": node.adoption_code,
        "apiUrl": std::env::var("BIFROST_API_URL").unwrap_or_default(),
        "wsUrl": std::env::var("BIFROST_WS_URL").unwrap_or_default(),
    })))
}

// ── POST /nodes/{nodeId}/reissue-code ───────────────────────────

/// Mint a new adoption code so this spark can be reinstalled from scratch.
///
/// Adoption consumes the code, so an adopted node has none — meaning a rebuilt or
/// wiped box has nothing to register with. This returns it to `pending` with a fresh
/// code and drops the existing node key.
///
/// That kills the running spark's credential, so it is a deliberate, separate action:
/// the dashboard's copy button never calls this. Updating an existing install doesn't
/// need a code at all (the installer reads its own install.conf).
async fn reissue_code(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path(node_id): Path<String>,
) -> AppResult<Json<Value>> {
    node_repo::get_node(&st.pool, &node_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Node not found".into()))?;

    let code = util::adoption_code();
    let expires_at = util::iso_in(24 * 60 * 60);
    node_repo::reissue_adoption_code(&st.pool, &node_id, &code, &expires_at).await?;
    // A stale handoff key for the old adoption would otherwise linger its 300s.
    node_repo::delete_pending_key(&st.pool, &node_id).await?;

    Ok(Json(json!({
        "nodeId": node_id,
        "adoptionCode": code,
        "expiresAt": expires_at,
    })))
}

// ── POST /nodes/{nodeId}/adopt ──────────────────────────────────

async fn adopt_node(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path(node_id): Path<String>,
) -> AppResult<Json<Value>> {
    let node = node_repo::get_node(&st.pool, &node_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Node not found".into()))?;
    if node.adoption_status != "available" {
        return Err(AppError::BadRequest(format!(
            "Cannot adopt node in {} state",
            node.adoption_status
        )));
    }
    let raw_key = util::node_key();
    let key_hash = hex::encode(Sha256::digest(raw_key.as_bytes()));
    node_repo::set_node_key_hash(&st.pool, &node_id, &key_hash).await?;
    node_repo::put_pending_key(&st.pool, &node_id, &raw_key).await?;
    Ok(Json(json!({ "success": true })))
}

// ── POST /nodes/{nodeId}/create-vpn ─────────────────────────────

async fn create_vpn(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path(node_id): Path<String>,
) -> AppResult<Json<Value>> {
    let node = node_repo::get_node(&st.pool, &node_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Node not found".into()))?;
    // Don't queue work the spark can't act on: the agent creates the VPN on its
    // controller, so require the spark to be online (connected) and not paused.
    if node.paused {
        return Err(AppError::Conflict(
            "Spark is paused — resume it before creating a VPN".into(),
        ));
    }
    if node.status != "online" {
        return Err(AppError::Conflict(
            "Spark is offline — bring it online before creating a VPN".into(),
        ));
    }
    // The spark can only build a VPN if it can reach a UniFi controller — a host plus a
    // credential (API key, or username+password). Mirrors the desired-config gate.
    let has_key = node.unifi_api_key_enc.as_deref().map_or(false, |s| !s.is_empty());
    let has_login = !node.unifi_username.is_empty()
        && node.unifi_password_enc.as_deref().map_or(false, |s| !s.is_empty());
    if node.unifi_host.is_empty() || !(has_key || has_login) {
        return Err(AppError::Conflict(
            "Configure the UniFi controller (host + API key) before creating a VPN".into(),
        ));
    }
    // Re-runnable on purpose: this unbinds any current server and asks the spark to
    // provision a fresh one. The spark dedups by name, so re-running adopts the server it
    // already created rather than piling up duplicates — no "already exists" block needed.
    const VPN_NAME: &str = "SPARK VPN";
    node_repo::mark_vpn_create(&st.pool, &node_id, VPN_NAME).await?;
    Ok(Json(json!({ "success": true, "vpnName": VPN_NAME })))
}

// ── WireGuard server CRUD (enqueued commands) ───────────────────

/// Enqueue a command for the spark and return its id. The spark drains the queue each
/// cycle, executes against the controller, and acknowledges on heartbeat.
async fn enqueue(st: &AppState, node_id: &str, command: Value) -> AppResult<Json<Value>> {
    node_repo::get_node(&st.pool, node_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Node not found".into()))?;
    let id = command.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    node_repo::append_command(&st.pool, node_id, command).await?;
    Ok(Json(json!({ "commandId": id })))
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CreateServerReq {
    name: Option<String>,
    /// Optional CIDR (e.g. "10.13.7.1/24"); the spark auto-picks a free one when absent.
    subnet: Option<String>,
    /// Optional listen port; the spark auto-picks a free one when absent.
    port: Option<i64>,
}

async fn create_server(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path(node_id): Path<String>,
    body: Option<Json<CreateServerReq>>,
) -> AppResult<Json<Value>> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let name = req.name.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "New VPN".into());
    enqueue(
        &st,
        &node_id,
        json!({ "id": util::ulid(), "kind": "server.create", "name": name, "subnet": req.subnet, "port": req.port }),
    )
    .await
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct UpdateServerReq {
    name: Option<String>,
    port: Option<i64>,
    enabled: Option<bool>,
}

async fn update_server(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path((node_id, server_id)): Path<(String, String)>,
    body: Option<Json<UpdateServerReq>>,
) -> AppResult<Json<Value>> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    enqueue(
        &st,
        &node_id,
        json!({
            "id": util::ulid(), "kind": "server.update", "serverId": server_id,
            "name": req.name, "port": req.port, "enabled": req.enabled,
        }),
    )
    .await
}

async fn delete_server(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path((node_id, server_id)): Path<(String, String)>,
) -> AppResult<Json<Value>> {
    enqueue(
        &st,
        &node_id,
        json!({ "id": util::ulid(), "kind": "server.delete", "serverId": server_id }),
    )
    .await
}

// ── WireGuard client/peer CRUD (enqueued commands) ──────────────

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CreatePeerReq {
    name: Option<String>,
    /// The client's public key. Absent → the spark generates a keypair and returns the
    /// private key in the command result so the dashboard can build the client config.
    public_key: Option<String>,
    /// Tunnel IP; the spark auto-picks a free one in the server's subnet when absent.
    ip: Option<String>,
    allowed_ips: Option<Vec<String>>,
}

async fn create_wg_peer(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path((node_id, server_id)): Path<(String, String)>,
    body: Option<Json<CreatePeerReq>>,
) -> AppResult<Json<Value>> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    enqueue(
        &st,
        &node_id,
        json!({
            "id": util::ulid(), "kind": "peer.create", "serverId": server_id,
            "name": req.name.unwrap_or_else(|| "client".into()),
            "publicKey": req.public_key, "ip": req.ip, "allowedIps": req.allowed_ips,
        }),
    )
    .await
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct UpdatePeerReq {
    name: Option<String>,
    ip: Option<String>,
    /// Required — the existing public key, so the spark preserves the client's keypair
    /// across the rename/re-address (which it does as delete-then-recreate).
    public_key: Option<String>,
    allowed_ips: Option<Vec<String>>,
}

async fn update_wg_peer(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path((node_id, server_id, peer_id)): Path<(String, String, String)>,
    body: Option<Json<UpdatePeerReq>>,
) -> AppResult<Json<Value>> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let public_key = req
        .public_key
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("publicKey is required to update a peer".into()))?;
    enqueue(
        &st,
        &node_id,
        json!({
            "id": util::ulid(), "kind": "peer.update", "serverId": server_id, "peerId": peer_id,
            "publicKey": public_key, "name": req.name, "ip": req.ip, "allowedIps": req.allowed_ips,
        }),
    )
    .await
}

async fn delete_wg_peer(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path((node_id, server_id, peer_id)): Path<(String, String, String)>,
) -> AppResult<Json<Value>> {
    enqueue(
        &st,
        &node_id,
        json!({ "id": util::ulid(), "kind": "peer.delete", "serverId": server_id, "peerId": peer_id }),
    )
    .await
}

// ── POST /nodes/{nodeId}/revoke ─────────────────────────────────

async fn revoke_node(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path(node_id): Path<String>,
) -> AppResult<Json<Value>> {
    let node = node_repo::get_node(&st.pool, &node_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Node not found".into()))?;
    if node.adoption_status != "adopted" {
        return Err(AppError::BadRequest(format!(
            "Cannot revoke key for node in {} state",
            node.adoption_status
        )));
    }
    node_repo::revoke_node_key(&st.pool, &node_id).await?;
    Ok(Json(json!({ "success": true })))
}

// ── POST /nodes/{nodeId}/delete-peer ────────────────────────────

#[derive(serde::Deserialize, Default)]
struct DeletePeerReq {
    #[serde(default)]
    #[serde(rename = "peerId")]
    peer_id: Option<String>,
}

async fn delete_node_peer(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path(node_id): Path<String>,
    body: Option<Json<DeletePeerReq>>,
) -> AppResult<Json<Value>> {
    let peer_id = body
        .and_then(|Json(b)| b.peer_id)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("Missing peerId".into()))?;
    node_repo::get_node(&st.pool, &node_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Node not found".into()))?;
    node_repo::append_pending_peer_deletions(&st.pool, &node_id, &[peer_id]).await?;
    Ok(Json(json!({ "success": true })))
}

// ── PUT /nodes/{nodeId}/role ────────────────────────────────────

#[derive(serde::Deserialize, Default)]
struct SetRoleReq {
    #[serde(default)]
    role: Option<String>,
}

async fn set_node_role(
    State(st): State<AppState>,
    AdminAuth(auth): AdminAuth,
    Path(node_id): Path<String>,
    body: Option<Json<SetRoleReq>>,
) -> AppResult<Json<Value>> {
    let role = body.and_then(|Json(b)| b.role).unwrap_or_default();
    if role != "primary" && role != "secondary" {
        return Err(AppError::BadRequest("role must be 'primary' or 'secondary'".into()));
    }
    let node = node_repo::get_node(&st.pool, &node_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Node {node_id} not found")))?;
    if node.role == role {
        return Ok(Json(json!({ "success": true, "message": "No change needed" })));
    }
    if role == "primary" {
        for primary in node_repo::query_nodes_by_role(&st.pool, "primary").await? {
            node_repo::update_node_role(&st.pool, &primary.node_id, "secondary", primary.priority)
                .await?;
        }
    }
    node_repo::update_node_role(&st.pool, &node_id, &role, node.priority).await?;
    let action = if role == "primary" { "node.promoted" } else { "node.demoted" };
    audit_repo::write_audit_log(&st.pool, action, &auth.sub, &node_id, json!({ "newRole": role }))
        .await?;
    Ok(Json(json!({ "success": true })))
}

// ── Pause / resume ──────────────────────────────────────────────

/// POST /nodes/{nodeId}/pause — operator override: treat the spark as offline.
async fn pause_node(
    State(st): State<AppState>,
    AdminAuth(auth): AdminAuth,
    Path(node_id): Path<String>,
) -> AppResult<Json<Value>> {
    if node_repo::set_paused(&st.pool, &node_id, true).await? == 0 {
        return Err(AppError::NotFound("Node not found".into()));
    }
    audit_repo::write_audit_log(&st.pool, "node.paused", &auth.sub, &node_id, json!({})).await?;
    Ok(Json(json!({ "success": true, "paused": true })))
}

/// POST /nodes/{nodeId}/resume — clear the operator pause.
async fn resume_node(
    State(st): State<AppState>,
    AdminAuth(auth): AdminAuth,
    Path(node_id): Path<String>,
) -> AppResult<Json<Value>> {
    if node_repo::set_paused(&st.pool, &node_id, false).await? == 0 {
        return Err(AppError::NotFound("Node not found".into()));
    }
    audit_repo::write_audit_log(&st.pool, "node.resumed", &auth.sub, &node_id, json!({})).await?;
    Ok(Json(json!({ "success": true, "paused": false })))
}

// ── Sharing ─────────────────────────────────────────────────────

/// Load the node and verify the caller owns it (or is superadmin).
async fn require_share_owner(st: &AppState, node_id: &str, auth_email: &str, is_super: bool) -> AppResult<Node> {
    let node = node_repo::get_node(&st.pool, node_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Spark not found".into()))?;
    if node.owner_email != auth_email && !is_super {
        return Err(AppError::Forbidden("Only the spark owner can manage sharing".into()));
    }
    Ok(node)
}

async fn list_shares(
    State(st): State<AppState>,
    AdminAuth(auth): AdminAuth,
    Path(node_id): Path<String>,
) -> AppResult<Json<Value>> {
    require_share_owner(&st, &node_id, &auth.email, auth.is_superadmin()).await?;
    let shares: Vec<Value> = share_repo::list_shares_for_node(&st.pool, &node_id)
        .await?
        .into_iter()
        .map(|s| json!({ "email": s.shared_with_email, "sharedBy": s.shared_by_email, "createdAt": s.created_at }))
        .collect();
    Ok(Json(json!({ "shares": shares })))
}

#[derive(serde::Deserialize, Default)]
struct ShareReq {
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    action: Option<String>,
}

async fn add_share(
    State(st): State<AppState>,
    AdminAuth(auth): AdminAuth,
    Path(node_id): Path<String>,
    body: Option<Json<ShareReq>>,
) -> AppResult<Json<Value>> {
    let is_super = auth.is_superadmin();
    require_share_owner(&st, &node_id, &auth.email, is_super).await?;
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let email = req.email.filter(|s| !s.is_empty()).ok_or_else(|| AppError::BadRequest("Email is required".into()))?;

    if req.action.as_deref() == Some("remove") {
        share_repo::delete_share(&st.pool, &node_id, &email).await?;
        cleanup_shared_peers(&st, &node_id, &email).await?;
        return Ok(Json(json!({ "success": true })));
    }

    // Cross-admin guard: don't share with a user owned by a different admin.
    if !is_super {
        if let Some(owner) = user_repo::get_user_owner(&st.pool, &email).await? {
            if owner != auth.email {
                return Err(AppError::Forbidden("Cannot share with users owned by another admin".into()));
            }
        }
    }
    share_repo::put_share(&st.pool, &node_id, &email, &auth.email).await?;
    Ok(Json(json!({ "success": true })))
}

/// DELETE /nodes/{nodeId}/share?email=... — unshare (the TS handler left this a
/// 405 and did removal via POST action=remove; we implement it properly here).
async fn remove_share(
    State(st): State<AppState>,
    AdminAuth(auth): AdminAuth,
    Path(node_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let is_super = auth.is_superadmin();
    require_share_owner(&st, &node_id, &auth.email, is_super).await?;
    let email = q.get("email").filter(|s| !s.is_empty()).ok_or_else(|| AppError::BadRequest("Email is required".into()))?;
    share_repo::delete_share(&st.pool, &node_id, email).await?;
    cleanup_shared_peers(&st, &node_id, email).await?;
    Ok(Json(json!({ "success": true })))
}

/// Queue WireGuard peer deletions for a now-unshared user's devices on a node.
async fn cleanup_shared_peers(st: &AppState, node_id: &str, email: &str) -> AppResult<()> {
    let devices: Vec<_> = device_repo::query_all_devices(&st.pool)
        .await?
        .into_iter()
        .filter(|d| d.owner_email == email)
        .collect();
    if devices.is_empty() {
        return Ok(());
    }
    let Some(node) = node_repo::get_node(&st.pool, node_id).await? else { return Ok(()) };
    let Some(peers) = node.actual_config.as_ref().and_then(|c| c.get("peers").and_then(|p| p.as_array()).cloned())
    else {
        return Ok(());
    };
    let mut to_delete = Vec::new();
    for d in &devices {
        let peer_name = format!("bifrost-{}", d.name);
        if let Some(p) = peers.iter().find(|p| p.get("name").and_then(|v| v.as_str()) == Some(peer_name.as_str())) {
            if let Some(id) = p.get("id").and_then(|v| v.as_str()) {
                to_delete.push(id.to_string());
            }
        }
    }
    node_repo::append_pending_peer_deletions(&st.pool, node_id, &to_delete).await?;
    Ok(())
}
