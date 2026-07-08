use crate::domain::Peer;
use crate::error::AppResult;
use crate::util::now_iso;
use sqlx::{QueryBuilder, Sqlite, SqlitePool};

pub async fn get_peer(pool: &SqlitePool, peer_id: &str) -> AppResult<Option<Peer>> {
    let p = sqlx::query_as::<_, Peer>("SELECT * FROM peers WHERE peer_id = ?")
        .bind(peer_id)
        .fetch_optional(pool)
        .await?;
    Ok(p)
}

const PEER_COLS: &str = "peer_id, name, server_id, node_id, unifi_peer_id, public_key, \
    private_key_encrypted, preshared_key, assigned_ip, allowed_ips, endpoint, config_version, \
    enabled, created_by, created_at, updated_at";

pub async fn put_peer(pool: &SqlitePool, p: &Peer) -> AppResult<()> {
    let sql = format!(
        "INSERT OR REPLACE INTO peers ({PEER_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    );
    sqlx::query::<Sqlite>(&sql)
        .bind(&p.peer_id)
        .bind(&p.name)
        .bind(&p.server_id)
        .bind(&p.node_id)
        .bind(&p.unifi_peer_id)
        .bind(&p.public_key)
        .bind(&p.private_key_encrypted)
        .bind(&p.preshared_key)
        .bind(&p.assigned_ip)
        .bind(&p.allowed_ips)
        .bind(&p.endpoint)
        .bind(p.config_version)
        .bind(p.enabled)
        .bind(&p.created_by)
        .bind(&p.created_at)
        .bind(&p.updated_at)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_peer(pool: &SqlitePool, peer_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM peers WHERE peer_id = ?")
        .bind(peer_id)
        .execute(pool)
        .await?;
    Ok(())
}

#[derive(Debug, Default)]
pub struct UpdatePeer {
    pub name: Option<String>,
    pub allowed_ips: Option<Vec<String>>,
    pub enabled: Option<bool>,
}

pub async fn update_peer(pool: &SqlitePool, peer_id: &str, u: UpdatePeer) -> AppResult<()> {
    let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new("UPDATE peers SET updated_at = ");
    qb.push_bind(now_iso());
    if let Some(name) = u.name {
        qb.push(", name = ").push_bind(name);
    }
    if let Some(ips) = u.allowed_ips {
        qb.push(", allowed_ips = ")
            .push_bind(serde_json::to_string(&ips).unwrap_or_else(|_| "[]".into()));
    }
    if let Some(enabled) = u.enabled {
        qb.push(", enabled = ").push_bind(enabled);
    }
    qb.push(" WHERE peer_id = ").push_bind(peer_id.to_string());
    qb.build().execute(pool).await?;
    Ok(())
}

pub async fn query_peers_by_server(pool: &SqlitePool, server_id: &str) -> AppResult<Vec<Peer>> {
    let ps = sqlx::query_as::<_, Peer>(
        "SELECT * FROM peers WHERE server_id = ? ORDER BY created_at",
    )
    .bind(server_id)
    .fetch_all(pool)
    .await?;
    Ok(ps)
}
