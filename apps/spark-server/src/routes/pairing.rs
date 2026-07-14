//! Device-code pairing. A device (e.g. a GL.iNet router) generates a code on
//! first boot; a signed-in user claims it in the dashboard, which ties a device
//! to their account. The device then receives its provision token — via the
//! browser redirecting to the device's callback URL, or by polling the code.

use crate::auth::Auth;
use crate::error::{AppError, AppResult};
use crate::repo::{device_code_repo, device_repo};
use crate::routes::shared;
use crate::state::AppState;
use crate::util;
use axum::extract::{Path, State};
use axum::{
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

/// Pending pairing codes live 15 minutes.
const CODE_TTL_SECS: i64 = 15 * 60;

/// The device's callback (where the browser is redirected with the token) must
/// point at a private/LAN address — the device is on the user's own network.
/// This stops a malicious code from redirecting the token to an off-site host.
fn callback_is_private(url: &str) -> bool {
    use std::net::IpAddr;
    let rest = match url.strip_prefix("http://").or_else(|| url.strip_prefix("https://")) {
        Some(r) => r,
        None => return false,
    };
    // authority = host[:port], before the first '/'; drop any userinfo@.
    let authority = rest.split('/').next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next().unwrap_or("") // [ipv6]:port
    } else {
        authority.split(':').next().unwrap_or(authority) // host or host:port
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        Ok(IpAddr::V6(v6)) => {
            v6.is_loopback()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // ULA  fc00::/7
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
        }
        Err(_) => false, // reject hostnames — they can resolve anywhere
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/device/code", post(create_code))
        .route("/device/code/:code", get(poll_code))
        .route("/device/register", post(register))
        .route("/devices/:deviceId/reset-expiration", post(reset_expiration))
}

// ── POST /device/code (public) — device first boot ──────────────

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CreateCodeReq {
    #[serde(default)]
    name: Option<String>,
    /// The device's own callback URL (e.g. its LAN config page); the dashboard
    /// redirects the browser here with the token after registration.
    #[serde(default)]
    callback_url: Option<String>,
}

async fn create_code(
    State(st): State<AppState>,
    body: Option<Json<CreateCodeReq>>,
) -> AppResult<Json<Value>> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let _ = device_code_repo::delete_expired(&st.pool, &util::now_iso()).await; // best-effort GC

    // Only keep a callback that targets a private/LAN address; otherwise the
    // device pairs via polling. Prevents off-site token redirection.
    let callback = req.callback_url.as_deref().filter(|c| callback_is_private(c));
    if req.callback_url.is_some() && callback.is_none() {
        tracing::warn!("dropping non-private device-code callback");
    }

    let code = util::device_code();
    let now = util::now_iso();
    let expires = util::iso_in(CODE_TTL_SECS);
    device_code_repo::create(
        &st.pool,
        &code,
        req.name.as_deref().unwrap_or(""),
        callback,
        &now,
        &expires,
    )
    .await?;

    Ok(Json(json!({
        "deviceCode": code,
        "expiresInSeconds": CODE_TTL_SECS,
        "expiresAt": expires,
    })))
}

// ── GET /device/code/:code (public) ─────────────────────────────
// The register page reads status/name; the device polls this and, once
// registered, receives the provision token (the code is then consumed).

async fn poll_code(State(st): State<AppState>, Path(code): Path<String>) -> AppResult<Json<Value>> {
    let code = code.trim().to_uppercase();
    let now = util::now_iso();
    let dc = device_code_repo::get(&st.pool, &code)
        .await?
        .ok_or_else(|| AppError::NotFound("Unknown device code".into()))?;

    if dc.status == "pending" && !dc.is_claimable(&now) {
        return Ok(Json(json!({ "status": "expired" })));
    }
    if dc.status == "registered" {
        let token = dc.provision_token.clone().unwrap_or_default();
        device_code_repo::mark_consumed(&st.pool, &code).await?;
        return Ok(Json(json!({
            "status": "registered",
            "provisionToken": token,
            "deviceId": dc.device_id,
            "name": dc.name,
        })));
    }
    Ok(Json(json!({ "status": dc.status, "name": dc.name })))
}

// ── POST /device/register (any signed-in user) ──────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterReq {
    device_code: String,
    #[serde(default)]
    name: Option<String>,
    /// Registration lifetime in days; absent or 0 = never expires.
    #[serde(default)]
    expires_in_days: Option<i64>,
}

async fn register(
    State(st): State<AppState>,
    Auth(auth): Auth,
    Json(req): Json<RegisterReq>,
) -> AppResult<Json<Value>> {
    let now = util::now_iso();
    let code = req.device_code.trim().to_uppercase();
    let dc = device_code_repo::get(&st.pool, &code)
        .await?
        .ok_or_else(|| AppError::NotFound("Unknown device code".into()))?;
    if !dc.is_claimable(&now) {
        return Err(AppError::BadRequest(
            "This code has expired or was already used".into(),
        ));
    }

    let owner =
        shared::resolve_spark_owner(&st.pool, &auth.email, auth.is_admin(), auth.is_superadmin())
            .await?;
    let name = req
        .name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| Some(dc.name.clone()).filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "Router".to_string());
    let expires_at = match req.expires_in_days {
        Some(d) if d > 0 => Some(util::iso_in(d * 86400)),
        _ => None,
    };

    let device = shared::create_device_for_owner(
        &st.pool,
        &owner,
        &auth.sub,
        &name,
        "router",
        "device-code",
        expires_at.clone(),
    )
    .await?;

    let token = device.provision_token.clone().unwrap_or_default();
    device_code_repo::mark_registered(&st.pool, &code, &device.device_id, &token, &owner).await?;

    // An empty node_id means no spark was available to bind to yet — the device
    // is registered but won't tunnel until a spark is adopted.
    let needs_spark = device.node_id.is_empty();

    Ok(Json(json!({
        "deviceId": device.device_id,
        "name": device.name,
        "provisionToken": token,
        "callbackUrl": dc.callback_url,
        "expiresAt": expires_at,
        "needsSpark": needs_spark,
    })))
}

// ── POST /devices/:deviceId/reset-expiration (owner or admin) ────

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ResetExpiryReq {
    /// New lifetime in days from now; absent or 0 = never expires.
    #[serde(default)]
    expires_in_days: Option<i64>,
}

async fn reset_expiration(
    State(st): State<AppState>,
    Auth(auth): Auth,
    Path(device_id): Path<String>,
    body: Option<Json<ResetExpiryReq>>,
) -> AppResult<Json<Value>> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let device = device_repo::get_device(&st.pool, &device_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Device not found".into()))?;

    let owner =
        shared::resolve_spark_owner(&st.pool, &auth.email, auth.is_admin(), auth.is_superadmin())
            .await?;
    if !auth.is_superadmin() && device.owner_email != owner {
        return Err(AppError::Forbidden("Not your device".into()));
    }

    let expires_at = match req.expires_in_days {
        Some(d) if d > 0 => Some(util::iso_in(d * 86400)),
        _ => None,
    };
    device_repo::set_device_expiry(&st.pool, &device_id, expires_at.as_deref()).await?;
    Ok(Json(json!({ "success": true, "expiresAt": expires_at })))
}
