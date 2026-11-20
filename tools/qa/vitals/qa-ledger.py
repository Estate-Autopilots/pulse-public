#!/usr/bin/env python3
"""QA-2 (QA system stage 1, step 7; research §4.7 "one list"): the QA bug ledger, and each morning's top 10.

Reads last night's Vitals QA output (night matrix, role walk, journeys, the AI employee task set) and the production monitor's state, merges every
finding into one ledger keyed by fingerprint (route, rule, where; states and roles are grouped under it), and appends the
day's top 10 open items to the human ledger. Read only towards the app: it writes files and nothing else (no bug report
is filed in the app: on production that starts the auto-fix pipeline and messages the owner).

    python3 tools/qa/vitals/qa-ledger.py [--night DIR] [--ledger DIR] [--top 10]

Ledger (default ~/ea-research/flow/qa-ledger/):
  ledger.json   every fingerprint: first/last seen, nights seen, states, roles, kind, area (the screen's section), status
  ledger.md     one section per morning: the top 10 (new "certain" findings first, then the widest: most states × roles)
  top10-<date>.txt  the same 10, one line each
An item missing from two nights in a row that both covered its route is marked "gone" (fixed or no longer reachable).
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
STATE = HOME / ".local/state/vitals-qa"


def area(route: str) -> str:
    seg = [s for s in route.split("?")[0].split("/") if s]
    return "/" + seg[0] if seg else "/"


def load(p: Path):
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def night_findings(night: Path) -> tuple[list[dict], set[str]]:
    """Findings from one night's folder, and the routes it covered."""
    out, covered = [], set()
    m = load(night / "matrix.json")
    if m:
        for f in m.get("findings", []):
            out.append({"fingerprint": "matrix | " + f["fingerprint"], "source": "night matrix", "route": f["route"], "rule": f["rule"],
                        "detail": str(f.get("detail", ""))[:200], "kind": f.get("kind", "certain"), "states": f.get("states", []), "roles": f.get("roles", [])})
            covered.add(f["route"])
    w = load(night / "walk" / "role-walk.json")
    if w:
        for r in w.get("results", []):
            for p in r.get("pages", []):
                covered.add(p.get("href", ""))
                for prob in p.get("problems", []):
                    kind = re.sub(r'[:"(].*', "", prob).strip()
                    out.append({"fingerprint": f"walk | {p['href']} | {kind}", "source": "role walk", "route": p["href"], "rule": "role walk",
                                "detail": prob[:200], "kind": "certain", "states": ["1440-light"], "roles": [r["role"]]})
            for c in r.get("checks", []):
                if not c.get("ok") and not c.get("info"):
                    out.append({"fingerprint": f"walk | {r['role']} | {c['name']}", "source": "role walk", "route": "(role)", "rule": "role check",
                                "detail": f"{c['name']}: {c.get('detail', '')}"[:200], "kind": "certain", "states": [], "roles": [r["role"]]})
            for t in r.get("tools", []):
                if not t.get("ok"):
                    out.append({"fingerprint": f"walk | agent tool | {t['name']}", "source": "role walk", "route": "(AI employee)", "rule": "agent tool",
                                "detail": f"{t['name']}: {t.get('detail', '')}"[:200], "kind": "certain", "states": [], "roles": ["agent"]})
    # WL-FLOWS: Willow Lane's production setup for its working day (wl-prod-check.py, read only): each gap is one item.
    wp = load(night / "wl-prod" / "wl-prod.json")
    if wp:
        covered.add("(Willow Lane)")
        for ch in wp.get("checks", []):
            if ch.get("ok") is False:
                out.append({"fingerprint": f"willow lane | {ch['flow']} | {ch['name']}", "source": "Willow Lane production check", "route": "(Willow Lane)",
                            "rule": "customer setup", "detail": f"{ch['name']}: {ch.get('detail', '')}"[:200], "kind": "certain", "states": [], "roles": []})
    j = load(night / "journeys" / "journeys.json")
    if j:
        covered.add("(journey)")  # WL-FLOWS: a journey that passes two nights running is gone, like a page
        for jr in j.get("journeys", []):
            if not jr.get("ok"):
                out.append({"fingerprint": f"journey | {jr['name']} | {jr.get('failedStep', '')}", "source": "journey", "route": "(journey)", "rule": "journey",
                            "detail": f"{jr['name']}: {jr.get('detail', '')}"[:200], "kind": "certain", "states": [], "roles": jr.get("roles", [])})
    a = load(night / "ai-tasks" / "ai-tasks.json")
    if a:
        for r in a.get("results", []):
            if r.get("ok") is False:
                out.append({"fingerprint": f"ai task | {a.get('set')} | {r.get('n')}", "source": "AI employee task set", "route": "(AI employee)",
                            "rule": "ai task", "detail": f"{a.get('set')} #{r.get('n')} \"{str(r.get('task', ''))[:60]}\": {'; '.join(r.get('problems', []))}"[:200],
                            "kind": "judgement", "states": [], "roles": [r.get("from", "")]})
        if a.get("error"):
            out.append({"fingerprint": f"ai task | {a.get('set')} | could not run", "source": "AI employee task set", "route": "(AI employee)",
                        "rule": "ai task", "detail": f"{a.get('set')}: could not run: {a['error']}"[:200], "kind": "certain", "states": [], "roles": []})
    return out, covered


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--night", type=Path, help="the night's folder (default: the newest under ~/.local/state/vitals-qa/night)")
    ap.add_argument("--ledger", type=Path, default=HOME / "ea-research/flow/qa-ledger")
    ap.add_argument("--top", type=int, default=10)
    args = ap.parse_args()
    nights = sorted((STATE / "night").glob("20*")) if (STATE / "night").exists() else []
    night = args.night or (nights[-1] if nights else None)
    if not night or not night.exists():
        print("qa-ledger: no night run found")
        return 2
    args.ledger.mkdir(parents=True, exist_ok=True)
    lf = args.ledger / "ledger.json"
    ledger = load(lf) or {"items": {}, "mornings": []}
    today = datetime.now(timezone.utc).date().isoformat()
    found, covered = night_findings(night)
    # the production monitor's current red, if any (its own alerts went out already)
    mon = load(STATE / "monitor" / "state.json") or {}
    for line in mon.get("red", []):
        found.append({"fingerprint": f"monitor | {line}", "source": "production monitor", "route": line.split(": ", 1)[-1].split(" ", 1)[0],
                      "rule": "monitor", "detail": line[:200], "kind": "certain", "states": ["1440-light"], "roles": [line.split(":")[0]]})
    items = ledger["items"]
    seen_now = set()
    for f in found:
        k = f["fingerprint"]
        seen_now.add(k)
        it = items.get(k)
        if not it:
            it = items[k] = {**f, "firstSeen": today, "nights": 0, "status": "open", "area": area(f["route"]) if f["route"].startswith("/") else f["route"]}
        it.update({"lastSeen": today, "detail": f["detail"], "states": sorted(set(it.get("states", [])) | set(f["states"])),
                   "roles": sorted(set(it.get("roles", [])) | set(f["roles"]))})
        if it.get("lastNight") != str(night):
            it["nights"] = it.get("nights", 0) + 1
            it["lastNight"] = str(night)
        if it["status"] == "gone":
            it["status"] = "open"
            it["reopened"] = today
        it.pop("missedNights", None) if it["status"] == "open" else None
    for k, it in items.items():
        if k in seen_now or it["status"] != "open":
            continue
        if it["route"] in covered or not it["route"].startswith("/"):
            it["missedNights"] = it.get("missedNights", 0) + 1
            if it["missedNights"] >= 2:
                it["status"] = "gone"
                it["goneSince"] = today
    # top N: open, certain first, new today first, then the widest
    open_items = [it for it in items.values() if it["status"] == "open" and it.get("lastSeen") == today]
    open_items.sort(key=lambda it: (it["kind"] != "certain", it["firstSeen"] != today, -max(1, len(it["states"])) * max(1, len(it["roles"])), it["route"]))
    top = open_items[: args.top]
    lines = []
    for i, it in enumerate(top, 1):
        new = "NEW " if it["firstSeen"] == today else f"since {it['firstSeen']} "
        lines.append(f"{i}. [{it['kind']}] {it['area']} — {it['route']} {it['rule']}: {it['detail'][:140]} "
                     f"({new}{len(it['states'])} states, roles {'/'.join(it['roles']) or '-'}; {it['source']})")
    (args.ledger / f"top10-{today}.txt").write_text("\n".join(lines) + "\n")
    counts = {s: sum(1 for it in items.values() if it["status"] == s) for s in ("open", "gone")}
    md = args.ledger / "ledger.md"
    head = "" if md.exists() else ("# Vitals QA bug ledger (QA system stage 1)\n\nOne list for the night matrix, the role walk, the journeys and the production monitor, "
                                     "grouped by fingerprint (tools/qa/vitals/qa-ledger.py). Each morning: the top 10 open items. Owner of an item: the screen area's lane.\n")
    with md.open("a") as fh:
        fh.write(head + f"\n## {today} (night {night.name}): top {len(top)} of {len(open_items)} seen last night; ledger {counts['open']} open, {counts['gone']} gone\n\n")
        fh.write("\n".join(lines) + "\n" if lines else "Nothing open.\n")
    ledger["mornings"] = (ledger.get("mornings", []) + [{"date": today, "night": str(night), "top": [it["fingerprint"] for it in top]}])[-60:]
    lf.write_text(json.dumps(ledger, indent=1))
    print(f"qa-ledger {today}: {len(found)} findings last night, {len(open_items)} open seen, top {len(top)} -> {md}")
    for ln in lines:
        print(ln)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
