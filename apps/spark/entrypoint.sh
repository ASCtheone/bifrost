#!/bin/sh
# Bifrost spark container entrypoint.
#
# The binary runs from the persisted /etc/bifrost volume (not the image), so a self-update
# survives a container recreate. On first run we seed it from the image. After an update —
# marked by .update-pending — we health-gate the new binary: it must write .healthy (which
# the spark does on its first successful heartbeat) within the window, or we roll back to
# the single backup. Nothing here trusts the network; the spark already verified the
# download's checksum before staging it.
set -eu

BINDIR="${BIFROST_UPDATE_DIR:-/etc/bifrost/bin}"
BIN="$BINDIR/bifrost-spark"
BAK="$BIN.bak"
SEED="/usr/local/bin/bifrost-spark"
HEALTHY="$BINDIR/.healthy"
PENDING="$BINDIR/.update-pending"
GATE_TRIES="${BIFROST_HEALTH_TRIES:-60}"   # x2s ≈ 120s to prove healthy

mkdir -p "$BINDIR"
# Seed the volume binary from the image on first run (or if it went missing).
if [ ! -x "$BIN" ]; then
	cp "$SEED" "$BIN"
	chmod +x "$BIN"
fi

# Fresh health marker each start; the running spark re-creates it once it heartbeats.
rm -f "$HEALTHY"

if [ -f "$PENDING" ]; then
	echo "bifrost: update pending — health-gating the new binary" >&2
	"$BIN" &
	pid=$!
	ok=0
	i=0
	while [ "$i" -lt "$GATE_TRIES" ]; do
		if [ -f "$HEALTHY" ]; then ok=1; break; fi
		kill -0 "$pid" 2>/dev/null || break   # the new binary died
		i=$((i + 1))
		sleep 2
	done
	# End the trial run either way; we re-exec the chosen binary as PID 1 below.
	kill "$pid" 2>/dev/null || true
	wait "$pid" 2>/dev/null || true
	if [ "$ok" = "1" ]; then
		echo "bifrost: update healthy — committed" >&2
		rm -f "$PENDING"
	else
		echo "bifrost: update failed its health check — rolling back to the backup" >&2
		if [ -x "$BAK" ]; then
			cp "$BAK" "$BIN"
			chmod +x "$BIN"
			rm -f "$BAK"
		fi
		rm -f "$PENDING"
	fi
fi

exec "$BIN"
