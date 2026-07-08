mod auth;
mod config;
mod db;
mod domain;
mod error;
mod repo;
mod routes;
mod state;
mod util;

use anyhow::Context;
use std::sync::Arc;
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

    let addr = format!("{}:{}", config.bind_addr, config.api_port);
    let state = state::AppState {
        pool,
        config: Arc::new(config),
    };

    let app = routes::router(state).layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("bind {addr}"))?;
    tracing::info!("listening on http://{addr}");

    axum::serve(listener, app).await.context("server error")?;
    Ok(())
}
