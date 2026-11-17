"""PM-BUILD-1 in the browser (services/api/test/plan-clocks-browser-runner.mjs): a synthetic agency whose delivery
template runs on clocks (format 3, migration 2262). One client project, twenty days after its invoice was paid: every
input came in on day 6 (Day 0 declared), the brand blueprint is finished, creatives are under way (one late, one waiting on
another), the campaign is set up and running, and two inputs still hold "ads live" back. The walk: the project page
(where it stands, "Before ads can go live", the steps by phase), the clock dialog that refuses and names what is open, a
step's own page (its card), and a task that reads as leadership business (the ask, then the mark). 1440 and 363, light
and dark. Synthetic tenants and invented names only; nothing is sent."""
import json
import os
import subprocess
from datetime import timedelta
from pathlib import Path

import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import new_task, one, team  # noqa: F401  (team is a fixture)

PKG = {"growth": "yes", "starter": "yes"}
S = lambda i, stage, title, owner, typ, frm, a, b, after=(), **x: {"id": i, "stage": stage, "title": title, "owner": owner, "type": typ, "kind": typ, "from": frm,  # noqa: E731
                                                                  "start": a, "end": b, "after": list(after), "packages": x.pop("packages", PKG), "clientInput": x.pop("client", False), **x}
TPL = {
    "format": 3,
    "stages": [{"n": 0, "key": "s0", "label": "Stage 0 · Getting started"}, {"n": 1, "key": "s1", "label": "Phase 1 · Brand blueprint"},
               {"n": 2, "key": "s2", "label": "Phase 2 · Creatives"}, {"n": 3, "key": "s3", "label": "Phase 2 · Trust videos"}, {"n": 4, "key": "s4", "label": "Phase 3 · Ads and follow-up"}],
    "packages": [{"key": "growth", "label": "Growth"}, {"key": "starter", "label": "Starter"}],
    "categories": [{"key": "competitive", "label": "Competitive", "units": 0.6}, {"key": "normal", "label": "Normal", "units": 0.4}],
    "bandwidth": {"role": "Project lead", "short": "Lead", "healthy": [6, 7], "max": 8},
    "milestones": {"adsLive": "J3"},
    "labels": {"gate": "Before ads can go live", "clientGroup": "client group", "teamChat": "team chat"},
    "clocks": [{"key": "start", "label": "Invoice paid", "day": -7}, {"key": "day0", "label": "Inputs complete", "step": "O9"},
               {"key": "live", "label": "Ads live", "step": "J3"}, {"key": "bought", "label": "Bought on"}],
    "windows": [{"key": "claim", "label": "Refund claim window", "from": "live", "start": 30, "end": 45}],
    "steps": [
        S("O1", 0, "Paid invoice opens the project", "System", "auto", "start", 0, 0),
        S("O2", 0, "Project lead assigned", "Head of delivery", "task", "start", 0, 0),
        S("O3", 0, "Client group opened with the client and the team", "Coordinator", "task", "start", 0, 1, ["O2"]),
        S("O4", 0, "Introductory call with the client", "Project lead", "task", "start", 1, 1, ["O3"]),
        S("O5", 0, "Working conditions signed; lead number and ad budget agreed", "Project lead", "task", "start", 1, 3, ["O4"], client=True),
        S("O6", 0, "Brochure, price sheet, layouts and past-buyer list collected", "Coordinator", "task", "start", 1, 4, ["O4"], client=True),
        S("O7", 0, "Onboarding and research meeting held, recorded", "Project lead + Strategist", "task", "start", 4, 5, ["O6"], client=True),
        S("O8", 0, "Ad account, page and domain access granted", "Coordinator", "task", "start", 1, 6, ["O4"], client=True),
        S("O9", 0, "Inputs complete declared: Day 0", "Project lead", "gate", "start", 7, 7, ["O5", "O6", "O7", "O8"]),
        S("P1", 1, "Market research and competition scan", "Strategist", "task", "day0", 1, 3, ["O9"]),
        S("P2", 1, "Buyer persona strategy", "Strategist", "task", "day0", 2, 4, ["P1"]),
        S("P3", 1, "Positioning and word library", "Strategist", "task", "day0", 3, 5, ["P2"]),
        S("P4", 1, "Blueprint presented to the client", "Project lead + Strategist", "task", "day0", 5, 6, ["P3"]),
        S("C1", 2, "Image ad copy, first set of 4", "Strategist", "task", "day0", 5, 9, ["P3"]),
        S("C2", 2, "Model-led video script", "Strategist", "task", "day0", 5, 9, ["P3"]),
        S("C3", 2, "Shoot day: drone, walkthrough and model footage", "Shoot coordinator", "task", "day0", 12, 12, ["C2"]),
        S("C4", 2, "Image ad set designed", "Designer", "task", "day0", 9, 12, ["C1"], hours=[3, 4]),
        S("C5", 2, "Design confirmed by the strategist", "Strategist", "approval", "day0", 12, 12, ["C4"]),
        S("C6", 2, "Model-led video drafted", "Video editor", "task", "day0", 13, 20, ["C3", "C2"], hours=[8, 10]),
        S("C7", 2, "Brainstorming session: model video", "Project lead", "task", "day0", 20, 22, ["C6"]),
        S("C8", 2, "Model-led video delivered", "Video editor", "task", "day0", 22, 25, ["C7"]),
        S("W1", 3, "Founder interview questions prepared", "Strategist", "task", "day0", 30, 34, ["P4"]),
        S("W2", 3, "Founder interview shot", "Shoot coordinator", "task", "day0", 38, 42, ["W1"]),
        S("W3", 3, "Founder video delivered", "Video editor", "task", "day0", 43, 52, ["W2"]),
        S("W4", 3, "Testimonials shot with real buyers", "Shoot coordinator", "task", "day0", 40, 45, ["P4"], when="realBuyers"),
        S("L1", 4, "Landing page copy and build", "Project lead", "task", "day0", 8, 15, ["P3"]),
        S("L2", 4, "Landing page live, tracking tested", "Project lead", "gate", "day0", 15, 15, ["L1"]),
        S("N1", 4, "Lead capture set up: routing and alerts", "Project lead", "task", "start", 3, 19, ["O6"]),
        S("J1", 4, "Meta campaign set up and scheduled", "Project lead", "ongoing", "day0", 12, 15, ["C5"]),
        S("J3", 4, "Campaigns live; ads live date recorded", "Project lead", "milestone", "day0", 15, 21, ["J1", "L2", "N1", "O8"], gateInputs=["C5", "L2", "N1", "O8", "J1"]),
        S("J4", 4, "Client told what was set up: targeting, form, budget", "Project lead", "task", "live", 0, 2, ["J3"]),
        S("J5", 4, "Weekly performance call with the client", "Project lead", "repeating", "live", 7, None, ["J3"]),
    ],
}


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_plan_on_clocks_in_the_browser(worker, owner, api, team):  # noqa: F811
    w = team
    today = one(api, w, w.lead, "select (now() at time zone pulse.org_time_zone())::date d")["d"]  # the company's day
    with owner.transaction():
        set_tenant(owner, w.org)
        for pid, name in ((w.lead, "Asha Kireteso"), (w.manager, "Ravi Menon"), (w.editor, "Neha Jivop"), (w.editor2, "Kabir Shah")):
            owner.execute("update pulse.person set display_name=%s where id=%s", (name, pid))
        owner.execute("update pulse.project set name='Skyline Residency', title='Skyline Residency', kind='client_work' where id=%s", (w.project,))
    one(api, w, w.manager, "select pulse.delivery_template_adopt('agency-test','Agency delivery plan',%s,%s) r", (Jsonb(TPL), w.project))
    kickoff = today - timedelta(days=20)
    one(api, w, w.manager, "select pulse.project_plan_set(%s,'agency-test','growth','competitive',%s,%s) r", (w.project, kickoff, w.lead))
    with owner.transaction():
        set_tenant(owner, w.org)
        ids = {r["template_step"]: r["id"] for r in owner.execute("select template_step,id from pulse.task where project_id=%s and template_step is not null", (w.project,)).fetchall()}
        # Who does what: the strategist and coordinator steps go to two people; design and video to the others.
        for step, who in (("O3", w.editor2), ("O6", w.editor2), ("O8", w.editor2), ("P1", w.manager), ("P2", w.manager), ("P3", w.manager), ("C1", w.manager), ("C2", w.manager),
                          ("C5", w.manager), ("W1", w.manager), ("C4", w.editor2), ("C3", w.editor2), ("C6", w.editor), ("C8", w.editor), ("O2", w.manager)):
            owner.execute("update pulse.task set assignee_person_id=%s where id=%s", (who, ids[step]))
    move = lambda step, st: one(api, w, w.lead, "select pulse.task_move(%s,%s,null)", (ids[step], st))  # noqa: E731
    for s in ("O2", "O3", "O4", "O5", "O6", "O7", "O8"):
        move(s, "done")
    one(api, w, w.lead, "select pulse.project_day0_declare(%s,%s) r", (w.project, today - timedelta(days=14)))
    for s in ("P1", "P2", "P3", "P4", "C1", "C2", "C3", "L1", "L2", "N1"):
        move(s, "done")
    move("C4", "in_progress")
    move("C6", "in_progress")
    move("J1", "in_progress")
    with owner.transaction():
        set_tenant(owner, w.org)
        # Finished work was finished around its due day (the seed finishes it today).
        owner.execute("update pulse.task set done_at=least(now(), due_at) where project_id=%s and status='done' and due_at is not null", (w.project,))
    # A task that reads as leadership business, open to the team.
    pay = new_task(api, w, w.manager, title="Write the payroll rules for next month (minimum pay, increments)", projectId=None)
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config),
           "TEST_IDS": json.dumps({"project": str(w.project), "c6": str(ids["C6"]), "o9": str(ids["O9"]), "pay": str(pay), "org": str(w.org)})}
    p = subprocess.run(["node", "test/plan-clocks-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1800, check=False)
    print(p.stdout[-6000:])
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    assert "PLAN-CLOCKS OK" in p.stdout
