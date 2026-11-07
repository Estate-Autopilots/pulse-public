#!/usr/bin/env bash
# Look for committed secrets: private keys; GitHub, OpenAI/Anthropic-style (sk-...), AWS, Google and Slack tokens;
# Telegram bot tokens; database URLs with a password. Runs in tools/ci.sh; run it yourself before committing.
#
#   tools/check-secrets.sh          scan the files tracked by git (what CI sees)
#   tools/check-secrets.sh --all    also scan untracked files that are not ignored (use before committing)
#
# A finding prints as `path:line: kind: <first characters>…`; the secret itself is never printed.
# False positives (synthetic fixtures, documented examples) go into tools/secrets-allowlist.txt, one rule per line:
#   <path glob> <extended regex that the whole line must match>
# The glob is a shell pattern in which * also matches /. Placeholders such as ${VAR}, <password> or *** in database
# URLs are not reported. Exit 0 = clean, 1 = findings, 2 = usage or allowlist error.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
ALLOWLIST=tools/secrets-allowlist.txt

KINDS=() PATTERNS=()
pattern() { KINDS+=("$1") PATTERNS+=("$2"); }
pattern "private key"                '-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----'
pattern "GitHub token"               'gh[pousr]_[A-Za-z0-9]{36,}'
pattern "GitHub fine-grained token"  'github_pat_[A-Za-z0-9_]{22,}'
pattern "API key (sk-...)"           '(^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}'
pattern "AWS access key id"          '(AKIA|ASIA)[A-Z0-9]{16}'
pattern "Google API key"             'AIza[0-9A-Za-z_-]{35}'
pattern "Slack token"                'xox[abposr]-[A-Za-z0-9-]{10,}'
pattern "Telegram bot token"         '(^|[^0-9])[0-9]{8,10}:[A-Za-z0-9_-]{35}'
# PULSE-ID: Sign in with Pulse's access/refresh tokens, codes, client secrets and webhook secrets (oidc.ts, connect-api.ts).
pattern "Pulse OIDC token or secret" '(^|[^A-Za-z0-9_])p(xa|xr|xc|sec|whs)_[A-Za-z0-9_-]{43}'
pattern "database URL with password" \
  '(postgres|postgresql|mysql|mariadb|mongodb|mongodb\+srv|redis|rediss)(\+[a-z0-9]+)?://[^:/@[:space:]]+:[^$<{*%@/[:space:]][^@/[:space:]]*@'

case ${1:-} in
  "") mode=tracked ;;
  --all) mode=all ;;
  -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "usage: tools/check-secrets.sh [--all]" >&2; exit 2 ;;
esac

# --- which files ---
files=()
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [[ $mode == all ]]; then
    mapfile -d '' files < <(git ls-files -z --cached --others --exclude-standard)
  else
    mapfile -d '' files < <(git ls-files -z)
  fi
else
  echo "check-secrets: not a git work tree, scanning every file" >&2
  mapfile -d '' files < <(find . -type f -not -path './.git/*' -printf '%P\0')
fi
scan=()
for file in "${files[@]}"; do
  # Deleted-but-tracked files are skipped, and so is the allowlist (its rules quote what they allow).
  if [[ -f $file && $file != "$ALLOWLIST" ]]; then scan+=("$file"); fi
done

# --- allowlist ---
ALLOW_GLOBS=() ALLOW_RES=()
if [[ -f $ALLOWLIST ]]; then
  lineno=0
  while IFS= read -r line || [[ -n $line ]]; do
    lineno=$((lineno + 1))
    line=${line%$'\r'}
    if [[ $line =~ ^[[:space:]]*(#|$) ]]; then continue; fi
    read -r glob regex <<<"$line"
    if [[ -z ${regex:-} ]]; then
      echo "check-secrets: $ALLOWLIST:$lineno: expected '<path glob> <regex>'" >&2
      exit 2
    fi
    ALLOW_GLOBS+=("$glob") ALLOW_RES+=("$regex")
  done <"$ALLOWLIST"
fi

allowed() {  # allowed <path> <full line>
  local j
  for j in "${!ALLOW_GLOBS[@]}"; do
    # shellcheck disable=SC2053  # the glob is meant to match as a pattern
    if [[ $1 == ${ALLOW_GLOBS[j]} && $2 =~ ${ALLOW_RES[j]} ]]; then return 0; fi
  done
  return 1
}

# --- scan ---
findings=0
for i in "${!PATTERNS[@]}"; do
  while IFS= read -r hit; do
    # grep -noH prints path:line:match (repository paths contain no colons).
    path=${hit%%:*} rest=${hit#*:}
    lineno=${rest%%:*} match=${rest#*:}
    if allowed "$path" "$(sed -n "${lineno}p" -- "$path")"; then continue; fi
    match=${match#[^A-Za-z0-9-]}  # drop the boundary character some patterns capture
    findings=$((findings + 1))
    printf '%s:%s: %s: %s… (%d characters, not shown)\n' "$path" "$lineno" "${KINDS[i]}" "${match:0:6}" "${#match}"
  done < <(if [[ ${#scan[@]} -gt 0 ]]; then
             printf '%s\0' "${scan[@]}" | xargs -0 grep -noIHE -e "${PATTERNS[i]}" -- || true
           fi)
done

if [[ $findings != 0 ]]; then
  echo "check-secrets: $findings possible secret(s) in ${#scan[@]} files." >&2
  echo "  Remove them. A real secret that was ever committed is in git history: rotate it." >&2
  echo "  A false positive (synthetic fixture, documented example) goes into $ALLOWLIST." >&2
  exit 1
fi
echo "check-secrets: ${#scan[@]} files scanned, nothing found."
