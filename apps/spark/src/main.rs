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
use serde_json::json;
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
    let mut state = State::load(&state_dir);
    if !state.is_adopted() {
        adopt(&cfg, &control, &state_dir, &mut state).await?;
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

    // Local config wins when present; otherwise take what the dashboard sends.
    let wanted = cfg.unifi.clone().or_else(|| desired.unifi.clone());

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
        heartbeat(control, node_id, node_key, None, &[]).await?;
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

/// One reconcile cycle: pull desired config, apply to UniFi, heartbeat actual state.
async fn sync_once(
    control: &Control,
    unifi: &mut UnifiClient,
    node_id: &str,
    node_key: &str,
    desired: &DesiredConfig,
) -> Result<()> {
    // Pick the WireGuard server this spark manages.
    let servers = unifi.list_wg_servers().await?;
    let server = match &desired.vpn_name {
        Some(name) => servers.iter().find(|s| &s.name == name).or_else(|| servers.first()),
        None => servers.first(),
    };
    let Some(server) = server.cloned() else {
        tracing::warn!("no WireGuard server on the UniFi controller yet — create one (server auto-creation not yet automated); reporting empty state");
        heartbeat(control, node_id, node_key, None, &[]).await?;
        return Ok(());
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
            name: format!("bifrost-{}", dp.name),
            interface_ip: ip,
            public_key: dp.public_key.clone(),
            preshared_key: dp.preshared_key.clone(),
            allowed_ips: dp.allowed_ips.clone(),
        };
        match unifi.create_peer(&server.id, &new).await {
            Ok(()) => created += 1,
            Err(e) => tracing::warn!("create peer {} failed: {e:#}", dp.name),
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
    heartbeat(control, node_id, node_key, Some(&server), &peers_now).await
}

async fn heartbeat(
    control: &Control,
    node_id: &str,
    node_key: &str,
    server: Option<&unifi::WgServer>,
    peers: &[unifi::WgPeer],
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
    if let Some(s) = server {
        body["sparkVpnId"] = json!(s.id);
    }
    if let Some(ip) = detect_wan_ip().await {
        body["wanIp"] = json!(ip);
    }
    control.heartbeat(node_id, node_key, &body).await
}

/// Best-effort public IP detection (the endpoint devices dial into).
async fn detect_wan_ip() -> Option<String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().ok()?;
    let ip = client.get("https://api.ipify.org").send().await.ok()?.text().await.ok()?;
    let ip = ip.trim().to_string();
    if ip.is_empty() || ip.len() > 45 { None } else { Some(ip) }
}
