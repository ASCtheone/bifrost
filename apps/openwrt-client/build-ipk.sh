#!/usr/bin/env bash
# Build the Bifrost OpenWrt package (arch: all) without the OpenWrt SDK.
# The ipk is an `ar` archive of {debian-binary, control.tar.gz, data.tar.gz}.
#
# One package, named `bifrost`: the shell agent that fetches this router's config
# from the Bifrost master and writes it into GL.iNet's native WireGuard Client so
# it appears in the router's own VPN UI.
#
# Usage: ./build-ipk.sh [output-dir]
set -euo pipefail

VERSION=0.7.8
here="$(cd "$(dirname "$0")" && pwd)"
outdir="${1:-$here/dist}"
mkdir -p "$outdir"

assemble() { # assemble <workdir> <pkg> <version> <arch>
	local work="$1" pkg="$2" version="$3" arch="$4" ipk
	tar --owner=0 --group=0 -czf "$work/control.tar.gz" -C "$work/control" .
	tar --owner=0 --group=0 -czf "$work/data.tar.gz" -C "$work/data" .
	echo "2.0" >"$work/debian-binary"
	ipk="$outdir/${pkg}_${version}_${arch}.ipk"
	rm -f "$ipk"
	# opkg on OpenWrt/GL.iNet expects the .ipk to be a GZIP-COMPRESSED TAR of the
	# three members (the legacy ipkg format) — NOT an `ar` archive, which this
	# opkg rejects as "Malformed package file".
	( cd "$work" && tar --owner=0 --group=0 -czf "$ipk" ./debian-binary ./control.tar.gz ./data.tar.gz )
	echo "built: $ipk"
}

isize() { du -sk "$1" | awk '{print $1*1024}'; }

build_bifrost() {
	local w; w="$(mktemp -d)"
	mkdir -p "$w/data" "$w/control"
	cp -r "$here/files/." "$w/data/"
	chmod 0755 "$w/data/usr/bin/bifrost" "$w/data/etc/init.d/bifrost" "$w/data/www/bifrost/cgi-bin/bifrost"
	chmod 0644 "$w/data/etc/config/bifrost"
	cat >"$w/control/control" <<EOF
Package: bifrost
Version: $VERSION
Architecture: all
Maintainer: Bifrost
Section: net
Priority: optional
Installed-Size: $(isize "$w/data")
Depends: curl, jq, wireguard-tools, kmod-wireguard
Description: Bifrost VPN for GL.iNet/OpenWrt.
 Connects this router to your Bifrost VPN: fetches its config from the master and
 brings up a WireGuard client tunnel, routing the LAN through it with automatic
 node failover. Includes a built-in config page at http://<router>:8099/.
EOF
	printf '/etc/config/bifrost\n' >"$w/control/conffiles"
	cat >"$w/control/postinst" <<'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] && exit 0
chmod 0755 /usr/bin/bifrost /etc/init.d/bifrost /www/bifrost/cgi-bin/bifrost 2>/dev/null

# Allow LAN clients to reach the config-page port (8099).
if ! uci -q get firewall.bifrost_ui >/dev/null 2>&1; then
	uci set firewall.bifrost_ui=rule
	uci set firewall.bifrost_ui.name='Bifrost-UI'
	uci set firewall.bifrost_ui.src='lan'
	uci set firewall.bifrost_ui.proto='tcp'
	uci set firewall.bifrost_ui.dest_port='8099'
	uci set firewall.bifrost_ui.target='ACCEPT'
	uci commit firewall
	/etc/init.d/firewall reload >/dev/null 2>&1
fi

# Give the LAN bridge a second IP so the config page can own :80 there, and name
# it in dnsmasq (http://bifrost.lan/). Idempotent, and a no-op on a LAN it can't
# safely pick an address in — in which case the page is still on :8099.
/usr/bin/bifrost ui-setup 2>/dev/null

# The service launches its own uhttpd for the config page (GL.iNet's uhttpd
# won't run add-on instances), so just enable + start it.
/etc/init.d/bifrost enable 2>/dev/null
/etc/init.d/bifrost restart 2>/dev/null
echo "Bifrost config page:  $(/usr/bin/bifrost ui-url 2>/dev/null || echo 'http://<router-ip>:8099/')"
exit 0
EOF
	cat >"$w/control/prerm" <<'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] && exit 0
/etc/init.d/bifrost stop 2>/dev/null
/etc/init.d/bifrost disable 2>/dev/null
# Drop the :80 alias, its dnsmasq name, and its firewall-zone membership —
# otherwise removing the package would strand a second IP on the LAN bridge.
/usr/bin/bifrost ui-teardown 2>/dev/null
if uci -q get firewall.bifrost_ui >/dev/null 2>&1; then
	uci -q delete firewall.bifrost_ui
	uci commit firewall
	/etc/init.d/firewall reload >/dev/null 2>&1
fi
exit 0
EOF
	chmod 0755 "$w/control/postinst" "$w/control/prerm"
	assemble "$w" bifrost "$VERSION" all
	rm -rf "$w"
}

build_bifrost
echo "== package =="
ls -l "$outdir"/*.ipk
