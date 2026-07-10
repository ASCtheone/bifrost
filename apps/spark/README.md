# bifrost-spark

The **spark** — a small on-site bridge (single Rust binary) that connects a
customer network to the Bifrost control plane and provisions the **WireGuard
server on a local UniFi controller** to match.

It replaces the old AWS/DynamoDB agent: no cloud SDK, no local database, no local
API. All state lives on the control plane (your VPS); the spark just reconciles
UniFi to it.

## What it does

```
   VPS (control plane)                     on-site
  ┌───────────────────┐   HTTPS out   ┌───────────────────────┐  UniFi API
  │ spark-server      │◀──────────────│  bifrost-spark        │──────────▶ UniFi
  │  (Rust)           │   node-key    │  adopt·heartbeat·sync │   controller
  └───────────────────┘               └───────────────────────┘  (WireGuard server)
```

1. **Adopt** — on first run, exchanges a one-time adoption code for a node key
   (`POST /agent/register` → `GET /agent/await-adoption`). The key is persisted
   to `spark-state.json`.
2. **Sync loop** (every `poll_interval_seconds`):
   - Pulls the desired WireGuard peers from `GET /nodes/{id}/desired-config`
     (node-key auth) — one peer per enabled device owned by this spark's owner.
   - Reconciles the UniFi WireGuard server: **creates** missing peers, applies
     the control plane's **pending peer deletions**.
   - **Heartbeats** back the actual state (WG server public key + address + port,
     current peers) and the spark's public WAN IP, so the control plane can hand
     devices a config that dials into this spark.

Only **outbound** HTTPS is needed from the site — no inbound firewall rules.

## Configure

Copy `bifrost-spark.example.toml` → `bifrost-spark.toml`:

```toml
master_url = "https://bifrost.example.com"   # your VPS control plane
adoption_code = "XXX-XXX-XXX"                # from the dashboard, first boot only
poll_interval_seconds = 30

[unifi]
host = "192.168.1.1"     # UniFi gateway / controller
port = 443
site = "default"
username = "bifrost"
password = "change-me"
insecure = true          # accept the controller's self-signed cert
```

## Run

```sh
BIFROST_SPARK_CONFIG=/etc/bifrost/bifrost-spark.toml bifrost-spark
```

Deploy as a systemd service or a container on any small always-on box inside the
network that can reach the UniFi controller.

## Build

```sh
cargo build --release      # single static-ish binary in target/release/bifrost-spark
```

Cross-compile for the target box's arch (e.g. `aarch64-unknown-linux-musl`) for a
dependency-free deploy.

## Notes / TODO

- **WireGuard-server auto-creation** isn't automated yet: the spark manages
  *peers* on an existing UniFi WireGuard server (matched by `spark_vpn_name`). If
  no server exists, create one in the UniFi UI (or via the `create-vpn` flow) —
  the spark then takes over peer management.
- On-server peer `allowed-ips` is the peer's tunnel IP (`/32`); the client-side
  full-tunnel `AllowedIPs` lives in the device's generated `.conf`.
