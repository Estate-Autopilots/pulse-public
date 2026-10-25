"""LIFECYCLE parts 2–4: value against cost (founders and HR with the salary permission, every view logged; a person
sees only their own work), role seats compared by tenure month (leadership only), and best-fit people with reasons.
Synthetic tenants, names and figures only."""
import uuid
from datetime import date, timedelta

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, new_task, one, team  # noqa: F401  (team is a fixture)

TODAY = date.today()
MONTH = TODAY.replace(day=1)


def world_money(worker, w):
    """A client with a project, its invoiced revenue this month, an unlinked client's revenue, and two salaries."""
    client, project = uuid.uuid4(), uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'Northstar')", (client, w.org))
        no = worker.execute("select coalesce(max(registry_no),0)+1 n from pulse.project").fetchone()["n"]
        worker.execute("insert into pulse.project(id,org_id,registry_no,name,title,client_id) values(%s,%s,%s,'Northstar launch','Northstar launch',%s)", (project, w.org, no, client))
        key = MONTH.strftime("%Y-%m")
        worker.execute("""insert into pulse_priv.finance_live_model(org_id,body) values(%s,%s)
                          on conflict(org_id) do update set body=excluded.body""",
                       (w.org, Jsonb({"revenue": {"clients": [{"client": "Northstar Developers LLP", "months": {key: 90000.0}},
                                                              {"client": "Unlisted Buyer", "months": {key: 10000.0}}]}})))
        for person, amount in ((w.editor, 30000), (w.editor2, 40000)):
            worker.execute("""insert into pulse_priv.hr_compensation(org_id,person_id,effective_month,kind,amount,source_file_id,source_name,source_sheet,basis)
                              values(%s,%s,%s,'monthly',%s,'synthetic','Synthetic payroll','Sheet1','test')""", (w.org, person, MONTH, amount))
        worker.execute("update pulse.people_profile set joined_on=%s where person_id in (%s,%s)", (TODAY - timedelta(days=400), w.editor, w.editor2))
    return client, project


def finish(api, worker, w, who, title, project=None, n=1, category=None, by=None):
    """`who` finishes n tasks given to them by `by` (leadership by default). INTEGRITY (0910): a task a person makes
    and finishes alone counts no work unit, so it cannot move their value; pass by=who for that case."""
    ids = []
    for i in range(n):
        t = new_task(api, w, by or w.manager, title=f"{title} {i + 1}", assigneeId=str(who), **({"projectId": str(project)} if project else {}))
        as_(api, w, who, "select pulse.task_move(%s,'in_progress')", (t,))
        as_(api, w, who, "select pulse.task_move(%s,'done')", (t,))
        ids.append(t)
    if category:
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("update pulse.task set category=%s where id=any(%s)", (category, ids))
    return ids


def grant_salary(worker, w, person):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.sensitive_permission(org_id,person_id,permission,granted_by) values(%s,%s,'hr.salary.read','test') on conflict do nothing", (w.org, person))


def test_value_against_cost_is_protected_like_salary(api, worker, team):
    w = team
    _, project = world_money(worker, w)
    finish(api, worker, w, w.editor, "Cut the Northstar teaser", project, n=3)
    finish(api, worker, w, w.editor2, "Internal reel", None, n=1)
    # Tasks editor2 makes and finishes alone, for Northstar, change nothing below (INTEGRITY 0910).
    finish(api, worker, w, w.editor2, "Self-made Northstar work", project, n=5, by=w.editor2)
    # Like salaries: HR and leadership read it; an admin only with the salary permission; never the person or a colleague.
    for who in (w.editor, w.editor2, w.manager):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, who, "select pulse.value_view(null)")
    grant_salary(worker, w, w.manager)
    assert one(api, w, w.manager, "select pulse.value_view(null) v")["v"]["rows"]
    v = one(api, w, w.lead, "select pulse.value_view(%s) v", (MONTH,))["v"]
    rows = {r["person"]["id"]: r for r in v["rows"]}
    ed, ed2 = rows[str(w.editor)], rows[str(w.editor2)]
    # Northstar's 90,000 goes to the editor (the only one who worked for Northstar); the unlinked 10,000 is shared by
    # work units this month (3 and 1).
    assert ed["linked"] == 90000 and ed["pooled"] == 7500 and ed["value"] == 97500 and ed["cost"] == 30000
    assert ed2["linked"] == 0 and ed2["pooled"] == 2500 and ed2["ratio"] == 0.06
    assert ed["tasks"] == 3 and ed["band"]["band"] in ("strong", "on_par") and ed2["band"]["band"] == "below"
    assert v["company"]["revenue"] == 100000 and v["company"]["coverage"] == 0.9 and "median" in v["company"]
    assert "Value ÷ cost" in v["method"]["band"] and ed["confidence"] in ("medium", "high")
    # Every view is written to the access log, one line per person shown.
    with worker.transaction():
        set_tenant(worker, w.org)
        logged = {r["subject_person_id"] for r in worker.execute("select subject_person_id from privacy.access_log where resource='hr.value' and viewer_id=%s", (w.lead,))}
    assert {w.editor, w.editor2} <= logged
    # A person sees their own work and value, never a cost.
    mine = one(api, w, w.editor, "select pulse.value_mine(3) m")["m"]
    assert mine[-1]["tasks"] == 3 and all("cost" not in m and "ratio" not in m for m in mine)
    # A new joiner is not judged in their first month.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.people_profile set joined_on=%s where person_id=%s", (TODAY - timedelta(days=5), w.editor2))
    v = one(api, w, w.lead, "select pulse.value_view(%s) v", (MONTH,))["v"]
    assert {r["person"]["id"]: r for r in v["rows"]}[str(w.editor2)]["band"]["band"] == "ramp"


def test_seats_compare_holders_by_tenure_month(api, worker, team):
    w = team
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.people_profile set role='Video Editor' where person_id in (%s,%s)", (w.editor, w.editor2))
        worker.execute("update pulse.people_profile set joined_on=%s where person_id=%s", (TODAY - timedelta(days=300), w.editor))
        worker.execute("update pulse.people_profile set joined_on=%s where person_id=%s", (TODAY - timedelta(days=20), w.editor2))
    finish(api, worker, w, w.editor, "Edit", None, n=2, category="video_edit")
    as_(api, w, w.lead, "select pulse.lifecycle_move(%s,'left',%s)", (w.editor, Jsonb({"leftType": "resigned", "effectiveOn": TODAY.isoformat()})))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.seat_list()")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.lead, "select pulse.seat_list()")  # HR without leadership: not for comparing people
    seats = one(api, w, w.manager, "select pulse.seat_list() s")["s"]
    seat = next(s for s in seats if s["role"] == "Video Editor" and s["pod"] == "Pod 1")
    assert {h["name"] for h in seat["holders"]} == {"Editor One", "Editor Two"} and seat["current"] == 1
    cmp = one(api, w, w.manager, "select pulse.seat_compare(%s) c", (seat["id"],))["c"]
    by = {h["person"]["name"]: h for h in cmp["holders"]}
    assert by["Editor Two"]["tooEarly"] is True and by["Editor One"]["tooEarly"] is False
    assert by["Editor One"]["months"][0]["k"] == 1 and sum(m["tasks"] for m in by["Editor One"]["months"]) == 2
    assert cmp["cost"] is False and all(m["cost"] is None for m in by["Editor One"]["months"])  # cost needs the salary permission
    assert "too early" in cmp["method"].lower()
    # Leadership can add a past holder by hand (a predecessor in another pod).
    hid = one(api, w, w.manager, "select pulse.seat_holder_add(%s,%s,%s,%s,'Covered the seat before Pod 2 existed') id",
              (seat["id"], w.outsider, TODAY - timedelta(days=700), TODAY - timedelta(days=500)))["id"]
    assert hid and len(one(api, w, w.manager, "select pulse.seat_compare(%s) c", (seat["id"],))["c"]["holders"]) == 3


def test_fit_people_explain_themselves(api, worker, team):
    w = team
    client, project = world_money(worker, w)
    finish(api, worker, w, w.editor, "Cut the Northstar teaser", project, n=4, category="video_edit")
    # Pod Two's outsider has video editing as an agreed domain; the pod head is on leave until tomorrow.
    d = one(api, w, w.lead, "select pulse.work_domain_propose(%s,%s) id", (w.outsider, Jsonb({"title": "Video editing", "categories": ["video_edit"], "basis": "policy"})))["id"]
    assert d
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,status,days)
                          values(%s,%s,%s,%s,'casual','approved',2)""", (w.org, w.editor2, TODAY - timedelta(days=1), TODAY + timedelta(days=1)))
    fit = one(api, w, w.editor2, "select pulse.fit_people(%s) f", (Jsonb({"project": str(project), "category": "video_edit", "limit": 4}),))["f"]
    people = {p["name"]: p for p in fit["people"]}
    assert fit["client"] == str(client) and fit["category"] == "video_edit"
    assert people["Editor One"]["why"].startswith("Did 4 similar") and "(4 for this client)" in people["Editor One"]["why"]
    assert people["Pod Two Outsider"]["why"].startswith("In their domain: Video editing")
    assert "on leave, back" in people["Editor Two"]["why"] and people["Editor Two"]["score"] < people["Editor One"]["score"]
    order = [p["name"] for p in fit["people"]]
    assert order.index("Editor Two") > order.index("Editor One")
    # Someone HR is asked to review as "possibly left" is not proposed.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.lifecycle_review(org_id,person_id,status,confidence,reasons) values(%s,%s,'open','high','[]')""", (w.org, w.editor))
    fit = one(api, w, w.editor2, "select pulse.fit_people(%s) f", (Jsonb({"project": str(project), "category": "video_edit"}),))["f"]
    assert "Editor One" not in {p["name"] for p in fit["people"]}


def test_staffing_gaps_name_open_work_load_and_empty_seats(api, worker, team):
    w = team
    for i in range(3):
        new_task(api, w, w.lead, title=f"Edit the pool reel {i}", pool={"scope": "company"})
    for i in range(9):
        new_task(api, w, w.editor2, title=f"Review cut {i}")
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.people_profile set role='Video Editor' where person_id=%s", (w.outsider,))
    as_(api, w, w.lead, "select pulse.lifecycle_move(%s,'left',%s)", (w.outsider, Jsonb({"leftType": "resigned", "effectiveOn": TODAY.isoformat()})))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.staffing_gaps()")
    g = one(api, w, w.lead, "select pulse.staffing_gaps() g")["g"]
    assert sum(x["open"] for x in g["openWork"]) >= 3 and any(x["pooled"] >= 3 for x in g["openWork"])
    assert [o["name"] for o in g["overloaded"]] == ["Editor Two"]
    assert any(s["lastHolder"]["name"] == "Pod Two Outsider" for s in g["vacantSeats"])
