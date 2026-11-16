#!/usr/bin/env bash
# pulse-dev deploy: build the web lane's newest pushed commit and serve it on pulse-dev.
#
# Run by the eadev user timer pulse-dev-deploy.timer (every 10 minutes). Picks the newest `task/web/*` head in the
# bare repository (by committer date), else `main`; builds it into a fresh release directory; on success points
# `current` at it and restarts pulse-dev-web.service; if the build or the restart fails, the previous release stays
# (or comes back) up. A commit that failed once is not rebuilt until the branch moves. See README.md here.
#
#   tools/pulse-dev/deploy.sh            deploy if the chosen head changed
#   tools/pulse-dev/deploy.sh --force    rebuild the chosen head even if it is served or failed before
#
# Environment: PULSE_DEV_HOME (default ~/pulse-dev), PULSE_DEV_REPO (default ~/git/pulse.git),
# PULSE_DEV_REFS (default refs/heads/task/web/), PULSE_DEV_PORT (default 3200), PULSE_DEV_KEEP (releases kept, 3).
set -euo pipefail

HOME_DIR=${PULSE_DEV_HOME:-$HOME/pulse-dev}
REPO=${PULSE_DEV_REPO:-$HOME/git/pulse.git}
REFS=${PULSE_DEV_REFS:-refs/heads/task/web/}
PORT=${PULSE_DEV_PORT:-3200}
KEEP=${PULSE_DEV_KEEP:-3}
UNIT=pulse-dev-web.service
force=0; [[ ${1:-} == --force ]] && force=1

export PATH=$HOME/.local/opt/node/bin:$HOME/.local/bin:$PATH
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1 CI=1

mkdir -p "$HOME_DIR/releases" "$HOME_DIR/logs"
exec 9>"$HOME_DIR/.lock"
flock -n 9 || { echo "pulse-dev: another deploy is running"; exit 0; }

log() { printf '%s pulse-dev: %s\n' "$(date -u +%FT%TZ)" "$*"; }
state() {  # state <key> [value]: tiny key files under $HOME_DIR (served, failed)
  if (($# == 2)); then printf '%s\n' "$2" > "$HOME_DIR/$1"; else cat "$HOME_DIR/$1" 2>/dev/null || true; fi
}

ref=$(git --git-dir="$REPO" for-each-ref --sort=-committerdate --count=1 --format='%(refname)' "$REFS")
[[ -n $ref ]] || ref=refs/heads/main
sha=$(git --git-dir="$REPO" rev-parse "$ref^{commit}")
short=${sha:0:7}; branch=${ref#refs/heads/}

if ((!force)); then
  [[ $sha == "$(state served)" ]] && { log "serving $branch @ $short, nothing to do"; exit 0; }
  [[ $sha == "$(state failed)" ]] && { log "$branch @ $short failed before, waiting for a new push"; exit 0; }
fi

rel=$HOME_DIR/releases/$sha
buildlog=$HOME_DIR/logs/$short.log
log "building $branch @ $short (log $buildlog)"
rm -rf "$rel.tmp" && mkdir -p "$rel.tmp"
fail() {
  log "FAILED $branch @ $short: $1; previous release stays up (see $buildlog)"
  state failed "$sha"; rm -rf "$rel.tmp"; exit 1
}

build() {  # runs in a subshell; `set -e` does not apply under `||`, so every step is chained
  git --git-dir="$REPO" archive "$sha" | tar -x -C "$rel.tmp" &&
  { [[ -f $rel.tmp/apps/web/package.json ]] || { echo "no apps/web/package.json at $short"; false; }; } &&
  cd "$rel.tmp" &&
  corepack pnpm install --frozen-lockfile &&
  mkdir -p apps/web/public &&
  printf '{"service":"pulse-dev","branch":"%s","commit":"%s","builtAt":"%s"}\n' \
    "$branch" "$sha" "$(date -u +%FT%TZ)" > apps/web/public/healthz.json &&
  NEXT_PUBLIC_PULSE_COMMIT=$short NEXT_PUBLIC_PULSE_BRANCH=$branch NODE_ENV=production \
    corepack pnpm --filter @pulse/web run build
}
(build) > "$buildlog" 2>&1 || fail "build"

rm -rf "$rel" && mv "$rel.tmp" "$rel"
prev=$(readlink "$HOME_DIR/current" 2>/dev/null || true)
ln -sfn "$rel" "$HOME_DIR/current.new" && mv -T "$HOME_DIR/current.new" "$HOME_DIR/current"
systemctl --user restart "$UNIT"

served() {  # wait up to 90 s for the service to answer with this commit
  for _ in $(seq 45); do
    curl -fsS "http://127.0.0.1:$PORT/healthz.json" 2>/dev/null | grep -q "\"$1\"" && return 0
    sleep 2
  done
  return 1
}
if served "$sha"; then
  state served "$sha"; rm -f "$HOME_DIR/failed"
  log "LIVE $branch @ $short on 127.0.0.1:$PORT"
else
  if [[ -n $prev && -d $prev ]]; then
    ln -sfn "$prev" "$HOME_DIR/current.new" && mv -T "$HOME_DIR/current.new" "$HOME_DIR/current"
    systemctl --user restart "$UNIT"
  fi
  fail "the new build did not start, rolled back to ${prev##*/}"
fi

# Keep the newest $KEEP releases (the current one always survives).
cur=$(readlink "$HOME_DIR/current")
ls -1dt "$HOME_DIR"/releases/*/ 2>/dev/null | sed 's:/$::' | tail -n +$((KEEP + 1)) | while read -r old; do
  [[ $old == "$cur" ]] || rm -rf "$old"
done
