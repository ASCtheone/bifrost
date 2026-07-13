# Deploying Bifrost

Two things get deployed:

| Component | Where it runs | Image |
|-----------|---------------|-------|
| **Control plane** (dashboard + API + opkg feed) | your VPS | `apps/spark-server/Dockerfile` |
| **Spark** (on-site UniFi bridge) | inside each customer network | `apps/spark/Dockerfile` |

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

**Key routing fact:** `spark-server` serves the dashboard UI at `/bifrost` but
the **API and feed at the domain root** (the built dashboard calls the API
same-origin, e.g. `/auth/login`). So the dashboard's hostname must route the
**whole hostname** to the tunnel — not just the `/bifrost` path — or login
breaks. The landing page makes no API calls, so it can be path-scoped.

**Public hostname 1 — dashboard (whole subdomain):**

| Field | Value |
|-------|-------|
| Subdomain | `dash` |
| Domain | `asc.ninja` |
| Path | *(empty)* |
| Service | `HTTP` → `spark-server:8443` |

→ `https://dash.asc.ninja/bifrost` (UI) + `/auth/*`, `/nodes/*` (API) all work;
`dash.asc.ninja/` redirects to `/bifrost/`.

**Public hostname 2 — landing (path-scoped, leaves the apex free):**

| Field | Value |
|-------|-------|
| Subdomain | *(empty / `@`)* |
| Domain | `asc.ninja` |
| Path | `bifrost.*` |
| Service | `HTTP` → `spark-server:8443` |

→ `https://asc.ninja/bifrost` serves the landing (Cloudflare preserves the path,
so the origin gets `/bifrost`). Its Connect button jumps to the dashboard host.

> **Apex caveat:** adding a public hostname for the **apex** `asc.ninja` points
> the whole apex DNS at the tunnel, so *all* `asc.ninja` traffic is now routed by
> these rules top-down. Keep the `bifrost.*` rule first; serve anything else on
> `asc.ninja` by adding a **catch-all** public hostname *below* it (Path empty →
> your other app, which can be a local container `http://other-app:PORT` or an
> external `https://…`). Until then, non-`/bifrost` paths on the apex return 404.

Equivalent file-based tunnel config (`config.yml`):

```yaml
ingress:
  - hostname: dash.asc.ninja
    service: http://spark-server:8443
  - hostname: asc.ninja
    path: ^/bifrost
    service: http://spark-server:8443
  # - hostname: asc.ninja          # your other site (catch-all, add later)
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
