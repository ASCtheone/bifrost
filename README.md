<p align="center">
  <img src="bifrost_logo.png" alt="Bifrost" width="120" />
</p>

<h1 align="center">Bifrost</h1>

<p align="center"><em>Your own VPN, bridging every device to the networks you control.</em></p>

---

## Mission

**Bifrost is a self-hosted, WireGuard-based mesh VPN with a central control plane
you actually own.** In Norse myth the *Bifröst* is the rainbow bridge between
worlds — here it's the bridge between your devices and your networks, with no
third party sitting in the middle.

Run your own VPN infrastructure on hardware you trust, connect any device to it
in a couple of taps, and manage the whole fleet from one dashboard — **no cloud
account required.** Bifrost started life on AWS serverless and has been rebuilt
to run entirely self-hosted: a single Rust control plane, a local identity store,
and WireGuard everywhere.

## Core ideas

- **Sparks** — the VPN nodes. A spark is a WireGuard endpoint (a UniFi gateway, a
  mini PC, a cloud box) that devices connect *through*. Sparks are adopted into
  the control plane with a one-time code, then managed remotely.
- **Devices** — the clients. Phones, laptops, and routers that connect to a spark
  over WireGuard. Each device is provisioned once and gets a config that can fail
  over between sparks (primary → secondary) automatically.
- **The control plane** — the brain. It holds the desired state (sparks, devices,
  peers, IP pools, config), issues provisioning configs, authenticates admins,
  and keeps everything in sync.

```
        devices                         sparks                control plane
   ┌───────────────┐   WireGuard   ┌───────────────┐  state  ┌───────────────┐
   │ phone         │──────────────▶│  primary      │◀───────▶│               │
   │ laptop        │──────────────▶│  spark        │         │  spark-server │
   │ GL.iNet router│──────╮   ╭───▶│               │         │   (Rust)      │
   └───────────────┘      │   │    ├───────────────┤  adopt  │   + dashboard │
                     failover to   │  secondary    │◀───────▶│               │
                     a secondary   │  spark        │         └───────────────┘
                                   └───────────────┘
```

## What's in the box

This is an Nx monorepo. The pieces that matter:

| Component | Path | What it is |
| --- | --- | --- |
| **Control plane** | `apps/spark-server` | The self-hosted master — Rust + axum + SQLite. Local auth (argon2 + JWT), node/device/peer management, provisioning, opkg feed. |
| **Dashboard** | `apps/dashboard` | Angular admin UI — manage sparks, devices, users, VPN config; pause/resume sparks; onboard devices. |
| **Spark** | `apps/spark` | The on-site bridge (Rust) — adoption, heartbeat, and WireGuard provisioning against a UniFi controller. Runs inside each customer network. |
| **Windows client** | `apps/bifrost-windows` | Go system-tray VPN client (WireGuard service, failover). Being replaced by a cross-platform Rust desktop client. |
| **Android client** | `apps/bifrost-android` | Kotlin/Compose VPN client (adoption, QR onboarding, secure credential store). |
| **Router client** | `apps/openwrt-client` | The `bifrost` package for GL.iNet/OpenWrt routers — installs from the master's opkg feed, ships its own config page, brings up WireGuard. |

## How it works

1. **Adopt a spark** — the dashboard mints a one-time adoption code; the spark's
   agent registers with it and receives a node key. From then on the spark
   heartbeats and applies whatever config the control plane assigns.
2. **Provision a device** — create a device (phone/laptop/router), and Bifrost
   generates its WireGuard keypair, allocates an IP, and hands back a config —
   as a QR code, a `.conf` download, or a provision URL.
3. **Connect** — the device (or router) brings up WireGuard against its primary
   spark. If that spark goes stale, the client fails over to a secondary.
4. **Manage** — pause a spark, promote a secondary to primary, rotate keys,
   revoke a device — all from the dashboard, reflected everywhere.

## Status

Actively evolving. The self-hosted Rust control plane is now the only backend —
the original AWS serverless stack has been removed entirely (local users +
self-issued JWTs, no cloud account anywhere). Native clients exist for Windows,
Android, and GL.iNet/OpenWrt routers.

## License

MIT.
