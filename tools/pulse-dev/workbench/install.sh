#!/usr/bin/env bash
# Install the pulse-dev workbench tuning for the eadev user (no root): CPU priorities so the owner's page views win
# over agents, CI and batch work; route pre-warming after every dev server start; a heal check that restarts only a
# really broken server. Safe to re-run. See README.md in this directory.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
units=$HOME/.config/systemd/user
mkdir -p "$HOME/.local/bin" "$units"

install -m 0755 "$here/pulse-dev-warm" "$HOME/.local/bin/pulse-dev-warm"
install -m 0755 "$here/pulse-dev-heal" "$HOME/.local/bin/pulse-dev-heal"
install -m 0755 "$here/pulse-dev-recycle" "$HOME/.local/bin/pulse-dev-recycle"
install -m 0644 "$here/pulse-dev-warm.service" "$units/pulse-dev-warm.service"
for unit in pulse-dev-recycle.service pulse-dev-recycle.timer pulse-dev-recycle-nightly.service pulse-dev-recycle-nightly.timer; do
  install -m 0644 "$here/$unit" "$units/$unit"
done

# Drop-ins: <unit>.d/workbench.conf for every unit directory shipped here. A unit that does not exist on this
# machine is skipped (the drop-in is harmless but the live set-property below would fail).
for dir in "$here"/units/*.d; do
  unit=$(basename "$dir" .d)
  mkdir -p "$units/$unit.d"
  install -m 0644 "$dir/workbench.conf" "$units/$unit.d/workbench.conf"
done
systemctl --user daemon-reload

# Apply the CPU weights to the running units now (daemon-reload alone leaves a running unit's cgroup as it was) and
# renice their live processes; Nice= in the drop-ins covers future starts.
weight() {  # weight <unit> <cpu-weight> [nice]
  systemctl --user list-units --all --no-legend "$1" | grep -q "$1" || return 0
  systemctl --user set-property --runtime "$1" CPUWeight="$2" >/dev/null 2>&1 || true
  if [[ -n ${3:-} ]]; then
    cg=/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/app.slice/$1
    [[ -r $cg/cgroup.procs ]] && xargs -r renice -n "$3" -p < "$cg/cgroup.procs" >/dev/null 2>&1 || true
  fi
}
weight pulse-dev-web.service 1000
weight pulse-dev-api.service 1000
weight paperclipai.service 40 10
weight pulse-github-actions-runner.service 40 10
weight pulse-dev-index.service 25 15
weight pulse-dev-worker.service 50 10
weight pulse-train.service 40 10
weight pulse-apps-web.service 60
weight pulse-apps-api.service 60
weight ea-bot.service 60

systemctl --user enable pulse-dev-warm.service >/dev/null 2>&1 || true
systemctl --user enable --now pulse-dev-recycle.timer pulse-dev-recycle-nightly.timer >/dev/null 2>&1 || true
echo "installed: priorities applied, pulse-dev-warm enabled, pulse-dev-heal replaced, pulse-dev-recycle timers on"
