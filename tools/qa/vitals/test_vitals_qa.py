"""QA-2: the pure parts of the Vitals QA tools: the monitor's fingerprints and alert decisions, and the ledger's merge
and morning top 10. No browser, no network: role-walk.mjs is replaced by a stand-in that prints a chosen summary, and
ea-notify by a stand-in that records its arguments.

    python3 -m pytest -q tools/qa/vitals/test_vitals_qa.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_fingerprints_drop_numbers_that_change_run_to_run():
    mon = load("prod_monitor", "prod-monitor.py")
    summary = "\n".join([
        "role walk prod monitor 1440px light, browser nivi (x), 79s: 2 findings",
        "FAIL owner      4/5 pages, 5/5 checks, 26 writes held",
        "     /erp (Billing): page 37px wider than the window",
        "     note  portal: shown",
        "ok   seller     6/6 pages, 5/5 checks",
        "(details: /tmp/x)",
    ])
    assert mon.fingerprints(summary) == ["owner: /erp (Billing): page Npx wider than the window"]


def run_monitor(tmp: Path, summaries: list[tuple[int, str]]) -> list[list[str]]:
    """Runs prod-monitor.py once per summary with stand-ins; returns the ea-notify calls of each run."""
    bin_ = tmp / "bin"
    bin_.mkdir(exist_ok=True)
    calls = tmp / "calls.jsonl"
    (bin_ / "ea-notify").write_text(f"#!/usr/bin/env python3\nimport json,sys\nopen({str(calls)!r},'a').write(json.dumps(sys.argv[1:])+'\\n')\n")
    os.chmod(bin_ / "ea-notify", stat.S_IRWXU)
    out = []
    for rc, text in summaries:
        node = bin_ / "node"
        node.write_text(f"#!/bin/sh\ncat <<'EOF'\n{text}\nEOF\nexit {rc}\n")
        os.chmod(node, stat.S_IRWXU)
        before = calls.read_text().count("\n") if calls.exists() else 0
        env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "HOME": str(tmp)}
        code = ("import importlib.util,sys;"
                f"s=importlib.util.spec_from_file_location('m',{str(HERE / 'prod-monitor.py')!r});m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
                f"m.NODE={str(node)!r};sys.argv=['x'];sys.exit(m.main())")
        subprocess.run([sys.executable, "-c", code], env=env, check=False, capture_output=True, text=True)  # exit 2 when it could not run
        lines = calls.read_text().splitlines() if calls.exists() else []
        out.append([" ".join(json.loads(x)[:4]) for x in lines[before:]])
    return out


def test_monitor_alerts_once_then_critical_on_the_second_red_then_resolves(tmp_path):
    red = "role walk prod monitor: 1 findings\nFAIL owner      4/5 pages, 5/5 checks\n     /erp (Billing): refusal: \"This view is unavailable\""
    green = "role walk prod monitor: all good\nok   owner      5/5 pages, 5/5 checks"
    calls = run_monitor(tmp_path, [(0, green), (1, red), (1, red), (1, red), (0, green)])
    assert calls[0] == []
    assert calls[1] and calls[1][0].startswith("-l important -k vitals-qa-monitor")
    assert calls[2] and calls[2][0].startswith("-l critical -k vitals-qa-monitor")
    assert calls[3] == []  # the critical alert repeats on its own until acknowledged; not sent again
    assert calls[4] and calls[4][0].startswith("--resolve vitals-qa-monitor")


def test_monitor_that_cannot_run_alerts_after_an_hour_only(tmp_path):
    calls = run_monitor(tmp_path, [(2, "role walk prod monitor: could not run: x")] * 5)
    assert [len(c) for c in calls] == [0, 0, 0, 1, 0]
    assert "vitals-qa-monitor-down" in calls[3][0]


def test_ledger_groups_by_fingerprint_and_marks_gone_after_two_clean_nights(tmp_path):
    led = load("qa_ledger", "qa-ledger.py")
    night1, night2, night3 = (tmp_path / "state/night" / d for d in ("2026-11-18", "2026-11-19", "2026-11-20"))
    finding = {"fingerprint": "/erp | R3 | button", "route": "/erp", "rule": "R3", "where": "button", "detail": "cut label", "kind": "certain",
               "states": ["360-dark-130"], "roles": ["seller"]}
    for n, fs in ((night1, [finding]), (night2, [{**finding, "states": ["412-dark-130"]}]), (night3, [])):
        n.mkdir(parents=True)
        (n / "matrix.json").write_text(json.dumps({"findings": fs}))
        (n / "walk").mkdir()
        (n / "walk/role-walk.json").write_text(json.dumps({"results": [{"role": "seller", "pages": [{"href": "/erp", "ok": True, "problems": []}], "checks": []}]}))
    ledger = tmp_path / "ledger"
    led.STATE = tmp_path / "state"
    for n in (night1, night2):
        sys.argv = ["qa-ledger", "--night", str(n), "--ledger", str(ledger)]
        assert led.main() == 0
    items = json.loads((ledger / "ledger.json").read_text())["items"]
    it = items["matrix | /erp | R3 | button"]
    assert it["status"] == "open" and it["states"] == ["360-dark-130", "412-dark-130"] and it["nights"] == 2 and it["area"] == "/erp"
    assert "/erp R3: cut label" in (ledger / "ledger.md").read_text()
    for n in (night3, night3):  # the same clean night read twice counts once per run: two clean mornings
        sys.argv = ["qa-ledger", "--night", str(n), "--ledger", str(ledger)]
        led.main()
    assert json.loads((ledger / "ledger.json").read_text())["items"]["matrix | /erp | R3 | button"]["status"] == "gone"


def test_ledger_takes_willow_lane_gaps_and_journeys_and_clears_them_when_fixed(tmp_path):
    """WL-FLOWS: a Willow Lane production gap (wl-prod-check.py) and a failed wl-* journey are ledger items; two clean
    nights in a row make them gone."""
    led = load("qa_ledger", "qa-ledger.py")
    gap = {"flow": "follow-up", "name": "a sent quotation comes back to its seller", "ok": False, "detail": "off"}
    bad = {"name": "wl-reminder", "ok": False, "failedStep": "the reminder is in the seller's bell", "detail": "not within 30 s", "roles": ["seller"]}
    nights = [tmp_path / "state/night" / d for d in ("2026-11-19", "2026-11-20", "2026-11-21")]
    for n, checks, journeys in ((nights[0], [gap], [bad]), (nights[1], [{**gap, "ok": True}], [{**bad, "ok": True}]), (nights[2], [{**gap, "ok": None}], [{"name": "wl-reminder", "ok": True}])):
        (n / "wl-prod").mkdir(parents=True)
        (n / "wl-prod/wl-prod.json").write_text(json.dumps({"checks": checks}))
        (n / "journeys").mkdir()
        (n / "journeys/journeys.json").write_text(json.dumps({"journeys": journeys}))
    ledger = tmp_path / "ledger"
    led.STATE = tmp_path / "state"
    sys.argv = ["qa-ledger", "--night", str(nights[0]), "--ledger", str(ledger)]
    assert led.main() == 0
    items = json.loads((ledger / "ledger.json").read_text())["items"]
    keys = [k for k in items if k.startswith("willow lane | follow-up") or k.startswith("journey | wl-reminder")]
    assert len(keys) == 2 and all(items[k]["status"] == "open" for k in keys)
    for n in nights[1:]:
        sys.argv = ["qa-ledger", "--night", str(n), "--ledger", str(ledger)]
        led.main()
    items = json.loads((ledger / "ledger.json").read_text())["items"]
    assert all(items[k]["status"] == "gone" for k in keys)
