//! Argon2id password hashing for the local identity store.

use crate::error::{AppError, AppResult};
use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;

/// Hash a plaintext password into a PHC string (includes salt + params).
pub fn hash_password(password: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::Other(anyhow::anyhow!("hash password: {e}")))
}

/// Verify a plaintext password against a stored PHC hash. Returns false on any
/// error (malformed hash, mismatch) — never leaks which.
pub fn verify_password(password: &str, phc: &str) -> bool {
    match PasswordHash::new(phc) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// Validate password strength, matching the old Cognito policy: 12+ chars with
/// upper, lower, and digit. Returns the list of unmet requirements.
pub fn password_issues(password: &str) -> Vec<&'static str> {
    let mut issues = Vec::new();
    if password.chars().count() < 12 {
        issues.push("at least 12 characters");
    }
    if !password.chars().any(|c| c.is_ascii_uppercase()) {
        issues.push("an uppercase letter");
    }
    if !password.chars().any(|c| c.is_ascii_lowercase()) {
        issues.push("a lowercase letter");
    }
    if !password.chars().any(|c| c.is_ascii_digit()) {
        issues.push("a number");
    }
    issues
}
