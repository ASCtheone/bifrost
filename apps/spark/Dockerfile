# syntax=docker/dockerfile:1.7
#
# The on-site Bifrost spark: adopts into the control plane and reconciles the
# local UniFi WireGuard server. Runs on any always-on box inside the customer
# network that can reach the UniFi controller. Outbound HTTPS only.
#
# Build context is apps/spark (self-contained crate):
#   docker build -t bifrost-spark apps/spark
# Run with a mounted config dir holding bifrost-spark.toml (+ spark-state.json):
#   docker run -v /etc/bifrost:/etc/bifrost bifrost-spark

# ── build ───────────────────────────────────────────────────────────
FROM rust:1-slim-bookworm AS build
WORKDIR /src
# Dependency cache layer.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
 && cargo build --release \
 && rm -rf src
COPY src ./src
# Touch sources so cargo rebuilds the crate (Docker preserves older mtimes that
# would otherwise let the stub build above satisfy the fingerprint check).
RUN find src -name '*.rs' -exec touch {} + \
 && cargo build --release \
 && strip target/release/bifrost-spark

# ── runtime ─────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /etc/bifrost bifrost
# The image binary is the seed source; the entrypoint copies it onto the volume and runs
# it from there, so a self-update (which replaces the volume copy) survives a recreate.
COPY --from=build /src/target/release/bifrost-spark /usr/local/bin/bifrost-spark
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
# State (node id/key) + the running binary + its backup all live on the volume.
ENV BIFROST_SPARK_CONFIG=/etc/bifrost/bifrost-spark.toml
ENV BIFROST_UPDATE_DIR=/etc/bifrost/bin
VOLUME ["/etc/bifrost"]
USER bifrost
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
