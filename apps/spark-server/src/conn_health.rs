//! Connection health: can this router actually get a tunnel to each of its sparks?
//!
//! A spark that heartbeats is "alive" in the dashboard, but that only proves it can
//! reach us. A router needs much more: the right public endpoint, a WireGuard server
//! with a key, its own IP inside that server's subnet, and its peer actually present on
//! the controller. Each of those has failed silently before — this checks every one,
//! per spark, and adds what the router itself last reported (its handshake result),
//! which is the only real network test we have.
//!
//! Pure: the route loads the device + nodes and calls `device_health`.

use crate::domain::{Device, Node};
use crate::routes::shared::{node_endpoint, node_serves_device, spark_server_for};
use crate::wg::ip_on_server;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use std::net::Ipv4Addr;

/// A spark heartbeats every 30 s by default; this many seconds of silence means down.
const HEARTBEAT_STALE_SECS: i64 = 180;
/// The router polls the master every refresh_interval (300 s by default).
const ROUTER_STALE_SECS: i64 = 900;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Serialize)]
pub struct Check {
    pub id: &'static str,
    pub status: Status,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeHealth {
    pub node_id: String,
    pub node_name: String,
    pub role: String,
    pub endpoint: Option<String>,
    pub status: Status,
    pub checks: Vec<Check>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceHealth {
    pub device_id: String,
    pub status: Status,
    /// Sparks that pass every check — the router can fail over between these.
    pub healthy_nodes: usize,
    pub checks: Vec<Check>,
    pub nodes: Vec<NodeHealth>,
    pub checked_at: String,
}

fn check(id: &'static str, status: Status, message: impl Into<String>) -> Check {
    Check {
        id,
        status,
        message: message.into(),
    }
}

fn worst(checks: &[Check]) -> Status {
    checks.iter().map(|c| c.status).max().unwrap_or(Status::Ok)
}

fn age_secs(iso: &str, now: DateTime<Utc>) -> Option<i64> {
    DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|t| (now - t.with_timezone(&Utc)).num_seconds())
}

fn ago(secs: i64) -> String {
    match secs {
        s if s < 120 => format!("{s}s ago"),
        s if s < 7200 => format!("{}m ago", s / 60),
        s => format!("{}h ago", s / 3600),
    }
}

/// Why an IPv4 endpoint can't be dialled from the internet, if it can't.
fn non_public_reason(ip: Ipv4Addr) -> Option<&'static str> {
    let o = ip.octets();
    if ip.is_private() {
        Some("a private LAN address")
    } else if o[0] == 100 && (64..128).contains(&o[1]) {
        Some("a carrier-grade NAT (CGNAT) address — the spark's ISP shares it, so inbound UDP can't reach the spark")
    } else if ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() {
        Some("not a routable address")
    } else {
        None
    }
}

/// The router's own handshake report for `node_id`: (ok, seconds ago).
fn router_report(device: &Device, node_id: &str, now: DateTime<Utc>) -> Option<(bool, i64)> {
    let r = device.node_reports.as_ref()?.get(node_id)?;
    let ok = r.get("ok")?.as_bool()?;
    let at = age_secs(r.get("at")?.as_str()?, now)?;
    Some((ok, at))
}

/// The name of another client on the spark's owned server that holds `ip`, if any.
fn ip_taken_by(node: &Node, ip: &str, own_key: &str) -> Option<String> {
    let peers = node.actual_config.as_ref()?.get("peers")?.as_array()?;
    peers
        .iter()
        .filter(|p| p.get("publicKey").and_then(Value::as_str) != Some(own_key))
        .find(|p| {
            p.get("ip")
                .and_then(Value::as_str)
                .and_then(|v| v.split('/').next())
                == Some(ip)
        })
        .map(|p| {
            p.get("name")
                .and_then(Value::as_str)
                .unwrap_or("?")
                .to_string()
        })
}

/// The device's peer on the spark's owned server, as last reported: its tunnel IP.
fn reported_peer_ip<'a>(node: &'a Node, public_key: &str) -> Option<&'a str> {
    let peers = node.actual_config.as_ref()?.get("peers")?.as_array()?;
    peers
        .iter()
        .find(|p| p.get("publicKey").and_then(Value::as_str) == Some(public_key))
        .map(|p| p.get("ip").and_then(Value::as_str).unwrap_or(""))
}

fn node_checks(device: &Device, node: &Node, now: DateTime<Utc>) -> NodeHealth {
    let mut checks = Vec::new();

    match age_secs(&node.last_seen, now) {
        Some(a) if a <= HEARTBEAT_STALE_SECS => checks.push(check(
            "heartbeat",
            Status::Ok,
            format!("spark checked in {}", ago(a)),
        )),
        Some(a) => checks.push(check(
            "heartbeat",
            Status::Fail,
            format!(
                "spark last checked in {} — it's offline or can't reach the control plane",
                ago(a)
            ),
        )),
        None => checks.push(check(
            "heartbeat",
            Status::Fail,
            "spark has never checked in",
        )),
    }
    if node.paused {
        checks.push(check(
            "paused",
            Status::Fail,
            "spark is paused — its WireGuard server is switched off",
        ));
    }
    if let Some(e) = node.error.as_deref().filter(|e| !e.is_empty()) {
        checks.push(check(
            "spark_error",
            Status::Warn,
            format!("spark reports an error: {e}"),
        ));
    }

    let server = spark_server_for(node);
    match &server {
        None => checks.push(check(
            "wg_server",
            Status::Fail,
            "spark hasn't reported its WireGuard server (none, or several and none bound)",
        )),
        Some(s) if s.public_key.is_empty() => checks.push(check(
            "wg_server",
            Status::Fail,
            "WireGuard server has no public key — no config can be built",
        )),
        Some(s) if !s.enabled => checks.push(check(
            "wg_server",
            Status::Fail,
            "WireGuard server is disabled on the controller",
        )),
        Some(s) => checks.push(check(
            "wg_server",
            Status::Ok,
            format!(
                "WireGuard server {} on UDP {}",
                s.server_address, s.server_port
            ),
        )),
    }

    let endpoint = node_endpoint(node);
    match endpoint.as_deref() {
        None => checks.push(check(
            "endpoint",
            Status::Fail,
            "no endpoint — the spark never reported a public IPv4 and no override is set",
        )),
        Some(ep) => match ep.parse::<Ipv4Addr>() {
            Ok(ip) => match non_public_reason(ip) {
                Some(why) => checks.push(check(
                    "endpoint",
                    Status::Fail,
                    format!("endpoint {ep} is {why}; set an endpoint override"),
                )),
                None => checks.push(check("endpoint", Status::Ok, format!("endpoint {ep}"))),
            },
            Err(_) => checks.push(check(
                "endpoint",
                Status::Ok,
                format!("endpoint {ep} (override)"),
            )),
        },
    }

    // The device's address on this spark: its host number on the spark's subnet.
    let subnet = server.as_ref().map_or("", |s| s.server_address.as_str());
    let want_ip = ip_on_server(&device.assigned_ip, subnet);
    if !subnet.is_empty() {
        // Another client already holding that address blocks ours from being created.
        match ip_taken_by(node, &want_ip, &device.public_key) {
            Some(other) => checks.push(check("device_ip", Status::Fail, format!(
                "this spark's address for the router, {want_ip}, is already used by client \"{other}\" — UniFi refuses a duplicate"
            ))),
            None => checks.push(check("device_ip", Status::Ok, format!("router uses {want_ip} on this spark"))),
        }
    }

    // The spark only provisions its owner's devices (see desired_config), so a router
    // using a shared spark is never added to it.
    let node_owner = node.owner_email.as_str();
    if !node_owner.is_empty() && device.owner_email != node_owner {
        checks.push(check("owner", Status::Fail, format!(
            "spark belongs to {node_owner}; it only adds its owner's devices as clients, so this router is never added"
        )));
    }

    match reported_peer_ip(node, &device.public_key) {
        None => checks.push(check("peer", Status::Fail, "router is not a client on this spark's WireGuard server (yet) — no handshake is possible")),
        Some(ip) if ip.split('/').next().unwrap_or("") != want_ip => checks.push(check("peer", Status::Warn, format!(
            "router is a client, but with IP {ip} instead of {want_ip} — being re-addressed"
        ))),
        Some(_) => checks.push(check("peer", Status::Ok, "router is a client on the WireGuard server")),
    }

    match router_report(device, &node.node_id, now) {
        Some((true, a)) => checks.push(check("router_handshake", Status::Ok, format!("router handshook with it {}", ago(a)))),
        Some((false, a)) => checks.push(check("router_handshake", Status::Fail, format!(
            "router's last attempt got no handshake ({}) — check the endpoint and that UDP {} is reachable from outside",
            ago(a),
            server.as_ref().map_or(51820, |s| s.server_port)
        ))),
        None => {} // not tried yet, or a router version that doesn't report
    }

    NodeHealth {
        node_id: node.node_id.clone(),
        node_name: if node.node_name.is_empty() {
            node.node_id.clone()
        } else {
            node.node_name.clone()
        },
        role: node.role.clone(),
        endpoint,
        status: worst(&checks),
        checks,
    }
}

fn device_checks(device: &Device, nodes: &[&Node], now: DateTime<Utc>) -> Vec<Check> {
    let mut checks = Vec::new();
    if device.status == "revoked" {
        checks.push(check("device", Status::Fail, "device is revoked"));
    } else if !device.enabled {
        checks.push(check(
            "device",
            Status::Fail,
            "device is disabled — sparks don't add it as a client",
        ));
    }
    if let Some(exp) = device.expires_at.as_deref().filter(|e| !e.is_empty()) {
        if age_secs(exp, now).is_some_and(|a| a >= 0) {
            checks.push(check(
                "expiry",
                Status::Fail,
                "registration has expired — the router is refused its config",
            ));
        }
    }
    match device.last_seen.as_deref().and_then(|s| age_secs(s, now)) {
        Some(a) if a <= ROUTER_STALE_SECS => checks.push(check(
            "router_seen",
            Status::Ok,
            format!("router polled {}", ago(a)),
        )),
        Some(a) => checks.push(check(
            "router_seen",
            Status::Warn,
            format!(
                "router last polled {} — offline, or its WAN is black-holed",
                ago(a)
            ),
        )),
        None => checks.push(check(
            "router_seen",
            Status::Warn,
            "router has never polled",
        )),
    }
    if device.safe_mode {
        checks.push(check(
            "safe_mode",
            Status::Warn,
            "router is in safe mode — tunnel down, LAN limited to management",
        ));
    }
    if nodes.is_empty() {
        checks.push(check(
            "sparks",
            Status::Fail,
            "no adopted spark serves this device",
        ));
    }

    checks
}

pub fn device_health(device: &Device, all_nodes: &[Node], now: DateTime<Utc>) -> DeviceHealth {
    let nodes: Vec<&Node> = all_nodes
        .iter()
        .filter(|n| node_serves_device(device, n))
        .collect();
    let checks = device_checks(device, &nodes, now);
    let mut node_health: Vec<NodeHealth> =
        nodes.iter().map(|n| node_checks(device, n, now)).collect();
    // Primary first, like the router tries them.
    node_health.sort_by_key(|n| n.role != "primary");
    let healthy_nodes = node_health
        .iter()
        .filter(|n| n.status == Status::Ok)
        .count();
    let status = worst(&checks).max(
        node_health
            .iter()
            .map(|n| n.status)
            .max()
            .unwrap_or(Status::Ok),
    );
    DeviceHealth {
        device_id: device.device_id.clone(),
        status,
        healthy_nodes,
        checks,
        nodes: node_health,
        checked_at: now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::types::Json;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-19T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn device() -> Device {
        serde_json::from_value(json!({
            "deviceId": "dev-1", "nodeId": "", "name": "router", "type": "router",
            "status": "active", "provisionMethod": "device-code", "provisionToken": "tok",
            "assignedIp": "10.13.0.42", "publicKey": "DEVPUB", "privateKey": "x", "presharedKey": "y",
            "serverPublicKey": "", "serverEndpoint": "", "serverPort": 51820,
            "dns": ["1.1.1.1"], "allowedIps": ["0.0.0.0/0"], "unifiPeerId": null, "enabled": true,
            "lastSeen": "2026-10-19T11:58:00Z", "createdBy": "a@b.c", "ownerEmail": "a@b.c",
            "createdAt": "2026-10-01T00:00:00Z", "updatedAt": "2026-10-01T00:00:00Z",
        }))
        .unwrap()
    }

    /// A spark that passes every check for `device()`.
    fn node(id: &str, role: &str, subnet: &str, wan: &str) -> Node {
        Node {
            node_id: id.into(),
            node_name: id.to_uppercase(),
            owner_email: "a@b.c".into(),
            role: role.into(),
            adoption_status: "adopted".into(),
            last_seen: "2026-10-19T11:59:40Z".into(),
            wan_ip: Some(wan.into()),
            actual_config: Some(Json(json!({
                "servers": [{ "id": "s1", "name": "VPN", "publicKey": "SRVPUB", "serverPort": 51820,
                              "serverAddress": subnet, "enabled": true }],
                "peers": [{ "id": "p1", "publicKey": "DEVPUB", "ip": "10.13.0.42" }],
            }))),
            ..Default::default()
        }
    }

    fn status_of<'a>(h: &'a NodeHealth, id: &str) -> Option<Status> {
        h.checks.iter().find(|c| c.id == id).map(|c| c.status)
    }

    #[test]
    fn healthy_spark_passes_every_check() {
        let h = device_health(
            &device(),
            &[node("home", "primary", "10.13.0.1/24", "81.2.3.4")],
            now(),
        );
        assert_eq!(h.status, Status::Ok, "{h:#?}");
        assert_eq!(h.healthy_nodes, 1);
    }

    #[test]
    fn stale_heartbeat_fails() {
        let mut n = node("home", "primary", "10.13.0.1/24", "81.2.3.4");
        n.last_seen = "2026-10-19T11:50:00Z".into();
        let h = device_health(&device(), &[n], now());
        assert_eq!(status_of(&h.nodes[0], "heartbeat"), Some(Status::Fail));
    }

    #[test]
    fn cgnat_and_private_endpoints_fail() {
        for wan in ["100.72.1.9", "192.168.1.10", "10.0.0.5"] {
            let h = device_health(
                &device(),
                &[node("home", "primary", "10.13.0.1/24", wan)],
                now(),
            );
            assert_eq!(
                status_of(&h.nodes[0], "endpoint"),
                Some(Status::Fail),
                "{wan}"
            );
        }
    }

    #[test]
    fn hostname_override_is_accepted() {
        let mut n = node("home", "primary", "10.13.0.1/24", "100.72.1.9");
        n.endpoint_override = "home.example.net".into();
        let h = device_health(&device(), &[n], now());
        assert_eq!(status_of(&h.nodes[0], "endpoint"), Some(Status::Ok));
    }

    #[test]
    fn missing_peer_fails() {
        let mut n = node("home", "primary", "10.13.0.1/24", "81.2.3.4");
        n.actual_config.as_mut().unwrap().0["peers"] = json!([]);
        let h = device_health(&device(), &[n], now());
        assert_eq!(status_of(&h.nodes[0], "peer"), Some(Status::Fail));
    }

    #[test]
    fn sparks_on_different_subnets_each_get_their_own_address() {
        // The real setup: HOME on 10.13.0.0/24, APT on a pre-existing 192.168.3.0/24.
        let mut apt = node("apt", "secondary", "192.168.3.1/24", "82.5.6.7");
        apt.actual_config.as_mut().unwrap().0["peers"] =
            json!([{ "id": "p2", "publicKey": "DEVPUB", "ip": "192.168.3.42" }]);
        let nodes = [node("home", "primary", "10.13.0.1/24", "81.2.3.4"), apt];
        let h = device_health(&device(), &nodes, now());
        assert_eq!(h.status, Status::Ok, "{h:#?}");
        assert_eq!(h.healthy_nodes, 2);
    }

    #[test]
    fn address_taken_by_another_client_fails() {
        let mut n = node("home", "primary", "10.13.0.1/24", "81.2.3.4");
        n.actual_config.as_mut().unwrap().0["peers"] = json!([{ "id": "px", "name": "Miguel Router", "publicKey": "OTHER", "ip": "10.13.0.42" }]);
        let h = device_health(&device(), &[n], now());
        assert_eq!(status_of(&h.nodes[0], "device_ip"), Some(Status::Fail));
    }

    #[test]
    fn same_subnet_on_every_spark_is_fine() {
        let nodes = [
            node("home", "primary", "10.13.0.1/24", "81.2.3.4"),
            node("apt", "secondary", "10.13.0.1/24", "82.5.6.7"),
        ];
        let h = device_health(&device(), &nodes, now());
        assert_eq!(h.status, Status::Ok, "{h:#?}");
        assert_eq!(h.healthy_nodes, 2);
    }

    #[test]
    fn shared_spark_owned_by_someone_else_fails() {
        let mut n = node("home", "primary", "10.13.0.1/24", "81.2.3.4");
        n.owner_email = "other@b.c".into();
        let mut d = device();
        d.owner_email = String::new(); // owner-less device still gets the config…
        let h = device_health(&d, &[n], now());
        assert_eq!(status_of(&h.nodes[0], "owner"), Some(Status::Fail)); // …but never the peer
    }

    #[test]
    fn router_reported_handshake_failure_fails() {
        let mut d = device();
        d.node_reports = Some(Json(
            json!({ "home": { "ok": false, "at": "2026-10-19T11:59:00Z" } }),
        ));
        let h = device_health(
            &d,
            &[node("home", "primary", "10.13.0.1/24", "81.2.3.4")],
            now(),
        );
        assert_eq!(
            status_of(&h.nodes[0], "router_handshake"),
            Some(Status::Fail)
        );
        assert_eq!(h.healthy_nodes, 0);
    }

    #[test]
    fn primary_is_listed_first() {
        let nodes = [
            node("apt", "secondary", "10.13.0.1/24", "82.5.6.7"),
            node("home", "primary", "10.13.0.1/24", "81.2.3.4"),
        ];
        assert_eq!(
            device_health(&device(), &nodes, now()).nodes[0].node_id,
            "home"
        );
    }
}
