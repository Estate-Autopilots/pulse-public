#!/bin/bash
# PR-PIPELINE: install the user units and the launcher as eadev (run from the repository root as eadev).
#   bash tools/pr-pipeline/install.sh            # installs; enables dev and staging timers whose config exists
#   systemctl --user enable --now user-3ce52126@org-0a75d0.example   # production, once the database has migration 1620
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p ~/.config/systemd/user ~/.local/lib/pulse-pr-pipeline ~/.config/pulse-pr-pipeline ~/.local/state/pulse-pr-pipeline
install -m 0644 tools/systemd/pulse-pr-pipeline@.service tools/systemd/pulse-pr-pipeline@.timer ~/.config/systemd/user/
install -m 0755 tools/pr-pipeline/run.sh ~/.local/lib/pulse-pr-pipeline/run.sh
systemctl --user daemon-reload
for e in dev staging; do
  [ -f ~/.config/pulse-pr-pipeline/$e.json ] && systemctl --user enable --now pulse-pr-pipeline@$e.timer
done
systemctl --user list-timers 'pulse-pr-pipeline@*' --no-pager
