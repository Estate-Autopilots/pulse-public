#!/usr/bin/env bash
# Database checks for CI (called by tools/ci.sh when db/migrations has SQL and PULSE_CI_DATABASE_URL is set):
# the migrations apply to an empty database and the Event Core acceptance suite passes (tests/core).
#
#   PULSE_CI_DATABASE_URL=postgresql://postgres@localhost:5432/pulse_ci bash tools/ci-db.sh
#
# PULSE_CI_DATABASE_URL: a THROWAWAY PostgreSQL 17 + pgvector database, superuser (GitHub Actions service
# container; locally `bash tools/pg-scratch.sh start`). The suite drops and recreates the Pulse schemas in it and
# connects as each service login (pulse_*_login) so row-level security applies as in production. Never printed.
# With a superuser (OPS-2) the suite runs in two shards side by side, each on a fresh copy of a migrated template
# database that later runs reuse (tools/ci-db-shards.py; PULSE_CI_DB_SHARDS=1 for one). PULSE_CI_PYTEST_ARGS: extra
# pytest arguments. PULSE_PG_TMPFS=1: the shards use a private PostgreSQL in RAM for this run instead (EST-1575).
set -euo pipefail
export PULSE_CI=1
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
[[ -n ${PULSE_CI_DATABASE_URL:-} ]] || { echo "PULSE_CI_DATABASE_URL is not set" >&2; exit 2; }
# The suite needs a superuser, or a login that may SET ROLE to the Pulse roles in a database that has the vector
# extension (root's pulse_ci). If the configured database cannot host it yet, a local run uses the scratch server.
usable=$(psql "$PULSE_CI_DATABASE_URL" -XAtc "select (select rolsuper from pg_roles where rolname = current_user)
           or exists (select 1 from pg_extension where extname = 'vector')" 2>/dev/null || echo f)
if [[ $usable != t && ${GITHUB_ACTIONS:-} != true && -f tools/pg-scratch.sh ]]; then
  echo "note: the configured CI database cannot host the suite (no vector extension, not a superuser: a root step);"
  echo "      using the user-level scratch PostgreSQL 17 (tools/pg-scratch.sh) for this run"
  if scratch=$(bash tools/pg-scratch.sh start 2>/dev/null | tail -n 1) && [[ $scratch == postgresql://* ]]; then
    export PULSE_CI_DATABASE_URL=$scratch PULSE_CI_FRESH_DB=1
  fi
fi
lock=()
[[ -f uv.lock ]] && lock=(--locked)
super=$(psql "$PULSE_CI_DATABASE_URL" -XAtc "select rolsuper from pg_roles where rolname = current_user" 2>/dev/null || echo f)
if [[ $super == t ]]; then
  exec uv run --all-packages "${lock[@]}" python tools/ci-db-shards.py
fi
if [[ ${PULSE_CI_FRESH_DB:-0} == 1 ]]; then
  # One database per run on the shared scratch server, so parallel runs (several lanes) never collide. The URL
  # names pulse_ci; the run database replaces it (works for host:port and socket URLs).
  base_url=$PULSE_CI_DATABASE_URL
  db="pulse_ci_run_$(date +%s)_$$"
  psql "$base_url" -Xqc "create database $db" >/dev/null
  trap 'psql "$base_url" -Xqc "drop database if exists $db with (force)" >/dev/null 2>&1 || true' EXIT
  export PULSE_CI_DATABASE_URL=${base_url/\/pulse_ci/\/$db}
fi
# shellcheck disable=SC2086  # PULSE_CI_PYTEST_ARGS is a list of arguments
uv run --all-packages "${lock[@]}" pytest tests/core -q -p no:cacheprovider -W ignore::DeprecationWarning ${PULSE_CI_PYTEST_ARGS:-}
