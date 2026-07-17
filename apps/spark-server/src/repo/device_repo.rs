use crate::domain::Device;
use crate::error::AppResult;
use crate::util::now_iso;
use sqlx::{Sqlite, SqlitePool};

pub async fn get_device(pool: &SqlitePool, device_id: &str) -> AppResult<Option<Device>> {
    let d = sqlx::query_as::<_, Device>("SELECT * FROM devices WHERE device_id = ?")
        .bind(device_id)
        .fetch_optional(pool)
        .await?;
    Ok(d)
}

const DEVICE_COLS: &str = "device_id, node_id, name, type, status, provision_method, \
    provision_token, assigned_ip, public_key, private_key, preshared_key, server_public_key, \
    server_endpoint, server_port, dns, allowed_ips, unifi_peer_id, enabled, last_seen, \
    created_by, owner_email, created_at, updated_at, expires_at";

/// Insert-or-replace (Dynamo `Put` overwrites).
pub async fn put_device(pool: &SqlitePool, d: &Device) -> AppResult<()> {
    let sql = format!(
        "INSERT OR REPLACE INTO devices ({DEVICE_COLS}) \
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    );
    sqlx::query::<Sqlite>(&sql)
        .bind(&d.device_id)
        .bind(&d.node_id)
        .bind(&d.name)
        .bind(&d.device_type)
        .bind(&d.status)
        .bind(&d.provision_method)
        .bind(&d.provision_token)
        .bind(&d.assigned_ip)
        .bind(&d.public_key)
        .bind(&d.private_key)
        .bind(&d.preshared_key)
        .bind(&d.server_public_key)
        .bind(&d.server_endpoint)
        .bind(d.server_port)
        .bind(&d.dns)
        .bind(&d.allowed_ips)
        .bind(&d.unifi_peer_id)
        .bind(d.enabled)
        .bind(&d.last_seen)
        .bind(&d.created_by)
        .bind(&d.owner_email)
        .bind(&d.created_at)
        .bind(&d.updated_at)
        .bind(&d.expires_at)
        .execute(pool)
        .await?;
    Ok(())
}

/// Set (or clear, with `None`) a device's registration expiry.
pub async fn set_device_expiry(
    pool: &SqlitePool,
    device_id: &str,
    expires_at: Option<&str>,
) -> AppResult<u64> {
    let res = sqlx::query("UPDATE devices SET expires_at = ?, updated_at = ? WHERE device_id = ?")
        .bind(expires_at)
        .bind(now_iso())
        .bind(device_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

pub async fn delete_device(pool: &SqlitePool, device_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM devices WHERE device_id = ?")
        .bind(device_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn query_devices_by_node(pool: &SqlitePool, node_id: &str) -> AppResult<Vec<Device>> {
    let ds = sqlx::query_as::<_, Device>(
        "SELECT * FROM devices WHERE node_id = ? ORDER BY created_at",
    )
    .bind(node_id)
    .fetch_all(pool)
    .await?;
    Ok(ds)
}

pub async fn query_all_devices(pool: &SqlitePool) -> AppResult<Vec<Device>> {
    let ds = sqlx::query_as::<_, Device>("SELECT * FROM devices ORDER BY created_at")
        .fetch_all(pool)
        .await?;
    Ok(ds)
}

pub async fn get_device_by_token(pool: &SqlitePool, token: &str) -> AppResult<Option<Device>> {
    let d = sqlx::query_as::<_, Device>(
        "SELECT * FROM devices WHERE provision_token = ? LIMIT 1",
    )
    .bind(token)
    .fetch_optional(pool)
    .await?;
    Ok(d)
}

pub async fn update_device_status(
    pool: &SqlitePool,
    device_id: &str,
    enabled: bool,
) -> AppResult<()> {
    sqlx::query("UPDATE devices SET enabled = ?, updated_at = ? WHERE device_id = ?")
        .bind(enabled)
        .bind(now_iso())
        .bind(device_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn update_device_unifi_peer_id(
    pool: &SqlitePool,
    device_id: &str,
    unifi_peer_id: &str,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE devices SET unifi_peer_id = ?, status = 'provisioned', updated_at = ? \
         WHERE device_id = ?",
    )
    .bind(unifi_peer_id)
    .bind(now_iso())
    .bind(device_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Reassign a device's owner (`""` unassigns). Super-admin only at the route.
pub async fn set_device_owner(pool: &SqlitePool, device_id: &str, owner_email: &str) -> AppResult<()> {
    sqlx::query("UPDATE devices SET owner_email = ?, updated_at = ? WHERE device_id = ?")
        .bind(owner_email)
        .bind(now_iso())
        .bind(device_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Reset a device so the spark-agent re-creates its peer (status → pending,
/// clears the UniFi peer id). Mirrors `sync-device`.
pub async fn reset_for_resync(pool: &SqlitePool, device_id: &str) -> AppResult<()> {
    sqlx::query(
        "UPDATE devices SET status = 'pending', unifi_peer_id = NULL, updated_at = ? \
         WHERE device_id = ?",
    )
    .bind(now_iso())
    .bind(device_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Re-address a device. Used when its IP was allocated before the spark's WireGuard
/// subnet was known, so it landed outside it and the controller refuses the peer.
pub async fn update_device_ip(
    pool: &SqlitePool,
    device_id: &str,
    assigned_ip: &str,
) -> AppResult<()> {
    sqlx::query("UPDATE devices SET assigned_ip = ?, updated_at = ? WHERE device_id = ?")
        .bind(assigned_ip)
        .bind(now_iso())
        .bind(device_id)
        .execute(pool)
        .await?;
    Ok(())
}

// ── Router client self-update ────────────────────────────────────

/// Record the router client's reported version + whether it has a rollback backup, from
/// its /provision poll. Also bumps last_seen, since the poll is its liveness signal.
pub async fn update_client_report(
    pool: &SqlitePool,
    device_id: &str,
    version: &str,
    backup: bool,
    safe_mode: bool,
) -> AppResult<()> {
    let now = now_iso();
    sqlx::query(
        "UPDATE devices SET client_version = ?, device_backup_available = ?, safe_mode = ?, \
         last_seen = ?, updated_at = ? WHERE device_id = ?",
    )
    .bind(version)
    .bind(backup)
    .bind(safe_mode)
    .bind(&now)
    .bind(&now)
    .bind(device_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Queue a one-shot self-update action ('update' | 'revert') for the router.
pub async fn set_pending_action(pool: &SqlitePool, device_id: &str, action: &str) -> AppResult<()> {
    sqlx::query("UPDATE devices SET pending_action = ?, updated_at = ? WHERE device_id = ?")
        .bind(action)
        .bind(now_iso())
        .bind(device_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Read and clear the pending action (fire-once) — so a missed poll just needs another
/// click rather than looping a failing update.
pub async fn take_pending_action(pool: &SqlitePool, device_id: &str) -> AppResult<Option<String>> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT pending_action FROM devices WHERE device_id = ?")
            .bind(device_id)
            .fetch_optional(pool)
            .await?;
    let action = row.and_then(|(a,)| a).filter(|s| !s.is_empty());
    if action.is_some() {
        sqlx::query("UPDATE devices SET pending_action = NULL, updated_at = ? WHERE device_id = ?")
            .bind(now_iso())
            .bind(device_id)
            .execute(pool)
            .await?;
    }
    Ok(action)
}
