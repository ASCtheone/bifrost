//! In-container self-update.
//!
//! The binary lives on the persisted `/etc/bifrost` volume (see the image entrypoint), so
//! an update survives a container recreate. Updating downloads the latest binary for this
//! arch, verifies its SHA256 against the release's `SHA256SUMS`, keeps a single backup, and
//! swaps it in; the process then exits and the entrypoint runs the new binary behind a
//! health gate — if the new binary doesn't report healthy in time the entrypoint restores
//! the backup. Nothing is touched until the download is verified, so a bad or tampered
//! download can never replace a working binary.

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn bin_dir() -> PathBuf {
    std::env::var("BIFROST_UPDATE_DIR")
        .unwrap_or_else(|_| "/etc/bifrost/bin".into())
        .into()
}
fn bin_path() -> PathBuf {
    bin_dir().join("bifrost-spark")
}
fn bak_path() -> PathBuf {
    bin_dir().join("bifrost-spark.bak")
}
fn healthy_marker() -> PathBuf {
    bin_dir().join(".healthy")
}
fn pending_marker() -> PathBuf {
    bin_dir().join(".update-pending")
}

/// Whether a rollback target exists (drives the dashboard's Revert button).
pub fn backup_exists() -> bool {
    bak_path().exists()
}

/// Record that this binary reached a healthy state (it heartbeated). The entrypoint clears
/// this on each start and, after an update, waits for it — its absence triggers a rollback.
/// Best-effort: failing to write it must never take the spark down.
pub fn mark_healthy() {
    let _ = std::fs::write(healthy_marker(), b"ok");
}

/// Download + verify the latest binary for this arch, back up the current one (single
/// slot), and swap it in. The caller restarts afterwards; the entrypoint health-gates it.
pub async fn apply_update(download_base: &str) -> Result<()> {
    if download_base.trim().is_empty() {
        bail!("no download base provided");
    }
    let asset = format!("bifrost-spark-{}-linux", arch());
    let base = download_base.trim_end_matches('/');

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .context("build update http client")?;

    let bytes = client
        .get(format!("{base}/{asset}"))
        .send()
        .await
        .context("download binary")?
        .error_for_status()
        .context("download binary")?
        .bytes()
        .await
        .context("read binary body")?;

    let sums = client
        .get(format!("{base}/SHA256SUMS"))
        .send()
        .await
        .context("download SHA256SUMS")?
        .error_for_status()
        .context("download SHA256SUMS")?
        .text()
        .await
        .context("read SHA256SUMS")?;

    let want = expected_hash(&sums, &asset)
        .with_context(|| format!("no checksum for {asset} in SHA256SUMS"))?;
    let got = sha256_hex(&bytes);
    if got != want {
        bail!("checksum mismatch for {asset}: expected {want}, got {got}");
    }

    let bin = bin_path();
    // Back up the current binary (single slot) before touching it.
    if bin.exists() {
        std::fs::copy(&bin, bak_path()).context("back up current binary")?;
    }
    // Write to a temp file, mark it executable, then atomically rename into place — so the
    // running binary is never left half-written.
    let tmp = bin_dir().join("bifrost-spark.new");
    std::fs::write(&tmp, &bytes).context("write new binary")?;
    set_exec(&tmp).context("chmod new binary")?;
    std::fs::rename(&tmp, &bin).context("swap in new binary")?;
    std::fs::write(pending_marker(), b"1").context("write update marker")?;

    tracing::info!(%asset, bytes = bytes.len(), "verified new binary; restarting to apply");
    Ok(())
}

/// Restore the backup binary and drop it — after reverting you're on the old version, and
/// the single-backup policy keeps nothing newer. The caller restarts afterwards.
pub fn revert() -> Result<()> {
    let bak = bak_path();
    if !bak.exists() {
        bail!("no backup to revert to");
    }
    std::fs::copy(&bak, bin_path()).context("restore backup binary")?;
    let _ = std::fs::remove_file(&bak);
    let _ = std::fs::remove_file(pending_marker());
    tracing::info!("reverted to the backup binary; restarting to apply");
    Ok(())
}

fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        _ => "x86_64",
    }
}

/// The hash for `asset` from a `SHA256SUMS` file (lines `"<hex>  <name>"`, name may be
/// `*`-prefixed for binary mode).
fn expected_hash(sums: &str, asset: &str) -> Option<String> {
    for line in sums.lines() {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next().unwrap_or("").trim_start_matches('*');
        if name == asset {
            return Some(hash.to_lowercase());
        }
    }
    None
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(unix)]
fn set_exec(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms)
}
#[cfg(not(unix))]
fn set_exec(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_matches_known_vector() {
        // SHA256("") — the canonical empty-string digest.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn expected_hash_finds_the_asset_in_either_format() {
        let sums = "aaaa  bifrost-spark-aarch64-linux\nBBBB  *bifrost-spark-x86_64-linux\n";
        assert_eq!(expected_hash(sums, "bifrost-spark-x86_64-linux").as_deref(), Some("bbbb"));
        assert_eq!(expected_hash(sums, "bifrost-spark-aarch64-linux").as_deref(), Some("aaaa"));
        assert_eq!(expected_hash(sums, "nope"), None);
    }
}
