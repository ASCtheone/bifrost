#!/bin/sh
# Agent failover tests. Runs the real /usr/bin/bifrost functions against fake
# router commands (see stubs.sh). POSIX sh — run with dash, bash or busybox ash:
#
#   sh apps/openwrt-client/test/agent_test.sh
#
# Scenario fixture: HOME is the primary (endpoint 10.0.0.1), APT the secondary
# (10.0.0.2). Which endpoints answer is set per test via $T/up_hosts.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
AGENT="$HERE/../files/usr/bin/bifrost"
. "$HERE/stubs.sh"

HOME_IP=10.0.0.1
APT_IP=10.0.0.2
pass=0
fail=0

wg_conf() {  # wg_conf <endpoint ip>
	printf '[Interface]\\nPrivateKey = cHJpdg==\\nAddress = 192.168.3.248/32\\n\\n[Peer]\\nPublicKey = cHVi%s\\nEndpoint = %s:51820\\nAllowedIPs = 0.0.0.0/0\\n' "$1" "$1"
}

provision_json() {
	printf '{"nodes":[{"nodeId":"node-apt","name":"APT","role":"secondary","wgConfig":"%s"},{"nodeId":"node-home","name":"HOME","role":"primary","wgConfig":"%s"}],"pendingAction":null,"latestVersion":null}\n' \
		"$(wg_conf "$APT_IP")" "$(wg_conf "$HOME_IP")"
}

# Fresh sandbox + the agent's functions loaded into this (sub)shell.
setup() {
	# $T is created (and removed) by run()
	make_stubs
	PATH="$T/bin:$PATH"; export PATH
	provision_json >"$T/served.json"
	cat >>"$T/uci" <<-EOF
		bifrost.settings=settings
		bifrost.settings.provision_token=tok
		bifrost.settings.location=auto
		bifrost.settings.enabled=1
		bifrost.settings.route_lan=0
		bifrost.settings.killswitch=0
		network.lan.device=br-lan
	EOF
	BIFROST_SOURCED=1 BIFROST_STATE_DIR="$T/state" BIFROST_UPDATE_DIR="$T/upd"
	export BIFROST_SOURCED BIFROST_STATE_DIR BIFROST_UPDATE_DIR
	. "$AGENT"
}

answers() { printf '%s\n' "$@" >"$T/up_hosts"; }
endpoint() { grep -m1 '^network\.cfgwireguard_bifrost\.endpoint_host=' "$T/uci" | cut -d= -f2-; }
tunnel_configured() { grep -q '^network.bifrost=' "$T/uci"; }
not() { ! "$@"; }
ifups() { grep -c '^ifup' "$T/calls"; }

check() {  # check <description> <command...>
	local desc=$1; shift
	if "$@"; then return 0; fi
	echo "    assertion failed: $desc"
	return 1
}

run() {  # run <test function>
	T=$(mktemp -d); export T
	if ( setup; "$1" ); then
		pass=$((pass + 1)); echo "ok   $1"
	else
		fail=$((fail + 1)); echo "FAIL $1"
	fi
	rm -rf "$T"
}

# ── tests ───────────────────────────────────────────────────────

# Baseline: primary down → auto fails over to the secondary.
test_failover_to_secondary() {
	answers "$APT_IP"
	connect || { echo "    connect failed"; return 1; }
	check "on APT" [ "$(endpoint)" = "$APT_IP" ] &&
	check "current node is APT" [ "$(cat "$CURNODE")" = node-apt ] &&
	check "healthy" healthy
}

# The bug seen on the BE10000: the periodic return-to-primary replaced the working
# secondary tunnel with the dead primary and left it there.
test_return_to_dead_primary_keeps_secondary() {
	answers "$APT_IP"
	connect || return 1
	maybe_return_primary
	check "still on APT after a failed primary probe" [ "$(endpoint)" = "$APT_IP" ] &&
	check "still healthy" healthy &&
	check "current node unchanged" [ "$(cat "$CURNODE")" = node-apt ]
}

# A dead primary shouldn't be re-probed (and the tunnel bounced) every refresh.
test_return_to_primary_backs_off() {
	answers "$APT_IP"
	connect || return 1
	maybe_return_primary
	before=$(ifups)
	maybe_return_primary
	check "no second probe inside the back-off window" [ "$(ifups)" -eq "$before" ]
}

# The periodic refresh (connect() while healthy) must stay on the current node —
# returning to the primary is maybe_return_primary's job, with its back-off.
test_refresh_while_healthy_stays_put() {
	answers "$APT_IP"
	connect || return 1
	before=$(ifups)
	connect
	check "tunnel not bounced" [ "$(ifups)" -eq "$before" ] &&
	check "still on APT" [ "$(endpoint)" = "$APT_IP" ]
}

# Probing a dead primary must not touch the live tunnel at all (seen live: every
# probe cost LAN clients ~15-20 s of outage).
test_dead_primary_probe_is_seamless() {
	answers "$APT_IP"
	connect || return 1
	before=$(ifups)
	maybe_return_primary
	check "primary was probed" grep -qx "$HOME_IP" "$T/probes" &&
	check "live tunnel untouched" [ "$(ifups)" -eq "$before" ] &&
	check "probe interface cleaned up" not ls "$T"/link.* >/dev/null 2>&1
}

# Once the primary is back, return-to-primary still works (after the back-off).
test_returns_to_primary_when_it_recovers() {
	answers "$APT_IP"
	connect || return 1
	answers "$APT_IP" "$HOME_IP"
	maybe_return_primary
	check "back on HOME" [ "$(endpoint)" = "$HOME_IP" ] &&
	check "current node is HOME" [ "$(cat "$CURNODE")" = node-home ]
}

# Deadlock seen on the router: a dead tunnel black-holes the router's own traffic,
# so fetching config from the master fails and connect() never tried a node.
test_connect_recovers_from_dead_tunnel() {
	answers "$APT_IP"
	apply_wg_node_ip "$HOME_IP"          # dead tunnel in place (as after the bug)
	check "precondition: master unreachable" not curl -o "$T/x" http://master
	connect
	check "recovered onto APT" [ "$(endpoint)" = "$APT_IP" ] &&
	check "healthy" healthy
}

# Master down but a previous provision is cached → still connect from the cache.
test_connect_uses_cached_config_when_master_down() {
	answers "$APT_IP"
	connect || return 1
	teardown
	echo down >"$T/master"
	connect
	check "connected from cached config" healthy &&
	check "on APT" [ "$(endpoint)" = "$APT_IP" ]
}

# A failed/partial download must not clobber the cached provision.
test_failed_fetch_keeps_cache() {
	fetch_config || return 1
	echo partial >"$T/master"
	fetch_config
	check "cache still valid JSON with nodes" jq -e '.nodes | length == 2' "$RESP" >/dev/null
}

# Every node down → don't leave a dead tunnel black-holing the router's WAN.
test_all_nodes_down_leaves_no_blackhole() {
	answers
	connect
	check "no WireGuard interface left configured" not tunnel_configured
}

# `bifrost down` must take effect immediately, not whenever the daemon gets to it.
test_down_tears_down_immediately() {
	answers "$APT_IP"
	connect || return 1
	cmd_down
	check "tunnel removed" not tunnel_configured &&
	check "disabled" [ "$(cfg_get enabled)" = 0 ]
}

# The kill switch must not log "released" every 5 s when it was never engaged.
test_killswitch_off_is_quiet_when_not_engaged() {
	apply_killswitch; apply_killswitch; apply_killswitch
	check "no log spam" [ "$(grep -c 'kill switch released' "$T/log")" -eq 0 ]
}

# Seen live: right after ifup the kernel still shows the previous peer's handshake,
# which made a switch to a dead node look successful ("connected via HOME").
test_switch_waits_for_the_new_peer() {
	answers "$APT_IP"
	connect || return 1
	home=$(jq -r '.nodes | to_entries | map(select(.value.role == "primary")) | .[0].key' "$RESP")
	check "dead node is not reported as up" not bring_up "$home"
}

# `bifrost down` from the web UI while the daemon is mid-connect: stop, don't
# bring another node up.
test_connect_stops_when_disabled() {
	answers "$APT_IP" "$HOME_IP"
	cfg_set enabled 0
	connect
	check "nothing brought up" not tunnel_configured
}

# Safe mode (e.g. an `unlock` pushed with the config) must win over connecting.
test_connect_respects_safe_mode() {
	answers "$APT_IP"
	cfg_set safe_mode 1
	connect
	check "tunnel stays down in safe mode" not tunnel_configured
}

# A damaged back-off file must not crash the daemon (ash exits on bad arithmetic).
test_corrupt_backoff_is_ignored() {
	answers "$APT_IP"
	connect || return 1
	echo "garbage x" >"$PRIMARY_BACKOFF"
	( maybe_return_primary ) || { echo "    maybe_return_primary exited non-zero"; return 1; }
	check "still on APT" [ "$(endpoint)" = "$APT_IP" ]
}

# Self-update health gate: must get through to the master even if a dead tunnel is
# configured (otherwise a good update gets rolled back).
test_health_gate_clears_dead_tunnel() {
	answers "$APT_IP"
	fetch_config || return 1
	apply_wg_node_ip "$HOME_IP"
	check "update judged healthy" health_gate
}

# Seen live: a dead tunnel was only noticed ~100 s later, because the last
# handshake stays "fresh" for up to 180 s. No bytes received for RX_STALL_MAX
# seconds must count as dead, even though the handshake still looks recent.
test_dead_tunnel_detected_by_rx_stall() {
	answers "$APT_IP"
	connect || return 1
	check "healthy while receiving" healthy || return 1
	answers                                    # APT dies
	read -r bytes _ <"$RXSTATE"
	echo "$bytes $(( $(date +%s) - RX_STALL_MAX - 5 ))" >"$RXSTATE"   # …a while ago
	check "precondition: handshake still recent" [ "$(handshake_age)" != none ] &&
	check "dead tunnel reported unhealthy" not healthy
}

# …but an idle-looking yet receiving tunnel is fine, however old the last sample.
test_receiving_tunnel_stays_healthy() {
	answers "$APT_IP"
	connect || return 1
	healthy || return 1
	read -r bytes _ <"$RXSTATE"
	echo "$bytes $(( $(date +%s) - RX_STALL_MAX - 5 ))" >"$RXSTATE"
	check "still healthy (bytes arriving)" healthy
}

# An idle tunnel receives nothing back for its keepalives — that alone must not
# look dead (it would flap). Real data (a ping through it) settles it.
test_idle_tunnel_is_not_mistaken_for_dead() {
	answers "$APT_IP"
	connect || return 1
	healthy || return 1
	: >"$T/idle"
	read -r bytes _ <"$RXSTATE"
	echo "$bytes $(( $(date +%s) - RX_STALL_MAX - 5 ))" >"$RXSTATE"
	check "idle but alive tunnel is healthy" healthy
}

# While the primary is known dead (in back-off), failover tries the others first —
# no ~15 s wasted on the dead primary before recovering.
test_failover_skips_primary_in_backoff() {
	answers "$APT_IP"
	connect || return 1
	maybe_return_primary                        # HOME dead → back-off recorded
	answers                                     # APT drops out too…
	teardown
	answers "$APT_IP"                           # …and comes back
	: >"$T/calls"
	connect
	check "first attempt goes to APT" [ "$(grep -m1 '^ifup' "$T/calls" | awk '{print $3}')" = "$APT_IP" ] &&
	check "connected" healthy
}

# Review finding: if the spark drops the ping, its only answer is a passive keepalive
# ~10 s later. Declaring the tunnel dead before it lands would reconnect forever.
test_ping_dropped_but_tunnel_alive_is_healthy() {
	answers "$APT_IP"
	connect || return 1
	healthy || return 1
	: >"$T/idle"; : >"$T/no_icmp"
	read -r bytes _ <"$RXSTATE"
	echo "$bytes $(( $(date +%s) - RX_STALL_MAX - 5 ))" >"$RXSTATE"
	check "alive tunnel with ICMP dropped is healthy" healthy
}

# A probe device left over from an interrupted probe (agent killed mid-probe) must
# be cleaned up — it would fight the real tunnel for the same server session.
test_leftover_probe_device_is_removed() {
	answers "$APT_IP"
	: >"$T/link.$PROBE_DEV"
	connect || return 1
	check "stale probe device removed" [ ! -f "$T/link.$PROBE_DEV" ]
}

# The back-off belongs to one primary: after the provision names a different
# primary, a leftover file must not demote the new one.
test_backoff_ignored_for_a_different_primary() {
	answers "$APT_IP"
	fetch_config || return 1
	echo "$(( $(date +%s) + 3600 )) 3 node-somebody-else" >"$PRIMARY_BACKOFF"
	check "new primary not demoted" not primary_backed_off
}

# The point of the app: never give up. Safe mode the watchdog engaged must lift by
# itself as soon as any node answers again — not wait for someone to press resume.
test_watchdog_safe_mode_lifts_when_a_node_answers() {
	answers
	fetch_config || return 1
	safe_on watchdog
	answers "$APT_IP"
	safe_recover
	check "safe mode released" [ "$(cfg_get safe_mode)" != 1 ] &&
	connect &&
	check "back on a tunnel" healthy &&
	check "on APT" [ "$(endpoint)" = "$APT_IP" ]
}

# …and while every node is still down it stays put, with no tunnel black-holing WAN.
test_watchdog_safe_mode_holds_while_all_down() {
	answers
	fetch_config || return 1
	safe_on watchdog
	not safe_recover &&
	check "still in safe mode" [ "$(cfg_get safe_mode)" = 1 ] &&
	check "no tunnel configured" not tunnel_configured
}

# Recovery must probe with a FRESH config: a spark that failed because its endpoint
# changed comes back under its new address, not the cached dead one.
test_watchdog_recovery_picks_up_new_config() {
	answers
	fetch_config || return 1
	safe_on watchdog
	APT_IP=10.0.0.3; provision_json >"$T/served.json"   # APT moved
	answers "$APT_IP"
	safe_recover
	check "safe mode released via the new endpoint" [ "$(cfg_get safe_mode)" != 1 ]
}

# A manual unlock (router UI / dashboard) is a deliberate choice — never auto-lifted.
test_manual_unlock_is_not_auto_released() {
	answers "$APT_IP"
	fetch_config || return 1
	safe_on
	not safe_recover &&
	check "still in safe mode" [ "$(cfg_get safe_mode)" = 1 ]
}

# Health check: the router reports, per spark, whether its last attempt handshook.
test_handshake_results_are_recorded_per_node() {
	answers "$APT_IP"
	connect || return 1
	check "HOME recorded as failed" grep -q '^node-home fail ' "$NODES_REPORT" &&
	check "APT recorded as ok" grep -q '^node-apt ok ' "$NODES_REPORT" &&
	check "one line per node" [ "$(grep -c '^node-home ' "$NODES_REPORT")" -eq 1 ]
}

# …a side probe counts too, and replaces the node's earlier result.
test_probe_result_replaces_earlier_report() {
	answers "$APT_IP"
	connect || return 1
	answers "$APT_IP" "$HOME_IP"
	maybe_return_primary
	check "HOME now ok" grep -q '^node-home ok ' "$NODES_REPORT" &&
	check "still one line for HOME" [ "$(grep -c '^node-home ' "$NODES_REPORT")" -eq 1 ]
}

# The header sends ages (the router's clock may be wrong), id=state:age, comma-joined.
test_node_report_header_format() {
	now=$(date +%s)
	printf 'node-home fail %s\nnode-apt ok %s\n' "$((now - 30))" "$now" >"$NODES_REPORT"
	h=$(node_reports_header)
	check "header format ($h)" expr "$h" : 'node-home=fail:3[01],node-apt=ok:[01]$' >/dev/null
}

# `bifrost check`: one line per spark, primary first, without disturbing the tunnel.
test_check_reports_each_spark() {
	answers "$APT_IP"
	connect || return 1
	before=$(ifups)
	out=$(cmd_check)
	check "HOME fails ($out)" expr "$out" : '.*HOME.*FAIL' >/dev/null &&
	check "APT ok, as the live tunnel" expr "$out" : '.*APT.*ok (current tunnel)' >/dev/null &&
	check "live tunnel untouched" [ "$(ifups)" -eq "$before" ] &&
	check "non-zero exit when a spark fails" not cmd_check >/dev/null
}

# Which spark are we on? `bifrost status` names it, and the master is told.
test_current_location_is_shown_and_reported() {
	answers "$APT_IP"
	connect || return 1
	check "status names the spark" expr "$(cmd_status)" : '.*connected to: APT (secondary)' >/dev/null &&
	check "reported to the master" [ "$(current_node_header)" = node-apt ]
}

# Down (or in safe mode) → report nothing, not the last node we were on.
test_no_current_location_when_down() {
	answers "$APT_IP"
	connect || return 1
	teardown
	check "nothing reported when down" [ -z "$(current_node_header)" ] &&
	check "status says not connected" expr "$(cmd_status)" : '.*connected to: none' >/dev/null
}

# A failover tells the master right away, not at the next 5-minute refresh.
test_switching_node_reports_immediately() {
	answers "$APT_IP"
	connect || return 1
	: >"$T/curl_headers"
	answers "$HOME_IP"; teardown
	connect || return 1
	check "master told about HOME after the switch" grep -q 'X-Bifrost-Current: node-home' "$T/curl_headers"
}

# Test helper: configure a tunnel to <ip> directly (simulates a leftover dead tunnel).
apply_wg_node_ip() {
	mkdir -p "$STATE_DIR"
	printf '%b' "$(wg_conf "$1")" >"$T/dead.conf"
	apply_wg "$T/dead.conf"
}

for t in \
	test_failover_to_secondary \
	test_return_to_dead_primary_keeps_secondary \
	test_return_to_primary_backs_off \
	test_refresh_while_healthy_stays_put \
	test_dead_primary_probe_is_seamless \
	test_returns_to_primary_when_it_recovers \
	test_connect_recovers_from_dead_tunnel \
	test_connect_uses_cached_config_when_master_down \
	test_failed_fetch_keeps_cache \
	test_all_nodes_down_leaves_no_blackhole \
	test_down_tears_down_immediately \
	test_killswitch_off_is_quiet_when_not_engaged \
	test_switch_waits_for_the_new_peer \
	test_connect_stops_when_disabled \
	test_connect_respects_safe_mode \
	test_corrupt_backoff_is_ignored \
	test_health_gate_clears_dead_tunnel \
	test_dead_tunnel_detected_by_rx_stall \
	test_receiving_tunnel_stays_healthy \
	test_idle_tunnel_is_not_mistaken_for_dead \
	test_failover_skips_primary_in_backoff \
	test_ping_dropped_but_tunnel_alive_is_healthy \
	test_leftover_probe_device_is_removed \
	test_backoff_ignored_for_a_different_primary \
	test_watchdog_safe_mode_lifts_when_a_node_answers \
	test_watchdog_safe_mode_holds_while_all_down \
	test_watchdog_recovery_picks_up_new_config \
	test_manual_unlock_is_not_auto_released \
	test_handshake_results_are_recorded_per_node \
	test_probe_result_replaces_earlier_report \
	test_node_report_header_format \
	test_check_reports_each_spark \
	test_current_location_is_shown_and_reported \
	test_no_current_location_when_down \
	test_switching_node_reports_immediately
do
	run "$t"
done

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
