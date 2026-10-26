#!/usr/bin/env bash
# A throwaway PostgreSQL 17 + pgvector for tests, run as an ordinary user (no root, no Docker). It stands in for the
# CI service container (pgvector/pgvector:pg17) on machines without Docker, e.g. the agents' server.
#
#   bash tools/pg-scratch.sh start    # download once, initdb once, start; prints the URL for PULSE_CI_DATABASE_URL
#   bash tools/pg-scratch.sh url      # print the URL
#   bash tools/pg-scratch.sh stop
#   bash tools/pg-scratch.sh status
#   bash tools/pg-scratch.sh bindir   # download once, print the binaries' directory (tools/ci-db-shards.py's RAM cluster)
#
# Binaries: the PGDG Ubuntu packages postgresql-17 and postgresql-17-pgvector, unpacked with dpkg-deb into
# $PULSE_PG_HOME (default ~/.cache/pulse-pg/17). Data: $PULSE_PG_DATA (default ~/.cache/pulse-pg/data, mode 0700).
# Unix socket only, inside the data directory: no TCP listener, so other local users cannot reach the trust-auth
# superuser (it could run COPY ... TO PROGRAM as this user). Port number $PULSE_PG_PORT (default 55432) names the
# socket. Throwaway data only: never point real data at it. Release gates use a private per-run cluster in RAM instead
# (PULSE_PG_TMPFS, tools/ci-db-shards.py); this shared disk server stays their fallback.
set -euo pipefail

PG_HOME=${PULSE_PG_HOME:-$HOME/.cache/pulse-pg/17}
PG_DATA=${PULSE_PG_DATA:-$HOME/.cache/pulse-pg/data}
PG_PORT=${PULSE_PG_PORT:-55432}
PGDG=https://apt.postgresql.org/pub/repos/apt
BIN=$PG_HOME/usr/lib/postgresql/17/bin
URL="postgresql://postgres@/pulse_ci?host=$PG_DATA&port=$PG_PORT"
ADMIN="postgresql://postgres@/postgres?host=$PG_DATA&port=$PG_PORT"
# Two CI runs (ea-heavy's two slots) of two db shards each (tools/ci-db-shards.py) need more than the old 50 connections.
MAX_CONNECTIONS=120
SOCKET_ONLY=(-o "-c listen_addresses='' -c unix_socket_directories='$PG_DATA' -c unix_socket_permissions=0700 -c port=$PG_PORT -c max_connections=$MAX_CONNECTIONS")

codename() { . /etc/os-release && echo "${VERSION_CODENAME:-noble}"; }

download() {
  [[ -x $BIN/postgres ]] && return 0
  command -v dpkg-deb >/dev/null || { echo "dpkg-deb not found (Debian/Ubuntu only)" >&2; exit 1; }
  local tmp index pkg file
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"; trap - RETURN' RETURN
  echo "downloading PostgreSQL 17 + pgvector (PGDG, $(codename)) into $PG_HOME"
  index=$tmp/Packages
  curl -fsSL "$PGDG/dists/$(codename)-pgdg/main/binary-amd64/Packages.gz" | gunzip >"$index"
  mkdir -p "$PG_HOME"
  for pkg in postgresql-17 postgresql-17-pgvector; do
    # The newest version of the package in the index (sort -V on the Version field).
    file=$(awk -v p="$pkg" '
      /^Package: /  { cur = $2 }
      /^Version: /  { ver = $2 }
      /^Filename: / { if (cur == p) print ver " " $2 }' "$index" | sort -V | tail -n 1 | cut -d' ' -f2)
    [[ -n $file ]] || { echo "$pkg not found in the PGDG index" >&2; exit 1; }
    curl -fsSL -o "$tmp/$pkg.deb" "$PGDG/$file"
    dpkg-deb -x "$tmp/$pkg.deb" "$PG_HOME"
    echo "  $(basename "$file")"
  done
}

running() { [[ -f $PG_DATA/postmaster.pid ]] && "$BIN/pg_ctl" -D "$PG_DATA" status >/dev/null 2>&1; }

start() {
  download
  if [[ ! -f $PG_DATA/PG_VERSION ]]; then
    mkdir -p "$(dirname "$PG_DATA")"
    "$BIN/initdb" -D "$PG_DATA" -U postgres --auth-local=trust --auth-host=reject -E UTF8 --locale=C.UTF-8 >/dev/null
    cat >>"$PG_DATA/postgresql.conf" <<EOF
jit = off
fsync = off
synchronous_commit = off
max_connections = 120
shared_buffers = 64MB
EOF
  fi
  chmod 0700 "$PG_DATA"
  if ! running; then
    "$BIN/pg_ctl" -D "$PG_DATA" -l "$PG_DATA/server.log" -w "${SOCKET_ONLY[@]}" start >/dev/null
  elif (( $(psql "$ADMIN" -XtAc "show max_connections" 2>/dev/null || echo "$MAX_CONNECTIONS") < MAX_CONNECTIONS )) &&
       [[ $(psql "$ADMIN" -XtAc "select count(*) from pg_stat_activity where backend_type = 'client backend'
                                  and pid <> pg_backend_pid()" 2>/dev/null) == 0 ]]; then
    # A server started before OPS-2 with 50 connections: restart it while nobody is connected.
    "$BIN/pg_ctl" -D "$PG_DATA" -l "$PG_DATA/server.log" -w -m fast "${SOCKET_ONLY[@]}" restart >/dev/null
  fi
  psql "$ADMIN" -XtAc "select 1 from pg_database where datname = 'pulse_ci'" | grep -q 1 \
    || psql "$ADMIN" -Xqc "create database pulse_ci"
  echo "$URL"
}

case ${1:-start} in
  start) start ;;
  url) echo "$URL" ;;
  stop) if running; then "$BIN/pg_ctl" -D "$PG_DATA" -m fast stop >/dev/null; fi; echo "stopped" ;;
  bindir) download >&2; echo "$BIN" ;;
  status) if running; then echo "running on socket $PG_DATA/.s.PGSQL.$PG_PORT ($("$BIN/postgres" --version))"; else echo "not running"; exit 3; fi ;;
  -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) echo "usage: $0 start|url|stop|status|bindir" >&2; exit 2 ;;
esac
