//! Local user management — the self-hosted replacement for the Cognito-backed
//! user handlers. Roles are modelled as `groups` (`admin`, `superadmin`).

use crate::auth::{password, AdminAuth};
use crate::domain::User;
use crate::error::{AppError, AppResult};
use crate::repo::user_repo;
use crate::state::AppState;
use crate::util;
use axum::extract::{Path, State};
use axum::{routing::{get, put}, Json, Router};
use serde_json::{json, Value};
use sqlx::types::Json as SqlxJson;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/users", get(list_users).post(create_user))
        .route("/users/:username", put(update_user).delete(delete_user))
}

// ── GET /users ──────────────────────────────────────────────────

async fn list_users(State(st): State<AppState>, AdminAuth(auth): AdminAuth) -> AppResult<Json<Value>> {
    let is_super = auth.is_superadmin();
    let users: Vec<Value> = user_repo::query_all_users(&st.pool)
        .await?
        .into_iter()
        .filter(|u| is_super || u.email == auth.email || u.owner_email == auth.email)
        .map(|u| {
            json!({
                "username": u.username,
                "displayName": u.display_name,
                "email": u.email,
                "sub": u.user_id,
                "status": u.status,
                "enabled": u.enabled,
                "groups": u.groups.0,
                "createdAt": u.created_at,
                "lastModified": u.updated_at,
                "createdBy": if u.owner_email.is_empty() { Value::Null } else { json!(u.owner_email) },
            })
        })
        .collect();
    Ok(Json(json!({ "users": users, "callerIsSuperadmin": is_super })))
}

// ── POST /users ─────────────────────────────────────────────────

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CreateUserReq {
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    temporary_password: Option<String>,
    #[serde(default)]
    is_admin: bool,
    #[serde(default)]
    is_superadmin: bool,
    #[serde(default)]
    owner_email: Option<String>,
}

async fn create_user(
    State(st): State<AppState>,
    AdminAuth(auth): AdminAuth,
    body: Option<Json<CreateUserReq>>,
) -> AppResult<Json<Value>> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let email = req.email.filter(|s| !s.is_empty()).ok_or_else(|| AppError::BadRequest("Email is required".into()))?;
    let is_super = auth.is_superadmin();
    if req.is_admin && !is_super {
        return Err(AppError::Forbidden("Only superadmins can grant admin role".into()));
    }
    if req.is_superadmin && !is_super {
        return Err(AppError::Forbidden("Only superadmins can create superadmin users".into()));
    }

    // Use the supplied temporary password, or generate one (no email delivery
    // in self-hosted mode, so we return it for the admin to hand off).
    let (plaintext, generated) = match req.temporary_password {
        Some(p) if !p.is_empty() => {
            let issues = password::password_issues(&p);
            if !issues.is_empty() {
                return Err(AppError::BadRequest(format!("Password needs {}", issues.join(", "))));
            }
            (p, false)
        }
        _ => (format!("Bif-{}-{}", util::random_hex(4), util::random_hex(4)), true),
    };

    let display_name = req
        .username
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| email.clone());
    let username = req.username.filter(|s| !s.is_empty()).unwrap_or_else(|| {
        email.split('@').next().unwrap_or(&email).to_string()
    });
    let mut groups = Vec::new();
    if req.is_admin || req.is_superadmin {
        groups.push("admin".to_string());
    }
    if req.is_superadmin {
        groups.push("superadmin".to_string());
    }
    let owner_email = if is_super {
        req.owner_email.unwrap_or_else(|| auth.email.clone())
    } else {
        auth.email.clone()
    };

    let now = util::now_iso();
    let user = User {
        user_id: util::ulid(),
        username: username.clone(),
        email: email.clone(),
        display_name,
        password_hash: password::hash_password(&plaintext)?,
        groups: SqlxJson(groups),
        enabled: true,
        status: if generated { "FORCE_CHANGE_PASSWORD".into() } else { "CONFIRMED".into() },
        owner_email,
        must_change: generated,
        created_at: now.clone(),
        updated_at: now,
    };
    user_repo::create_user(&st.pool, &user).await?;

    let mut resp = json!({
        "username": username,
        "email": email,
        "displayName": user.display_name,
        "status": user.status,
    });
    if generated {
        resp["temporaryPassword"] = json!(plaintext);
    }
    Ok(Json(resp))
}

// ── PUT /users/{username} ───────────────────────────────────────

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct UpdateUserReq {
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    is_admin: Option<bool>,
    #[serde(default)]
    is_superadmin: Option<bool>,
    #[serde(default)]
    reset_password: bool,
}

async fn update_user(
    State(st): State<AppState>,
    AdminAuth(auth): AdminAuth,
    Path(username): Path<String>,
    body: Option<Json<UpdateUserReq>>,
) -> AppResult<Json<Value>> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let is_super = auth.is_superadmin();
    if req.is_admin.is_some() && !is_super {
        return Err(AppError::Forbidden("Only superadmins can modify admin status".into()));
    }
    if req.is_superadmin.is_some() && !is_super {
        return Err(AppError::Forbidden("Only superadmins can modify superadmin status".into()));
    }

    let user = user_repo::get_user_by_username(&st.pool, &username)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".into()))?;
    let mut actions = Vec::new();
    let mut groups = user.groups.0.clone();

    if let Some(enabled) = req.enabled {
        user_repo::set_enabled(&st.pool, &username, enabled).await?;
        actions.push(if enabled { "enabled" } else { "disabled" });
    }
    if let Some(is_admin) = req.is_admin {
        groups = with_group(groups, "admin", is_admin);
        actions.push(if is_admin { "admin granted" } else { "admin revoked" });
    }
    if let Some(is_super_req) = req.is_superadmin {
        groups = with_group(groups, "superadmin", is_super_req);
        if is_super_req {
            groups = with_group(groups, "admin", true); // superadmin implies admin
        }
        actions.push(if is_super_req { "superadmin granted" } else { "superadmin revoked" });
    }
    if req.is_admin.is_some() || req.is_superadmin.is_some() {
        user_repo::set_groups(&st.pool, &username, &groups).await?;
    }

    let mut new_password = None;
    if req.reset_password {
        let temp = format!("Bif-{}-{}", util::random_hex(4), util::random_hex(4));
        let hash = password::hash_password(&temp)?;
        user_repo::set_password(&st.pool, &username, &hash, true).await?;
        new_password = Some(temp);
        actions.push("password reset");
    }

    let mut resp = json!({ "success": true, "actions": actions });
    if let Some(pw) = new_password {
        resp["temporaryPassword"] = json!(pw);
    }
    Ok(Json(resp))
}

fn with_group(mut groups: Vec<String>, group: &str, add: bool) -> Vec<String> {
    groups.retain(|g| g != group);
    if add {
        groups.push(group.to_string());
    }
    groups
}

// ── DELETE /users/{username} ────────────────────────────────────

async fn delete_user(
    State(st): State<AppState>,
    AdminAuth(_auth): AdminAuth,
    Path(username): Path<String>,
) -> AppResult<Json<Value>> {
    let affected = user_repo::delete_user_by_username(&st.pool, &username).await?;
    if affected == 0 {
        return Err(AppError::NotFound("User not found".into()));
    }
    Ok(Json(json!({ "success": true })))
}
