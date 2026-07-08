use crate::domain::VpnConfig;
use crate::error::AppResult;
use crate::util::now_iso;
use serde_json::Value;
use sqlx::SqlitePool;

pub async fn get_vpn_config(pool: &SqlitePool) -> AppResult<Option<VpnConfig>> {
    let c = sqlx::query_as::<_, VpnConfig>(
        "SELECT config_version, server, defaults, updated_at, updated_by \
         FROM vpn_config WHERE id = 1",
    )
    .fetch_optional(pool)
    .await?;
    Ok(c)
}

/// Shallow-merge `patch` object keys into `base` (mirrors the TS `{...a, ...b}`).
fn merge(base: Value, patch: Option<Value>) -> Value {
    let mut obj = match base {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    if let Some(Value::Object(p)) = patch {
        for (k, v) in p {
            obj.insert(k, v);
        }
    }
    Value::Object(obj)
}

/// Create-or-merge the singleton VPN config, bumping `config_version`.
pub async fn update_vpn_config(
    pool: &SqlitePool,
    server: Option<Value>,
    defaults: Option<Value>,
    updated_by: &str,
) -> AppResult<()> {
    let now = now_iso();
    let existing = get_vpn_config(pool).await?;

    match existing {
        None => {
            let server_json = merge(Value::Object(Default::default()), server).to_string();
            let defaults_json = merge(Value::Object(Default::default()), defaults).to_string();
            sqlx::query(
                "INSERT INTO vpn_config (id, config_version, server, defaults, updated_at, updated_by) \
                 VALUES (1, 1, ?, ?, ?, ?)",
            )
            .bind(server_json)
            .bind(defaults_json)
            .bind(&now)
            .bind(updated_by)
            .execute(pool)
            .await?;
        }
        Some(c) => {
            let new_server = merge(serde_json::to_value(&c.server.0).unwrap_or_default(), server);
            let new_defaults =
                merge(serde_json::to_value(&c.defaults.0).unwrap_or_default(), defaults);
            sqlx::query(
                "UPDATE vpn_config SET server = ?, defaults = ?, config_version = config_version + 1, \
                 updated_at = ?, updated_by = ? WHERE id = 1",
            )
            .bind(new_server.to_string())
            .bind(new_defaults.to_string())
            .bind(&now)
            .bind(updated_by)
            .execute(pool)
            .await?;
        }
    }
    Ok(())
}

pub async fn increment_config_version(pool: &SqlitePool, updated_by: &str) -> AppResult<()> {
    sqlx::query(
        "UPDATE vpn_config SET config_version = config_version + 1, updated_at = ?, updated_by = ? \
         WHERE id = 1",
    )
    .bind(now_iso())
    .bind(updated_by)
    .execute(pool)
    .await?;
    Ok(())
}
