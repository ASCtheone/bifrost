//! Bifrost spark — on-site bridge. Adopts into the Bifrost control plane (your
//! VPS), then on a loop pulls the desired WireGuard config and reconciles the
//! local UniFi controller's WireGuard server peers to match, reporting actual
//! state back via heartbeat.

mod config;
mod control;
mod unifi;

use anyhow::{Context, Result};
use config::{Config, State};
use control::{Control, DesiredConfig};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;
use tracing_subscriber::EnvFilter;
use unifi::{NewPeer, UnifiClient};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "bifrost_spark=info".into()),
        )
        .init();

    let config_path =
        std::env::var("BIFROST_SPARK_CONFIG").unwrap_or_else(|_| "bifrost-spark.toml".into());
    let cfg = Config::load(&config_path)?;
    let state_dir: PathBuf = std::path::Path::new(&config_path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    let control = Control::new(cfg.master_url())?;

    // ── Adoption (once) ─────────────────────────────────────────
    //
    // Retry in-process rather than exiting. Bailing out makes the container die and
    // be restarted, which turns a plain "the master is unreachable" or "that code is
    // spent" into a crash-loop — and buries the actual reason under restart noise.
    // Here the error is logged every cycle and stays readable in `docker logs`.
    let mut state = State::load(&state_dir);
    while !state.is_adopted() {
        if let Err(e) = adopt(&cfg, &control, &state_dir, &mut state).await {
            tracing::warn!("adoption failed: {e:#} — retrying in 30s");
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    }
    let node_id = state.node_id.clone().unwrap();
    let node_key = state.node_key.clone().unwrap();
    tracing::info!(node_id = %node_id, "spark adopted; starting sync loop");

    // ── Sync loop ───────────────────────────────────────────────
    //
    // The UniFi client is built lazily, from whichever config we have: a local
    // [unifi] block if one was provided, else whatever the dashboard sends with each
    // poll. It is rebuilt when that config changes, so editing the controller
    // credentials in the UI takes effect on the next cycle without a restart.
    let interval = Duration::from_secs(cfg.poll_interval_seconds.max(5));
    let mut unifi: Option<UnifiClient> = None;
    let mut applied: Option<config::UnifiConfig> = None;
    let mut idle_logged = false;

    loop {
        if let Err(e) = tick(
            &control,
            &cfg,
            &node_id,
            &node_key,
            &mut unifi,
            &mut applied,
            &mut idle_logged,
        )
        .await
        {
            tracing::warn!("sync cycle failed: {e:#}");
        }
        tokio::time::sleep(interval).await;
    }
}

/// One cycle: fetch desired state, make sure the UniFi client matches the configured
/// controller, then reconcile.
async fn tick(
    control: &Control,
    cfg: &Config,
    node_id: &str,
    node_key: &str,
    unifi: &mut Option<UnifiClient>,
    applied: &mut Option<config::UnifiConfig>,
    idle_logged: &mut bool,
) -> Result<()> {
    let desired = control.desired_config(node_id, node_key).await?;

    // Local config wins when present; otherwise take what the dashboard sends. Either
    // way it must actually carry a credential — a host with no API key and no login is
    // not usable, and treating it as configured would just fail every request.
    let wanted = cfg
        .unifi
        .clone()
        .or_else(|| desired.unifi.clone())
        .filter(|u| !u.host.is_empty() && u.has_credentials());

    let Some(wanted) = wanted else {
        // Not an error: the spark is adopted and healthy, just not told which
        // controller to drive yet. Say so once rather than every poll interval.
        if !*idle_logged {
            tracing::info!(
                "no UniFi controller configured — set it in the dashboard (Sparks → this spark → UniFi); idling"
            );
            *idle_logged = true;
        }
        *unifi = None;
        *applied = None;
        heartbeat(control, node_id, node_key, None, &[], None).await?;
        return Ok(());
    };
    *idle_logged = false;

    if unifi.is_none() || applied.as_ref() != Some(&wanted) {
        tracing::info!(host = %wanted.host, site = %wanted.site, "connecting to UniFi controller");
        let mut client = UnifiClient::new(&wanted)?;
        if let Err(e) = client.login().await {
            tracing::warn!("unifi login failed: {e:#} (will retry next cycle)");
        }
        *unifi = Some(client);
        *applied = Some(wanted);
    }
    let client = unifi.as_mut().expect("just set");

    sync_once(control, client, node_id, node_key, &desired).await
}

/// Register with the control plane and poll until an admin adopts us.
async fn adopt(cfg: &Config, control: &Control, state_dir: &std::path::Path, state: &mut State) -> Result<()> {
    let code = cfg
        .adoption_code
        .as_deref()
        .context("not adopted and no adoption_code in config")?;
    tracing::info!("registering with control plane…");
    let node_id = control.register(code).await?;
    tracing::info!(node_id = %node_id, "registered; waiting for adoption in the dashboard…");

    loop {
        if let Some(node_key) = control.await_adoption(&node_id, Some(code)).await? {
            state.node_id = Some(node_id.clone());
            state.node_key = Some(node_key);
            state.save(state_dir)?;
            tracing::info!("adopted — node key received");
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// One reconcile cycle: apply the desired config to UniFi, then heartbeat.
///
/// The heartbeat is sent **whatever happens to UniFi**. It used to be reached only
/// after a clean reconcile — one `?` on the first controller call and the whole cycle
/// bailed out — so a spark whose controller was unreachable, or whose API key was
/// refused, never heartbeated at all and sat there reading "offline" in the dashboard.
/// That is exactly backwards: it is alive, it is talking to the control plane, and it
/// has something useful to say (namely *why* UniFi is unhappy). Liveness must not
/// depend on the health of the thing we are reporting on.
async fn sync_once(
    control: &Control,
    unifi: &mut UnifiClient,
    node_id: &str,
    node_key: &str,
    desired: &DesiredConfig,
) -> Result<()> {
    match reconcile(unifi, desired).await {
        Ok((server, peers)) => {
            heartbeat(control, node_id, node_key, server.as_ref(), &peers, None).await
        }
        Err(e) => {
            let msg = format!("{e:#}");
            tracing::warn!("unifi reconcile failed: {msg}");
            // Still report in: online, with the reason, so the dashboard can show it.
            heartbeat(control, node_id, node_key, None, &[], Some(&msg)).await?;
            Err(e)
        }
    }
}

/// The name a peer gets on the controller.
///
/// Device names in Bifrost are free text ("Miguel Router"), but UniFi validates
/// WireGuard peer names and rejects the request outright — a bare 400 with no hint —
/// when they contain characters it doesn't like, a space being the usual culprit. So
/// everything outside [A-Za-z0-9._-] becomes a dash, runs are collapsed, and the
/// result is capped: a peer we cannot name is a peer we cannot create.
fn peer_name(device_name: &str) -> String {
    let mut out = String::from("bifrost-");
    let mut last_dash = out.ends_with('-');
    for ch in device_name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_end_matches('-');
    let capped: String = trimmed.chars().take(48).collect();
    let capped = capped.trim_end_matches('-').to_string();
    if capped == "bifrost" {
        "bifrost-device".to_string() // a name of nothing but separators
    } else {
        capped
    }
}

/// Bring the UniFi WireGuard server's peers in line with the desired config, and
/// return what's actually there now.
async fn reconcile(
    unifi: &mut UnifiClient,
    desired: &DesiredConfig,
) -> Result<(Option<unifi::WgServer>, Vec<unifi::WgPeer>)> {
    // Pick the WireGuard server this spark manages.
    let servers = unifi.list_wg_servers().await?;
    let server = match &desired.vpn_name {
        Some(name) => servers.iter().find(|s| &s.name == name).or_else(|| servers.first()),
        None => servers.first(),
    };
    let Some(server) = server.cloned() else {
        tracing::warn!("no WireGuard server on the UniFi controller yet — create one (server auto-creation not yet automated); reporting empty state");
        return Ok((None, Vec::new()));
    };

    // Reconcile peers.
    let actual = unifi.list_peers(&server.id).await?;
    let actual_pks: HashSet<&str> = actual.iter().map(|p| p.public_key.as_str()).collect();

    let mut created = 0;
    for dp in &desired.peers {
        if dp.public_key.is_empty() || actual_pks.contains(dp.public_key.as_str()) {
            continue;
        }
        let ip = dp.assigned_ip.split('/').next().unwrap_or(&dp.assigned_ip).to_string();
        let new = NewPeer {
            name: peer_name(&dp.name),
            interface_ip: ip,
            public_key: dp.public_key.clone(),
            preshared_key: dp.preshared_key.clone(),
            allowed_ips: dp.allowed_ips.clone(),
        };
        match unifi.create_peer(&server.id, &new).await {
            Ok(()) => created += 1,
            // The payload is logged too: a rejected create is almost always a field
            // the controller didn't like, and guessing at it from the outside is how
            // this took several rounds to pin down.
            Err(e) => tracing::warn!(
                payload = %serde_json::to_string(&new).unwrap_or_default(),
                "create peer {} failed: {e:#}",
                dp.name
            ),
        }
    }

    let mut deleted = 0;
    for peer_id in &desired.pending_peer_deletions {
        match unifi.delete_peer(&server.id, peer_id).await {
            Ok(()) => deleted += 1,
            Err(e) => tracing::warn!("delete peer {peer_id} failed: {e:#}"),
        }
    }
    if created > 0 || deleted > 0 {
        tracing::info!("reconciled UniFi peers: +{created} -{deleted}");
    }

    // Report actual state.
    let peers_now = unifi.list_peers(&server.id).await.unwrap_or_default();
    Ok((Some(server), peers_now))
}

/// `error` is surfaced on the node in the dashboard: a spark that is up but can't
/// reach its controller should say so, not just look healthy or vanish.
async fn heartbeat(
    control: &Control,
    node_id: &str,
    node_key: &str,
    server: Option<&unifi::WgServer>,
    peers: &[unifi::WgPeer],
    error: Option<&str>,
) -> Result<()> {
    let actual_config = match server {
        Some(s) => json!({
            "servers": [{
                "id": s.id,
                "name": s.name,
                "serverAddress": s.server_address,
                "serverPort": s.server_port,
                "publicKey": s.public_key,
            }],
            "peers": peers.iter().map(|p| json!({
                "id": p.id, "name": p.name, "ip": p.interface_ip,
                "publicKey": p.public_key, "enabled": true,
            })).collect::<Vec<_>>(),
        }),
        None => json!({ "servers": [], "peers": [] }),
    };

    let mut body = json!({ "actualConfig": actual_config });
    // Always present: `null` clears a previous error once the controller recovers.
    body["error"] = match error {
        Some(e) => json!(e),
        None => Value::Null,
    };
    if let Some(s) = server {
        body["sparkVpnId"] = json!(s.id);
    }
    // The public IP is NOT reported here. The control plane sees the source address of
    // this very request and derives it there — no third-party lookup, nothing to fail
    // on a host that can reach the master but not the open internet, and a node cannot
    // claim an address that isn't its own.
    control.heartbeat(node_id, node_key, &body).await
}

#[cfg(test)]
mod tests {
    use super::peer_name;

    #[test]
    fn spaces_become_dashes() {
        // The exact name that got a bare 400 from the controller.
        assert_eq!(peer_name("Miguel Router"), "bifrost-Miguel-Router");
    }

    #[test]
    fn collapses_runs_and_trims() {
        assert_eq!(peer_name("  a  //  b  "), "bifrost-a-b");
        assert_eq!(peer_name("trailing!!!"), "bifrost-trailing");
    }

    #[test]
    fn keeps_safe_characters() {
        assert_eq!(peer_name("phone_1.2-x"), "bifrost-phone_1.2-x");
    }

    #[test]
    fn a_name_of_only_separators_still_yields_something() {
        assert_eq!(peer_name("   "), "bifrost-device");
        assert_eq!(peer_name("!!!"), "bifrost-device");
    }

    #[test]
    fn caps_the_length() {
        let n = peer_name(&"x".repeat(200));
        assert!(n.len() <= 48, "got {} chars", n.len());
        assert!(n.starts_with("bifrost-"));
    }
}
