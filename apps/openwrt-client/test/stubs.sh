#!/bin/sh
# Fake router commands for the agent tests. Each stub is an executable in
# $T/bin (prepended to PATH) whose state lives in plain files under $T:
#
#   $T/uci          key=value store (the only uci features the agent uses)
#   $T/up_hosts     WireGuard endpoints that answer a handshake (one per line)
#   $T/master       "up" | "down" | "partial" — how curl to the master behaves
#   $T/served.json  what the master returns for /provision/<token>
#   $T/calls        one line per ifup/ifdown/firewall call, for assertions
#   $T/log          everything the agent sent to logger
#
# The model that matters: while a WireGuard interface exists whose endpoint does
# NOT handshake, its 0.0.0.0/0 route black-holes the router's own traffic — so
# curl to the master fails, exactly like on the real router.

make_stubs() {
	mkdir -p "$T/bin"
	: >"$T/uci"; : >"$T/up_hosts"; : >"$T/calls"; : >"$T/log"; : >"$T/ipt"
	echo up >"$T/master"

	cat >"$T/bin/uci" <<'EOF'
#!/bin/sh
S="$T/uci"
[ "$1" = "-q" ] && shift
cmd=$1; shift
getv() { grep -m1 "^$1=" "$S" | cut -d= -f2-; }
case "$cmd" in
	get) v=$(getv "$1"); [ -n "$v" ] || grep -q "^$1=" "$S" || exit 1; printf '%s\n' "$v" ;;
	set) k=${1%%=*}; v=${1#*=}; grep -v "^$k=" "$S" >"$S.t"; mv "$S.t" "$S"; echo "$k=$v" >>"$S" ;;
	add_list) k=${1%%=*}; v=${1#*=}; echo "$k+=$v" >>"$S" ;;
	del_list) : ;;
	commit) : ;;
	add) id="cfg$2"; grep -v "^$1.$id[.=+]" "$S" >"$S.t"; mv "$S.t" "$S"; echo "$1.$id=$2" >>"$S"; echo "$id" ;;
	delete)
		case "$1" in
			*.@*\[0\])   # network.@wireguard_bifrost[0] → the first section of that type
				pkg=${1%%.*}; typ=${1#*.@}; typ=${typ%%[*}
				id=$(grep -m1 "^$pkg\.[^.=]*=$typ$" "$S" | cut -d= -f1 | cut -d. -f2)
				[ -n "$id" ] || exit 1
				grep -v "^$pkg\.$id[.=+]" "$S" >"$S.t"; mv "$S.t" "$S" ;;
			*)
				grep -q "^$1[.=+]" "$S" || exit 1
				grep -v "^$1[.=+]" "$S" >"$S.t"; mv "$S.t" "$S" ;;
		esac ;;
	show) cat "$S" ;;
esac
exit 0
EOF

	# wg: the interface exists iff network.bifrost is configured. What the kernel
	# shows lags netifd like on the real router: `ifup` queues the new peer, and the
	# first `wg` call after it still reports the OLD peer ($T/wg_live) — only then
	# does the queued one ($T/wg_pending) take over. A peer handshakes iff its
	# endpoint is listed in $T/up_hosts.
	#
	# Any other device is a probe interface made with `ip link add <dev> type
	# wireguard` + `wg set <dev> ... peer <key> endpoint <host:port>`; it handshakes
	# iff that endpoint is in $T/up_hosts. $T/probes records every probe made.
	cat >"$T/bin/wg" <<'EOF'
#!/bin/sh
if [ "${2:-}" != bifrost ]; then
	dev=$2
	[ -f "$T/link.$dev" ] || exit 1
	if [ "$1" = set ]; then
		ep=$(echo "$*" | sed -n 's/.* endpoint \([^ ]*\).*/\1/p')
		key=$(echo "$*" | sed -n 's/.* peer \([^ ]*\).*/\1/p')
		echo "$key ${ep%:*}" >"$T/link.$dev"; echo "${ep%:*}" >>"$T/probes"; exit 0
	fi
	live=$(cat "$T/link.$dev"); [ -n "$live" ] || exit 0
	key=${live%% *}; host=${live#* }
	if grep -qx "$host" "$T/up_hosts"; then echo "$key	$(date +%s)"; else echo "$key	0"; fi
	exit 0
fi
grep -q "^network.bifrost=" "$T/uci" || { rm -f "$T/wg_live" "$T/wg_pending"; exit 1; }
live=$(cat "$T/wg_live" 2>/dev/null)
[ -f "$T/wg_pending" ] && mv "$T/wg_pending" "$T/wg_live"
[ -n "$live" ] || exit 0
key=${live%% *}; host=${live#* }
# A live peer handshakes (timestamp kept per host, so a peer that dies keeps its
# LAST handshake time like the kernel does) and receives bytes on every look.
# With $T/idle present nothing arrives unless we send real data (see ping), like
# an idle WireGuard tunnel whose peer only answers keepalives with silence.
if grep -qx "$host" "$T/up_hosts"; then
	date +%s >"$T/hs.$host"
	[ -f "$T/idle" ] || echo $(( $(cat "$T/rx.$host" 2>/dev/null || echo 0) + 92 )) >"$T/rx.$host"
	# Passive keepalive owed for data we sent (see ping): it lands a few looks later,
	# like the peer's reply ~10 s after receiving data it had nothing to answer with.
	if [ -f "$T/owed" ]; then
		n=$(cat "$T/owed"); n=$((n - 1))
		if [ "$n" -le 0 ]; then rm -f "$T/owed"; echo $(( $(cat "$T/rx.$host" 2>/dev/null || echo 0) + 32 )) >"$T/rx.$host"
		else echo "$n" >"$T/owed"; fi
	fi
fi
case "$3" in
	latest-handshakes) echo "$key	$(cat "$T/hs.$host" 2>/dev/null || echo 0)" ;;
	transfer) echo "$key	$(cat "$T/rx.$host" 2>/dev/null || echo 0)	1000" ;;
	endpoints) echo "$key	$host:51820" ;;
esac
EOF

	cat >"$T/bin/ifup" <<'EOF'
#!/bin/sh
key=$(grep -m1 "^network\.cfgwireguard_bifrost\.public_key=" "$T/uci" | cut -d= -f2-)
host=$(grep -m1 "^network\.cfgwireguard_bifrost\.endpoint_host=" "$T/uci" | cut -d= -f2-)
echo "ifup $* $host" >>"$T/calls"
echo "$key $host" >"$T/wg_pending"
EOF
	printf '#!/bin/sh\necho "ifdown $*" >>"$T/calls"\n' >"$T/bin/ifdown"
	# ip link: `show bifrost` → exists while its uci interface does; other devices
	# are probe interfaces tracked as $T/link.<dev>.
	cat >"$T/bin/ip" <<'EOF'
#!/bin/sh
[ "$1" = link ] || exit 0
case "$2 ${3:-}" in
	"show bifrost") grep -q "^network.bifrost=" "$T/uci"; exit $? ;;
esac
case "$2" in
	add) [ -f "$T/link.$3" ] && exit 1; : >"$T/link.$3" ;;
	del|delete) [ -f "$T/link.$3" ] || exit 1; rm -f "$T/link.$3" ;;
	show) [ -f "$T/link.$3" ] || exit 1 ;;
esac
exit 0
EOF

	# curl: only the master fetch is modelled (-o <file>).
	cat >"$T/bin/curl" <<'EOF'
#!/bin/sh
out=""
while [ $# -gt 0 ]; do
	case "$1" in
		-o) out=$2; shift ;;
		-H) echo "$2" >>"$T/curl_headers"; shift ;;
	esac
	shift
done
if grep -q "^network.bifrost=" "$T/uci"; then
	host=$(grep -m1 "^network\.cfgwireguard_bifrost\.endpoint_host=" "$T/uci" | cut -d= -f2-)
	grep -qx "$host" "$T/up_hosts" || exit 7   # black-holed by the dead tunnel's default route
fi
case "$(cat "$T/master")" in
	up) [ -n "$out" ] && cp "$T/served.json" "$out"; exit 0 ;;
	partial) [ -n "$out" ] && printf '{"nod' >"$out"; exit 18 ;;
	*) exit 7 ;;
esac
EOF

	# iptables: only chain existence is modelled (-N/-X/-nL); rule checks always
	# miss, so the agent (re)inserts its jump — harmless for these tests.
	cat >"$T/bin/iptables" <<'EOF'
#!/bin/sh
S="$T/ipt"
case "$1" in
	-N) grep -qx "$2" "$S" && exit 1; echo "$2" >>"$S" ;;
	-X) grep -vx "$2" "$S" >"$S.t"; mv "$S.t" "$S" ;;
	-nL|-L) grep -qx "$2" "$S" || exit 1 ;;
	-C) exit 1 ;;
esac
exit 0
EOF

	# ping -I bifrost …: real data through the tunnel — a live peer answers (bytes in).
	cat >"$T/bin/ping" <<'EOF'
#!/bin/sh
live=$(cat "$T/wg_live" 2>/dev/null); host=${live#* }
[ -n "$live" ] && grep -qx "$host" "$T/up_hosts" || exit 1
# $T/no_icmp: the spark drops the ping — no reply now, only its passive keepalive later.
if [ -f "$T/no_icmp" ]; then echo 4 >"$T/owed"; exit 1; fi
echo $(( $(cat "$T/rx.$host" 2>/dev/null || echo 0) + 84 )) >"$T/rx.$host"
EOF
	printf '#!/bin/sh\nshift; echo "$*" >>"$T/log"\n' >"$T/bin/logger"
	# nslookup: no DNS in tests — the safe-mode whitelist just resolves to nothing.
	printf '#!/bin/sh\nexit 0\n' >"$T/bin/nslookup"
	printf '#!/bin/sh\nexit 0\n' >"$T/bin/sleep"
	chmod +x "$T/bin/"*
}
