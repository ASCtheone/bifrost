# syntax=docker/dockerfile:1.7
#
# Unified Bifrost control-plane image. Builds the Angular dashboard and the Rust
# spark-server, then ships a single small container that serves, on one origin:
#   • the dashboard SPA at /bifrost   • the REST API at the root
#   • the opkg package feed at /feed
#
# Build context is the REPO ROOT (the dashboard build needs the nx workspace):
#   docker build -f apps/spark-server/Dockerfile \
#     --secret id=fontawesome_token,src=./secrets/fontawesome_token .
# (docker compose in the repo root wires this up for you.)

# ── Stage 1: build the Angular dashboard ────────────────────────────
# The dashboard is a self-contained Angular 21 project (its own package.json /
# tsconfig), so it installs and builds entirely within apps/dashboard.
FROM node:22-bookworm-slim AS dashboard
WORKDIR /app
# Manifests first for better layer caching.
COPY apps/dashboard/package.json apps/dashboard/package-lock.json ./
# The FontAwesome Pro packages need a registry token. It is provided as a build
# secret (never copied into a layer) and the .npmrc is removed after install.
RUN --mount=type=secret,id=fontawesome_token \
    sh -eux -c '\
      if [ -s /run/secrets/fontawesome_token ]; then \
        printf "@fortawesome:registry=https://npm.fontawesome.com/\n//npm.fontawesome.com/:_authToken=%s\n" \
          "$(cat /run/secrets/fontawesome_token)" > .npmrc ; \
      fi ; \
      npm ci ; \
      rm -f .npmrc'
COPY apps/dashboard/ ./
RUN npx ng build --configuration production
#  → /app/dist/dashboard/browser

# ── Stage 2: build the Rust spark-server ────────────────────────────
FROM rust:1-slim-bookworm AS server
WORKDIR /src
RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config \
 && rm -rf /var/lib/apt/lists/*
# Cache the dependency build: compile a stub against the real manifests first.
COPY apps/spark-server/Cargo.toml apps/spark-server/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
 && cargo build --release \
 && rm -rf src
COPY apps/spark-server/ ./
# Docker preserves the context files' mtimes, which can be older than the stub
# build above — cargo would then skip recompiling. Touch the real sources so the
# crate is actually rebuilt (deps stay cached).
RUN find src -name '*.rs' -exec touch {} + \
 && cargo build --release \
 && strip target/release/spark-server

# ── Stage 3: build the opkg feed (GL.iNet `bifrost` package + index) ─────
# Assembles the router .ipk (gzip-tar, no OpenWrt SDK needed) and the Packages
# index, so the server ships a ready-to-use feed at /bifrost/feed.
FROM debian:bookworm-slim AS feed
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash tar gzip coreutils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY scripts/build-feed.sh scripts/build-feed.sh
COPY apps/openwrt-client apps/openwrt-client
# Don't rely on the checked-out execute bit (Windows/git can drop it); set it.
RUN chmod +x scripts/build-feed.sh apps/openwrt-client/build-ipk.sh \
 && bash scripts/build-feed.sh
# → /src/apps/spark-server/feed/{bifrost_*.ipk, Packages, Packages.gz}

# ── Stage 4: runtime ────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /app bifrost
WORKDIR /app
COPY --from=server    /src/target/release/spark-server       /usr/local/bin/spark-server
COPY --from=dashboard /app/dist/dashboard/browser            /app/dashboard
COPY --from=feed      /src/apps/spark-server/feed            /app/feed

# Sensible in-container defaults; override any of these via the environment.
ENV BIFROST_BIND_ADDR=0.0.0.0 \
    BIFROST_API_PORT=8443 \
    BIFROST_DATABASE_URL=sqlite:///app/data/bifrost.db \
    BIFROST_DASHBOARD_DIR=/app/dashboard \
    BIFROST_FEED_DIR=/app/feed
# BIFROST_JWT_SECRET must be supplied at runtime (compose reads it from .env).

# The feed is baked into the image (rebuilt each `docker compose up --build`);
# only the database is a persistent volume.
# Pre-create the self-update trigger dir owned by bifrost, so a FRESH named volume
# mounted there inherits bifrost ownership (Docker seeds an empty volume from the
# image dir) and the non-root server can write the trigger file. Existing volumes
# are fixed at runtime by the updater sidecar (it chmods the shared dir on startup).
RUN mkdir -p /app/data /run/bifrost-update \
 && chown -R bifrost:bifrost /app /run/bifrost-update
USER bifrost
VOLUME ["/app/data"]
EXPOSE 8443
CMD ["spark-server"]
