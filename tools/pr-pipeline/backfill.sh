#!/bin/bash
# PR-PIPELINE backfill, the root side (on the Pulse server): a pg_dump of the pr_* tables first, then the load.
#   sudo bash tools/pr-pipeline/backfill.sh <database> <harvest.json> <map.json> "<approver>" "<words>" [apply]
# Without "apply" it is a dry run (the script rolls back; nothing is written, no dump is needed).
set -euo pipefail
DB=${1:?database (pulse_dev, pulse_staging or pulse)}; H=${2:?harvest json}; M=${3:?map json}; APPROVER=${4:?approver}; WORDS=${5:?words}; MODE=${6:-dry}
HERE=$(cd "$(dirname "$0")" && pwd)
FREE=$(df -BG --output=avail / | tail -1 | tr -dc 0-9); echo "free=${FREE}G"; [ "$FREE" -ge 16 ] || { echo "REFUSED: under 16 GiB free"; exit 2; }
ARGS=(--harvest "$H" --map "$M" --approver "$APPROVER" --words "$WORDS")
python3 "$HERE/backfill.py" "${ARGS[@]}" --summary
if [ "$MODE" = apply ]; then
  B=/var/backups/pulse/pr-pipeline; mkdir -p $B; chmod 700 $B
  F=$B/$DB-pr-tables-$(date -u +%Y%m%dT%H%M%SZ).dump
  docker exec ea-postgres pg_dump -U ea_admin -d "$DB" -Fc -t 'pulse.pr_*' -t pulse_priv.platform_audit > "$F"
  chmod 600 "$F"; ls -la "$F"; [ -s "$F" ] || { echo "REFUSED: empty backup"; exit 2; }
  ARGS+=(--apply)
fi
python3 "$HERE/backfill.py" "${ARGS[@]}" | docker exec -i ea-postgres psql -U ea_admin -d "$DB" -X -At -v ON_ERROR_STOP=1
