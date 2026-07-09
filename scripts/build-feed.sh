#!/usr/bin/env bash
# Build the OpenWrt package(s) and generate the opkg feed the master serves at
# /feed. After running this, a GL.iNet/OpenWrt router that added the master as a
# package source can `opkg update && opkg install bifrost-vpn`.
#
# Usage: scripts/build-feed.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
feed="$root/apps/spark-server/feed"
mkdir -p "$feed"

echo "== building bifrost-vpn .ipk =="
"$root/apps/openwrt-client/build-ipk.sh" "$feed"

echo "== generating Packages index =="
cd "$feed"
: >Packages
for ipk in *.ipk; do
	[ -e "$ipk" ] || continue
	tmp="$(mktemp -d)"
	( cd "$tmp" && ar x "$feed/$ipk" control.tar.gz && tar xzf control.tar.gz ./control )
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
