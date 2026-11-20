#!/bin/bash
# QA-2 (QA system stage 1, steps 6, 7, 8b): the Vitals night on dev, 21:00 to 01:00 UTC (vitals-qa-night.timer).
#   1. the role walk, 8 roles (role-walk.mjs; browser on nivi)        -> $N/walk/
#   2. the three journeys: chat, call (audio, direct and relay), quote -> $N/journeys/
#   3. the night matrix until 01:00 UTC on the screens the walk opened -> $N/matrix.json
#   beside it: the night's AI employee task set (ai-task-set.py --rotate: one set a night, in turn; no browser)
#                                                                       -> $N/ai-tasks/
# The morning ledger (qa-ledger.py, vitals-qa-ledger.timer 01:30 UTC) reads $N. Everything runs as eadev from the
# checkout this script is in (strike, dev/live); the browser work goes to nivi's shared slots.
set -uo pipefail
export HOME=/home/eadev PATH=/home/eadev/.local/opt/node/bin:/home/eadev/.local/bin:/home/eadev/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
D=$(cd "$(dirname "$0")" && pwd)
N=${NIGHT_DIR:-$HOME/.local/state/vitals-qa/night/$(date -u +%F)}
mkdir -p "$N"
exec >>"$N/night.log" 2>&1
echo "== night $(date -u +%FT%TZ) from $(git -C "$D" rev-parse --short HEAD 2>/dev/null)"
timeout 5400 node "$D/role-walk.mjs" --env dev --out "$N/walk"; echo "walk rc=$?"
# WL-FLOWS: the Willow Lane journeys (wl-*) act as the QA copies of bhrātā and Artha (production's settings and access, read
# only; a dev key each); then Willow Lane itself is checked on production, read only (wl-prod-check.py: set up and used?).
timeout 300 /opt/ea-watchdog/venv/bin/python -I "$D/ai-task-set.py" --prepare wl-bhrata,wl-artha; echo "wl copies rc=$?"
timeout 900 node "$D/journeys.mjs" --out "$N/journeys"; echo "journeys rc=$?"
timeout 300 /opt/ea-watchdog/venv/bin/python -I "$D/wl-prod-check.py" --out "$N/wl-prod" >/dev/null; echo "wl production check rc=$?"
( timeout 5400 /opt/ea-watchdog/venv/bin/python -I "$D/ai-task-set.py" --rotate --out "$N/ai-tasks"; echo "ai tasks rc=$?" ) &
ai=$!
timeout 16200 node "$D/night-matrix.mjs" --walk "$N/walk/role-walk.json" --until "${NIGHT_UNTIL:-01:00}" --out "$N"; echo "matrix rc=$?"
wait $ai
# keep 14 nights
find "$HOME/.local/state/vitals-qa/night" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} + 2>/dev/null
echo "== done $(date -u +%FT%TZ)"
