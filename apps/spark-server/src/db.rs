use anyhow::Context;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
use std::str::FromStr;
use std::time::Duration;

/// Open the SQLite pool (WAL mode) and run embedded migrations.
pub async fn init_pool(database_url: &str) -> anyhow::Result<SqlitePool> {
    // Ensure the parent directory exists for file-backed databases.
    if let Some(path) = database_url.strip_prefix("sqlite://") {
        if let Some(parent) = std::path::Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).ok();
            }
        }
    }

    let opts = SqliteConnectOptions::from_str(database_url)
        .context("parse database_url")?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5))
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await
        .context("open sqlite pool")?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("run migrations")?;

    Ok(pool)
}
