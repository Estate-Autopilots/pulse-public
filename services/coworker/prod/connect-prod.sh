#!/bin/bash
# EA-AI: connect AI employees to production's runtime (the operator's step, as eadev on this server). For each username:
# services/coworker/connect.sh issues a 90-day key as one of that organisation's admins (pulse.agent_key_issue, audited
# by prefix), writes it to a 600 file under ~/.config/pulse-coworker-prod/keys and lists it in prod.json; then the
# runtime restarts. No key is printed or shown in Pulse. Rotate: run again (then revoke the old prefix in Pulse).
#   services/coworker/prod/connect-prod.sh <org code> <username>...   e.g.  connect-prod.sh EA ops.chief hr.ai
set -euo pipefail
code=$1; shift
here=$(cd "$(dirname "$0")/.." && pwd)
cfg=$HOME/.config/pulse-coworker-prod/prod.json
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT; chmod 700 "$tmp"
# The production migrate login, read from root's env file at run time (never copied): connect.sh sources this file.
printf '%s\n' '. /etc/estate-autopilots/db/pulse.env' 'MIGRATE_DATABASE_URL="$PULSE_DATABASE_URL_MIGRATE"' > "$tmp/env"
for user in "$@"; do PULSE_URL=http://127.0.0.1:4002 "$here/connect.sh" "$tmp/env" pulse_owner "$code" "$user" "$cfg"; done
XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)} systemctl --user restart pulse-prod-coworker.service
