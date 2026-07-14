#!/usr/bin/env bash
# Build the OpenWrt package(s) and generate an opkg feed: the .ipk plus the
# Packages/Packages.gz index. A GL.iNet/OpenWrt router that adds the feed as a
# package source can then `opkg update && opkg install bifrost`.
#
# The feed is served from two places, both built by this script:
#   • the master itself, at /bifrost/feed (baked into the server image)
#   • GitHub Releases, published by CI (see .github/workflows/ci.yml)
#
# Usage: scripts/build-feed.sh [output-dir]
#   Defaults to apps/spark-server/feed, which is what the Dockerfile bakes in.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
feed="${1:-$root/apps/spark-server/feed}"
mkdir -p "$feed"
feed="$(cd "$feed" && pwd)"

echo "== building bifrost-vpn .ipk =="
"$root/apps/openwrt-client/build-ipk.sh" "$feed"

echo "== generating Packages index =="
cd "$feed"
: >Packages
for ipk in *.ipk; do
	[ -e "$ipk" ] || continue
	tmp="$(mktemp -d)"
	# The ipk is a gzip'd tar of {debian-binary, control.tar.gz, data.tar.gz};
	# pull control.tar.gz out of it, then extract the control file.
	( cd "$tmp" && gzip -dc "$feed/$ipk" | tar xf - ./control.tar.gz && tar xzf control.tar.gz ./control )
	size="$(wc -c <"$ipk" | tr -d ' ')"
	sha="$(sha256sum "$ipk" | awk '{print $1}')"
	{
		cat "$tmp/control"
		echo "Filename: $ipk"
		echo "Size: $size"
		echo "SHA256sum: $sha"
		echo ""
	} >>Packages
	rm -rf "$tmp"
done

gzip -kf Packages
echo "== feed ready at $feed =="
ls -l "$feed"
