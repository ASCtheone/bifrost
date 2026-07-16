#!/bin/sh
# Bifrost updater sidecar.
#
# The ONLY component with Docker-socket access. It watches a shared trigger file that the
# control plane writes when an admin clicks "Update dashboard", then pulls the latest
# server image and recreates it via docker compose. Keeping this out of the control plane
# means the internet-facing service never holds host-level privilege.
set -eu

TRIGGER="${BIFROST_UPDATE_TRIGGER:-/run/bifrost-update/request}"
PROJECT_DIR="${BIFROST_COMPOSE_DIR:-/compose}"
SERVICE="${BIFROST_SERVICE:-server}"

mkdir -p "$(dirname "$TRIGGER")"
echo "bifrost-updater: watching $TRIGGER (service=$SERVICE, dir=$PROJECT_DIR, project=${COMPOSE_PROJECT_NAME:-<compose-dir default>})"

while :; do
	if [ -f "$TRIGGER" ]; then
		rm -f "$TRIGGER"
		echo "bifrost-updater: update requested — pulling + recreating '$SERVICE'"
		if (cd "$PROJECT_DIR" && docker compose pull "$SERVICE" && docker compose up -d "$SERVICE"); then
			echo "bifrost-updater: update applied"
		else
			echo "bifrost-updater: update failed" >&2
		fi
	fi
	sleep 5
done
