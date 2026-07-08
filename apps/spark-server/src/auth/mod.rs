//! Authentication: local JWT issuance/verification, password hashing, request
//! extractors, and spark-agent node-key validation.

pub mod extract;
pub mod jwt;
pub mod node_key;
pub mod password;

pub use extract::AdminAuth;
pub use jwt::JwtKeys;
pub use node_key::validate_node_key;

// `Auth`, `AuthContext` (used structurally by the extractors) and the node-key
// context type are part of the auth surface even if not re-exported by path.
#[allow(unused_imports)]
pub use extract::{Auth, AuthContext};
