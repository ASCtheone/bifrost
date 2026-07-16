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
use std::collections::HashMap;
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
        heartbeat(control, node_id, node_key, None, &[], &[], &[], false, None).await?;
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
    // Drain the management-command queue first, so the inventory we then report reflects
    // any server just created/updated/deleted this cycle.
    let command_results = execute_commands(unifi, &desired.commands).await;
    match reconcile(unifi, desired).await {
        Ok(o) => {
            heartbeat(control, node_id, node_key, o.server.as_ref(), &o.peers, &o.inventory, &command_results, o.clear_deletions, None).await
        }
        Err(e) => {
            let msg = format!("{e:#}");
            tracing::warn!("unifi reconcile failed: {msg}");
            // Still report in: online, with the reason, so the dashboard can show it.
            heartbeat(control, node_id, node_key, None, &[], &[], &command_results, false, Some(&msg)).await?;
            Err(e)
        }
    }
}

/// Execute the queued management commands against the controller and return a result per
/// command (`{ id, ok, error? }`) for the control plane to acknowledge. Commands are
/// independent: one failing doesn't stop the rest, and its error is reported, not
/// swallowed. An unrecognised kind reports an error rather than being silently dropped.
async fn execute_commands(unifi: &mut UnifiClient, commands: &[Value]) -> Vec<Value> {
    let mut results = Vec::with_capacity(commands.len());
    for cmd in commands {
        let id = cmd.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let kind = cmd.get("kind").and_then(Value::as_str).unwrap_or("");
        let sid = cmd.get("serverId").and_then(Value::as_str).unwrap_or_default();
        // Ok carries any data to hand back (a created peer's config); Null otherwise.
        let outcome: Result<Value> = match kind {
            "server.create" => {
                let name = cmd.get("name").and_then(Value::as_str).unwrap_or("New VPN");
                let subnet = cmd.get("subnet").and_then(Value::as_str);
                let port = cmd.get("port").and_then(Value::as_i64);
                unifi.create_wg_server(name, subnet, port).await.map(|_| Value::Null)
            }
            "server.update" => unifi
                .update_wg_server(
                    sid,
                    cmd.get("name").and_then(Value::as_str),
                    cmd.get("port").and_then(Value::as_i64),
                    cmd.get("enabled").and_then(Value::as_bool),
                )
                .await
                .map(|_| Value::Null),
            "server.delete" => unifi.delete_wg_server(sid).await.map(|_| Value::Null),
            "peer.create" => {
                let name = sanitize_peer_name(cmd.get("name").and_then(Value::as_str).unwrap_or("client"));
                let allowed = allowed_ips_of(cmd);
                unifi
                    .create_client_peer(
                        sid,
                        &name,
                        cmd.get("publicKey").and_then(Value::as_str),
                        cmd.get("ip").and_then(Value::as_str),
                        allowed,
                    )
                    .await
                    .map(|(ip, pubk, privk)| {
                        let mut p = json!({ "serverId": sid, "ip": ip, "publicKey": pubk });
                        // The private key is present only when the spark generated it — the
                        // dashboard uses it to build the client config, then it's gone.
                        if let Some(pk) = privk {
                            p["privateKey"] = json!(pk);
                        }
                        p
                    })
            }
            // Update = delete + recreate preserving the client's public key, so only the
            // verified peer endpoints are used (no unverified peer PUT) and the client's
            // keypair survives a rename or re-address.
            "peer.update" => {
                let peer_id = cmd.get("peerId").and_then(Value::as_str).unwrap_or_default();
                match cmd.get("publicKey").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    None => Err(anyhow::anyhow!(
                        "peer.update needs the existing publicKey to preserve the client's key"
                    )),
                    Some(pubk) => match unifi.delete_peer(sid, peer_id).await {
                        Err(e) => Err(e),
                        Ok(()) => {
                            let name = sanitize_peer_name(cmd.get("name").and_then(Value::as_str).unwrap_or("client"));
                            unifi
                                .create_client_peer(sid, &name, Some(pubk), cmd.get("ip").and_then(Value::as_str), allowed_ips_of(cmd))
                                .await
                                .map(|_| Value::Null)
                        }
                    },
                }
            }
            "peer.delete" => {
                let peer_id = cmd.get("peerId").and_then(Value::as_str).unwrap_or_default();
                unifi.delete_peer(sid, peer_id).await.map(|_| Value::Null)
            }
            other => Err(anyhow::anyhow!("unknown command kind: {other}")),
        };
        match outcome {
            Ok(data) => {
                tracing::info!(%id, %kind, "executed management command");
                let mut r = json!({ "id": id, "ok": true });
                if !data.is_null() {
                    r["peer"] = data;
                }
                results.push(r);
            }
            Err(e) => {
                tracing::warn!(%id, %kind, "management command failed: {e:#}");
                results.push(json!({ "id": id, "ok": false, "error": format!("{e:#}") }));
            }
        }
    }
    results
}

/// A command's `allowedIps`, or empty (which `create_client_peer` turns into the peer's
/// own `/32` — the correct server-side value, not `0.0.0.0/0`).
fn allowed_ips_of(cmd: &Value) -> Vec<String> {
    cmd.get("allowedIps")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
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

/// Sanitise a free-text name into what UniFi accepts for a WireGuard peer — the same
/// [A-Za-z0-9._-] rule as `peer_name`, but with no `bifrost-` prefix (these are
/// operator-created clients, not bifrost devices). Empty result → "client".
fn sanitize_peer_name(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true; // trims leading separators
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let capped: String = out.trim_matches('-').chars().take(48).collect();
    let capped = capped.trim_end_matches('-').to_string();
    if capped.is_empty() {
        "client".to_string()
    } else {
        capped
    }
}

/// One WireGuard server on the controller together with its peers — the unit of the
/// full inventory the spark reports so the dashboard can see and manage every server and
/// client, not just the one bifrost owns.
struct ServerPeers {
    server: unifi::WgServer,
    peers: Vec<unifi::WgPeer>,
}

/// List every WireGuard server on the controller with its peers. Best-effort per server:
/// one whose peer list fails still appears (with no peers) rather than dropping the whole
/// inventory. This is what makes "detect UniFi changes" work — it's reported every cycle.
async fn gather_inventory(unifi: &mut UnifiClient) -> Vec<ServerPeers> {
    let mut out = Vec::new();
    for server in unifi.list_wg_servers().await.unwrap_or_default() {
        let peers = unifi.list_peers(&server.id).await.unwrap_or_default();
        out.push(ServerPeers { server, peers });
    }
    out
}

/// The result of one reconcile against the UniFi controller.
struct ReconcileOutcome {
    server: Option<unifi::WgServer>,
    peers: Vec<unifi::WgPeer>,
    /// Every WireGuard server on the controller and its peers — reported for the dashboard.
    inventory: Vec<ServerPeers>,
    /// Whether the control plane's peer-deletion queue was fully drained and should be
    /// cleared. `false` leaves it queued for the next cycle.
    clear_deletions: bool,
}

/// Bring the UniFi WireGuard server's peers in line with the desired config, and
/// return what's actually there now.
async fn reconcile(
    unifi: &mut UnifiClient,
    desired: &DesiredConfig,
) -> Result<ReconcileOutcome> {
    // Select the WireGuard server this spark owns. By id — an exact match on the server
    // the spark itself created — never a guess among whatever servers happen to exist
    // (that guess put peers on the wrong VPN instance). The id round-trips: the spark
    // reports it, the control plane stores it, and it comes back here as `vpn_id`.
    let servers = unifi.list_wg_servers().await?;
    let owned = desired
        .vpn_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .and_then(|id| servers.iter().find(|s| s.id == id).cloned());

    let server = match owned {
        Some(s) => s,
        None => {
            // No bound server. Create one only when the operator asked (Create VPN);
            // otherwise idle. We never adopt an existing server by guessing.
            if desired.pending_vpn_create {
                let name = desired
                    .vpn_name
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("SPARK VPN");
                // Idempotent across restarts and a not-yet-round-tripped id: reuse a
                // server we already created with this name rather than duplicating it.
                match servers.into_iter().find(|s| s.name == name) {
                    Some(existing) => existing,
                    None => unifi.create_wg_server(name, None, None).await?,
                }
            } else {
                tracing::info!(
                    "no spark-owned WireGuard server yet — click \"Create VPN\" in the dashboard; idling"
                );
                // Still report the full inventory: the dashboard should see every server on
                // the controller even when the spark owns none.
                let inventory = gather_inventory(unifi).await;
                return Ok(ReconcileOutcome { server: None, peers: Vec::new(), inventory, clear_deletions: false });
            }
        }
    };

    tracing::info!(
        id = %server.id, name = %server.name, subnet = %server.server_address,
        port = server.server_port, pubkey_len = server.public_key.len(),
        "using UniFi WireGuard server"
    );
    // An empty public key means the control plane will refuse to build device configs
    // (a peer with no server key can't connect), so the router shows "no spark". The key
    // is read from `wireguard_public_key` and, when that's empty, derived from
    // `x_wireguard_private_key` (see unifi::server_public_key). Reaching 0 here means the
    // controller exposed neither on this object — the raw dump below shows exactly which
    // fields it did return (secret values redacted, names kept) so the gap is visible.
    if server.public_key.is_empty() {
        tracing::warn!(
            raw = %server.raw,
            "UniFi server has no public key and no derivable private key — device configs \
             cannot be built; the raw object shows which fields the controller returned"
        );
    }

    // Reconcile peers.
    let actual = unifi.list_peers(&server.id).await?;
    let actual_by_pk: HashMap<&str, &unifi::WgPeer> =
        actual.iter().map(|p| (p.public_key.as_str(), p)).collect();

    let mut created = 0;
    let mut readdressed = 0;
    for dp in &desired.peers {
        if dp.public_key.is_empty() {
            continue;
        }
        let want_ip = dp.assigned_ip.split('/').next().unwrap_or(&dp.assigned_ip);

        // A peer already on the controller is matched by public key. Leave it untouched
        // unless its address drifted: a device allocated on the default subnet before the
        // spark knew its real one gets re-addressed by the control plane, but matching by
        // key means the controller keeps the stale IP — wrong subnet, can't route — until
        // the peer is replaced. UniFi's peer API is create/delete only, so re-addressing
        // is delete-then-create.
        let is_readdress = match actual_by_pk.get(dp.public_key.as_str()) {
            Some(existing) => {
                let have_ip = existing
                    .interface_ip
                    .split('/')
                    .next()
                    .unwrap_or(&existing.interface_ip);
                if have_ip == want_ip {
                    continue; // present and correct
                }
                if let Err(e) = unifi.delete_peer(&server.id, existing.id.as_str()).await {
                    tracing::warn!("re-address {}: deleting the stale peer failed: {e:#}", dp.name);
                    continue;
                }
                true
            }
            None => false,
        };

        let new = NewPeer {
            name: peer_name(&dp.name),
            interface_ip: want_ip.to_string(),
            public_key: dp.public_key.clone(),
            preshared_key: dp.preshared_key.clone(),
            allowed_ips: dp.allowed_ips.clone(),
        };
        match unifi.create_peer(&server.id, &new).await {
            Ok(()) => {
                if is_readdress {
                    readdressed += 1;
                } else {
                    created += 1;
                }
            }
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
    let mut all_deletions_ok = true;
    for peer_id in &desired.pending_peer_deletions {
        match unifi.delete_peer(&server.id, peer_id).await {
            Ok(()) => deleted += 1,
            Err(e) => {
                all_deletions_ok = false;
                tracing::warn!("delete peer {peer_id} failed: {e:#}");
            }
        }
    }
    // Tell the control plane to drop the deletion queue once we've drained it, so the
    // same ids aren't handed back every cycle — that showed up as a perpetual "-N" in the
    // logs, re-deleting peers that were already gone. Only clear when *every* queued
    // deletion went through (idempotent no-ops on already-gone peers count): a genuine
    // failure stays queued to retry rather than being silently forgotten.
    let clear_deletions = !desired.pending_peer_deletions.is_empty() && all_deletions_ok;

    if created > 0 || readdressed > 0 || deleted > 0 {
        tracing::info!("reconciled UniFi peers: +{created} ~{readdressed} -{deleted}");
    }

    // Report actual state: the owned server's peers (flat, for the existing
    // provisioning/repair logic) plus the full inventory of every server and its peers
    // (for the dashboard). Gathered after any create so a just-made server is included.
    let peers_now = unifi.list_peers(&server.id).await.unwrap_or_default();
    let inventory = gather_inventory(unifi).await;
    Ok(ReconcileOutcome { server: Some(server), peers: peers_now, inventory, clear_deletions })
}

/// `error` is surfaced on the node in the dashboard: a spark that is up but can't
/// reach its controller should say so, not just look healthy or vanish.
async fn heartbeat(
    control: &Control,
    node_id: &str,
    node_key: &str,
    server: Option<&unifi::WgServer>,
    peers: &[unifi::WgPeer],
    inventory: &[ServerPeers],
    command_results: &[Value],
    clear_peer_deletions: bool,
    error: Option<&str>,
) -> Result<()> {
    // actualConfig.servers is the *full* inventory — every WireGuard server on the
    // controller, each with its peers nested — so the dashboard can show and manage all
    // of them. actualConfig.peers stays the *owned* server's peers, flat, because the
    // existing provisioning/repair/display logic reads it.
    let servers_json: Vec<Value> = inventory
        .iter()
        .map(|sp| {
            json!({
                "id": sp.server.id,
                "name": sp.server.name,
                "serverAddress": sp.server.server_address,
                "serverPort": sp.server.server_port,
                "publicKey": sp.server.public_key,
                "peers": sp.peers.iter().map(|p| json!({
                    "id": p.id, "name": p.name, "ip": p.interface_ip,
                    "publicKey": p.public_key, "allowedIps": p.allowed_ips, "enabled": true,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let actual_config = json!({
        "servers": servers_json,
        "peers": peers.iter().map(|p| json!({
            "id": p.id, "name": p.name, "ip": p.interface_ip,
            "publicKey": p.public_key, "enabled": true,
        })).collect::<Vec<_>>(),
    });

    let mut body = json!({ "actualConfig": actual_config });
    // Clear "creating on controller" once a server is actually bound. The dashboard sets
    // pending_vpn_create when you ask for a spark VPN, and nothing ever cleared it — the
    // Rust spark never implemented server creation — so the UI sat on "Creating on
    // controller…" forever. Reporting a bound server is proof the work is done.
    if server.is_some() {
        body["pendingVpnCreate"] = json!(false);
    }
    // Acknowledge a drained deletion queue so the control plane empties it (it clears the
    // queue to [] on this flag). Without it the same peer ids are re-sent every cycle.
    if clear_peer_deletions {
        body["clearPeerDeletions"] = json!(true);
    }
    // Report the outcome of any management commands executed this cycle; the control plane
    // removes those ids from the queue and records the results for the dashboard.
    if !command_results.is_empty() {
        body["commandResults"] = json!(command_results);
    }
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
    use super::{peer_name, sanitize_peer_name};

    #[test]
    fn spaces_become_dashes() {
        // The exact name that got a bare 400 from the controller.
        assert_eq!(peer_name("Miguel Router"), "bifrost-Miguel-Router");
    }

    #[test]
    fn sanitize_peer_name_has_no_prefix_and_falls_back() {
        // Operator-created clients: sanitised the same way, but without the bifrost- prefix.
        assert_eq!(sanitize_peer_name("My Phone"), "My-Phone");
        assert_eq!(sanitize_peer_name("  a // b "), "a-b");
        assert_eq!(sanitize_peer_name("!!!"), "client");
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
