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

VERSION=0.1.0-1
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
	( cd "$work" && ar rc "$ipk" debian-binary control.tar.gz data.tar.gz )
	echo "built: $ipk"
}

isize() { du -sk "$1" | awk '{print $1*1024}'; }

build_bifrost() {
	local w; w="$(mktemp -d)"
	mkdir -p "$w/data" "$w/control"
	cp -r "$here/files/." "$w/data/"
	chmod 0755 "$w/data/usr/bin/bifrost" "$w/data/etc/init.d/bifrost" "$w/data/www/cgi-bin/bifrost"
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
 configures WireGuard (integrating with GL.iNet's native WireGuard Client), with
 automatic node failover.
EOF
	printf '/etc/config/bifrost\n' >"$w/control/conffiles"
	cat >"$w/control/postinst" <<'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] && exit 0
chmod 0755 /usr/bin/bifrost /etc/init.d/bifrost /www/cgi-bin/bifrost 2>/dev/null
/etc/init.d/bifrost enable 2>/dev/null
echo "Bifrost installed. Open the config page:  http://<router-ip>/bifrost/"
exit 0
EOF
	cat >"$w/control/prerm" <<'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] && exit 0
/etc/init.d/bifrost stop 2>/dev/null
/etc/init.d/bifrost disable 2>/dev/null
exit 0
EOF
	chmod 0755 "$w/control/postinst" "$w/control/prerm"
	assemble "$w" bifrost "$VERSION" all
	rm -rf "$w"
}

build_bifrost
echo "== package =="
ls -l "$outdir"/*.ipk
