//! Public device provisioning by token (no auth; the token is the credential).

use crate::domain::Device;
use crate::error::{AppError, AppResult};
use crate::repo::{device_repo, node_repo};
use crate::routes::shared;
use crate::state::AppState;
use crate::util;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::{routing::get, Json, Router};
use serde_json::{json, Value};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/provision/:token", get(provision))
        .route("/wg/:token", get(wg_conf))
}

/// Refuse a device whose registration has lapsed (device-code expiry).
fn ensure_not_expired(device: &Device) -> AppResult<()> {
    if let Some(exp) = device.expires_at.as_deref() {
        if !exp.is_empty() && exp <= util::now_iso().as_str() {
            return Err(AppError::Forbidden(
                "Device registration has expired — reset it in the dashboard".into(),
            ));
        }
    }
    Ok(())
}

/// GET /wg/{token} — the device's primary WireGuard config as a downloadable
/// `.conf`, for importing into a router's native WireGuard client (e.g. GL.iNet).
async fn wg_conf(
    State(st): State<AppState>,
    Path(token): Path<String>,
) -> AppResult<axum::response::Response> {
    use axum::http::header;
    use axum::response::IntoResponse;

    if token.is_empty() {
        return Err(AppError::BadRequest("Missing provision token".into()));
    }
    let device = device_repo::get_device_by_token(&st.pool, &token)
        .await?
        .ok_or_else(|| AppError::NotFound("Invalid provision token".into()))?;
    if device.status == "revoked" {
        return Err(AppError::Forbidden("Device has been revoked".into()));
    }
    ensure_not_expired(&device)?;
    let all_nodes = node_repo::query_all_nodes(&st.pool).await?;
    let configs = shared::build_device_configs(&device, &all_nodes);
    let conf = configs
        .first()
        .map(|c| c.wg_config.clone())
        .ok_or_else(|| AppError::NotFound("No VPN node available for this device".into()))?;

    Ok((
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"bifrost.conf\"",
            ),
        ],
        conf,
    )
        .into_response())
}

/// Parse `X-Bifrost-Nodes: <nodeId>=ok:<age s>,<nodeId>=fail:<age s>` into
/// `{nodeId: {"ok": bool, "at": iso}}`. The router sends ages, not timestamps — its
/// clock may be wrong (no RTC) — so `at` is anchored to our own clock. Malformed
/// entries are skipped; the header is untrusted input.
fn parse_node_reports(raw: &str, now: chrono::DateTime<chrono::Utc>) -> serde_json::Map<String, Value> {
    const MAX_ENTRIES: usize = 32;
    raw.split(',')
        .take(MAX_ENTRIES)
        .filter_map(|entry| {
            let (id, rest) = entry.trim().split_once('=')?;
            let (state, age) = rest.split_once(':')?;
            let ok = match state {
                "ok" => true,
                "fail" => false,
                _ => return None,
            };
            let age: i64 = age.parse().ok().filter(|a| (0..=30 * 86_400).contains(a))?;
            let valid_id = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
            valid_id.then(|| {
                let at = (now - chrono::Duration::seconds(age)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
                (id.to_string(), json!({ "ok": ok, "at": at }))
            })
        })
        .collect()
}

async fn provision(
    State(st): State<AppState>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    if token.is_empty() {
        return Err(AppError::BadRequest("Missing provision token".into()));
    }
    let device = device_repo::get_device_by_token(&st.pool, &token)
        .await?
        .ok_or_else(|| AppError::NotFound("Invalid provision token".into()))?;
    if device.status == "revoked" {
        return Err(AppError::Forbidden("Device has been revoked".into()));
    }
    ensure_not_expired(&device)?;

    // The router reports its version + whether it holds a rollback backup on each poll.
    let header = |name| headers.get(name).and_then(|v| v.to_str().ok());
    if let Some(v) = header("x-bifrost-version").filter(|s| !s.is_empty()) {
        let backup = header("x-bifrost-backup") == Some("1");
        let safe_mode = header("x-bifrost-safemode") == Some("1");
        device_repo::update_client_report(&st.pool, &device.device_id, v, backup, safe_mode).await?;
    }
    // Per-spark handshake results, for the connection health check.
    if let Some(raw) = header("x-bifrost-nodes").filter(|s| !s.is_empty()) {
        let reports = parse_node_reports(raw, chrono::Utc::now());
        if !reports.is_empty() {
            let current = device.node_reports.as_ref().map(|j| &j.0);
            device_repo::merge_node_reports(&st.pool, &device.device_id, current, &reports).await?;
        }
    }
    // One-shot self-update instruction (set by the dashboard's Update/Revert), cleared as
    // it's handed over so a missed poll doesn't loop.
    let pending_action = device_repo::take_pending_action(&st.pool, &device.device_id).await?;
    let latest = st.latest_version.read().map(|g| g.clone()).unwrap_or_default();

    let all_nodes = node_repo::query_all_nodes(&st.pool).await?;
    let configs = shared::build_device_configs(&device, &all_nodes);

    let nodes: Vec<Value> = configs
        .iter()
        .map(|c| {
            json!({
                "nodeId": c.node_id,
                "name": c.node_name,
                "serverName": c.server_name,
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
    let primary = configs.first().map(|c| c.wg_config.clone()).unwrap_or_default();

    Ok(Json(json!({
        "deviceId": device.device_id,
        "name": device.name,
        "type": device.device_type,
        "assignedIp": device.assigned_ip,
        "nodes": nodes,
        "config": primary,
        // Router self-update: the latest published version + a one-shot action to run.
        "latestVersion": latest,
        "pendingAction": pending_action,
    })))
}

#[cfg(test)]
mod tests {
    use super::parse_node_reports;
    use chrono::{DateTime, Utc};

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-19T12:00:00Z").unwrap().with_timezone(&Utc)
    }

    #[test]
    fn parses_ok_and_fail_anchored_to_our_clock() {
        let r = parse_node_reports("node-home=fail:30, node-apt=ok:120", now());
        assert_eq!(r["node-home"]["ok"], false);
        assert_eq!(r["node-home"]["at"], "2026-10-19T11:59:30Z");
        assert_eq!(r["node-apt"]["ok"], true);
    }

    #[test]
    fn skips_malformed_entries() {
        let r = parse_node_reports("good=ok:5,bad,x=maybe:1,y=ok:-3,z=ok:abc,a b=ok:1,=ok:1", now());
        assert_eq!(r.len(), 1);
        assert!(r.contains_key("good"));
    }
}
