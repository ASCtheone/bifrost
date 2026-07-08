use crate::domain::SystemConfig;
use crate::error::AppResult;
use sqlx::SqlitePool;

impl Default for SystemConfig {
    fn default() -> Self {
        SystemConfig {
            heartbeat_interval_seconds: 30,
            stale_threshold_seconds: 120,
            sync_timeout_seconds: 60,
            max_retries: 10,
            drift_check_interval_seconds: 300,
            auto_promote_enabled: true,
            auto_promote_stale_seconds: 120,
        }
    }
}

pub async fn get_system_config(pool: &SqlitePool) -> AppResult<SystemConfig> {
    let cfg = sqlx::query_as::<_, SystemConfig>(
        "SELECT heartbeat_interval_seconds, stale_threshold_seconds, sync_timeout_seconds, \
         max_retries, drift_check_interval_seconds, auto_promote_enabled, auto_promote_stale_seconds \
         FROM system_config WHERE id = 1",
    )
    .fetch_optional(pool)
    .await?
    .unwrap_or_default();
    Ok(cfg)
}
