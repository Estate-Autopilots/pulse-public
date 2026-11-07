#!/bin/bash
# PR-STUDIO-2 walk: a private API + web for this lane on a throwaway scratch database (migrated by the test suite's own
# fixture), seeded with tests/e2e/pr-pipeline-seed.sql and tests/e2e/pr-studio-flow-seed.py (synthetic), then
# tests/e2e/pr-studio-flow-walk.mjs. Never touches pulse_dev, staging or production.
export HOME=/home/eadev PATH=/home/eadev/.local/opt/node/bin:/home/eadev/.local/bin:/usr/local/bin:/usr/bin:/bin PULSE_CI=1
W=${W:-/home/eadev/work/pulse/pr-studio-2}; cd $W || exit 2
API_PORT=${API_PORT:-4693} WEB_PORT=${WEB_PORT:-4692}
OUT=${OUT:-/home/eadev/work/pulse/pr-studio-2-shots}
pkill -f "pr-studio-flow-walk-stack" 2>/dev/null; sleep 1
base=$(bash tools/pg-scratch.sh start 2>/dev/null | tail -n1)
db=pulse_ci_pr_flow_walk
psql "$base" -Xqc "drop database if exists $db with (force)" >/dev/null 2>&1; psql "$base" -Xqc "create database $db" >/dev/null || exit 3
url="${base/\/pulse_ci?//$db?}"
PULSE_CI_DATABASE_URL="$url" ea-heavy uv run --all-packages --quiet pytest -q -p no:cacheprovider "tests/core/test_pr_studio_flow.py::test_tables_force_row_security_with_a_tenant_policy" 2>&1 | tail -3
psql "$url" -X -q -f tests/e2e/pr-pipeline-seed.sql >/dev/null || exit 4
python3 tests/e2e/pr-studio-flow-seed.py | psql "$url" -X -q >/dev/null || exit 4
psql "$url" -XAtc "select 'assets', count(*) from pulse.pr_asset union all select 'posts', count(*) from pulse.pr_post union all select 'files', count(*) from pulse.pr_file"
login() { python3 -c "import sys;from urllib.parse import urlsplit,urlunsplit;u=urlsplit(sys.argv[1]);print(urlunsplit((u.scheme,sys.argv[2]+'@'+(u.hostname or ''),u.path,u.query,'')))" "$url" "$1"; }
[ -f services/api/dist/pr-flow.js ] || { ea-heavy corepack pnpm --dir services/api run build >/tmp/prf-apibuild.log 2>&1 || { tail -20 /tmp/prf-apibuild.log; exit 5; }; }
setsid bash -c "exec -a pr-studio-flow-walk-stack-api env DATABASE_URL='$(login pulse_api_login)' HOST=127.0.0.1 PORT=$API_PORT PULSE_ENV=dev nice node services/api/dist/server.js" > /home/eadev/work/pulse/pr-studio-2.walk-api.log 2>&1 &
cd apps/web
setsid bash -c "exec -a pr-studio-flow-walk-stack-web env NEXT_TELEMETRY_DISABLED=1 NODE_ENV=development NEXT_DIST_DIR=.next-prf PULSE_API_URL=http://127.0.0.1:$API_PORT nice node_modules/.bin/next dev --disable-source-maps -p $WEB_PORT -H 127.0.0.1" > /home/eadev/work/pulse/pr-studio-2.walk-web.log 2>&1 &
cd $W
for i in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:$API_PORT/healthz && break; sleep 2; done
curl -s -o /dev/null -w "api %{http_code}\n" http://127.0.0.1:$API_PORT/healthz
for i in $(seq 1 90); do curl -s -o /dev/null http://127.0.0.1:$WEB_PORT/login && break; sleep 3; done
curl -s -o /dev/null -w "web %{http_code}\n" http://127.0.0.1:$WEB_PORT/login
mkdir -p tests/e2e/node_modules; [ -e tests/e2e/node_modules/playwright ] || ln -s $(readlink -f node_modules/.pnpm/node_modules/playwright) tests/e2e/node_modules/playwright
rm -rf $OUT; mkdir -p $OUT
WEB=http://127.0.0.1:$WEB_PORT OUT=$OUT timeout 1500 ea-heavy node tests/e2e/pr-studio-flow-walk.mjs
echo "WALK-EXIT $?"
[ "${KEEP_STACK:-0}" = 1 ] || pkill -f "pr-studio-flow-walk-stack"
