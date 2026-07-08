use crate::error::AppResult;
use crate::util::{now_iso, ulid};
use serde_json::Value;
use sqlx::SqlitePool;

/// Append an audit-log entry. `action` values mirror the old `AuditAction` union
/// (e.g. "node.adopted", "peer.created"); not enforced here to stay flexible.
pub async fn write_audit_log(
    pool: &SqlitePool,
    action: &str,
    actor: &str,
    target_id: &str,
    details: Value,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO audit_log (id, action, actor, target_id, details, timestamp) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(ulid())
    .bind(action)
    .bind(actor)
    .bind(target_id)
    .bind(details.to_string())
    .bind(now_iso())
    .execute(pool)
    .await?;
    Ok(())
}
