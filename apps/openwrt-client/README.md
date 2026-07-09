# bifrost — GL.iNet / OpenWrt VPN client

Turns a GL.iNet (or any OpenWrt) router into a **Bifrost VPN device**. The router
fetches its WireGuard config from the Bifrost master and brings up a client
tunnel to a remote spark, optionally routing the whole LAN through it — with
automatic node failover.

It's a single, self-contained shell package (`Architecture: all`) that installs
on any GL.iNet model regardless of CPU (MIPS/ARM), and it ships its **own config
page** — no LuCI required (many GL.iNet firmwares ship without a working LuCI).

## What's in the package

| Path                        | What it is                                                  |
| --------------------------- | ----------------------------------------------------------- |
| `/usr/bin/bifrost`          | the agent (fetch config, configure WireGuard, failover)     |
| `/etc/init.d/bifrost`       | procd service (keeps the tunnel healthy)                    |
| `/etc/config/bifrost`       | uci config (provision URL, route-LAN, refresh interval)     |
| `/www/bifrost/`             | **config page** — served at `http://<router-ip>/bifrost/`   |
| `/www/cgi-bin/bifrost`      | the config page's backend (drives the agent)                |

## How it fits together

```
Bifrost master (spark-server)                     GL.iNet router (this package)
  ├─ /feed  (opkg source) ─────── bifrost.ipk ────▶ installed via Plug-ins menu
  ├─ config page at /bifrost/ ─── provision URL ──▶ you paste it here, press Connect
  └─ /provision/{token}  ──────── WireGuard cfg ──▶ agent configures the tunnel
```

## Install on a GL.iNet router

**1. On the master** — build the feed (once, or after any change):

```sh
scripts/build-feed.sh      # builds bifrost.ipk + Packages index into apps/spark-server/feed
```

Served at `http://<master>:<port>/feed`.

**2. Add the master as a package source** — GL.iNet UI → **Applications → Plug-ins
→ Manage sources / Add source**:

```
http://<master>:8899/feed
```

(CLI equivalent: `echo "src/gz bifrost http://<master>:8899/feed" >> /etc/opkg/customfeeds.conf`.)

**3. Discover & install** — refresh the plugin list (`opkg update`). **`bifrost`**
appears; install it.

**4. Open the config page** — browse to **`http://<router-ip>/bifrost/`**:

- Create a device of type **router** in the Bifrost dashboard and copy its
  **Provision URL**.
- Paste it into the config page, leave *Route LAN through VPN* on, press **Connect**.

The page shows live tunnel status (and last handshake). The agent writes the
WireGuard interface + firewall rules and brings the tunnel up.

*(CLI equivalent: `uci set bifrost.settings.provision_url='…'; uci commit bifrost; bifrost up; bifrost status`.)*

## CLI

| Command            | Action                                                        |
| ------------------ | ------------------------------------------------------------- |
| `bifrost up`       | enable + connect                                              |
| `bifrost down`     | disable + tear the tunnel down                                |
| `bifrost status`   | tunnel state, last handshake, `wg` details                    |
| `bifrost json`     | machine-readable status (used by the config page)             |
| `bifrost refresh`  | re-fetch config from the master, reconnect if it changed      |

## Config (`/etc/config/bifrost`)

| Option             | Default    | Meaning                                                   |
| ------------------ | ---------- | --------------------------------------------------------- |
| `provision_url`    | *(empty)*  | The master-issued provision URL for this router device    |
| `enabled`          | `0`        | Whether the tunnel service runs (`bifrost up` sets it)    |
| `route_lan`        | `1`        | Route LAN clients through the VPN (firewall zone + masq)  |
| `refresh_interval` | `300`      | Seconds between config refreshes / failover checks        |
| `ifname`           | `bifrost`  | WireGuard interface name created on the router            |

## Building

- **With the OpenWrt SDK**: symlink this dir into `package/bifrost` and
  `make package/bifrost/compile`.
- **Without the SDK**: `./build-ipk.sh` → `dist/bifrost_*.ipk`.

## Notes

- The config page is served on the router's LAN by uhttpd and is unauthenticated
  — fine on a trusted LAN; put it behind auth / HTTPS if that matters to you.
- The opkg feed is unauthenticated (standard for opkg); the **provision token is
  the device credential** — treat the provision URL as a secret.
- `curl`, `wireguard-tools`, `kmod-wireguard` ship on most GL.iNet firmware; `jq`
  is pulled from the standard OpenWrt feed as a dependency.
