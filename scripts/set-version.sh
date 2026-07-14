#!/usr/bin/env bash
# set-version.sh — set the single Bifrost version across every component, so the
# server, dashboard, spark, and GL.iNet package all move together.
#
# Usage: scripts/set-version.sh 0.3.0
set -euo pipefail

V="${1:-}"
[ -n "$V" ] || { echo "usage: scripts/set-version.sh <major.minor.patch>" >&2; exit 1; }
echo "$V" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "version must be major.minor.patch" >&2; exit 1; }

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

printf '%s\n' "$V" > VERSION

# Rust crates ([package] version is the only `version = ` at column 0).
sed -i "s/^version = \".*\"/version = \"$V\"/" apps/spark-server/Cargo.toml apps/spark/Cargo.toml
# Cargo.lock entries for our own crates.
sed -i "/name = \"spark-server\"/{n;s/^version = \".*\"/version = \"$V\"/;}" apps/spark-server/Cargo.lock
sed -i "/name = \"bifrost-spark\"/{n;s/^version = \".*\"/version = \"$V\"/;}" apps/spark/Cargo.lock

# JS packages (top-level "version").
sed -i "s/\"version\": *\"[^\"]*\"/\"version\": \"$V\"/" package.json apps/dashboard/package.json

# GL.iNet package + agent.
sed -i "s/^VERSION=.*/VERSION=$V/" apps/openwrt-client/build-ipk.sh
sed -i "s/^BIFROST_VERSION=.*/BIFROST_VERSION=$V/" apps/openwrt-client/files/usr/bin/bifrost

echo "Set version $V across:"
echo "  VERSION, spark-server, spark, dashboard, root package.json, openwrt ipk + agent"
echo "The server reports it at /bifrost/api/health; the router at its config page."
