//! opkg package feed. Serves `Packages`, `Packages.gz`, and the `.ipk` files
//! from the configured feed directory so a GL.iNet/OpenWrt router can add this
//! master as a package source (mounted under /bifrost/feed):
//!     src/gz bifrost https://<master>/bifrost/feed

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

/// Feed routes, relative — mounted at `/bifrost/feed` by `main`.
pub fn routes() -> Router<AppState> {
    Router::new().route("/:file", get(serve))
}

async fn serve(State(st): State<AppState>, Path(file): Path<String>) -> AppResult<Response> {
    // Single path segment only — reject anything that could escape the feed dir.
    if file.is_empty() || file.contains('/') || file.contains('\\') || file.contains("..") {
        return Err(AppError::BadRequest("invalid feed path".into()));
    }
    let path = std::path::Path::new(&st.config.feed_dir).join(&file);
    let data = tokio::fs::read(&path)
        .await
        .map_err(|_| AppError::NotFound("not found".into()))?;

    let content_type = if file.ends_with(".gz") {
        "application/gzip"
    } else if file.ends_with(".ipk") {
        "application/octet-stream"
    } else {
        "text/plain; charset=utf-8"
    };
    Ok(([(header::CONTENT_TYPE, content_type)], data).into_response())
}
