//! Axum extractors that authenticate a request from its `Authorization: Bearer`
//! token. `Auth` requires any valid user; `AdminAuth` additionally requires the
//! `admin` group — the local equivalent of the old `requireAdmin` middleware.

use crate::error::AppError;
use crate::state::AppState;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;

/// The authenticated caller's identity, extracted from verified JWT claims.
#[derive(Debug, Clone)]
pub struct AuthContext {
    pub sub: String,
    pub email: String,
    pub groups: Vec<String>,
}

impl AuthContext {
    pub fn is_admin(&self) -> bool {
        self.groups.iter().any(|g| g == "admin")
    }
    pub fn is_superadmin(&self) -> bool {
        self.groups.iter().any(|g| g == "superadmin")
    }
}

fn bearer_token(parts: &Parts) -> Result<&str, AppError> {
    let header = parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("missing authorization header".into()))?;
    header
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| AppError::Unauthorized("malformed authorization header".into()))
}

/// Any authenticated user.
pub struct Auth(pub AuthContext);

#[axum::async_trait]
impl FromRequestParts<AppState> for Auth {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        let token = bearer_token(parts)?;
        let claims = st.jwt.verify(token)?;
        Ok(Auth(AuthContext {
            sub: claims.sub,
            email: claims.email,
            groups: claims.groups,
        }))
    }
}

/// An authenticated user in the `admin` group.
pub struct AdminAuth(pub AuthContext);

#[axum::async_trait]
impl FromRequestParts<AppState> for AdminAuth {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        let Auth(ctx) = Auth::from_request_parts(parts, st).await?;
        if !ctx.is_admin() {
            return Err(AppError::Forbidden("Admin role required".into()));
        }
        Ok(AdminAuth(ctx))
    }
}
