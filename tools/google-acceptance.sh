#!/usr/bin/env bash
# tools/google-acceptance.sh <exact-sha> [--self-check|--matrix]; Ctrl-C tears down the synthetic stack.
# QA: use the printed credentialsFile locally (0600), ignoreHTTPSErrors in Playwright, and routeGoogle from
# services/api/test/google-harness.mjs. POST {identity,session} to googleOrigin/session selects Google state.
set -euo pipefail
umask 077
if [[ ${GITHUB_ACTIONS:-} != true && ${PULSE_GOOGLE_HEAVY_ENTERED:-0} != 1 ]]; then
  export PULSE_GOOGLE_HEAVY_ENTERED=1
  exec /usr/local/bin/ea-heavy bash "$0" "$@"
fi
[[ $# == 1 || ( $# == 2 && ( $2 == --self-check || $2 == --matrix ) ) ]] || { echo 'usage: tools/google-acceptance.sh <sha> [--self-check|--matrix]' >&2; exit 2; }
if [[ ${2:-} == --matrix ]]; then
  matrix_reason=${PULSE_GOOGLE_MATRIX_REASON:-}
  [[ -n ${matrix_reason// /} && -d ${PULSE_GOOGLE_MATRIX_OUT:-} && -w ${PULSE_GOOGLE_MATRIX_OUT:-} ]] || {
    echo 'matrix requires PULSE_GOOGLE_MATRIX_REASON and an existing writable PULSE_GOOGLE_MATRIX_OUT' >&2; exit 2;
  }
  [[ $PULSE_GOOGLE_MATRIX_OUT == /* ]] || { echo 'matrix output directory must be absolute' >&2; exit 2; }
fi
driver=$(cd "$(dirname "$0")/.." && pwd)
sha=$(git -C "$driver" rev-parse --verify "$1^{commit}")
scratch=$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-${PAPERCLIP_SCRATCH_DIR:-${TMPDIR:-/tmp}}}/google-acceptance.XXXXXX")
chmod 700 "$scratch"
export PULSE_HARNESS_SCRATCH=$scratch PULSE_CI=1 PULSE_AUTH_MAIL_MODE=sink PULSE_PUBLIC_LOGIN_ENABLED=1
export UV_CONCURRENT_BUILDS=2 UV_CONCURRENT_DOWNLOADS=2
export PULSE_PG_DATA=$scratch/pg PULSE_PG_PORT=55439
pids=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  bash "$driver/tools/pg-scratch.sh" stop >/dev/null 2>&1 || true
  git -C "$driver" worktree remove --force "$scratch/tree" >/dev/null 2>&1 || true
  rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git -C "$driver" worktree add --detach "$scratch/tree" "$sha" >/dev/null
cd "$scratch/tree"
cp "$driver/services/api/test/google-harness.mjs" services/api/test/google-harness.mjs
cp "$driver/services/api/test/google-harness-check.mjs" services/api/test/google-harness-check.mjs
echo "Google acceptance @ $sha: installing locked dependencies"
pnpm install --frozen-lockfile --child-concurrency=2 >"$scratch/install.log" 2>&1 || { tail -40 "$scratch/install.log"; exit 1; }
echo 'Building the exact API and web sources (sequentially, at most two workers)'
pnpm --filter @pulse/api build >"$scratch/api-build.log" 2>&1 || { tail -40 "$scratch/api-build.log"; exit 1; }
pnpm --filter @pulse/web build >"$scratch/web-build.log" 2>&1 || { tail -40 "$scratch/web-build.log"; exit 1; }
echo 'Starting private PostgreSQL and applying migrations in order'
export PULSE_HARNESS_DB
PULSE_HARNESS_DB=$(bash tools/pg-scratch.sh start | tail -1)
uv run --all-packages --locked python - <<'PY'
import os
import psycopg
from pulse_sdk import migrate
with psycopg.connect(os.environ['PULSE_HARNESS_DB'], autocommit=True) as c:
    migrate.bootstrap_scratch(c)
    migrate.migrate(c, owner='pulse_owner', verbose=False)
    migrate.sync_registry(c, owner='pulse_owner')
PY
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout "$scratch/key.pem" -out "$scratch/cert.pem" >"$scratch/tls.log" 2>&1
chmod 600 "$scratch/key.pem"
export PULSE_HARNESS_SHA=$sha
node services/api/test/google-harness.mjs >"$scratch/stack.log" 2>&1 &
pids+=("$!")
# Bounded readiness wait; no background poller or service survives this command.
for ((i=0;i<90;i++)); do
  [[ ! -f $scratch/manifest.json ]] || break
  kill -0 "${pids[0]}" 2>/dev/null || { cat "$scratch/stack.log"; exit 1; }
  sleep 1
done
[[ -s $scratch/manifest.json ]] || { cat "$scratch/stack.log"; exit 1; }
cat "$scratch/manifest.json"
if [[ ${2:-} == --self-check ]]; then
  node services/api/test/google-harness-check.mjs || { tail -60 "$scratch/stack.log"; exit 1; }
elif [[ ${2:-} == --matrix ]]; then
  MATRIX_TREE="$scratch/tree" PULSE_GOOGLE_MATRIX_SHA="$sha" \
    timeout --signal=TERM --kill-after=15s 15m node "$driver/tests/e2e/google-acceptance-matrix.mjs"
else
  echo 'Synthetic stack ready; Ctrl-C removes its processes, database, credentials and worktree.'
  wait "${pids[0]}"
fi
