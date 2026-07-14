# Deploying Bifrost

Two things get deployed:

| Component | Where it runs | Image |
|-----------|---------------|-------|
| **Control plane** (dashboard + API + opkg feed) | your VPS | `apps/spark-server/Dockerfile` |
| **Spark** (on-site UniFi bridge) | inside each customer network | `apps/spark/Dockerfile` |

## Installing a spark (one line)

On the machine inside the network you want to bridge:

```sh
curl -fsSL https://raw.githubusercontent.com/ASCtheone/bifrost/master/scripts/install-spark.sh | sh
```

It asks, once, how to install:

- **docker** — a container via docker compose. Installs Docker for you if it's missing.
- **native** — a static binary (`/usr/local/bin/bifrost-spark`) plus a systemd
  service. No Docker at all. The binaries are published per release and the
  download is checksum-verified against `SHA256SUMS` before install.

The answer is recorded in `/opt/bifrost-spark/install.conf`, so **re-running the
same one-liner updates in place** — it never re-asks the mode or your UniFi
credentials. The dashboard shows this command on its home page, ready to copy.

## 1. Control plane on the VPS

Prerequisites: Docker + Docker Compose. Ingress is a **Cloudflare Tunnel** by
default, so **no inbound ports** are needed — only outbound access from the VPS.

```sh
git clone https://github.com/ASCtheone/bifrost && cd bifrost

# 1. configuration + secrets
cp .env.example .env
$EDITOR .env                                   # BIFROST_JWT_SECRET, TUNNEL_TOKEN, domains
#   openssl rand -hex 32   → BIFROST_JWT_SECRET

mkdir -p secrets
printf '%s' '<your-fontawesome-pro-token>' > secrets/fontawesome_token

# 2. build + run
docker compose up -d --build
```

### Cloudflare Tunnel setup

In the Cloudflare Zero Trust dashboard → **Networks → Tunnels**, create a tunnel
and copy its **token** into `TUNNEL_TOKEN` in `.env`. Then add its public
hostnames.

**Everything lives under `/bifrost`** — the UI at `/bifrost`, the API at
`/bifrost/api`, the feed at `/bifrost/feed`. So **both** hostnames are simply
path-scoped to `/bifrost`, leaving the rest of each domain free for other apps.

Add two **public hostnames**, both with **Service = `HTTP` → `spark-server:8443`**
and **Path = `bifrost.*`**:

| Subdomain | Domain | Path | Service |
|-----------|--------|------|---------|
| `dash` | `asc.ninja` | `bifrost.*` | `HTTP` `spark-server:8443` |
| *(empty / `@`)* | `asc.ninja` | `bifrost.*` | `HTTP` `spark-server:8443` |

Cloudflare **preserves the path** to the origin, so `spark-server` receives
`/bifrost/...` and serves the UI, API, and feed from there. `dash.asc.ninja/bifrost`
is the dashboard (its API calls hit `/bifrost/api/*`, which the same rule covers);
`asc.ninja/bifrost` is the landing.

> **Hosting other apps on the same domains:** because everything is under
> `/bifrost`, you can add more path-scoped public hostnames on the same domains
> for other apps (e.g. `asc.ninja` path `otherapp.*` → its service), and a final
> **catch-all** (Path empty → your main site). Keep the `bifrost.*` rules above
> any catch-all.

Equivalent file-based tunnel config (`config.yml`):

```yaml
ingress:
  - hostname: dash.asc.ninja
    path: ^/bifrost
    service: http://spark-server:8443
  - hostname: asc.ninja
    path: ^/bifrost
    service: http://spark-server:8443
  # - hostname: asc.ninja          # your other apps (path-scoped, add later)
  #   path: ^/otherapp
  #   service: http://other-app:PORT
  - service: http_status:404       # required final catch-all
```

Cloudflare terminates TLS at its edge; the `cloudflared` container dials the
`spark-server` service over the internal Docker network. Then:

- Dashboard → `https://dash.asc.ninja/bifrost`
- Landing   → `https://asc.ninja/bifrost`

> **No Cloudflare?** Use the built-in Caddy ingress instead (direct exposure,
> its own Let's Encrypt certs, needs ports 80/443 open + DNS A/AAAA records).
> Start just the server + Caddy (not cloudflared):
> `docker compose --profile caddy up -d --build spark-server caddy`.

**First run:** the dashboard has no accounts yet, so it opens the **setup**
screen — create the super admin. From there, create admins (they get a
temporary password and are forced to change it on first login).

### What the compose stack contains

- **spark-server** — one Rust binary serving the built dashboard at `/bifrost`,
  the REST API at the root, and the package feed at `/feed`. SQLite lives on the
  `bifrost-data` volume; the feed is bind-mounted from `./feed`.
- **caddy** — TLS + reverse proxy for both domains (config in `Caddyfile`).

Secrets/paths are read from the environment (see `apps/spark-server/src/main.rs`
`apply_env_overrides`); nothing sensitive is baked into the image.

### Configurable URLs

The dashboard's build-time config lives in
`apps/dashboard/src/environments/environment.prod.ts`:

- `landingUrl` / `dashboardUrl` — the landing page's **Connect** button target.
- `apiUrl: ''` — same-origin API (so the dashboard domain must serve the API,
  which it does).

Change those and rebuild the image to point at different domains.

## 2. Spark on a customer site

On any always-on box inside the network that can reach the UniFi controller
(outbound HTTPS to the VPS is all that's needed):

```sh
docker build -t bifrost-spark apps/spark

mkdir -p /etc/bifrost
cp apps/spark/bifrost-spark.example.toml /etc/bifrost/bifrost-spark.toml
$EDITOR /etc/bifrost/bifrost-spark.toml         # master_url, adoption code, UniFi creds

docker run -d --name bifrost-spark \
  -v /etc/bifrost:/etc/bifrost \
  --restart unless-stopped \
  bifrost-spark
```

Get the one-time **adoption code** from the dashboard (Add Spark), then adopt the
spark there. After adoption the node key is persisted to `spark-state.json` and
the code is no longer needed.

## Updating

```sh
git pull
docker compose up -d --build      # control plane
# spark: rebuild + docker restart bifrost-spark on the site box
```
