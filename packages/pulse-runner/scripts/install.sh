#!/usr/bin/env bash
# Pulse Runner one-line installer, to be hosted at https://app.vitalsos.ai/runner/install.sh
#   curl -fsSL https://app.vitalsos.ai/runner/install.sh | bash -s -- --code ABCD-1234
set -euo pipefail

VERSION="${PULSE_RUNNER_VERSION:-latest}"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js 20 or newer is required. Install it from https://nodejs.org and run this again." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js 20 or newer is required (found $(node --version))." >&2
  exit 1
fi

if ! command -v bwrap >/dev/null 2>&1; then
  echo "Warning: bubblewrap is not installed, so this server will reject jobs until it is." >&2
  echo "         Install it, for example: sudo apt-get install bubblewrap" >&2
fi

if [ "$(id -u)" -eq 0 ]; then
  exec npx --yes "@vitalsos/pulse-runner@${VERSION}" connect "$@"
fi
# Root is needed to create the service user and the systemd unit.
exec sudo env "PATH=$PATH" npx --yes "@vitalsos/pulse-runner@${VERSION}" connect "$@"
