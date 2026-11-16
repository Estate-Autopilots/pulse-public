"""GAP-FOUNDER-VIEW: one founder view of every company a person runs, designations across companies, and the Google
Calendar link (switched off until the Google client exists). Synthetic companies and people only.

The owner's case (MASTER-BACKLOG PW-06, PM-07, PM-08): one human is an admin in several companies on one Pulse account and
wants one screen that says what is going on where. Each company is read inside itself as the account's person there
(pulse.founder_today is SECURITY INVOKER, called once per seat by services/api/src/founder.ts), so its row security
decides every row; nothing reads two organisations in one query.
"""
import json
import os
import subprocess
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb  # noqa: F401
from conftest import dsn
from types import SimpleNamespace
from helpers import NOTICE_PURPOSES, build_world, new_code
from test_my_day import _staff_ready, _token
from pulse_sdk.db import set_tenant
from test_erp_invoice import as_, draft, issue, one, person, setup_company
from test_kazuk_gaps import backdate_issued, owner_sql

IST = timezone(timedelta(hours=5, minutes=30))


def _account(owner, handle, *seats, name="Synthetic Person"):
    """One Pulse account holding the given (org, person) seats, named as its person is."""
    account = uuid.uuid4()
    with owner.transaction():
        owner.execute("insert into pulse_priv.pulse_account(id,handle,display_name,last_org) values(%s,%s,%s,%s)", (account, handle, name, seats[0][0]))
        owner.execute("insert into pulse_priv.handle_name(handle,kind,ref) values(%s,'person',%s)", (handle, account))
        for org, pid in seats:
            owner.execute("insert into pulse_priv.account_member(account_id,member_org,person_id,kind) values(%s,%s,%s,'staff')", (account, org, pid))
    return account


def _title(owner, w, pid, title):
    owner_sql(owner, w, """insert into pulse.people_profile(org_id,person_id,role,evidence) values(%s,%s,%s,'{}')
        on conflict (person_id) do update set role=excluded.role""", (w.org, pid, title))


def _grant(worker, w, pid, role):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2026-01-01')", (w.org, pid, role))


def _today(api, org, pid):
    with api.transaction():
        set_tenant(api, org, pid)
        return api.execute("select pulse.founder_today() d").fetchone()["d"]


@pytest.fixture
def founder(worker, owner, api):
    """Kedab: admin (and leadership, so billing) in a, admin in b, a plain member in c, and a personal workspace p with
    Focus weights that put b first. Diya works in a and b on her own account."""
    a, b, c = (build_world(worker, owner, api) for _ in range(3))
    ka = person(worker, a, "Synthetic Kedab", "admin"); _grant(worker, a, ka, "leadership"); _title(owner, a, ka, "Founder")
    kb = person(worker, b, "Synthetic Kedab", "admin"); _title(owner, b, kb, "Adviser")
    kc = person(worker, c, "Synthetic Kedab")
    da = person(worker, a, "Synthetic Diya"); _title(owner, a, da, "Head of sales")
    db = person(worker, b, "Synthetic Diya"); _title(owner, b, db, "Adviser")
    handle = f"kedab{uuid.uuid4().int % 9000 + 1000}"  # a readable synthetic handle (shown on the profile)
    account = _account(owner, handle, (a.org, ka), (b.org, kb), (c.org, kc), name="Synthetic Kedab")
    dhandle = "diya" + uuid.uuid4().hex[:8]
    _account(owner, dhandle, (a.org, da), (b.org, db), name="Synthetic Diya")
    # The personal workspace: an organisation of kind personal that belongs to Kedab's account.
    p, kp = uuid.uuid4(), uuid.uuid4()
    code = new_code()
    with worker.transaction():
        set_tenant(worker, p)
        worker.execute("insert into pulse.org(id,slug,name,code,kind,personal_account) values(%s,%s,'Synthetic Kedab HQ',%s,'personal',%s)", (p, f"org-{p}", code, account))
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Kedab','staff')", (kp, p))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (p, kp))
    with owner.transaction():
        owner.execute("insert into pulse_priv.account_member(account_id,member_org,person_id,kind) values(%s,%s,%s,'staff')", (account, p, kp))
    with owner.transaction():
        set_tenant(owner, p)
        owner.execute("insert into pulse.focus_company(org_id,key,name,weight,sort) values(%s,'bee',%s,30,0),(%s,'ay',%s,10,1)",
                      (p, f"Synthetic {b.code}", p, f"Synthetic {a.code} / Sales"))
    return dict(a=a, b=b, c=c, p=p, ka=ka, kb=kb, kc=kc, kp=kp, da=da, db=db, account=account, handle=handle, dhandle=dhandle)


def test_each_company_is_read_inside_itself_and_only_for_its_admin(api, worker, owner, founder):
    f = founder; a, b, c = f["a"], f["b"], f["c"]
    today = datetime.now(IST).date()
    # a: a bill 5 days late (₹1,00,000 + GST), a late task, a block on a client's project, one person in today, a paused AI.
    client = uuid.uuid4()
    owner_sql(owner, a, "insert into pulse.client(id,org_id,display_name) values(%s,%s,'Lotus Interiors')", (client, a.org))
    setup_company(api, a, f["ka"])
    inv = draft(api, a, f["ka"], taxable=10000000, client=client)
    owner_sql(owner, a, "update pulse.erp_document set due_date=(now() at time zone 'Asia/Kolkata')::date-5 where id=%s", (inv,))
    issue(api, a, f["ka"], inv)
    late = uuid.uuid4()
    owner_sql(owner, a, """insert into pulse.task(id,org_id,title,status,priority,assignee_person_id,due_at,created_by)
        values(%s,%s,'Send the Harbor drawings','open','high',%s,now()-interval '3 days',%s)""", (late, a.org, a.editor2, f["ka"]))
    owner_sql(owner, a, "update pulse.project set client_id=%s where id=%s", (client, a.project))
    owner_sql(owner, a, """insert into pulse.blocker(org_id,project_id,blocker_key,opened_at,owner_side,source)
        values(%s,%s,'client_inputs_missing',now()-interval '2 days','client','declared')""", (a.org, a.project))
    owner_sql(owner, a, "insert into pulse.attendance_entry(org_id,person_id,work_date,checked_in_at,mode) values(%s,%s,%s,now(),'office')", (a.org, a.editor, today))
    ai = person(worker, a, "Synthetic Studio AI")
    owner_sql(owner, a, """insert into pulse.agent_member(org_id,person_id,owner_person_id,employee_no,employee_id,paused_reason)
        values(%s,%s,%s,(select coalesce(max(employee_no),0)+1 from pulse.agent_member where org_id=%s),%s,'Out of budget for today')""",
              (a.org, ai, f["ka"], a.org, f"{a.code}-AI-{uuid.uuid4().hex[:4]}"))

    d = _today(api, a.org, f["ka"])
    assert d["role"] == "Founder" and d["access"] == "owner" and d["kind"] == "company"
    assert d["money"]["late"] == {"count": 1, "amount": 11800000} and d["money"]["atRisk"] >= 11800000
    assert d["money"]["topLate"]["id"] == str(inv) and d["money"]["topLate"]["age"] == 5 and d["money"]["topLate"]["buyer"]
    assert d["tasksLate"]["count"] == 1 and d["tasksLate"]["top"]["title"] == "Send the Harbor drawings" and d["tasksLate"]["top"]["days"] == 3
    assert d["clientIssues"]["count"] == 1 and d["clientIssues"]["top"]["client"] == "Lotus Interiors"
    # People: the AI employee is not counted as a person; one person checked in.
    staff = one(api, a, f["ka"], "select count(*)::int n from pulse.person where status='active' and side='staff'")["n"]
    assert d["people"]["in"] == 1 and d["people"]["total"] == staff - 1
    assert d["ai"] == {"total": 1, "working": 0, "stuck": 1, "top": {"id": str(ai), "name": "Synthetic Studio AI", "why": "paused", "task": None}}
    # The next thing is the biggest late bill.
    assert d["next"]["kind"] == "late_bill" and d["next"]["id"] == str(inv)

    # b: nothing of a's shows there; Kedab is an adviser there, so "admin", and there is no billing (null money).
    e = _today(api, b.org, f["kb"])
    assert e["role"] == "Adviser" and e["access"] == "admin" and e["money"] is None
    assert e["tasksLate"]["count"] == 0 and e["clientIssues"]["count"] == 0 and e["ai"]["total"] == 0 and e["next"] is None
    # Not an admin: nothing. Kedab in c (a member), a's own member, nobody signed in, and Kedab's a-person read inside b.
    assert _today(api, c.org, f["kc"]) is None
    assert _today(api, a.org, a.editor) is None
    assert _today(api, a.org, None) is None
    assert _today(api, b.org, f["ka"]) is None
    # Once the bill is paid off the list, a stuck AI employee is the next thing.
    backdate_issued(owner, a, "update pulse.erp_document set due_date=(now() at time zone 'Asia/Kolkata')::date+3 where id=%s", (inv,))
    d = _today(api, a.org, f["ka"])
    assert d["money"]["late"]["count"] == 0 and d["money"]["dueWeek"] == {"count": 1, "amount": 11800000}
    assert d["next"]["kind"] == "ai_stuck" and d["next"]["name"] == "Synthetic Studio AI"


def test_people_and_roles_across_companies(api, founder):
    f = founder; a, b = f["a"], f["b"]
    people = one(api, a, f["ka"], "select pulse.founder_people() p")["p"]
    diya = [x for x in people if x["id"] == str(f["da"])]
    assert len(diya) == 1 and diya[0]["role"] == "Head of sales" and diya[0]["handle"].startswith("diya")
    # Never the viewer, never someone with no Pulse account; only this organisation's people.
    assert str(f["ka"]) not in {x["id"] for x in people} and str(f["db"]) not in {x["id"] for x in people}
    assert {x["id"] for x in one(api, b, f["kb"], "select pulse.founder_people() p")["p"]} == {str(f["db"])}
    # A member gets nothing.
    assert one(api, a, a.editor, "select pulse.founder_people() p")["p"] is None
    # Kedab's own roles in every company (the personal workspace left out), read from any seat.
    roles = one(api, b, f["kb"], "select pulse.account_roles() r")["r"]
    got = {r["company"]: r["role"] for r in roles}
    assert got == {f"Synthetic {a.code}": "Founder", f"Synthetic {b.code}": "Adviser", f"Synthetic {f['c'].code}": None}
    assert one(api, a, a.editor, "select pulse.account_roles() r")["r"] == []


def test_focus_weights_are_read_in_the_personal_workspace_only(api, founder):
    f = founder
    with api.transaction():
        set_tenant(api, f["p"], f["kp"])
        assert api.execute("select pulse.org_kind() k").fetchone()["k"] == "personal"
        assert [r["key"] for r in api.execute("select key from pulse.focus_company order by sort").fetchall()] == ["bee", "ay"]
    # The same table read inside a company shows none of the workspace's rows.
    with api.transaction():
        set_tenant(api, f["a"].org, f["ka"])
        assert api.execute("select count(*)::int n from pulse.focus_company").fetchone()["n"] == 0


def test_calendar_link_is_each_persons_own_and_lists_timed_work(api, owner, admin, founder):
    f = founder; a = f["a"]
    for t in ("calendar_link", "calendar_pushed"):
        r = admin.execute("select relrowsecurity r, relforcerowsecurity f from pg_class where oid=('pulse.'||%s)::regclass", (t,)).fetchone()
        assert r["r"] and r["f"], t
        assert admin.execute("select count(*)::int n from pg_policies where schemaname='pulse' and tablename=%s and policyname='tenant'", (t,)).fetchone()["n"] == 1
    r = admin.execute("select relrowsecurity r, relforcerowsecurity f from pg_class where oid='pulse_priv.calendar_attempt'::regclass").fetchone()
    assert r["r"] and r["f"]
    # The API never reads the link table (and so never the token) directly.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, a, f["ka"], "select token_sealed from pulse.calendar_link")
    # One-use state: a different session gets nothing, the right one the verifier once.
    s1, s2 = "a" * 64, "b" * 64
    as_(api, a, f["ka"], "select pulse.calendar_begin(%s,%s,%s)", (s1, s2, "v" * 50))
    assert one(api, a, f["ka"], "select pulse.calendar_take(%s,%s) v", (s1, "c" * 64))["v"] is None
    as_(api, a, f["ka"], "select pulse.calendar_begin(%s,%s,%s)", (s1, s2, "v" * 50))
    assert one(api, a, a.editor, "select pulse.calendar_take(%s,%s) v", (s1, s2))["v"] is None
    assert one(api, a, f["ka"], "select pulse.calendar_take(%s,%s) v", (s1, s2))["v"] == "v" * 50
    assert one(api, a, f["ka"], "select pulse.calendar_take(%s,%s) v", (s1, s2))["v"] is None
    # Saved, the state shows the address and never the token; another person (and another company) has none.
    as_(api, a, f["ka"], "select pulse.calendar_save('Kedab@Example.com','k1','wrapped','sealed')")
    st = one(api, a, f["ka"], "select pulse.calendar_state() s")["s"]
    assert st["address"] == "kedab@example.com" and st["status"] == "connected" and "token_sealed" not in str(st) and "sealed" not in st.values()
    assert one(api, a, a.editor, "select pulse.calendar_state() s")["s"] is None
    assert one(api, f["b"], f["kb"], "select pulse.calendar_state() s")["s"] is None
    assert [r["address"] for r in as_(api, a, a.editor, "select * from pulse.calendar_sealed()")] == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, a, None, "select pulse.calendar_state()")
    # What goes on the calendar: Kedab's own work with a due time, not a due date alone, not a colleague's.
    tomorrow = (datetime.now(IST) + timedelta(days=1)).date()
    timed, dated, theirs = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    owner_sql(owner, a, """insert into pulse.task(id,org_id,title,status,assignee_person_id,due_at,created_by) values
        (%s,%s,'Call the bank','open',%s,(%s::date+time '10:30') at time zone 'Asia/Kolkata',%s),
        (%s,%s,'Some day work','open',%s,(%s::date+time '18:00') at time zone 'Asia/Kolkata',%s),
        (%s,%s,'Diya''s call','open',%s,(%s::date+time '11:00') at time zone 'Asia/Kolkata',%s)""",
              (timed, a.org, f["ka"], tomorrow, f["ka"], dated, a.org, f["ka"], tomorrow, f["ka"], theirs, a.org, f["da"], tomorrow, f["ka"]))
    items = one(api, a, f["ka"], "select pulse.calendar_items() i")["i"]
    assert [(i["source"], i["title"]) for i in items] == [("task", "Call the bank")]
    as_(api, a, f["ka"], "select pulse.calendar_set(false,null)")
    assert one(api, a, f["ka"], "select pulse.calendar_state() s")["s"]["pushTasks"] is False
    # Pushed rows are each person's own too.
    as_(api, a, f["ka"], "insert into pulse.calendar_pushed(org_id,person_id,source,source_id,event_id,fingerprint) values(%s,%s,'task',%s,'pulse0abc12',%s)",
        (a.org, f["ka"], timed, "0" * 64))
    assert as_(api, a, a.editor, "select * from pulse.calendar_pushed") == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, a, a.editor, "insert into pulse.calendar_pushed(org_id,person_id,source,source_id,event_id,fingerprint) values(%s,%s,'task',%s,'pulse0abc13',%s)",
            (a.org, f["ka"], uuid.uuid4(), "0" * 64))
    as_(api, a, f["ka"], "select pulse.calendar_disconnect()")
    assert one(api, a, f["ka"], "select pulse.calendar_state() s")["s"] is None
    assert as_(api, a, f["ka"], "select * from pulse.calendar_pushed") == []


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_founder_view_in_the_browser(api, worker, owner, founder):
    """services/api/test/founder-browser-runner.mjs: a synthetic owner with three companies and a personal workspace.
    Northstar Realty: a late bill, a paused AI employee, a late task, a client's block, one person in. Brightpath Labs
    (first by Focus weight): an adviser seat, a late task. Kite Studio: all clear. 1440 and 363, light and dark
    (PULSE_FV_SCREENSHOTS=<dir> keeps the shots)."""
    f = founder; a, b, c = f["a"], f["b"], f["c"]
    names = {a.org: "Northstar Realty", b.org: "Brightpath Labs", c.org: "Kite Studio"}
    # Each company's name and its own @handle (as a real company has; the switcher shows it beside your access).
    for w, name in ((a, names[a.org]), (b, names[b.org]), (c, names[c.org])):
        owner_sql(owner, w, "update pulse.org set name=%s, handle=%s where id=%s", (name, name.split()[0].lower() + w.code.lower(), w.org))
    # Kedab is an admin of Kite Studio too (three companies), and the Focus weights name the companies. Diya runs one
    # company (admin of Northstar Realty): her page is the empty one, naming it.
    _grant(worker, c, f["kc"], "admin")
    _grant(worker, a, f["da"], "admin")
    with owner.transaction():
        set_tenant(owner, f["p"])
        owner.execute("update pulse.focus_company set name='Brightpath Labs' where org_id=%s and key='bee'", (f["p"],))
        owner.execute("update pulse.focus_company set name='Northstar Realty / Sales' where org_id=%s and key='ay'", (f["p"],))
        owner.execute("insert into pulse.focus_company(org_id,key,name,weight,sort) values(%s,'kite','Kite Studio',5,2)", (f["p"],))
    client = uuid.uuid4()
    owner_sql(owner, a, "insert into pulse.client(id,org_id,display_name) values(%s,%s,'Lotus Interiors')", (client, a.org))
    setup_company(api, a, f["ka"])
    inv = draft(api, a, f["ka"], taxable=10000000, client=client)
    owner_sql(owner, a, "update pulse.erp_document set due_date=(now() at time zone 'Asia/Kolkata')::date-5 where id=%s", (inv,))
    issue(api, a, f["ka"], inv)
    soon = draft(api, a, f["ka"], taxable=6000000, client=client)
    owner_sql(owner, a, "update pulse.erp_document set due_date=(now() at time zone 'Asia/Kolkata')::date+2 where id=%s", (soon,))
    issue(api, a, f["ka"], soon)
    owner_sql(owner, a, """insert into pulse.task(id,org_id,title,status,priority,assignee_person_id,due_at,created_by)
        values(%s,%s,'Send the Harbor drawings','open','high',%s,now()-interval '3 days',%s)""", (uuid.uuid4(), a.org, a.editor2, f["ka"]))
    owner_sql(owner, a, "update pulse.project set client_id=%s where id=%s", (client, a.project))
    owner_sql(owner, a, """insert into pulse.blocker(org_id,project_id,blocker_key,opened_at,owner_side,source)
        values(%s,%s,'Floor plan from the client',now()-interval '2 days','client','declared')""", (a.org, a.project))
    owner_sql(owner, a, "insert into pulse.attendance_entry(org_id,person_id,work_date,checked_in_at,mode) values(%s,%s,(now() at time zone 'Asia/Kolkata')::date,now(),'office')", (a.org, a.editor))
    ai = person(worker, a, "Studio AI")
    owner_sql(owner, a, """insert into pulse.agent_member(org_id,person_id,owner_person_id,employee_no,employee_id,paused_reason)
        values(%s,%s,%s,(select coalesce(max(employee_no),0)+1 from pulse.agent_member where org_id=%s),%s,'Out of budget for today')""",
              (a.org, ai, f["ka"], a.org, f"{a.code}-AI-{uuid.uuid4().hex[:4]}"))
    owner_sql(owner, b, """insert into pulse.task(id,org_id,title,status,assignee_person_id,due_at,created_by)
        values(%s,%s,'Review the pitch deck','open',%s,now()-interval '1 day',%s)""", (uuid.uuid4(), b.org, f["kb"], f["kb"]))
    owner_sql(owner, a, "update pulse.person set display_name='Diya Nair' where id=%s", (f["da"],))
    owner_sql(owner, b, "update pulse.person set display_name='Diya Nair' where id=%s", (f["db"],))
    with owner.transaction():
        owner.execute("update pulse_priv.pulse_account set display_name='Diya Nair' where handle=%s", (f["dhandle"],))
    with worker.transaction():
        set_tenant(worker, a.org)
        for who, handle in ((f["ka"], "kedab"), (f["da"], "diya")):
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (a.org, f"{handle}@{a.domain}", who))
    # Kedab's own workspace is a ready staff seat (the privacy notice read, a profile), and the browser opens there with a
    # session minted by the account switch, as the organisation switcher does (test_my_day._token).
    with owner.transaction():
        set_tenant(owner, f["p"])
        owner.execute("""insert into privacy.notice (org_id, id, language, body_md, purposes, published_at)
                         values (%s, 'staff-v1', 'en', 'Synthetic staff notice', %s, now() - interval '30 days')""", (f["p"], NOTICE_PURPOSES))
    _staff_ready(api, worker, SimpleNamespace(org=f["p"]), f["kp"])
    token = _token(api, a, f["ka"], f["p"], owner)
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config),
           "TEST_IDS": json.dumps({"personal": str(f["p"]), "token": token, "orgs": [str(a.org), str(b.org), str(c.org)], "names": [names[a.org], names[b.org], names[c.org]],
                                   "order": [names[b.org], names[a.org], names[c.org]]}),
           "TEST_EMAILS": json.dumps({"founder": f"kedab@{a.domain}", "diya": f"diya@{a.domain}"})}
    p = subprocess.run(["node", "test/founder-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    print(p.stdout[-600:])
