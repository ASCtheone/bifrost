use crate::domain::IpPool;
use crate::error::{AppError, AppResult};
use sqlx::SqlitePool;

pub async fn get_ip_pool(pool: &SqlitePool, subnet_key: &str) -> AppResult<Option<IpPool>> {
    let p = sqlx::query_as::<_, IpPool>("SELECT * FROM ip_pools WHERE subnet_key = ?")
        .bind(subnet_key)
        .fetch_optional(pool)
        .await?;
    Ok(p)
}

pub async fn create_ip_pool(
    pool: &SqlitePool,
    subnet_key: &str,
    subnet: &str,
    gateway: &str,
    total_addresses: i64,
) -> AppResult<IpPool> {
    sqlx::query(
        "INSERT INTO ip_pools (subnet_key, subnet, gateway, next_available, total_addresses) \
         VALUES (?, ?, ?, 2, ?)",
    )
    .bind(subnet_key)
    .bind(subnet)
    .bind(gateway)
    .bind(total_addresses)
    .execute(pool)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            AppError::Conflict("ip pool already exists".into())
        }
        other => AppError::Db(other),
    })?;

    Ok(IpPool {
        subnet_key: subnet_key.to_string(),
        subnet: subnet.to_string(),
        gateway: gateway.to_string(),
        next_available: 2,
        total_addresses,
    })
}

/// Allocate the next free address to `peer_id`, idempotently. Runs in a single
/// transaction; the `UNIQUE(subnet_key, ip)` constraint guarantees no address
/// is ever handed out twice (replacing the old conditional-write retry loop).
pub async fn allocate_ip(
    pool: &SqlitePool,
    subnet_key: &str,
    peer_id: &str,
) -> AppResult<String> {
    let mut tx = pool.begin().await?;

    // Already allocated? Return the existing address.
    if let Some((ip,)) = sqlx::query_as::<_, (String,)>(
        "SELECT ip FROM ip_allocations WHERE subnet_key = ? AND peer_id = ?",
    )
    .bind(subnet_key)
    .bind(peer_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        return Ok(ip);
    }

    let pool_row = sqlx::query_as::<_, IpPool>(
        "SELECT * FROM ip_pools WHERE subnet_key = ?",
    )
    .bind(subnet_key)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("IP pool {subnet_key} not found")))?;

    if pool_row.next_available >= pool_row.total_addresses {
        return Err(AppError::Conflict(format!("IP pool {subnet_key} exhausted")));
    }

    // base = first three octets of the subnet address
    let base = pool_row
        .subnet
        .split('/')
        .next()
        .unwrap_or("")
        .rsplitn(2, '.')
        .last()
        .unwrap_or("")
        .to_string();
    let ip = format!("{base}.{}", pool_row.next_available);

    sqlx::query("INSERT INTO ip_allocations (subnet_key, peer_id, ip) VALUES (?, ?, ?)")
        .bind(subnet_key)
        .bind(peer_id)
        .bind(&ip)
        .execute(&mut *tx)
        .await?;

    sqlx::query("UPDATE ip_pools SET next_available = next_available + 1 WHERE subnet_key = ?")
        .bind(subnet_key)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(ip)
}

pub async fn release_ip(pool: &SqlitePool, subnet_key: &str, peer_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM ip_allocations WHERE subnet_key = ? AND peer_id = ?")
        .bind(subnet_key)
        .bind(peer_id)
        .execute(pool)
        .await?;
    Ok(())
}
