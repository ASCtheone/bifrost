//! Pending device-pairing codes. A device generates a code on first boot; a
//! signed-in user claims it, which ties a device to their account and stores the
//! provision token for the device to pick up.

use crate::error::AppResult;
use sqlx::{FromRow, SqlitePool};

#[derive(Debug, Clone, FromRow)]
pub struct DeviceCode {
    pub code: String,
    pub status: String,
    pub device_id: Option<String>,
    pub provision_token: Option<String>,
    pub owner_email: Option<String>,
    pub callback_url: Option<String>,
    pub name: String,
    pub created_at: String,
    pub code_expires_at: String,
}

impl DeviceCode {
    /// The pending code is still claimable (not registered/consumed, not expired).
    pub fn is_claimable(&self, now_iso: &str) -> bool {
        self.status == "pending" && self.code_expires_at.as_str() > now_iso
    }
}

pub async fn create(
    pool: &SqlitePool,
    code: &str,
    name: &str,
    callback_url: Option<&str>,
    created_at: &str,
    code_expires_at: &str,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO device_codes (code, status, name, callback_url, created_at, code_expires_at) \
         VALUES (?, 'pending', ?, ?, ?, ?)",
    )
    .bind(code)
    .bind(name)
    .bind(callback_url)
    .bind(created_at)
    .bind(code_expires_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get(pool: &SqlitePool, code: &str) -> AppResult<Option<DeviceCode>> {
    let c = sqlx::query_as::<_, DeviceCode>("SELECT * FROM device_codes WHERE code = ?")
        .bind(code)
        .fetch_optional(pool)
        .await?;
    Ok(c)
}

/// Claim a pending code: tie it to a device + owner and store the token.
pub async fn mark_registered(
    pool: &SqlitePool,
    code: &str,
    device_id: &str,
    provision_token: &str,
    owner_email: &str,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE device_codes SET status = 'registered', device_id = ?, provision_token = ?, \
         owner_email = ? WHERE code = ?",
    )
    .bind(device_id)
    .bind(provision_token)
    .bind(owner_email)
    .bind(code)
    .execute(pool)
    .await?;
    Ok(())
}

/// Mark a registered code as consumed once the device has fetched its token.
pub async fn mark_consumed(pool: &SqlitePool, code: &str) -> AppResult<()> {
    sqlx::query("UPDATE device_codes SET status = 'consumed' WHERE code = ?")
        .bind(code)
        .execute(pool)
        .await?;
    Ok(())
}

/// Best-effort cleanup of stale pending codes.
pub async fn delete_expired(pool: &SqlitePool, now_iso: &str) -> AppResult<u64> {
    let res = sqlx::query(
        "DELETE FROM device_codes WHERE status = 'pending' AND code_expires_at <= ?",
    )
    .bind(now_iso)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}
