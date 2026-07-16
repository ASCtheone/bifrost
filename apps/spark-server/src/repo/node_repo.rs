use crate::domain::{Node, PendingKey};
use crate::error::{AppError, AppResult};
use crate::util::{iso_in, now_iso};
use serde_json::Value;
use sqlx::{QueryBuilder, Sqlite, SqlitePool};

// ── Basic CRUD ──────────────────────────────────────────────────

pub async fn get_node(pool: &SqlitePool, node_id: &str) -> AppResult<Option<Node>> {
    let node = sqlx::query_as::<_, Node>("SELECT * FROM nodes WHERE node_id = ?")
        .bind(node_id)
        .fetch_optional(pool)
        .await?;
    Ok(node)
}

const NODE_COLS: &str = "node_id, node_name, owner_id, owner_email, status, role, priority, \
    last_seen, tunnel_url, tunnel_id, controller_url, controller_api_key, spark_vpn_name, \
    spark_vpn_id, pending_vpn_create, sync_state, last_applied_version, actual_config, error, \
    adoption_status, adoption_code, code_expires_at, node_key_hash, key_issued_at, wan_ip, geo, \
    isp_name, speed_down, speed_up, speed_ping, pending_peer_deletions, created_at, updated_at, paused";

fn bind_node<'q>(
    q: sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    n: &'q Node,
) -> sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    q.bind(&n.node_id)
        .bind(&n.node_name)
        .bind(&n.owner_id)
        .bind(&n.owner_email)
        .bind(&n.status)
        .bind(&n.role)
        .bind(n.priority)
        .bind(&n.last_seen)
        .bind(&n.tunnel_url)
        .bind(&n.tunnel_id)
        .bind(&n.controller_url)
        .bind(&n.controller_api_key)
        .bind(&n.spark_vpn_name)
        .bind(&n.spark_vpn_id)
        .bind(n.pending_vpn_create)
        .bind(&n.sync_state)
        .bind(n.last_applied_version)
        .bind(&n.actual_config)
        .bind(&n.error)
        .bind(&n.adoption_status)
        .bind(&n.adoption_code)
        .bind(&n.code_expires_at)
        .bind(&n.node_key_hash)
        .bind(&n.key_issued_at)
        .bind(&n.wan_ip)
        .bind(&n.geo)
        .bind(&n.isp_name)
        .bind(n.speed_down)
        .bind(n.speed_up)
        .bind(n.speed_ping)
        .bind(&n.pending_peer_deletions)
        .bind(&n.created_at)
        .bind(&n.updated_at)
        .bind(n.paused)
}

const NODE_PLACEHOLDERS: &str =
    "?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?";

/// Insert-or-replace (Dynamo `Put` overwrites).
pub async fn put_node(pool: &SqlitePool, node: &Node) -> AppResult<()> {
    let sql = format!("INSERT OR REPLACE INTO nodes ({NODE_COLS}) VALUES ({NODE_PLACEHOLDERS})");
    bind_node(sqlx::query(&sql), node).execute(pool).await?;
    Ok(())
}

/// Insert only if absent (Dynamo `attribute_not_exists(PK)`).
pub async fn put_node_if_not_exists(pool: &SqlitePool, node: &Node) -> AppResult<()> {
    let sql = format!("INSERT INTO nodes ({NODE_COLS}) VALUES ({NODE_PLACEHOLDERS})");
    bind_node(sqlx::query(&sql), node)
        .execute(pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(db) if db.is_unique_violation() => {
                AppError::Conflict("node already exists".into())
            }
            other => AppError::Db(other),
        })?;
    Ok(())
}

pub async fn delete_node(pool: &SqlitePool, node_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM nodes WHERE node_id = ?")
        .bind(node_id)
        .execute(pool)
        .await?;
    Ok(())
}

// ── Role management ─────────────────────────────────────────────

pub async fn update_node_role(
    pool: &SqlitePool,
    node_id: &str,
    role: &str,
    priority: i64,
) -> AppResult<()> {
    sqlx::query("UPDATE nodes SET role = ?, priority = ?, updated_at = ? WHERE node_id = ?")
        .bind(role)
        .bind(priority)
        .bind(now_iso())
        .bind(node_id)
        .execute(pool)
        .await?;
    Ok(())
}

// ── Queries ─────────────────────────────────────────────────────

pub async fn query_nodes_by_role(pool: &SqlitePool, role: &str) -> AppResult<Vec<Node>> {
    let nodes = sqlx::query_as::<_, Node>("SELECT * FROM nodes WHERE role = ? ORDER BY priority")
        .bind(role)
        .fetch_all(pool)
        .await?;
    Ok(nodes)
}

/// Online secondaries, highest priority first (candidates for auto-promotion).
pub async fn query_online_secondaries_by_priority(
    pool: &SqlitePool,
    limit: i64,
) -> AppResult<Vec<Node>> {
    let nodes = sqlx::query_as::<_, Node>(
        "SELECT * FROM nodes WHERE role = 'secondary' AND status = 'online' \
         ORDER BY priority DESC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(nodes)
}

pub async fn query_all_nodes(pool: &SqlitePool) -> AppResult<Vec<Node>> {
    let nodes = sqlx::query_as::<_, Node>("SELECT * FROM nodes ORDER BY created_at")
        .fetch_all(pool)
        .await?;
    Ok(nodes)
}

// ── Adoption flow ───────────────────────────────────────────────

pub async fn get_node_by_adoption_code(
    pool: &SqlitePool,
    code: &str,
) -> AppResult<Option<Node>> {
    let node = sqlx::query_as::<_, Node>("SELECT * FROM nodes WHERE adoption_code = ? LIMIT 1")
        .bind(code)
        .fetch_optional(pool)
        .await?;
    Ok(node)
}

pub async fn update_adoption_status(
    pool: &SqlitePool,
    node_id: &str,
    adoption_status: &str,
) -> AppResult<()> {
    sqlx::query("UPDATE nodes SET adoption_status = ?, updated_at = ? WHERE node_id = ?")
        .bind(adoption_status)
        .bind(now_iso())
        .bind(node_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Store the hashed node key, mark adopted, and clear the (now consumed)
/// adoption code + expiry. Mirrors the old `setNodeKeyHash`.
pub async fn set_node_key_hash(pool: &SqlitePool, node_id: &str, key_hash: &str) -> AppResult<()> {
    let now = now_iso();
    sqlx::query(
        "UPDATE nodes SET node_key_hash = ?, key_issued_at = ?, adoption_status = 'adopted', \
         updated_at = ?, adoption_code = NULL, code_expires_at = NULL WHERE node_id = ?",
    )
    .bind(key_hash)
    .bind(&now)
    .bind(&now)
    .bind(node_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Issue a fresh adoption code for an existing node and send it back to `pending`,
/// dropping the current node key. This is the "reinstall this spark" path: adoption
/// consumes the code (see `set_node_key_hash`), so a rebuilt box has nothing to
/// register with. Destructive by design — the old key stops working — so it must
/// never be triggered by anything as casual as a copy button.
pub async fn reissue_adoption_code(
    pool: &SqlitePool,
    node_id: &str,
    code: &str,
    expires_at: &str,
) -> AppResult<u64> {
    let now = now_iso();
    let res = sqlx::query(
        "UPDATE nodes SET adoption_code = ?, code_expires_at = ?, adoption_status = 'pending', \
         node_key_hash = NULL, key_issued_at = NULL, updated_at = ? WHERE node_id = ?",
    )
    .bind(code)
    .bind(expires_at)
    .bind(&now)
    .bind(node_id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

pub async fn revoke_node_key(pool: &SqlitePool, node_id: &str) -> AppResult<()> {
    sqlx::query(
        "UPDATE nodes SET adoption_status = 'revoked', updated_at = ?, \
         node_key_hash = NULL, key_issued_at = NULL WHERE node_id = ?",
    )
    .bind(now_iso())
    .bind(node_id)
    .execute(pool)
    .await?;
    Ok(())
}

// ── Admin mutations ─────────────────────────────────────────────

/// Fields an admin may patch on a node (each `Some` is applied). `owner` set to
/// `Some(String)` reassigns ownership; `Some("")` unassigns.
#[derive(Debug, Default)]
pub struct NodePatch {
    pub node_name: Option<String>,
    pub controller_url: Option<String>,
    pub controller_api_key: Option<String>,
    pub tunnel_url: Option<String>,
    pub tunnel_id: Option<String>,
    pub priority: Option<i64>,
    pub owner: Option<String>,
    pub unifi_host: Option<String>,
    pub unifi_port: Option<i64>,
    pub unifi_site: Option<String>,
    pub unifi_username: Option<String>,
    /// Already-encrypted blob (the route encrypts before it gets here, so a
    /// plaintext password can never reach the query builder by mistake).
    pub unifi_password_enc: Option<String>,
    pub unifi_api_key_enc: Option<String>,
    pub unifi_insecure: Option<bool>,
    pub endpoint_override: Option<String>,
}

impl NodePatch {
    pub fn is_empty(&self) -> bool {
        self.node_name.is_none()
            && self.controller_url.is_none()
            && self.controller_api_key.is_none()
            && self.tunnel_url.is_none()
            && self.tunnel_id.is_none()
            && self.priority.is_none()
            && self.owner.is_none()
            && self.unifi_host.is_none()
            && self.unifi_port.is_none()
            && self.unifi_site.is_none()
            && self.unifi_username.is_none()
            && self.unifi_password_enc.is_none()
            && self.unifi_api_key_enc.is_none()
            && self.unifi_insecure.is_none()
            && self.endpoint_override.is_none()
    }
}

/// Apply a partial update to a node. Returns rows affected (0 if node absent).
pub async fn patch_node(pool: &SqlitePool, node_id: &str, p: NodePatch) -> AppResult<u64> {
    let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new("UPDATE nodes SET updated_at = ");
    qb.push_bind(now_iso());
    if let Some(v) = p.node_name {
        qb.push(", node_name = ").push_bind(v);
    }
    if let Some(v) = p.controller_url {
        qb.push(", controller_url = ").push_bind(v);
    }
    if let Some(v) = p.controller_api_key {
        qb.push(", controller_api_key = ").push_bind(v);
    }
    if let Some(v) = p.tunnel_url {
        qb.push(", tunnel_url = ").push_bind(v);
    }
    if let Some(v) = p.tunnel_id {
        qb.push(", tunnel_id = ").push_bind(v);
    }
    if let Some(v) = p.priority {
        qb.push(", priority = ").push_bind(v);
    }
    if let Some(v) = p.unifi_host {
        qb.push(", unifi_host = ").push_bind(v);
    }
    if let Some(v) = p.unifi_port {
        qb.push(", unifi_port = ").push_bind(v);
    }
    if let Some(v) = p.unifi_site {
        qb.push(", unifi_site = ").push_bind(v);
    }
    if let Some(v) = p.unifi_username {
        qb.push(", unifi_username = ").push_bind(v);
    }
    if let Some(v) = p.unifi_password_enc {
        qb.push(", unifi_password_enc = ").push_bind(v);
    }
    if let Some(v) = p.unifi_api_key_enc {
        qb.push(", unifi_api_key_enc = ").push_bind(v);
    }
    if let Some(v) = p.unifi_insecure {
        qb.push(", unifi_insecure = ").push_bind(v);
    }
    if let Some(v) = p.endpoint_override {
        qb.push(", endpoint_override = ").push_bind(v);
    }
    if let Some(owner) = p.owner {
        qb.push(", owner_id = ").push_bind(owner.clone());
        qb.push(", owner_email = ").push_bind(owner);
    }
    qb.push(" WHERE node_id = ").push_bind(node_id.to_string());
    let res = qb.build().execute(pool).await?;
    Ok(res.rows_affected())
}

/// Pause or resume a node (operator override). Returns rows affected.
pub async fn set_paused(pool: &SqlitePool, node_id: &str, paused: bool) -> AppResult<u64> {
    let res = sqlx::query("UPDATE nodes SET paused = ?, updated_at = ? WHERE node_id = ?")
        .bind(paused)
        .bind(now_iso())
        .bind(node_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// Flag the node so its spark-agent creates the named VPN out-of-band.
pub async fn mark_vpn_create(pool: &SqlitePool, node_id: &str, vpn_name: &str) -> AppResult<()> {
    // Clear spark_vpn_id too: "Create VPN" provisions a *fresh* spark-owned server, so any
    // previous binding (including a stale one a pre-creation spark reported) must be
    // dropped — otherwise the spark would select the old server by id instead of creating.
    // Re-running is safe: the spark dedups by name, so it adopts the server it already
    // made rather than making a duplicate.
    sqlx::query(
        "UPDATE nodes SET spark_vpn_name = ?, pending_vpn_create = 1, spark_vpn_id = NULL, \
         updated_at = ? WHERE node_id = ?",
    )
    .bind(vpn_name)
    .bind(now_iso())
    .bind(node_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Append peer ids to the node's `pending_peer_deletions` work queue (a JSON
/// array consumed by the spark-agent). Read-modify-write on the JSON column.
pub async fn append_pending_peer_deletions(
    pool: &SqlitePool,
    node_id: &str,
    peer_ids: &[String],
) -> AppResult<()> {
    if peer_ids.is_empty() {
        return Ok(());
    }
    let existing: Option<(Option<String>,)> =
        sqlx::query_as("SELECT pending_peer_deletions FROM nodes WHERE node_id = ?")
            .bind(node_id)
            .fetch_optional(pool)
            .await?;
    let mut list: Vec<String> = existing
        .and_then(|(json,)| json)
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default();
    list.extend(peer_ids.iter().cloned());
    let json = serde_json::to_string(&list).unwrap_or_else(|_| "[]".into());
    sqlx::query("UPDATE nodes SET pending_peer_deletions = ?, updated_at = ? WHERE node_id = ?")
        .bind(json)
        .bind(now_iso())
        .bind(node_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Append a management command to the node's queue (read-modify-write on the JSON
/// `pending_commands` column). The command is an opaque object the spark interprets;
/// it must carry a unique `id` so the heartbeat can acknowledge and remove it.
pub async fn append_command(pool: &SqlitePool, node_id: &str, command: serde_json::Value) -> AppResult<()> {
    let existing: Option<(String,)> = sqlx::query_as("SELECT pending_commands FROM nodes WHERE node_id = ?")
        .bind(node_id)
        .fetch_optional(pool)
        .await?;
    let mut list: Vec<serde_json::Value> = existing
        .and_then(|(s,)| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    list.push(command);
    let json = serde_json::to_string(&list).unwrap_or_else(|_| "[]".into());
    sqlx::query("UPDATE nodes SET pending_commands = ?, updated_at = ? WHERE node_id = ?")
        .bind(json)
        .bind(now_iso())
        .bind(node_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Acknowledge executed commands: drop the given ids from `pending_commands` and record
/// their results in `command_results` (for the dashboard). Ids the spark reports that were
/// already gone are simply not found — harmless.
pub async fn ack_commands(
    pool: &SqlitePool,
    node_id: &str,
    executed_ids: &[String],
    results: &serde_json::Value,
) -> AppResult<()> {
    if executed_ids.is_empty() {
        return Ok(());
    }
    let existing: Option<(String,)> = sqlx::query_as("SELECT pending_commands FROM nodes WHERE node_id = ?")
        .bind(node_id)
        .fetch_optional(pool)
        .await?;
    let done: std::collections::HashSet<&str> = executed_ids.iter().map(String::as_str).collect();
    let remaining: Vec<serde_json::Value> = existing
        .and_then(|(s,)| serde_json::from_str::<Vec<serde_json::Value>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.get("id").and_then(|v| v.as_str()).map(|id| !done.contains(id)).unwrap_or(true))
        .collect();
    sqlx::query("UPDATE nodes SET pending_commands = ?, command_results = ?, updated_at = ? WHERE node_id = ?")
        .bind(serde_json::to_string(&remaining).unwrap_or_else(|_| "[]".into()))
        .bind(results.to_string())
        .bind(now_iso())
        .bind(node_id)
        .execute(pool)
        .await?;
    Ok(())
}

// ── Heartbeat ───────────────────────────────────────────────────

#[derive(Debug, Default)]
pub struct HeartbeatUpdate {
    pub actual_config: Value, // always written; Value::Null clears the column
    pub wan_ip: Option<String>,
    pub geo: Option<Value>,
    pub isp_name: Option<String>,
    pub speed_down: Option<f64>,
    pub speed_up: Option<f64>,
    pub speed_ping: Option<f64>,
    pub spark_vpn_id: Option<String>,
    pub pending_vpn_create: Option<bool>,
    pub clear_peer_deletions: bool,
    /// Always written. `None` clears it, so a spark that recovers stops showing a
    /// stale error; `Some` records why UniFi is unhappy while the spark itself is fine.
    pub error: Option<String>,
}

pub async fn update_heartbeat(
    pool: &SqlitePool,
    node_id: &str,
    u: HeartbeatUpdate,
) -> AppResult<()> {
    let now = now_iso();
    let mut qb: QueryBuilder<Sqlite> =
        QueryBuilder::new("UPDATE nodes SET status = 'online', last_seen = ");
    qb.push_bind(now.clone());
    qb.push(", updated_at = ").push_bind(now);

    let ac = match u.actual_config {
        Value::Null => None,
        v => Some(v.to_string()),
    };
    qb.push(", actual_config = ").push_bind(ac);
    qb.push(", error = ").push_bind(u.error);

    if let Some(v) = u.wan_ip {
        qb.push(", wan_ip = ").push_bind(v);
    }
    if let Some(v) = u.geo {
        qb.push(", geo = ").push_bind(v.to_string());
    }
    if let Some(v) = u.isp_name {
        qb.push(", isp_name = ").push_bind(v);
    }
    if let Some(v) = u.speed_down {
        qb.push(", speed_down = ").push_bind(v);
    }
    if let Some(v) = u.speed_up {
        qb.push(", speed_up = ").push_bind(v);
    }
    if let Some(v) = u.speed_ping {
        qb.push(", speed_ping = ").push_bind(v);
    }
    if let Some(v) = u.spark_vpn_id {
        qb.push(", spark_vpn_id = ").push_bind(v);
    }
    if let Some(v) = u.pending_vpn_create {
        qb.push(", pending_vpn_create = ").push_bind(v);
    }
    if u.clear_peer_deletions {
        qb.push(", pending_peer_deletions = ").push_bind("[]".to_string());
    }

    qb.push(" WHERE node_id = ").push_bind(node_id.to_string());
    qb.build().execute(pool).await?;
    Ok(())
}

// ── Pending key (temporary raw key for adoption handoff) ────────

pub async fn put_pending_key(pool: &SqlitePool, node_id: &str, raw_key: &str) -> AppResult<()> {
    sqlx::query(
        "INSERT OR REPLACE INTO pending_keys (node_id, raw_key, expires_at) VALUES (?, ?, ?)",
    )
    .bind(node_id)
    .bind(raw_key)
    .bind(iso_in(300))
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_pending_key(pool: &SqlitePool, node_id: &str) -> AppResult<Option<PendingKey>> {
    let pk = sqlx::query_as::<_, PendingKey>("SELECT * FROM pending_keys WHERE node_id = ?")
        .bind(node_id)
        .fetch_optional(pool)
        .await?;
    Ok(pk)
}

pub async fn delete_pending_key(pool: &SqlitePool, node_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM pending_keys WHERE node_id = ?")
        .bind(node_id)
        .execute(pool)
        .await?;
    Ok(())
}
