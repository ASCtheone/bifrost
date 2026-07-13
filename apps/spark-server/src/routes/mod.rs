use crate::state::AppState;
use axum::Router;
use serde::Deserialize;

pub mod admin;
pub mod agent;
pub mod auth;
pub mod config;
pub mod devices;
pub mod feed;
pub mod health;
pub mod node; // spark-agent node-key routes (heartbeat, self)
pub mod nodes; // admin node management
pub mod peers;
pub mod provision;
pub mod shared;
pub mod users;

/// The REST API surface — everything except the package feed and the dashboard
/// SPA. Mounted under `/bifrost/api` (see `main`), so it never collides with
/// dashboard routes that share a name (e.g. `/devices`, `/users`).
pub fn api_router() -> Router<AppState> {
    Router::new()
        .merge(health::routes())
        .merge(auth::routes())
        .merge(node::routes())
        .merge(nodes::routes())
        .merge(agent::routes())
        .merge(devices::routes())
        .merge(peers::routes())
        .merge(provision::routes())
        .merge(config::routes())
        .merge(users::routes())
        .merge(admin::routes())
}

/// Deserialize a field so that "absent" and "present-but-null" are
/// distinguishable: absent → `None`, `null` → `Some(None)`, value → `Some(Some(v))`.
/// Used for tri-state fields like `assignToEmail`/`ownerEmail` (unassign vs. skip).
pub fn de_opt_field<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::<T>::deserialize(deserializer)?))
}
