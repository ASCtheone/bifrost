// The node list JSON is a large `json!` literal; the default macro recursion limit is
// too low for it once every field is included.
#![recursion_limit = "256"]

mod auth;
mod config;
mod crypto;
mod db;
mod domain;
mod error;
mod net;
mod release;
mod repo;
mod routes;
mod state;
#[cfg(test)]
mod tests;
mod util;
mod wg;

use anyhow::Context;
use axum::response::Redirect;
use axum::routing::get;
use axum::Router;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
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
    let mut config = config::Config::load(&config_path)?;
    apply_env_overrides(&mut config);
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
    // Guard against a non-positive TTL, which would make every token expire
    // immediately (only the ~60s jsonwebtoken leeway would keep it alive).
    let token_ttl_hours = if config.auth.token_ttl_hours > 0 {
        config.auth.token_ttl_hours
    } else {
        tracing::warn!(
            ttl = config.auth.token_ttl_hours,
            "token_ttl_hours must be > 0; falling back to 720"
        );
        720
    };
    let jwt = Arc::new(auth::JwtKeys::new(&jwt_secret, token_ttl_hours));

    // Key for secrets at rest (the UniFi password). Defaults to the JWT secret so an
    // existing deployment needs no config change — but that couples them: rotating
    // jwt_secret makes stored UniFi passwords undecryptable, and they must be
    // re-entered. Set `secret_key` explicitly to decouple the two.
    let secret_key = config
        .secret_key
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| jwt_secret.clone());
    if config.secret_key.as_deref().unwrap_or("").is_empty() {
        tracing::info!(
            "no secret_key configured — deriving the at-rest encryption key from auth.jwt_secret; \
             rotating that secret will require re-entering UniFi passwords"
        );
    }
    let cipher = Arc::new(crypto::Cipher::from_secret(&secret_key));

    // First-run bootstrap: create a superadmin if the user store is empty and
    // bootstrap credentials are configured.
    routes::auth::bootstrap_admin(&pool, &config).await?;

    let addr = format!("{}:{}", config.bind_addr, config.api_port);
    let dashboard_dir = config.dashboard_dir.clone();
    // Latest-version cache, seeded with our own build and kept current from GitHub
    // Releases by a background task — so "update available" tracks what's published.
    let latest_version: release::LatestVersion =
        Arc::new(std::sync::RwLock::new(env!("CARGO_PKG_VERSION").to_string()));
    release::spawn_refresh(latest_version.clone());

    let state = state::AppState {
        pool,
        config: Arc::new(config),
        jwt,
        cipher,
        latest_version,
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Everything the app exposes lives under a single `/bifrost` prefix, so one
    // path can be routed to Bifrost while the rest of the domain hosts other
    // apps:
    //   /bifrost/api/*   → REST API
    //   /bifrost/feed/*  → opkg package feed
    //   /bifrost, /bifrost/*  → dashboard SPA (deep links fall back to index.html)
    // The dashboard's base-href is /bifrost/ and it calls the API at
    // /bifrost/api, so it all works on one origin under one prefix.
    let mut app = Router::new()
        .nest("/bifrost/api", routes::api_router())
        .nest("/bifrost/feed", routes::feed::routes());

    // Serve the SPA as a catch-all under /bifrost (this correctly handles the
    // bare "/bifrost/" root, unlike a nested fallback); the more-specific
    // /bifrost/api and /bifrost/feed nests above take precedence.
    if let Some(dir) = &dashboard_dir {
        if std::path::Path::new(dir).is_dir() {
            let index = format!("{dir}/index.html");
            let spa = ServeDir::new(dir).fallback(ServeFile::new(index));
            app = app.nest_service("/bifrost", spa);
            tracing::info!(dir = %dir, "serving dashboard at /bifrost");
        } else {
            tracing::warn!(dir = %dir, "dashboard_dir set but not a directory; not serving dashboard");
        }
    }

    let app = app
        .route("/", get(|| async { Redirect::permanent("/bifrost/") }))
        .with_state(state)
        .layer(TraceLayer::new_for_http())
        .layer(cors);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("bind {addr}"))?;
    tracing::info!("listening on http://{addr}");

    // into_make_service_with_connect_info: attaches the peer SocketAddr so the
    // heartbeat can fall back to it when there is no proxy header to read.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .context("server error")?;
    Ok(())
}

/// Let environment variables override the TOML config, so a container can be
/// configured (and handed its secrets) entirely through the environment without
/// baking anything into the image. Empty values are ignored.
fn apply_env_overrides(config: &mut config::Config) {
    let set = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    if let Some(v) = set("BIFROST_JWT_SECRET") {
        config.auth.jwt_secret = Some(v);
    }
    if let Some(v) = set("BIFROST_TOKEN_TTL_HOURS").and_then(|v| v.parse::<i64>().ok()) {
        config.auth.token_ttl_hours = v;
    }
    if let Some(v) = set("BIFROST_DATABASE_URL") {
        config.database_url = v;
    }
    if let Some(v) = set("BIFROST_DASHBOARD_DIR") {
        config.dashboard_dir = Some(v);
    }
    if let Some(v) = set("BIFROST_SECRET_KEY") {
        config.secret_key = Some(v);
    }
    if let Some(v) = set("BIFROST_FEED_DIR") {
        config.feed_dir = v;
    }
    if let Some(v) = set("BIFROST_BIND_ADDR") {
        config.bind_addr = v;
    }
    if let Some(v) = set("BIFROST_API_PORT").and_then(|v| v.parse().ok().map(|_: u16| v)) {
        config.api_port = v.parse().unwrap();
    }
}
