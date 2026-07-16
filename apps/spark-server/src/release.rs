//! Latest published version, checked online against GitHub Releases.
//!
//! "Update available" is judged against the newest *published* release, not the control
//! plane's own build — so a spark shows an update as soon as a newer release exists, even
//! if this control plane hasn't been redeployed. The value is cached and refreshed in the
//! background; a failed check just leaves the last-known value in place.

use std::sync::{Arc, RwLock};
use std::time::Duration;

/// The GitHub repo to check, `owner/name`. Overridable for a fork/mirror.
fn repo() -> String {
    std::env::var("BIFROST_GITHUB_REPO").unwrap_or_else(|_| "asctheone/bifrost".into())
}

/// Shared, readable-from-sync-handlers cache of the latest published version.
pub type LatestVersion = Arc<RwLock<String>>;

/// Fetch the latest release version (tag `vX.Y.Z` → `X.Y.Z`) from the GitHub API.
pub async fn fetch_latest() -> Option<String> {
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .ok()?;
    // GitHub requires a User-Agent; without one it 403s.
    let resp = client
        .get(&url)
        .header("User-Agent", "bifrost-control-plane")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let body: serde_json::Value = resp.json().await.ok()?;
    let tag = body.get("tag_name").and_then(|v| v.as_str())?;
    Some(tag.trim_start_matches('v').to_string())
}

/// Spawn a background task that keeps `cache` up to date with the latest release.
pub fn spawn_refresh(cache: LatestVersion) {
    tokio::spawn(async move {
        loop {
            if let Some(v) = fetch_latest().await {
                if let Ok(mut w) = cache.write() {
                    if *w != v {
                        tracing::info!(latest = %v, "latest published spark version");
                        *w = v;
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(30 * 60)).await;
        }
    });
}

/// Whether version `a` is strictly older than `b` (numeric, dot-separated). Non-numeric
/// or malformed parts compare as 0, so a garbage value never spuriously flags an update.
pub fn version_lt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u32> { s.split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    parse(a) < parse(b)
}

#[cfg(test)]
mod tests {
    use super::version_lt;

    #[test]
    fn compares_versions_numerically() {
        assert!(version_lt("0.9.6", "0.9.8"));
        assert!(version_lt("0.9.9", "0.10.0")); // 9 < 10, not string order
        assert!(!version_lt("0.9.8", "0.9.8"));
        assert!(!version_lt("1.0.0", "0.9.9"));
    }
}
