//! Self-issued JWTs (HS256) — the local replacement for Cognito-issued tokens.

use crate::error::{AppError, AppResult};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

/// JWT claims. `groups` carries roles (`admin`, `superadmin`), mirroring the
/// old `cognito:groups` claim so downstream authorization logic is unchanged.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub email: String,
    #[serde(default)]
    pub groups: Vec<String>,
    pub exp: i64,
    pub iat: i64,
}

/// Symmetric signing/verification keys plus token lifetime.
pub struct JwtKeys {
    enc: EncodingKey,
    dec: DecodingKey,
    ttl_hours: i64,
}

impl JwtKeys {
    pub fn new(secret: &str, ttl_hours: i64) -> Self {
        Self {
            enc: EncodingKey::from_secret(secret.as_bytes()),
            dec: DecodingKey::from_secret(secret.as_bytes()),
            ttl_hours,
        }
    }

    /// Issue a signed access token for a user.
    pub fn issue(&self, sub: &str, email: &str, groups: Vec<String>) -> AppResult<String> {
        let now = chrono::Utc::now().timestamp();
        let claims = Claims {
            sub: sub.to_string(),
            email: email.to_string(),
            groups,
            iat: now,
            exp: now + self.ttl_hours * 3600,
        };
        encode(&Header::new(Algorithm::HS256), &claims, &self.enc)
            .map_err(|e| AppError::Other(anyhow::anyhow!("issue token: {e}")))
    }

    /// Verify a token's signature and expiry, returning its claims.
    pub fn verify(&self, token: &str) -> AppResult<Claims> {
        let validation = Validation::new(Algorithm::HS256);
        decode::<Claims>(token, &self.dec, &validation)
            .map(|data| data.claims)
            .map_err(|_| AppError::Unauthorized("invalid or expired token".into()))
    }
}
