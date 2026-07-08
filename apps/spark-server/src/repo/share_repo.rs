use crate::domain::SparkShare;
use crate::error::AppResult;
use crate::util::now_iso;
use sqlx::SqlitePool;

/// All shares for a given node (who it's shared with).
pub async fn list_shares_for_node(pool: &SqlitePool, node_id: &str) -> AppResult<Vec<SparkShare>> {
    let shares = sqlx::query_as::<_, SparkShare>(
        "SELECT * FROM spark_shares WHERE node_id = ? ORDER BY created_at",
    )
    .bind(node_id)
    .fetch_all(pool)
    .await?;
    Ok(shares)
}

/// The set of node ids shared with a given email.
pub async fn shared_node_ids_for_email(pool: &SqlitePool, email: &str) -> AppResult<Vec<String>> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT node_id FROM spark_shares WHERE shared_with_email = ?")
            .bind(email)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

pub async fn put_share(
    pool: &SqlitePool,
    node_id: &str,
    shared_with_email: &str,
    shared_by_email: &str,
) -> AppResult<()> {
    sqlx::query(
        "INSERT OR REPLACE INTO spark_shares (node_id, shared_with_email, shared_by_email, created_at) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(node_id)
    .bind(shared_with_email)
    .bind(shared_by_email)
    .bind(now_iso())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_share(pool: &SqlitePool, node_id: &str, shared_with_email: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM spark_shares WHERE node_id = ? AND shared_with_email = ?")
        .bind(node_id)
        .bind(shared_with_email)
        .execute(pool)
        .await?;
    Ok(())
}
