use crate::error::{AppError, AppResult};
use crate::repo::node_repo;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use subtle::ConstantTimeEq;

pub struct NodeKeyContext {
    pub node_id: String,
}

/// Validate the `X-Node-Key` presented by a spark-agent against the stored
/// SHA-256 hash. Constant-time comparison; mirrors the old `validateNodeKey`.
pub async fn validate_node_key(
    pool: &SqlitePool,
    node_id: &str,
    key: &str,
) -> AppResult<NodeKeyContext> {
    let node = node_repo::get_node(pool, node_id)
        .await?
        .ok_or_else(|| AppError::Unauthorized("invalid node key".into()))?;

    if node.adoption_status == "revoked" {
        return Err(AppError::Unauthorized("node key has been revoked".into()));
    }

    let stored_hex = node
        .node_key_hash
        .ok_or_else(|| AppError::Unauthorized("invalid node key".into()))?;
    let stored = hex::decode(&stored_hex)
        .map_err(|_| AppError::Unauthorized("invalid node key".into()))?;

    let incoming = Sha256::digest(key.as_bytes());

    if incoming.len() != stored.len() || incoming.as_slice().ct_eq(&stored).unwrap_u8() != 1 {
        return Err(AppError::Unauthorized("invalid node key".into()));
    }

    Ok(NodeKeyContext {
        node_id: node_id.to_string(),
    })
}
