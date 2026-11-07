#!/usr/bin/env bash
# CONSOLIDATION step 1 (docs/ops/CONSOLIDATION.md): the people inventory of every Pulse install, read only, run from the
# operator's own machine with the ssh aliases ea, wl and ac (each with passwordless sudo).
#
#   bash tools/consolidate/inventory-all.sh [owner e-mail] [owner name]
#
# One HMAC key for this run is made here, sent to each server on stdin with pulse-accounts.py, used inside a private
# directory in /dev/shm (memory) and removed with it; it is never printed and nothing stays on the servers. Each server
# answers with its inventory lines (keyed hashes and counts; the owner's own rows in full). The report then prints
# counts and duplicate groups only, and the key and the lines are deleted here too (KEEP=1 keeps them, mode 600).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OWNER_EMAIL=${1:-admin@atlascrest.example}
OWNER_NAME=${2:-savuzo}
PY=${PY:-python3}
# label  ssh-alias  how to reach psql there                      superuser
TARGETS=${TARGETS:-"ea ea docker_exec_-i_ea-postgres ea_admin
wl wl docker_exec_-i_wl-pulse-postgres-1 pulse_admin
ac-old ac docker_exec_-i_pulse-postgres-1 pulse_admin"}
W=$(mktemp -d)
chmod 700 "$W"
[ "${KEEP:-}" = 1 ] || trap 'rm -rf "$W"' EXIT
( umask 077; head -c 48 /dev/urandom | base64 | tr -d '\n' > "$W/inventory.key" )
cp "$HERE/pulse-accounts.py" "$W/pulse-accounts.py"
while read -r label host exec user; do
  [ -n "$label" ] || continue
  exec=${exec//_/ }
  echo "inventory $label (ssh $host) ..." >&2
  # shellcheck disable=SC2029
  tar -C "$W" -cf - pulse-accounts.py inventory.key | ssh "$host" "sudo -n bash -c '
    set -e; d=\$(mktemp -d -p /dev/shm); trap \"rm -rf \$d\" EXIT; tar -x -C \$d
    python3 \$d/pulse-accounts.py inventory --exec \"$exec\" --db-user $user --label $label --key-file \$d/inventory.key \
      --out \$d/inv.jsonl --owner-email \"$OWNER_EMAIL\" --owner-name \"$OWNER_NAME\" >&2
    cat \$d/inv.jsonl'" > "$W/inv-$label.jsonl"
  chmod 600 "$W/inv-$label.jsonl"
done <<<"$TARGETS"
"$PY" "$W/pulse-accounts.py" inventory-report "$W"/inv-*.jsonl
[ "${KEEP:-}" = 1 ] && echo "kept (delete when done): $W" >&2 || true
