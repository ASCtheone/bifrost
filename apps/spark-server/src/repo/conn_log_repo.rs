use crate::domain::ConnectionLog;
use crate::error::AppResult;
use sqlx::SqlitePool;

/// Append a connection-log event for a device.
#[allow(clippy::too_many_arguments)]
pub async fn insert(
    pool: &SqlitePool,
    device_id: &str,
    seq: &str,
    action: &str,
    connected_node_id: Option<&str>,
    connected_node_name: Option<&str>,
    source_ip: &str,
    location: Option<&str>,
    user_agent: &str,
    user_email: Option<&str>,
    timestamp: &str,
    expires_at: i64,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO connection_logs (device_id, seq, action, connected_node_id, \
         connected_node_name, source_ip, location, user_agent, user_email, timestamp, expires_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(device_id)
    .bind(seq)
    .bind(action)
    .bind(connected_node_id)
    .bind(connected_node_name)
    .bind(source_ip)
    .bind(location)
    .bind(user_agent)
    .bind(user_email)
    .bind(timestamp)
    .bind(expires_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// Most-recent connection logs for a device (newest first), capped at `limit`.
pub async fn recent(
    pool: &SqlitePool,
    device_id: &str,
    limit: i64,
) -> AppResult<Vec<ConnectionLog>> {
    let logs = sqlx::query_as::<_, ConnectionLog>(
        "SELECT * FROM connection_logs WHERE device_id = ? ORDER BY seq DESC LIMIT ?",
    )
    .bind(device_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(logs)
}
