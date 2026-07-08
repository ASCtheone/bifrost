use crate::state::AppState;
use axum::Router;

pub mod health;
pub mod node;

pub fn router(state: AppState) -> Router {
    Router::new()
        .merge(health::routes())
        .merge(node::routes())
        .with_state(state)
}
