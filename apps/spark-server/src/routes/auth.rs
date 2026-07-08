//! Local authentication routes: password login (issues our own JWT) and the
//! device auth-provision endpoint. Also owns first-run admin bootstrap.

use crate::auth::{password, AdminAuth};
use crate::config::Config;
use crate::domain::{Device, User};
use crate::error::{AppError, AppResult};
use crate::repo::{conn_log_repo, device_repo, node_repo, user_repo};
use crate::routes::shared;
use crate::state::AppState;
use crate::util;
use crate::wg;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::{routing::post, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::types::Json as SqlxJson;
use sqlx::SqlitePool;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/login", post(login))
        .route("/auth/provision", post(auth_provision))
}

// ── POST /auth/login (public) ───────────────────────────────────

#[derive(Deserialize)]
struct LoginReq {
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    email: Option<String>,
    password: String,
}

async fn login(State(st): State<AppState>, Json(req): Json<LoginReq>) -> AppResult<Json<Value>> {
    let login = req
        .username
        .or(req.email)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AppError::BadRequest("username or email is required".into()))?;

    let invalid = || AppError::Unauthorized("Incorrect username or password".into());

    let user = user_repo::get_user_by_login(&st.pool, login.trim())
        .await?
        .ok_or_else(invalid)?;

    if !user.enabled {
        return Err(AppError::Forbidden("User is disabled".into()));
    }
    if !password::verify_password(&req.password, &user.password_hash) {
        return Err(invalid());
    }

    let token = st.jwt.issue(&user.user_id, &user.email, user.groups.0.clone())?;

    Ok(Json(json!({
        "token": token,
        "idToken": token,       // compatibility alias for token-consuming clients
        "email": user.email,
        "displayName": user.display_name,
        "groups": user.groups.0,
        "mustChangePassword": user.must_change,
    })))
}

// ── POST /auth/provision (admin JWT) ────────────────────────────

async fn auth_provision(
    State(st): State<AppState>,
    headers: HeaderMap,
    AdminAuth(auth): AdminAuth,
) -> AppResult<Json<Value>> {
    let all_devices = device_repo::query_all_devices(&st.pool).await?;
    let mut device = all_devices.into_iter().find(|d| d.owner_email == auth.email);

    let spark_owner =
        shared::resolve_spark_owner(&st.pool, &auth.email, auth.is_admin(), auth.is_superadmin())
            .await?;
    let all_nodes = node_repo::query_all_nodes(&st.pool).await?;
    let owner_nodes = shared::owned_nodes(&st.pool, &spark_owner, &all_nodes).await?;

    // Auto-create a device on first login if the account has sparks but no device.
    if device.is_none() && !owner_nodes.is_empty() {
        let node = &owner_nodes[0];
        let server = shared::spark_server_for(node);
        let device_id = util::device_id();
        let kp = wg::generate_keypair();
        let now = util::now_iso();
        let assigned_ip =
            wg::assign_ip(&device_id, server.as_ref().map(|s| s.server_address.as_str()));
        let name = auth.email.split('@').next().unwrap_or("device").to_string();

        let new_device = Device {
            device_id: device_id.clone(),
            node_id: node.node_id.clone(),
            name,
            device_type: "phone".into(),
            status: "pending".into(),
            provision_method: "headless".into(),
            provision_token: Some(util::provision_token()),
            assigned_ip,
            public_key: kp.public_key,
            private_key: kp.private_key,
            preshared_key: wg::generate_preshared_key(),
            server_public_key: server.as_ref().map(|s| s.public_key.clone()).unwrap_or_default(),
            server_endpoint: node.controller_url.clone(),
            server_port: server.as_ref().map(|s| s.server_port).unwrap_or(51830),
            dns: SqlxJson(vec!["1.1.1.1".into(), "8.8.8.8".into()]),
            allowed_ips: SqlxJson(vec!["0.0.0.0/0".into()]),
            unifi_peer_id: None,
            enabled: true,
            last_seen: None,
            created_by: auth.sub.clone(),
            owner_email: auth.email.clone(),
            created_at: now.clone(),
            updated_at: now,
        };
        device_repo::put_device(&st.pool, &new_device).await?;
        device = Some(new_device);
    }

    let Some(device) = device else {
        return Ok(Json(json!({
            "provisioned": false,
            "message": "No sparks available for your account",
        })));
    };

    let configs = shared::build_device_configs(&device, &owner_nodes);
    let nodes_json: Vec<Value> = configs
        .iter()
        .map(|c| {
            json!({
                "nodeId": c.node_id,
                "name": c.node_name,
                "endpoint": c.endpoint,
                "port": c.port,
                "wgConfig": c.wg_config,
                "location": c.location,
                "role": c.role,
                "ispName": c.isp_name,
                "speedDown": c.speed_down,
                "speedUp": c.speed_up,
            })
        })
        .collect();
    let primary_config = configs.first().map(|c| c.wg_config.clone()).unwrap_or_default();

    // Best-effort connection log (90-day retention).
    let seq = format!("{}#{}", util::now_iso(), util::short_suffix());
    let _ = conn_log_repo::insert(
        &st.pool,
        &device.device_id,
        &seq,
        "provision",
        None,
        None,
        source_ip(&headers),
        None,
        user_agent(&headers),
        Some(&auth.email),
        &util::now_iso(),
        util::now_unix() + 90 * 24 * 60 * 60,
    )
    .await;

    Ok(Json(json!({
        "provisioned": true,
        "deviceId": device.device_id,
        "name": device.name,
        "assignedIp": device.assigned_ip,
        "enabled": device.enabled,
        "config": primary_config,
        "nodes": nodes_json,
        "provisionToken": device.provision_token,
    })))
}

// ── First-run bootstrap ─────────────────────────────────────────

/// Create a bootstrap superadmin when the user store is empty and bootstrap
/// credentials are configured. No-op otherwise.
pub async fn bootstrap_admin(pool: &SqlitePool, config: &Config) -> AppResult<()> {
    let (Some(email), Some(pw)) = (
        config.auth.bootstrap_admin_email.as_deref(),
        config.auth.bootstrap_admin_password.as_deref(),
    ) else {
        return Ok(());
    };
    if email.is_empty() || pw.is_empty() {
        return Ok(());
    }
    if user_repo::count_users(pool).await? > 0 {
        return Ok(());
    }

    let now = util::now_iso();
    let user = User {
        user_id: util::ulid(),
        username: email.split('@').next().unwrap_or(email).to_string(),
        email: email.to_string(),
        display_name: email.to_string(),
        password_hash: password::hash_password(pw)?,
        groups: SqlxJson(vec!["admin".into(), "superadmin".into()]),
        enabled: true,
        status: "CONFIRMED".into(),
        owner_email: String::new(),
        must_change: false,
        created_at: now.clone(),
        updated_at: now,
    };
    user_repo::create_user(pool, &user).await?;
    tracing::info!(email = %email, "bootstrapped initial superadmin");
    Ok(())
}

// ── request helpers ─────────────────────────────────────────────

fn user_agent(headers: &HeaderMap) -> &str {
    headers.get("user-agent").and_then(|v| v.to_str().ok()).unwrap_or("unknown")
}

fn source_ip(headers: &HeaderMap) -> &str {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("unknown")
}
