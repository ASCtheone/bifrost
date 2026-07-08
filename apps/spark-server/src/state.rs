use crate::auth::JwtKeys;
use crate::config::Config;
use sqlx::SqlitePool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub config: Arc<Config>,
    pub jwt: Arc<JwtKeys>,
}
