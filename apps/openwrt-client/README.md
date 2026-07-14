# bifrost — GL.iNet / OpenWrt VPN client

Turns a GL.iNet (or any OpenWrt) router into a **Bifrost VPN device**. It links
to your Bifrost account with a **device code**, then brings up a WireGuard client
tunnel to a spark — a chosen location or, on **Auto**, the primary with failover
and automatic return-to-primary — optionally routing the whole LAN through it,
with an optional **kill switch**.

It's a single, self-contained shell package (`Architecture: all`) that installs
on any GL.iNet model regardless of CPU (MIPS/ARM), and it ships its **own config
page** — no LuCI required (many GL.iNet firmwares ship without a working LuCI).

## What's in the package

| Path                    | What it is                                                    |
| ----------------------- | ------------------------------------------------------------ |
| `/usr/bin/bifrost`      | the agent (pairing, WireGuard, kill switch, failover)        |
| `/etc/init.d/bifrost`   | procd service (config page + reactive agent daemon)          |
| `/etc/config/bifrost`   | uci config (location, kill switch, route-LAN, …)             |
| `/www/bifrost/`         | **config page** — served at `http://<router-ip>:8099/`       |
| `/www/bifrost/cgi-bin/bifrost` | the config page's backend (drives the agent)          |

The control-plane URL is **hard-bound** into the client (`https://dash.asc.ninja/bifrost`);
override only for self-hosting via `uci set bifrost.settings.master_url=…`.

## Onboarding (device-code pairing)

```
router first boot ──▶ asks master for a code (XXXX-XXXX)
you, signed in ─────▶ dash.asc.ninja/bifrost/device/register?deviceCode=XXXX&callback=<router>
dashboard ──────────▶ ties the device to your account, redirects back to the router
router ─────────────▶ saves the provision token, connects
```

The router shows the code and a **Register in dashboard** link on its config page.
Approving it in the dashboard sends the token back to the router (via the callback,
or the router polling), and the tunnel comes up. No token or URL to copy by hand.

## Install on a GL.iNet router

1. **Add the package source** — GL.iNet UI → **Applications → Plug-ins → Add source**:
   `https://github.com/ASCtheone/bifrost/releases/latest/download`
   (CLI: `echo "src/gz bifrost https://github.com/ASCtheone/bifrost/releases/latest/download" >> /etc/opkg/customfeeds.conf`)

   This is the feed CI publishes on every release. `releases/latest/download` always
   redirects to the newest release, so the router never needs the URL changed to pick
   up a new version — just `opkg update`.

   Your own master also serves the same feed at `https://<your-master>/bifrost/feed`
   (baked into the server image), if you'd rather not depend on GitHub.
2. **Install** — `opkg update`, then install **`bifrost`**.
3. **Open the config page** — **`http://bifrost.lan/`** (or `http://<router-ip>:8099/`):
   - Press **Get a pairing code**.
   - Click **Register in dashboard** (sign in if prompted), pick an expiry, confirm.
   - The router connects. Choose **Location** (Auto or a specific spark) and toggle
     the **Kill switch** / **Route LAN** as you like.

## CLI

| Command                 | Action                                                     |
| ----------------------- | ---------------------------------------------------------- |
| `bifrost bootstrap`     | request a pairing code from the master                     |
| `bifrost save-token <t>`| save a provision token (used by the dashboard callback)    |
| `bifrost poll`          | check the master for a claimed code, save the token        |
| `bifrost up` / `down`   | enable / disable the tunnel                                |
| `bifrost status`        | tunnel state, last handshake, `wg` details                 |
| `bifrost json`          | machine-readable status (used by the config page)          |
| `bifrost refresh`       | re-fetch config from the master, reconnect if it changed   |
| `bifrost killswitch`    | (re)apply the kill switch from config                      |
| `bifrost ui-setup`      | create the `:80` alias + `bifrost.lan` DNS record (postinst) |
| `bifrost ui-teardown`   | remove them again (prerm)                                  |
| `bifrost ui-url`        | print where the config page is reachable                   |

## The config page on port 80 (`http://bifrost.lan/`)

The page always listens on **`:8099`**. On install it *also* becomes available at
**`http://bifrost.lan/`** — no port — and here's how, because it's not obvious:

GL.iNet's own uhttpd owns `:80` on the router's address, and uhttpd has no
name-based virtual hosting, so that port can't be shared. Instead `bifrost
ui-setup` gives the LAN bridge a **second IP** and binds a second uhttpd to
`<alias>:80`. GL.iNet's UI is left completely untouched on the router's own
address. dnsmasq — already the DNS server for every DHCP client — maps the name
to the alias.

The alias is **chosen at install**, not hardcoded: it takes the first free host
address in the LAN `/24`, skipping the router's own address and the entire DHCP
pool, so it can't collide with a client. If the LAN isn't a `/24`, `ui-setup`
declines rather than guess, and the page simply stays on `:8099`.

**Why `.lan` and not `.local`:** `.local` is reserved for mDNS (RFC 6762), and
macOS, iOS and Windows resolve it *only* over multicast — a dnsmasq record for
`.local` would silently fail on exactly those clients. Names in the LAN's own
domain resolve everywhere, with no extra daemon.

## Config (`/etc/config/bifrost`)

| Option             | Default   | Meaning                                                       |
| ------------------ | --------- | ------------------------------------------------------------- |
| `master_url`       | *(empty)* | Control plane; empty = hard-bound default. Self-host override |
| `provision_token`  | *(empty)* | Set by registration — the device credential                   |
| `device_code`      | *(empty)* | Pending pairing code (cleared after registration)             |
| `location`         | `auto`    | `auto` (primary + failover) or a specific spark `nodeId`      |
| `killswitch`       | `0`       | Block LAN→internet unless via the tunnel (incl. while switching) |
| `enabled`          | `0`       | Whether the tunnel runs (`bifrost up` sets it)                |
| `route_lan`        | `1`       | Route LAN clients through the VPN (firewall zone + masq)      |
| `refresh_interval` | `300`     | Seconds between config refreshes / failover checks            |
| `ifname`           | `bifrost` | WireGuard interface name created on the router                |

## Building

- **Without the SDK**: `./build-ipk.sh` → `dist/bifrost_*.ipk` (gzip-tar ipk, no SDK needed).
- **The whole feed** (ipk + `Packages`/`Packages.gz` index): `scripts/build-feed.sh [outdir]`.
- Both consumers use that one script, so the two feeds can't drift:
  - the server image bakes it into `/bifrost/feed`;
  - CI (`.github/workflows/ci.yml`, job `openwrt`) publishes it to GitHub Releases,
    tagged `v<VERSION>`. Bump with `scripts/set-version.sh`, push to `master`, and the
    release is cut automatically.

## Notes

- The agent runs as a **reactive daemon**: the config page only edits uci config,
  and the daemon acts on it each cycle — so saving settings never restarts procd
  or drops the config page.
- The **kill switch** is a self-contained iptables chain (it doesn't touch the
  router's own firewall config) that only lets LAN clients egress via the tunnel;
  it blocks leaks whenever the tunnel is down or switching. Needs `iptables`
  (present on GL.iNet as iptables-nft); it logs and no-ops if absent.
- The config page is unauthenticated on the LAN — fine on a trusted network.
- `curl`, `wireguard-tools`, `kmod-wireguard` ship on most GL.iNet firmware; `jq`
  is pulled from the standard OpenWrt feed as a dependency.
