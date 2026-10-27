#!/bin/sh
# Migrations may use the local/deploy owner URL; service processes and PID 1 must not retain those credentials.
set -eu
if [ "${1:-}" != "--services" ]; then
  if [ -n "${PULSE_DATABASE_URL_MIGRATE:-}${MIGRATE_DATABASE_URL:-}" ]; then
    pulse-migrate
  fi
  exec env -u PULSE_DATABASE_URL_MIGRATE -u MIGRATE_DATABASE_URL "$0" --services
fi

HOSTNAME=0.0.0.0 PORT=8080 node apps/web/server.js &
web=$!
HOST=127.0.0.1 PORT=8081 node services/api/dist/server.js &
api=$!
HOST=127.0.0.1 PORT="${PULSE_INGEST_PORT:-8082}" pulse-ingest &
ingest=$!
pulse-worker run --state /tmp/pulse-worker-state.json &
worker=$!
# Once production owns the data, deployments never replay the dev seed over company edits.
children="$web $api $ingest $worker"
if [ "${PULSE_BOOTSTRAP_ENABLED:-0}" = "1" ]; then
  pulse-ea-bootstrap --loop &
  backfill=$!
  children="$children $backfill"
fi
drive_backfill_enabled=${PULSE_DRIVE_BACKFILL_ENABLED:-${PULSE_BOOTSTRAP_ENABLED:-0}}
if [ "$drive_backfill_enabled" = "1" ] && [ -n "${EA_INDEX_DATABASE_URL:-}" ]; then
  pulse-drive-backfill --loop &
  drive_backfill=$!
  children="$children $drive_backfill"
elif [ "$drive_backfill_enabled" = "1" ]; then
  echo "pulse-drive-backfill not started: EA index connection is not configured" >&2
fi
# R44: the direct Drive changes feed reads only owner-approved roots, and only when switched on.
if [ "${PULSE_DRIVE_CHANGES:-0}" = "1" ]; then
  pulse-drive-changes run --loop &
  drive_changes=$!
  children="$children $drive_changes"
fi
# R45: document text from approved roots, only with a recorded content approval, and only when switched on.
if [ "${PULSE_DRIVE_EXTRACT:-0}" = "1" ]; then
  pulse-drive-extract run --loop &
  drive_extract=$!
  children="$children $drive_extract"
fi

stop_children() {
  for pid in $children; do kill "$pid" 2>/dev/null || true; done
  for pid in $children; do wait "$pid" 2>/dev/null || true; done
}
trap 'stop_children; exit 1' TERM INT
while kill -0 "$web" 2>/dev/null && kill -0 "$api" 2>/dev/null && \
      kill -0 "$ingest" 2>/dev/null && kill -0 "$worker" 2>/dev/null; do
  sleep 2
done
stop_children
exit 1
