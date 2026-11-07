#!/usr/bin/env bash
# AI-AUTONOMY (1233): issue a service token for Pulse's dev agents' queue (/api/v0/dev-queue/*), as the server's operator.
#   tools/dev-queue-token.sh <envfile> <owner-role> <name> <token-file>
#   e.g. tools/dev-queue-token.sh /etc/estate-autopilots/db/pulse_dev.env pulse_dev_owner claude-dev ~/.config/pulse-dev-queue/dev.token
# The token goes only into <token-file> (mode 600); the database keeps its SHA-256. Only its prefix is printed.
# Revoke: select pulse.dev_queue_token_revoke('<prefix>');
set -euo pipefail
envfile=$1 role=$2 name=$3 file=$4
set -a; . "$envfile"; set +a
mkdir -p "$(dirname "$file")"; chmod 700 "$(dirname "$file")"
tok=$(PGOPTIONS="-c role=$role" psql "$MIGRATE_DATABASE_URL" -X -At -q -v ON_ERROR_STOP=1 -c "select pulse.dev_queue_token_issue('$name')")
[[ "$tok" =~ ^pdq_[0-9a-f]{8}_[0-9a-f]{64}$ ]] || { echo "could not issue a token" >&2; exit 1; }
umask 077; printf '%s\n' "$tok" > "$file"
echo "issued dev queue token ${tok:0:12}… for \"$name\" in $file"
