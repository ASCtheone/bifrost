mod auth;
mod config;
mod db;
mod domain;
mod error;
mod repo;
mod routes;
mod state;
#[cfg(test)]
mod tests;
mod util;
mod wg;

use anyhow::Context;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "spark_server=info,tower_http=info,sqlx=warn".into()),
        )
        .init();

    let config_path =
        std::env::var("BIFROST_CONFIG").unwrap_or_else(|_| "bifrost-control.toml".into());
    let config = config::Config::load(&config_path)?;
    tracing::info!(node_id = %config.node_id, "starting bifrost control plane");

    let pool = db::init_pool(&config.database_url).await?;

    // Resolve the JWT signing secret. A configured secret keeps tokens valid
    // across restarts; otherwise we generate an ephemeral one and warn.
    let jwt_secret = match &config.auth.jwt_secret {
        Some(s) if !s.is_empty() => s.clone(),
        _ => {
            tracing::warn!(
                "no auth.jwt_secret configured — generating an ephemeral secret; \
                 tokens will be invalidated on restart. Set auth.jwt_secret in production."
            );
            util::random_hex(32)
        }
    };
    let jwt = Arc::new(auth::JwtKeys::new(&jwt_secret, config.auth.token_ttl_hours));

    // First-run bootstrap: create a superadmin if the user store is empty and
    // bootstrap credentials are configured.
    routes::auth::bootstrap_admin(&pool, &config).await?;

    let addr = format!("{}:{}", config.bind_addr, config.api_port);
    let state = state::AppState {
        pool,
        config: Arc::new(config),
        jwt,
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = routes::router(state)
        .layer(TraceLayer::new_for_http())
        .layer(cors);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("bind {addr}"))?;
    tracing::info!("listening on http://{addr}");

    axum::serve(listener, app).await.context("server error")?;
    Ok(())
}
