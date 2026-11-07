#!/usr/bin/env bash
# Pulse CI: the one entry point for GitHub Actions and the local runner (ops contracts §3). Exit 0 = pass.
#
#   bash tools/ci.sh
#
# Steps are discovered from what is in the tree, so CI passes on the bare skeleton and grows with the repository:
#   tools    syntax of tools/*.sh and tools/lane; tools/lanes.json is valid JSON; no new company literals (check-tenant-neutral.mjs)
#   js       pnpm workspace members with a package.json: install, then lint, typecheck, test (pnpm -r --if-present)
#   python   every pyproject.toml below services/, collectors/, packages/: the root uv workspace lists exactly
#            those packages; pytest where tests exist; ruff where available
#   schemas  generated TypeScript types and Pydantic models are fresh (pulse-codegen --check)
#   rust     every Cargo.toml below apps/desktop/core (apps/desktop/src-tauri too with PULSE_CI_TAURI=1): cargo test
#   db       SQL files in db/migrations and PULSE_CI_DATABASE_URL set: tools/ci-db.sh (migrations + RLS tests)
#   secrets  tools/check-secrets.sh
#
# Environment:
#   PULSE_CI_GROUPS         comma-separated groups for hosted jobs; unset keeps the complete local gate
#   PULSE_CI_STRICT=1       a missing toolchain (corepack, uv, cargo, the CI database) fails the run instead of
#                           warning. GitHub Actions sets it; local runs default to warnings.
#   PULSE_CI_TAURI=1        also test apps/desktop/src-tauri (needs the Tauri system libraries)
#   PULSE_CI_DATABASE_URL   scratch PostgreSQL 17 database for tools/ci-db.sh; never printed. Unset on a local run:
#                           tools/pg-scratch.sh provides one (user-level, no Docker)
#   PULSE_PG_TMPFS          0, 1 or require: the db suite runs on a private PostgreSQL in RAM (tools/ci-db-shards.py,
#                           EST-1575). Defaults to 1 on strict local runs (the release train), 0 otherwise
#   PULSE_CI=1              set by both runners; informational
#   PULSE_CI_FLAKY_OUT      a file that receives the browser tests that failed once and passed on their one retry
#                           (OPS-2: Playwright and the browser flows in tests/core retry a failure once; a test that
#                           fails twice fails the run). The summary lists them either way.
set -euo pipefail
# The local VPS must serialize CI with every other heavy job. GitHub-hosted runners have their own slot.
if [[ ${GITHUB_ACTIONS:-} != true ]]; then
  [[ -x /usr/local/bin/ea-heavy ]] || { echo "CI requires /usr/local/bin/ea-heavy on this host" >&2; exit 75; }
  if [[ ${PULSE_CI_HEAVY_ENTERED:-} != 1 ]]; then
    export PULSE_CI_HEAVY_ENTERED=1
    exec /usr/local/bin/ea-heavy bash "$0" "$@"
  fi
fi
export CARGO_BUILD_JOBS=2 RAYON_NUM_THREADS=2 UV_CONCURRENT_BUILDS=2
export PULSE_CI=1
shopt -s nullglob

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
# Keep temporary test/browser profiles out of the shared /tmp tmpfs, which has a per-user quota and can fill
# independently of its reported free space. Use /var/tmp on the main filesystem; some collector tests also require
# their temporary files to live outside the repository.
CI_TMP_BASE=${PULSE_CI_TMP_BASE:-/var/tmp}
CI_TMP_DIR=$(mktemp -d "$CI_TMP_BASE/pulse-ci.XXXXXX") || { echo "cannot create CI temporary directory under $CI_TMP_BASE" >&2; exit 1; }
export TMPDIR="$CI_TMP_DIR"
export PULSE_CI_FLAKY_FILE="$CI_TMP_DIR/flaky.txt"
: >"$PULSE_CI_FLAKY_FILE"
AFFECTED_PLAN=""
cleanup_ci_tmp() {
  [[ -z ${AFFECTED_PLAN:-} ]] || rm -f -- "$AFFECTED_PLAN"
  [[ -z ${CI_TMP_DIR:-} ]] || rm -rf -- "$CI_TMP_DIR"
}
trap cleanup_ci_tmp EXIT
STRICT=${PULSE_CI_STRICT:-0}
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# PRs can use a conservative impact plan; main, releases and nightly stay full by default.
if [[ ${PULSE_CI_AFFECTED:-0} == 1 && -n ${PULSE_CI_BASE:-} ]]; then
  AFFECTED_PLAN=$(mktemp "$TMPDIR/pulse-ci-affected.XXXXXX")
  python3 tools/ci-affected.py --base "$PULSE_CI_BASE" --output "$AFFECTED_PLAN" || exit 1
fi
# A typo must fail rather than silently turn a required hosted job into an empty green check.
if [[ -n ${PULSE_CI_GROUPS:-} ]]; then
  IFS=, read -ra requested_groups <<<"$PULSE_CI_GROUPS"
  for group in "${requested_groups[@]}"; do
    case "$group" in tools|js|smoke|python|schemas|rust|e2e|db|secrets) ;;
      *) echo "Unknown CI group: $group" >&2; exit 2 ;;
    esac
  done
fi
selected() {
  [[ -z ${PULSE_CI_GROUPS:-} || ,$PULSE_CI_GROUPS, == *,$1,* ]] || return 1
  case "$1" in tools|secrets) return 0 ;; esac
  [[ -n $AFFECTED_PLAN ]] || return 0
  python3 - "$AFFECTED_PLAN" "$1" <<'PYSEL'
import json,sys
try:p=json.load(open(sys.argv[1]))
except (OSError,ValueError):sys.exit(0)
sys.exit(0 if p.get('mode','full')=='full' or sys.argv[2] in p.get('groups',[]) else 1)
PYSEL
}
affected_step() {
  local group=$1
  shift
  if selected "$group"; then "$@"; else skip "$group: unaffected" "PR impact plan"; fi
}

# --- step bookkeeping ---------------------------------------------------------------------------------------------

STEP_NAMES=() STEP_RESULTS=() STEP_SECONDS=() STEP_NOTES=()
LAST_RC=0

record() {  # record <name> <pass|FAIL|warn|skip> <seconds> <note>
  STEP_NAMES+=("$1") STEP_RESULTS+=("$2") STEP_SECONDS+=("$3") STEP_NOTES+=("$4")
}

flaky_count() { wc -l <"$PULSE_CI_FLAKY_FILE" 2>/dev/null || echo 0; }

in_actions() { [[ ${GITHUB_ACTIONS:-} == true ]]; }

notice() {
  if in_actions; then echo "::warning::$*"; else echo "warning: $*" >&2; fi
}

# run <name> <command...>: one command is one step. A failure is recorded (LAST_RC) and never stops the script.
# Shell functions passed here run with `set -e` suspended, so they check their own errors.
run() {
  local name=$1 start=$SECONDS flaky_before flaky_note=""
  shift
  if in_actions; then echo "::group::$name"; else printf '\n==> %s\n' "$name"; fi
  LAST_RC=0
  flaky_before=$(flaky_count)
  "$@" || LAST_RC=$?
  if in_actions; then echo "::endgroup::"; fi
  if (( $(flaky_count) > flaky_before )); then flaky_note="$(( $(flaky_count) - flaky_before )) flaky (passed on retry)"; fi
  if [[ $LAST_RC == 0 ]]; then
    record "$name" pass $((SECONDS - start)) "$flaky_note"
  else
    record "$name" FAIL $((SECONDS - start)) "exit $LAST_RC"
    if in_actions; then echo "::error::$name failed (exit $LAST_RC)"; fi
  fi
}

skip() {  # skip <name> <reason>
  record "$1" skip 0 "$2"
  printf '\n--- %s: skipped (%s)\n' "$1" "$2"
}

missing() {  # missing <name> <what>: a toolchain is not installed. Warning locally, failure with PULSE_CI_STRICT=1.
  if [[ $STRICT == 1 ]]; then record "$1" FAIL 0 "$2 (PULSE_CI_STRICT=1)"; else record "$1" warn 0 "$2"; fi
  notice "$1: $2"
}

have() { command -v "$1" >/dev/null 2>&1; }

in_dir() {  # in_dir <dir> <command...>
  local dir=$1
  shift
  (cd "$dir" && "$@")
}

allow_no_tests() {  # pytest exits 5 when it collects no tests; that is not a failure here
  local rc=0
  "$@" || rc=$?
  if [[ $rc == 5 ]]; then echo "(no tests collected)"; return 0; fi
  return "$rc"
}

# --- tools --------------------------------------------------------------------------------------------------------

tools_selfcheck() {
  local script
  for script in tools/*.sh; do
    bash -n "$script" || return 1
  done
  python3 - tools/lane tools/*.py tools/smoke <<'PY' || return 1
import sys
for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as fh:
        compile(fh.read(), path, "exec")
PY
  python3 -m json.tool tools/lanes.json >/dev/null || return 1
  echo "tools/*.sh, tools/lane and tools/lanes.json are well-formed"
}

# --- JavaScript / TypeScript --------------------------------------------------------------------------------------

js_members() {  # directories matched by pnpm-workspace.yaml `packages:` that have a package.json
  [[ -f pnpm-workspace.yaml ]] || return 0
  local pattern dir
  while IFS= read -r pattern; do
    if [[ -z $pattern || $pattern == '!'* ]]; then continue; fi
    for dir in $pattern; do  # unquoted on purpose: the pattern is a glob
      if [[ -f $dir/package.json ]]; then printf '%s\n' "$dir"; fi
    done
  done < <(awk '
    /^packages:/ { inside = 1; next }
    inside && /^[^[:space:]#-]/ { inside = 0 }
    inside && /^[[:space:]]*-/ {
      sub(/^[[:space:]]*-[[:space:]]*/, ""); sub(/[[:space:]]+#.*$/, ""); gsub(/["\047]/, ""); print
    }' pnpm-workspace.yaml)
}

js_step() {
  local members=() pnpm=() filters=() script
  mapfile -t members < <(js_members)
  if [[ ${#members[@]} == 0 ]]; then skip "js" "no pnpm workspace package yet"; return; fi
  if have corepack; then pnpm=(corepack pnpm)
  elif have pnpm; then pnpm=(pnpm)
  else missing "js" "corepack and pnpm not found (Node 24 ships corepack)"; return
  fi
  echo "JS packages: ${members[*]}"
  if [[ -f pnpm-lock.yaml ]]; then
    run "js: install" "${pnpm[@]}" install --frozen-lockfile
  else
    notice "js: no pnpm-lock.yaml yet, installing without a lockfile; commit the lockfile"
    run "js: install (no lockfile)" "${pnpm[@]}" install --no-frozen-lockfile
  fi
  if [[ $LAST_RC != 0 ]]; then skip "js: lint, typecheck, test" "install failed"; return; fi
  if [[ -n $AFFECTED_PLAN ]]; then
    mapfile -t filters < <(python3 - "$AFFECTED_PLAN" <<'PYFILTER'
import json,sys
p=json.load(open(sys.argv[1]))
for f in p.get('js_filters',[]):
 if p['mode']=='affected':print('--filter');print(f)
PYFILTER
)
  fi
  for script in lint typecheck test; do
    if [[ $script == test ]]; then
      # Python API integration tests import services/api/dist/app.js. Build it before the recursive test command,
      # which can stop at an earlier workspace package's failure and otherwise leave that dist tree absent.
      run "js: api build" "${pnpm[@]}" --filter @pulse/api build
    fi
    run "js: $script" "${pnpm[@]}" -r --workspace-concurrency=1 "${filters[@]}" --if-present run "$script"
  done
}

# --- Python -------------------------------------------------------------------------------------------------------

python_packages() {
  find services collectors packages \( -name node_modules -o -name .venv -o -name target -o -name .git \) -prune \
    -o -name pyproject.toml -print 2>/dev/null | sed 's#/pyproject.toml$##' | LC_ALL=C sort
}

has_tests() {  # has_tests <dir>
  if [[ -d $1/tests ]]; then return 0; fi
  [[ -n $(find "$1" \( -name node_modules -o -name .venv \) -prune -o \
          \( -name 'test_*.py' -o -name '*_test.py' \) -print -quit) ]]
}

uv_workspace_check() {  # uv_workspace_check <package dir...>: root [tool.uv.workspace] members == the packages
  python3 - "$@" <<'PY'
import glob
import os
import sys

try:
    import tomllib
except ImportError:  # Python < 3.11
    print("tomllib unavailable; uv workspace check skipped")
    sys.exit(0)

try:
    with open("pyproject.toml", "rb") as fh:
        workspace = tomllib.load(fh).get("tool", {}).get("uv", {}).get("workspace")
except FileNotFoundError:
    workspace = None
if workspace is None:
    print("no [tool.uv.workspace] in the root pyproject.toml")
    sys.exit(1)


def dirs(patterns):
    return {os.path.normpath(p) for pattern in patterns for p in glob.glob(pattern) if os.path.isdir(p)}


members = dirs(workspace.get("members", [])) - dirs(workspace.get("exclude", []))
packages = {os.path.normpath(p) for p in sys.argv[1:]}
problems = [f"{d}: listed in [tool.uv.workspace] members but has no pyproject.toml (uv refuses to run)"
            for d in sorted(members - packages)]
problems += [f"{d}: has a pyproject.toml but is missing from [tool.uv.workspace] members in the root pyproject.toml"
             for d in sorted(packages - members)]
print("\n".join(problems) or f"uv workspace members match the {len(packages)} Python package(s)")
sys.exit(1 if problems else 0)
PY
}

python_step() {
  local packages=() lock=() dir
  mapfile -t packages < <(python_packages)
  if [[ ${#packages[@]} == 0 ]]; then skip "python" "no Python package yet"; return; fi
  run "python: uv workspace members" uv_workspace_check "${packages[@]}"
  if have uv; then
    if [[ -f uv.lock ]]; then lock=(--locked)
    else notice "python: no uv.lock yet, resolving without a lockfile; commit uv.lock"
    fi
  else
    missing "python: uv" "uv not found; falling back to python3 -m pytest without installing dependencies"
  fi
  for dir in "${packages[@]}"; do
    if ! has_tests "$dir"; then
      skip "python: $dir pytest" "no tests yet"
    elif have uv; then
      run "python: $dir pytest" allow_no_tests uv run --directory "$dir" "${lock[@]}" pytest -q
    elif python3 -c 'import pytest' 2>/dev/null; then
      run "python: $dir pytest" allow_no_tests in_dir "$dir" python3 -m pytest -q
    else
      missing "python: $dir pytest" "neither uv nor pytest is installed"
    fi
    if have uv && grep -q '"ruff' "$dir/pyproject.toml"; then
      run "python: $dir ruff" uv run --directory "$dir" "${lock[@]}" ruff check .
    elif have ruff; then
      run "python: $dir ruff" ruff check "$dir"
    else
      skip "python: $dir ruff" "ruff not available"
    fi
  done
}

# --- generated code -----------------------------------------------------------------------------------------------

schemas_step() {  # TypeScript types and Pydantic models generated from packages/schemas must be committed fresh
  [[ -f packages/sdk-py/src/pulse_sdk/codegen.py ]] || { skip "schemas: generated code" "no generator yet"; return; }
  if ! have uv; then missing "schemas: generated code" "uv not found"; return; fi
  local lock=()
  if [[ -f uv.lock ]]; then lock=(--locked); fi
  run "schemas: generated code is fresh" uv run --all-packages "${lock[@]}" pulse-codegen --check
}

# --- Rust ---------------------------------------------------------------------------------------------------------

rust_step() {
  local manifests=() roots=() args=() manifest dir root nested
  mapfile -t manifests < <(find apps/desktop/core \( -name target -o -name node_modules \) -prune \
                             -o -name Cargo.toml -print 2>/dev/null | LC_ALL=C sort)
  if [[ ${PULSE_CI_TAURI:-0} == 1 && -f apps/desktop/src-tauri/Cargo.toml ]]; then
    manifests+=(apps/desktop/src-tauri/Cargo.toml)
  fi
  if [[ ${#manifests[@]} == 0 ]]; then skip "rust" "no crate yet"; return; fi
  if ! have cargo; then missing "rust" "cargo not found (install the Rust toolchain)"; return; fi
  for manifest in "${manifests[@]}"; do
    dir=${manifest%/Cargo.toml}
    nested=0
    for root in "${roots[@]}"; do
      if [[ $dir == "$root"/* ]]; then nested=1; fi
    done
    if [[ $nested == 1 ]]; then continue; fi  # tested with its workspace root
    args=()
    if grep -q '^\[workspace\]' "$manifest"; then roots+=("$dir"); args+=(--workspace); fi
    if [[ -f $dir/Cargo.lock ]]; then args+=(--locked); fi
    if [[ ${GITHUB_ACTIONS:-} != true ]]; then
      # Same toolchain/lock shares a target cache across clean worktrees; Cargo fingerprints source changes.
      local cache_key
      cache_key=$( { cat rust-toolchain.toml; cat "$dir/Cargo.lock" 2>/dev/null || true; } | sha256sum | cut -c1-24 )
      export CARGO_TARGET_DIR="/home/eadev/.cache/pulse-cargo/$cache_key"
    fi
    run "rust: $dir cargo test" cargo test -j2 --manifest-path "$manifest" "${args[@]}"
  done
}

# --- browser end-to-end ------------------------------------------------------------------------------------------

e2e_step() {
  local pnpm=() args=(--workers=1)
  if have corepack; then pnpm=(corepack pnpm)
  elif have pnpm; then pnpm=(pnpm)
  else skip "e2e: Playwright" "corepack/pnpm is not installed"; return; fi
  if [[ -z ${PULSE_BASE_URL:-} && ! -f apps/web/package.json ]]; then
    skip "e2e: Playwright" "no web app yet (apps/web/package.json is absent)"
    return
  fi
  if [[ -z ${PULSE_BASE_URL:-} && ${PULSE_WEB_BUILT:-0} != 1 ]]; then
    # OPS-2: the production build is its own step (no time limit; the db step's browser flows use it too). Inside
    # Playwright's webServer it had 240 s: on 15 Oct a busy server took longer, no build existed, and every browser
    # test of the release run failed with "next start did not answer".
    run "web: production build" "${pnpm[@]}" --dir apps/web exec next build
    if [[ $LAST_RC != 0 ]]; then skip "e2e: Playwright" "the web production build failed"; return; fi
  fi
  if ! "${pnpm[@]}" --dir tests/e2e exec node -e 'const fs = require("node:fs"); const { chromium } = require("@playwright/test"); process.exit(fs.existsSync(chromium.executablePath()) ? 0 : 1)' >/dev/null 2>&1; then
    local reason="@playwright/test or its bundled Chromium browser is not installed"
    if in_actions; then echo "::notice::e2e: Playwright skipped ($reason)"; else echo "notice: e2e: Playwright skipped ($reason)" >&2; fi
    if [[ $STRICT == 1 ]]; then missing "e2e: Playwright" "$reason"; else skip "e2e: Playwright" "$reason"; fi
    return
  fi
  [[ -z ${PULSE_CI_E2E_SHARD:-} ]] || args+=("--shard=$PULSE_CI_E2E_SHARD")
  PULSE_WEB_BUILT=1 run "e2e: Playwright" "${pnpm[@]}" --dir tests/e2e run e2e "${args[@]}"
  if [[ -z ${PULSE_CI_E2E_SHARD:-} || $PULSE_CI_E2E_SHARD == 1/6 ]]; then
    run "e2e: synthetic Google exact-build acceptance" bash tools/google-acceptance.sh HEAD --self-check
  fi
}

# --- database -----------------------------------------------------------------------------------------------------

db_step() {
  local migrations=()
  mapfile -t migrations < <(find db/migrations -type f -name '*.sql' 2>/dev/null)
  if [[ ${#migrations[@]} == 0 ]]; then skip "db" "no migrations yet"; return; fi
  if ! in_actions && [[ -f tools/pg-scratch.sh ]]; then
    # Local agents share a configured pulse_ci URL. Prefer the user-level scratch PostgreSQL so every run gets an
    # isolated database (tools/ci-db.sh creates and drops it) instead of resetting the shared database.
    local scratch
    if scratch=$(bash tools/pg-scratch.sh start 2>/dev/null | tail -n 1) && [[ $scratch == postgresql://* ]]; then
      export PULSE_CI_DATABASE_URL=$scratch PULSE_CI_FRESH_DB=1
    elif [[ -n ${PULSE_CI_DATABASE_URL:-} ]]; then
      # If scratch is unavailable, fail safely on a shared database instead of letting concurrent jobs race.
      export PULSE_CI_FRESH_DB=1
    fi
  fi
  if [[ -z ${PULSE_CI_DATABASE_URL:-} ]]; then
    missing "db" "PULSE_CI_DATABASE_URL is not set (scratch PostgreSQL 17 for migrations and RLS tests)"
    return
  fi
  if [[ ! -f tools/ci-db.sh ]]; then
    record "db" warn 0 "${#migrations[@]} migration(s) but no tools/ci-db.sh hook yet"
    notice "db: tools/ci-db.sh does not exist yet, so migrations are not checked"
    return
  fi
  # EST-1575: strict local runs (the release train) put the suite's PostgreSQL in RAM; the disk server above stays
  # the fallback when the RAM cluster is refused, and the summary says which one ran.
  if ! in_actions && [[ $STRICT == 1 ]]; then export PULSE_PG_TMPFS=${PULSE_PG_TMPFS:-1}; fi
  PULSE_AUTH_BROWSER=1 run "db: migrations and tests" bash tools/ci-db.sh
}

# --- summary ------------------------------------------------------------------------------------------------------

summary() {
  local i passed=0 failed=0 warned=0 skipped=0 failures=()
  printf '\nPulse CI summary (%s)\n' "$(git rev-parse --short=12 HEAD 2>/dev/null || echo 'not a git checkout')"
  printf '  %-46s %-6s %5s  %s\n' STEP RESULT TIME NOTE
  for i in "${!STEP_NAMES[@]}"; do
    printf '  %-46s %-6s %4ss%s\n' "${STEP_NAMES[i]}" "${STEP_RESULTS[i]}" "${STEP_SECONDS[i]}" \
      "${STEP_NOTES[i]:+  ${STEP_NOTES[i]}}"
    case ${STEP_RESULTS[i]} in
      pass) passed=$((passed + 1)) ;;
      FAIL) failed=$((failed + 1)); failures+=("${STEP_NAMES[i]}") ;;
      warn) warned=$((warned + 1)) ;;
      skip) skipped=$((skipped + 1)) ;;
    esac
  done
  if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
    {
      echo "| Step | Result | Time | Note |"
      echo "|---|---|---|---|"
      for i in "${!STEP_NAMES[@]}"; do
        echo "| ${STEP_NAMES[i]} | ${STEP_RESULTS[i]} | ${STEP_SECONDS[i]}s | ${STEP_NOTES[i]} |"
      done
    } >>"$GITHUB_STEP_SUMMARY"
  fi
  if [[ -s $PULSE_CI_FLAKY_FILE ]]; then
    printf '\nFlaky browser tests (failed once, passed on their one retry; worth a look):\n'
    sed 's/^/  /' "$PULSE_CI_FLAKY_FILE"
    if [[ -n ${PULSE_CI_FLAKY_OUT:-} ]]; then cp "$PULSE_CI_FLAKY_FILE" "$PULSE_CI_FLAKY_OUT" || true; fi
    if in_actions; then notice "$(wc -l <"$PULSE_CI_FLAKY_FILE") flaky browser test(s) passed on retry"; fi
  fi
  local counts="$passed passed, $skipped skipped, $warned warning(s)" joined
  if [[ $failed != 0 ]]; then
    joined=$(printf '%s, ' "${failures[@]}")
    printf 'CI result: FAIL (%s failed: %s; %s)\n' "$failed" "${joined%, }" "$counts"
    return 1
  fi
  printf 'CI result: PASS (%s)\n' "$counts"
}

# --- main ---------------------------------------------------------------------------------------------------------

echo "Pulse CI in $ROOT (strict: $STRICT)"
for tool in python3 node corepack uv cargo; do
  if have "$tool"; then printf '  %-8s %s\n' "$tool" "$("$tool" --version 2>&1 | head -n 1)"; fi
done

affected_step tools run "tools: self-check" tools_selfcheck
affected_step tools run "docker: uv workspace members copied" python3 tools/check-docker-uv-members.py
affected_step tools run "tenant-neutral: no new company literals (DE-EA)" node tools/check-tenant-neutral.mjs
affected_step js js_step
affected_step smoke run "tools: smoke tests" uv run --all-packages --locked python -m unittest discover -s tests/smoke
affected_step python python_step
affected_step schemas schemas_step
affected_step rust rust_step
affected_step e2e e2e_step
affected_step db db_step
affected_step secrets run "secrets: check-secrets" bash tools/check-secrets.sh
summary
