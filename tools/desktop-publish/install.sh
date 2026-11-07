#!/usr/bin/env bash
# Install or update the eadev user's Windows-build publisher and its 10-minute timer.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}
mkdir -p "$HOME/pulse-downloads/bin" "$HOME/pulse-downloads/desktop" "$HOME/.config/systemd/user"
chmod 0755 "$HOME/pulse-downloads" "$HOME/pulse-downloads/bin" "$HOME/pulse-downloads/desktop"
install -m 0755 "$here/publish.mjs" "$HOME/pulse-downloads/bin/publish.mjs"
for unit in pulse-desktop-publish.service pulse-desktop-publish.timer; do
  install -m 0644 "$here/$unit" "$HOME/.config/systemd/user/$unit"
done
systemctl --user daemon-reload
systemctl --user enable --now pulse-desktop-publish.timer
echo "publisher timer installed; it will publish the next successful main build with a valid manifest"
