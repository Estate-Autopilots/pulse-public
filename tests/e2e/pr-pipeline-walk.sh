#!/bin/bash
# PR-PIPELINE walk: a private API + web for this lane on a throwaway scratch database (migrated by the test suite's own
# fixture), seeded with tests/e2e/pr-pipeline-seed.sql (synthetic), the creatives rendered by tools/pr-pipeline, then
# tests/e2e/pr-pipeline-walk.mjs. Never touches pulse_dev, staging or production.
export HOME=/home/eadev PATH=/home/eadev/.local/opt/node/bin:/home/eadev/.local/bin:/usr/local/bin:/usr/bin:/bin PULSE_CI=1
W=${W:-/home/eadev/work/pulse/pr-pipeline}; cd $W || exit 2
API_PORT=${API_PORT:-4691} WEB_PORT=${WEB_PORT:-4690}
OUT=${OUT:-/home/eadev/work/pulse/pr-pipeline-shots}
pkill -f "pr-pipeline-walk-stack" 2>/dev/null; sleep 1
base=$(bash tools/pg-scratch.sh start 2>/dev/null | tail -n1)
db=pulse_ci_pr_walk
psql "$base" -Xqc "drop database if exists $db with (force)" >/dev/null 2>&1; psql "$base" -Xqc "create database $db" >/dev/null || exit 3
url="${base/\/pulse_ci?//$db?}"
PULSE_CI_DATABASE_URL="$url" ea-heavy uv run --all-packages --quiet pytest -q -p no:cacheprovider "tests/core/test_pr_pipeline.py::test_tables_force_row_security_with_a_tenant_policy" 2>&1 | tail -3
psql "$url" -X -q -f tests/e2e/pr-pipeline-seed.sql || exit 4
login() { python3 -c "import sys;from urllib.parse import urlsplit,urlunsplit;u=urlsplit(sys.argv[1]);print(urlunsplit((u.scheme,sys.argv[2]+'@'+(u.hostname or ''),u.path,u.query,'')))" "$url" "$1"; }
CFG=$(mktemp --suffix=.json /tmp/prp-walk-config.XXXXXX); echo '{"orgs":[{"org":"00000000-0000-4000-8000-00000000e001"}]}' > $CFG
PR_PIPELINE_NODE=node ea-heavy /home/eadev/work/pulse/strike/.venv/bin/python tools/pr-pipeline/collect.py --url "$(login pulse_worker_login)" --config $CFG --state ${CFG%.json}.state --render-only 2>&1 | tail -5
rm -f $CFG ${CFG%.json}.state
psql "$url" -XAtc "select status, count(*) from pulse.pr_creative group by 1"
[ -f services/api/dist/pr-pipeline.js ] || { ea-heavy corepack pnpm --dir services/api run build >/tmp/prp-apibuild.log 2>&1 || { tail -20 /tmp/prp-apibuild.log; exit 5; }; }
setsid bash -c "exec -a pr-pipeline-walk-stack-api env DATABASE_URL='$(login pulse_api_login)' HOST=127.0.0.1 PORT=$API_PORT PULSE_ENV=dev nice node services/api/dist/server.js" > /home/eadev/work/pulse/pr-pipeline.walk-api.log 2>&1 &
cd apps/web
setsid bash -c "exec -a pr-pipeline-walk-stack-web env NEXT_TELEMETRY_DISABLED=1 NODE_ENV=development NEXT_DIST_DIR=.next-prp PULSE_API_URL=http://127.0.0.1:$API_PORT nice node_modules/.bin/next dev --disable-source-maps -p $WEB_PORT -H 127.0.0.1" > /home/eadev/work/pulse/pr-pipeline.walk-web.log 2>&1 &
cd $W
for i in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:$API_PORT/healthz && break; sleep 2; done
curl -s -o /dev/null -w "api %{http_code}\n" http://127.0.0.1:$API_PORT/healthz
for i in $(seq 1 90); do curl -s -o /dev/null http://127.0.0.1:$WEB_PORT/login && break; sleep 3; done
curl -s -o /dev/null -w "web %{http_code}\n" http://127.0.0.1:$WEB_PORT/login
mkdir -p tests/e2e/node_modules; [ -e tests/e2e/node_modules/playwright ] || ln -s $(readlink -f node_modules/.pnpm/node_modules/playwright) tests/e2e/node_modules/playwright
rm -rf $OUT; mkdir -p $OUT
WEB=http://127.0.0.1:$WEB_PORT OUT=$OUT timeout 1200 ea-heavy node tests/e2e/pr-pipeline-walk.mjs
echo "WALK-EXIT $?"
[ "${KEEP_STACK:-0}" = 1 ] || pkill -f "pr-pipeline-walk-stack"
