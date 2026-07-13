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

1. In the Cloudflare Zero Trust dashboard → **Networks → Tunnels**, create a
   tunnel and copy its **token** into `TUNNEL_TOKEN` in `.env`.
2. Add two **public hostnames** to the tunnel, both pointing at the origin
   service `http://spark-server:8443`:
   - `${DASHBOARD_DOMAIN}` → `http://spark-server:8443`
   - `${LANDING_DOMAIN}`   → `http://spark-server:8443`

Cloudflare terminates TLS at its edge; the `cloudflared` container dials the
`spark-server` service over the internal Docker network. Then:

- Dashboard → `https://<DASHBOARD_DOMAIN>/bifrost`
- Landing   → `https://<LANDING_DOMAIN>/bifrost`

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
