"""PM-BUILD-4 (KAZUK-PM-2 phase 6, migration 2522): each person's load is read against their own benchmark, set only by
leadership (never an AI, never a colleague), seen by leadership and the person only, cleared softly (kept). The desk's
delivery read gives date moves of the last 30 days by reason and side, and the client waits apart. Synthetic tenants
only; nothing is sent."""
from datetime import timedelta

import psycopg
import pytest
from test_plan_clocks import ai, org_today
from test_pm_chat_board import plan
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def test_only_leadership_sets_a_benchmark_and_only_they_and_the_person_see_it(api, owner, worker, team):
    w = team
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Only leadership"):
        as_(api, w, w.editor, "select pulse.load_benchmark_set(%s,5,6,8,null)", (w.editor2,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Only a person"):
        ai(api, w, w.manager, "select pulse.load_benchmark_set(%s,5,6,8,null)", (w.editor,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.manager, "select pulse.load_benchmark_set(%s,6,5,8,null) r", (w.editor,))
    r = one(api, w, w.manager, "select pulse.load_benchmark_set(%s,4.5,5.5,7,'New to the team') r", (w.editor,))["r"]
    assert r["healthy"] == [4.5, 5.5] and r["reviewAbove"] == 7
    seen = lambda who: one(api, w, who, "select count(*)::int n from pulse.load_benchmark where cleared_at is null")["n"]  # noqa: E731
    assert seen(w.manager) == 1 and seen(w.editor) == 1 and seen(w.editor2) == 0
    # Cleared: back to the template's range; the row is kept.
    assert one(api, w, w.manager, "select pulse.load_benchmark_set(%s,null,null,null,null) r", (w.editor,))["r"]["cleared"] is True
    assert one(api, w, w.manager, "select count(*)::int n, count(*) filter (where cleared_at is not null)::int c from pulse.load_benchmark") == {"n": 1, "c": 1}


def test_the_desk_reads_date_moves_by_reason_and_client_waits_apart(api, owner, worker, team):
    w = team
    s, _ = plan(api, owner, w)
    today = org_today(api, w)
    one(api, w, w.lead, "select pulse.project_client_ask(%s,%s,null) r", (w.project, [s["I1"]["id"]]))
    one(api, w, w.lead, "select pulse.project_clock_move(%s,'day0',%s,'client_delay','Floor plans late',true) r", (w.project, today + timedelta(days=6)))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.pm_leadership()")
    d = one(api, w, w.manager, "select pulse.pm_leadership() d")["d"]
    assert d["clientWaits"]["open"] == 1 and d["clientWaits"]["projects"] == 1
    m = {x["reason"]: x for x in d["moves"]}
    assert m["client_delay"]["moves"] == 1 and m["client_delay"]["side"] == "client" and m["client_delay"]["steps"] >= 1
