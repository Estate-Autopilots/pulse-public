#!/bin/bash
# EA-AI: keep production's AI runtime on the code production runs. Reads the live release from production's /healthz,
# moves the runtime's own worktree to that commit and, when it moved, restarts the runtime. --sync only moves the
# worktree (the unit's ExecStartPre). Production unreadable: nothing changes. Installed as
# ~/.local/bin/pulse-prod-coworker-follow (see services/coworker/prod/README.md).
set -euo pipefail
WT=${PULSE_COWORKER_WORKTREE:-$HOME/work/pulse/coworker-prod}
REPO=${PULSE_REPO:-$HOME/work/pulse/strike}
HEALTH=${PULSE_PROD_HEALTH:-http://127.0.0.1:4002/healthz}
rel=$(curl -fsS -m 10 "$HEALTH" | grep -o '"release":"[0-9a-f]\{40\}"' | grep -o '[0-9a-f]\{40\}') || { echo "production /healthz unreadable: runtime left as it is" >&2; exit 0; }
if [ ! -e "$WT/.git" ]; then
  git -C "$REPO" cat-file -e "$rel^{commit}" 2>/dev/null || git -C "$REPO" fetch -q origin
  git -C "$REPO" worktree add -q --detach "$WT" "$rel"
  echo "runtime worktree made at ${rel:0:12}"
fi
cur=$(git -C "$WT" rev-parse HEAD)
[ "$cur" = "$rel" ] && exit 0
git -C "$WT" cat-file -e "$rel^{commit}" 2>/dev/null || git -C "$REPO" fetch -q origin
git -C "$WT" checkout -q --detach "$rel"
echo "runtime code moved ${cur:0:12} -> ${rel:0:12} (production's live release)"
[ "${1:-}" = "--sync" ] || systemctl --user restart pulse-prod-coworker.service
