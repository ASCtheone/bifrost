use crate::domain::User;
use crate::error::{AppError, AppResult};
use crate::util::now_iso;
use sqlx::{Sqlite, SqlitePool};

const USER_COLS: &str = "user_id, username, email, display_name, password_hash, groups, \
    enabled, status, owner_email, must_change, created_at, updated_at";

fn bind_user<'q>(
    q: sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    u: &'q User,
) -> sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    q.bind(&u.user_id)
        .bind(&u.username)
        .bind(&u.email)
        .bind(&u.display_name)
        .bind(&u.password_hash)
        .bind(&u.groups)
        .bind(u.enabled)
        .bind(&u.status)
        .bind(&u.owner_email)
        .bind(u.must_change)
        .bind(&u.created_at)
        .bind(&u.updated_at)
}

/// Insert a new user, failing with Conflict on a duplicate username/email.
pub async fn create_user(pool: &SqlitePool, u: &User) -> AppResult<()> {
    let sql = format!("INSERT INTO users ({USER_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    bind_user(sqlx::query(&sql), u)
        .execute(pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(db) if db.is_unique_violation() => {
                AppError::Conflict("A user with this email already exists".into())
            }
            other => AppError::Db(other),
        })?;
    Ok(())
}

pub async fn get_user_by_id(pool: &SqlitePool, user_id: &str) -> AppResult<Option<User>> {
    let u = sqlx::query_as::<_, User>("SELECT * FROM users WHERE user_id = ?")
        .bind(user_id)
        .fetch_optional(pool)
        .await?;
    Ok(u)
}

pub async fn get_user_by_username(pool: &SqlitePool, username: &str) -> AppResult<Option<User>> {
    let u = sqlx::query_as::<_, User>("SELECT * FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(pool)
        .await?;
    Ok(u)
}

/// Look up a user by email OR username (login accepts either).
pub async fn get_user_by_login(pool: &SqlitePool, login: &str) -> AppResult<Option<User>> {
    let u = sqlx::query_as::<_, User>(
        "SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1",
    )
    .bind(login)
    .bind(login)
    .fetch_optional(pool)
    .await?;
    Ok(u)
}

pub async fn get_user_by_email(pool: &SqlitePool, email: &str) -> AppResult<Option<User>> {
    let u = sqlx::query_as::<_, User>("SELECT * FROM users WHERE email = ? LIMIT 1")
        .bind(email)
        .fetch_optional(pool)
        .await?;
    Ok(u)
}

pub async fn query_all_users(pool: &SqlitePool) -> AppResult<Vec<User>> {
    let us = sqlx::query_as::<_, User>("SELECT * FROM users ORDER BY created_at")
        .fetch_all(pool)
        .await?;
    Ok(us)
}

pub async fn count_users(pool: &SqlitePool) -> AppResult<i64> {
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await?;
    Ok(n)
}

/// The owning admin's email for a given user email (old `UserOwnership`).
pub async fn get_user_owner(pool: &SqlitePool, email: &str) -> AppResult<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT owner_email FROM users WHERE email = ? LIMIT 1")
            .bind(email)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(o,)| o).filter(|o| !o.is_empty()))
}

pub async fn set_enabled(pool: &SqlitePool, username: &str, enabled: bool) -> AppResult<u64> {
    let res = sqlx::query("UPDATE users SET enabled = ?, updated_at = ? WHERE username = ?")
        .bind(enabled)
        .bind(now_iso())
        .bind(username)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

pub async fn set_groups(pool: &SqlitePool, username: &str, groups: &[String]) -> AppResult<u64> {
    let json = serde_json::to_string(groups).unwrap_or_else(|_| "[]".into());
    let res = sqlx::query("UPDATE users SET groups = ?, updated_at = ? WHERE username = ?")
        .bind(json)
        .bind(now_iso())
        .bind(username)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

pub async fn set_password(
    pool: &SqlitePool,
    username: &str,
    password_hash: &str,
    must_change: bool,
) -> AppResult<u64> {
    let res = sqlx::query(
        "UPDATE users SET password_hash = ?, must_change = ?, status = ?, updated_at = ? \
         WHERE username = ?",
    )
    .bind(password_hash)
    .bind(must_change)
    .bind(if must_change { "FORCE_CHANGE_PASSWORD" } else { "CONFIRMED" })
    .bind(now_iso())
    .bind(username)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

pub async fn delete_user_by_username(pool: &SqlitePool, username: &str) -> AppResult<u64> {
    let res = sqlx::query("DELETE FROM users WHERE username = ?")
        .bind(username)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}
