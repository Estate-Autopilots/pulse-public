#!/bin/bash
# PR-PIPELINE launcher (installed at ~/.local/lib/pulse-pr-pipeline/run.sh by tools/pr-pipeline/install.sh; small and stable).
# Runs tools/pr-pipeline/collect.py for one environment (dev | staging | production) from the shipped release checkout when
# it has the tool, else from dev/live (strike). The collector checks the database has the pipeline before it writes.
set -euo pipefail
ENV=${1:?dev, staging or production}
case "$ENV" in dev|staging|production) ;; *) echo "unknown environment $ENV" >&2; exit 2;; esac
STRIKE=/home/eadev/work/pulse/strike
CHECKOUT=$STRIKE
if [ "$ENV" != dev ]; then
  SHIPPED=$(python3 - <<'PY' 2>/dev/null || true
import sys
from pathlib import Path
sys.path.insert(0, str(Path.home() / ".local/lib/pulse-release"))
import shipped_release
print(shipped_release.shipped_checkout(Path.home() / "work/pulse", "pr pipeline")[0])
PY
)
  [ -n "$SHIPPED" ] && [ -f "$SHIPPED/tools/pr-pipeline/collect.py" ] && CHECKOUT=$SHIPPED
fi
PY=$CHECKOUT/.venv/bin/python; [ -x "$PY" ] || PY=$STRIKE/.venv/bin/python
export PR_PIPELINE_PLAYWRIGHT=${PR_PIPELINE_PLAYWRIGHT:-$STRIKE/tests/e2e/node_modules/@playwright/test/index.mjs}
FREE=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
NORENDER=""; [ "$FREE" -ge 16 ] || NORENDER=--no-render   # renders need room; signals still flow
exec "$PY" "$CHECKOUT/tools/pr-pipeline/collect.py" --env "$ENV" $NORENDER
