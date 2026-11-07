#!/usr/bin/env bash
# ORG: docs/ops/tenant-own-server/pulse-update.sh against stand-in docker and curl (no Docker, no Pulse, no root):
# a dry run changes nothing; an update backs up, migrates with the new image, switches and checks health; a failed
# migration and a failed health check both put the previous image back; --rollback returns to the image before.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd); SCRIPT=$ROOT/docs/ops/tenant-own-server/pulse-update.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/kit" "$T/backups"; touch "$T/kit/compose.yaml"
printf 'PULSE_IMAGE=pulse:old\nPULSE_POSTGRES_PASSWORD=x\n' > "$T/pulse.env"
cat > "$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE/calls"
case "$*" in
  "image inspect --format"*) echo "${FAKE_DIGEST:-ghcr.io/estate-autopilots/pulse@sha256:new}";;
  "image inspect"*) exit 0;;
  pull*) exit 0;;
  inspect*) echo healthy;;
  *"exec -T postgres pg_dump"*) echo "-- dump";;
  *"run --rm pulse pulse-migrate"*) [[ ${FAKE_MIGRATE_FAIL:-0} == 1 ]] && exit 1; echo "migrated with $PULSE_IMAGE" >> "$FAKE/calls";;
  *"ps -q pulse"*) echo cid;;
  *) exit 0;;
esac
EOF
cat > "$T/bin/curl" <<'EOF'
#!/usr/bin/env bash
img=$(sed -n 's/^PULSE_IMAGE=//p' "$FAKE/pulse.env")
[[ ${FAKE_HEALTH_BAD:-} != "" && $img == "$FAKE_HEALTH_BAD" ]] && exit 7
echo '{"status":"ok","setup":"ready"}'
EOF
cat > "$T/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$T/bin/"*
export FAKE=$T PATH=$T/bin:$PATH PULSE_ENV_FILE=$T/pulse.env PULSE_COMPOSE_DIR=$T/kit PULSE_BACKUP_DIR=$T/backups PULSE_MIN_FREE_GB=0
pass=0; ok() { pass=$((pass + 1)); echo "ok $pass - $1"; }
img() { sed -n 's/^PULSE_IMAGE=//p' "$T/pulse.env"; }

bash "$SCRIPT" >/dev/null; [[ $(img) == pulse:old && ! -s $T/calls ]] && ok "a dry run changes nothing"
bash "$SCRIPT" --apply >/dev/null 2>&1
[[ $(img) == "ghcr.io/estate-autopilots/pulse@sha256:new" ]] && ok "updated and pinned by digest"
grep -q "migrated with ghcr.io/estate-autopilots/pulse@sha256:new" "$T/calls" && ok "migrations ran with the new image"
ls "$T"/backups/pulse-*-before-update.sql.gz >/dev/null && ok "a backup came first"
grep -q '^previous=pulse:old' "$T/backups/last-update" && ok "the previous image is recorded"
bash "$SCRIPT" --rollback >/dev/null 2>&1; [[ $(img) == pulse:old ]] && ok "--rollback returns to the image before"

: > "$T/calls"; FAKE_MIGRATE_FAIL=1 bash "$SCRIPT" --apply >/dev/null 2>&1 && exit 1 || true
[[ $(img) == pulse:old ]] && ok "a failed migration keeps the previous image"
FAKE_HEALTH_BAD="ghcr.io/estate-autopilots/pulse@sha256:new" bash "$SCRIPT" --apply >/dev/null 2>&1 && exit 1 || true
[[ $(img) == pulse:old ]] && ok "a failed health check puts the previous image back"
grep -q "FAILED at: health check" "$T/backups/update.log" && ok "the log says why"
bash "$SCRIPT" --apply --image pulse:local >/dev/null 2>&1 || true
FAKE_DIGEST=sha256:abc bash "$SCRIPT" --apply --image pulse:local >/dev/null 2>&1; [[ $(img) == pulse:local ]] && ok "a local image (no digest) runs by its name"
((pass == 10)) || { echo "FAIL: $pass of 10"; exit 1; }
echo "pulse-update: all $pass checks passed"
