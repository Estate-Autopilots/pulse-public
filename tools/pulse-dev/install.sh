#!/usr/bin/env bash
# Install (or update) the pulse-dev units for the eadev user from this checkout. No root needed.
#   tools/pulse-dev/install.sh     copy deploy.sh to ~/pulse-dev/bin, link the units, enable the timer
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
mkdir -p "$HOME/pulse-dev/bin" "$HOME/.config/systemd/user"
install -m 0755 "$here/deploy.sh" "$HOME/pulse-dev/bin/deploy.sh"
for u in pulse-dev-web.service pulse-dev-deploy.service pulse-dev-deploy.timer; do
  install -m 0644 "$here/$u" "$HOME/.config/systemd/user/$u"
done
systemctl --user daemon-reload
systemctl --user enable pulse-dev-web.service pulse-dev-deploy.timer
systemctl --user start pulse-dev-deploy.timer
echo "installed; first build: systemctl --user start pulse-dev-deploy.service"
