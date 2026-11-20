#!/usr/bin/env python3
"""QA-2 (QA system stage 1, step 8b; research §4.1 L4 and §4.7): the Vitals production monitor.

Every 15 minutes (systemd user timer vitals-qa-monitor.timer) the QA company's synthetic owner and seller open the main
screens of production (role-walk.mjs --env prod --mode monitor: read only, every write held in the browser; the browser
runs on nivi). Findings are fingerprinted (role, page, kind of problem; no timings) and:

  * red once            -> ea-notify -l important -k vitals-qa-monitor   (one alert, deduplicated by the key)
  * red twice in a row  -> ea-notify -l critical  -k vitals-qa-monitor   for a reason seen both times (top priority)
  * green after red     -> ea-notify --resolve vitals-qa-monitor        ("Fixed", threaded under the alert)
  * the monitor itself cannot run 4 times in a row (an hour) -> one important alert (key vitals-qa-monitor-down)

State: ~/.local/state/vitals-qa/monitor/state.json; each run's output under runs/ (kept 3 days). Never prints secrets.

    python3 tools/qa/vitals/prod-monitor.py [--dry-run]      (--dry-run: run and decide, but print instead of notifying)
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE_DIR = Path.home() / ".local/state/vitals-qa/monitor"
KEY = "vitals-qa-monitor"
NODE = shutil.which("node") or "/home/eadev/.local/opt/node/bin/node"


def fingerprints(summary: str) -> list[str]:
    """One line per finding, without numbers that change run to run (timings, counts in quotes stay)."""
    out, role = [], ""
    for line in summary.splitlines()[1:]:
        m = re.match(r"^(ok  |FAIL) (\S+)", line)
        if m:
            role = m.group(2)
            continue
        line = line.strip()
        if not line or line.startswith("(details") or line.startswith("note "):
            continue
        out.append(f"{role}: {re.sub(r'[0-9]+px', 'Npx', line)[:200]}")
    return sorted(set(out))


def notify(args, level: str | None, text: str, resolve: bool = False, key: str = KEY) -> None:
    cmd = ["ea-notify", "--resolve", key, text] if resolve else ["ea-notify", "-l", level or "important", "-k", key, "-t", "Vitals production monitor", text]
    if args.dry_run:
        print("WOULD NOTIFY:", " ".join(cmd[:-1]), "|", text.replace("\n", " / ")[:400])
        return
    subprocess.run(cmd, check=False, timeout=60)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--roles", default="owner,seller")
    args = ap.parse_args()
    runs = STATE_DIR / "runs"
    runs.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = runs / stamp
    t0 = time.time()
    try:
        p = subprocess.run([NODE, str(HERE / "role-walk.mjs"), "--env", "prod", "--mode", "monitor", "--roles", args.roles, "--out", str(out)],
                           capture_output=True, text=True, timeout=600)
        rc, summary = p.returncode, p.stdout.strip()
    except subprocess.TimeoutExpired:
        rc, summary = 2, "role walk prod monitor: did not finish in 10 minutes"
    state_file = STATE_DIR / "state.json"
    state = json.loads(state_file.read_text()) if state_file.exists() else {}
    prev = state.get("red") or []
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if rc == 2 or not summary:
        state["downRuns"] = state.get("downRuns", 0) + 1
        if state["downRuns"] == 4:
            notify(args, "important", f"The production monitor could not run for an hour: {summary.splitlines()[0] if summary else 'no output'}", key=f"{KEY}-down")
    else:
        if state.get("downRuns", 0) >= 4:
            notify(args, None, "The production monitor runs again.", resolve=True, key=f"{KEY}-down")
        state["downRuns"] = 0
        red = fingerprints(summary) if rc == 1 else []
        head = summary.splitlines()[0]
        if red:
            twice = [f for f in red if f in prev]
            if twice:
                if not state.get("criticalSent"):
                    notify(args, "critical", "Red twice in a row on production (QA account, read only):\n" + "\n".join(twice[:8]) + f"\nRun: {out}")
                    state["criticalSent"] = True
            elif not prev:
                notify(args, "important", f"{head}\n" + "\n".join(red[:8]) + f"\nRun: {out}")
        elif prev:
            notify(args, None, f"Production monitor green again ({head.split(': ')[-1]}).", resolve=True)
            state["criticalSent"] = False
        if not red:
            state["criticalSent"] = False
        state["red"] = red
        state["lastGreen" if not red else "lastRed"] = now
    state["last"] = {"at": now, "rc": rc, "seconds": round(time.time() - t0), "summary": summary.splitlines()[0] if summary else ""}
    state_file.write_text(json.dumps(state, indent=1))
    print(summary)
    # keep three days of runs
    cutoff = time.time() - 3 * 86400
    for d in runs.iterdir():
        if d.stat().st_mtime < cutoff:
            shutil.rmtree(d, ignore_errors=True)
    return 0 if rc in (0, 1) else rc


if __name__ == "__main__":
    sys.exit(main())
