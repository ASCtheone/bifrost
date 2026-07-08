use chrono::{Duration, Utc};

/// ISO-8601 / RFC-3339 timestamp with millisecond precision and a trailing `Z`,
/// matching JavaScript's `new Date().toISOString()` used by the old handlers.
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// ISO timestamp `secs` seconds in the future (used for short-lived TTLs).
pub fn iso_in(secs: i64) -> String {
    (Utc::now() + Duration::seconds(secs)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Generate a ULID string (lexicographically sortable, time-prefixed).
pub fn ulid() -> String {
    ulid::Ulid::new().to_string()
}
