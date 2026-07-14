use crate::auth::JwtKeys;
use crate::config::Config;
use crate::crypto::Cipher;
use sqlx::SqlitePool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub config: Arc<Config>,
    pub jwt: Arc<JwtKeys>,
    /// Encrypts secrets stored in the database (today: the UniFi password).
    pub cipher: Arc<Cipher>,
}
