"""KAZUK-GAPS (1853): what was promised to Kazuk. The CEO screen's money at risk (overdue invoices, work not billed yet,
quotations above a threshold with no answer, each with amount and age) and client-service issues raised today; a
salesperson's pipeline (quotations by stage, follow-ups due, won and lost this month); and unfinished forms kept per
person on the server (A12). Synthetic tenants, people, clients and figures only."""
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import (  # noqa: F401  (erp is a fixture)
    as_,
    draft,
    erp,
    issue,
    one,
    person,
)


def owner_sql(owner, w, sql, args=()):
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute(sql, args)


def backdate_issued(owner, w, sql, args=()):
    """Move an issued document back in time for the test. erp_document_guard refuses any change to an issued document
    (and stamps updated_at), so it is paused inside this one transaction only, as test_notification_outbox does."""
    with owner.transaction():
        owner.execute("set local role pulse_owner")
        owner.execute("alter table pulse.erp_document disable trigger erp_document_guard")
        set_tenant(owner, w.org)
        owner.execute(sql, args)
        owner.execute("alter table pulse.erp_document enable trigger erp_document_guard")


@pytest.fixture
def world(worker, erp):  # noqa: F811
    w = erp
    w.sales = person(worker, w, "Synthetic Sales")
    return w


def test_money_at_risk_lists_overdue_unbilled_and_stalled_with_amount_and_age(api, owner, world):
    w = world
    # An invoice 10 days overdue, ₹1,00,000 + GST.
    inv = draft(api, w, w.finance, taxable=10000000, client=w.client)
    owner_sql(owner, w, "update pulse.erp_document set due_date=(now() at time zone 'Asia/Kolkata')::date-10 where id=%s", (inv,))
    issue(api, w, w.finance, inv)
    # A big quotation sent 12 days ago with no answer, and a small one (below the threshold).
    big = draft(api, w, w.finance, "quotation", taxable=5000000, client=w.client)
    small = draft(api, w, w.finance, "quotation", taxable=100000, client=w.client)
    for q in (big, small):
        issue(api, w, w.finance, q)
        backdate_issued(owner, w, "update pulse.erp_document set issued_at=now()-interval '12 days',sent_at=null,updated_at=now()-interval '12 days' where id=%s", (q,))
    # An accepted quotation with no invoice made from it yet.
    acc = draft(api, w, w.finance, "quotation", taxable=3000000, client=w.client)
    issue(api, w, w.finance, acc)
    owner_sql(owner, w, "update pulse.erp_document set status='accepted' where id=%s", (acc,))

    m = one(api, w, w.founder, "select pulse.money_at_risk(7, 2500000) m")["m"]
    assert m["overdue"]["count"] == 1 and m["overdue"]["amount"] == 11800000
    assert m["overdue"]["items"][0]["id"] == str(inv) and m["overdue"]["items"][0]["age"] == 10
    assert [x["id"] for x in m["stalled"]["items"]] == [str(big)] and m["stalled"]["items"][0]["age"] >= 12
    assert m["stalled"]["amount"] == 5900000
    assert [(x["id"], x["why"]) for x in m["unbilled"]["items"]] == [(str(acc), "accepted")]
    # Once an invoice is made from it, it is billed.
    inv2 = draft(api, w, w.finance, taxable=3000000, client=w.client)
    owner_sql(owner, w, "update pulse.erp_document set source_id=%s where id=%s", (acc, inv2))
    issue(api, w, w.finance, inv2)
    assert one(api, w, w.founder, "select pulse.money_at_risk() m")["m"]["unbilled"]["count"] == 0
    # A raised threshold leaves the big quotation out; bad arguments are refused; a member sees no rupees (null).
    assert one(api, w, w.founder, "select pulse.money_at_risk(7, 9000000) m")["m"]["stalled"]["count"] == 0
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.founder, "select pulse.money_at_risk(0, 1)")
    assert one(api, w, w.member, "select pulse.money_at_risk() m")["m"] is None


def test_client_issues_raised_today_reach_leadership_only(api, owner, world):
    w = world
    owner_sql(owner, w, "update pulse.project set client_id=%s where id=%s", (w.client, w.project))
    owner_sql(owner, w, """insert into pulse.blocker(org_id,project_id,blocker_key,opened_at,owner_side,source)
        values(%s,%s,'client_inputs_missing',now(),'client','declared'),(%s,%s,'old_one',now()-interval '3 days','client','declared')""", (w.org, w.project, w.org, w.project))
    a = one(api, w, w.founder, "select pulse.cs_alerts_today() a")["a"]
    assert [(x["kind"], x["title"], x["client"]) for x in a] == [("blocked", "client_inputs_missing", "Northstar Homes")]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.member, "select pulse.cs_alerts_today()")


def test_a_salesperson_sees_their_pipeline_by_stage_follow_ups_and_this_month(api, owner, world):
    w = world
    q = {}
    for name, taxable in (("draft", 100000), ("sent", 2000000), ("won", 3000000), ("lost", 400000), ("other", 999900)):
        q[name] = draft(api, w, w.finance, "quotation", taxable=taxable, client=w.client)
        if name != "other":
            owner_sql(owner, w, "update pulse.erp_document set salesperson_id=%s where id=%s", (w.sales, q[name]))
        if name != "draft":
            issue(api, w, w.finance, q[name])
    owner_sql(owner, w, "update pulse.erp_document set status='accepted' where id=%s", (q["won"],))
    owner_sql(owner, w, "update pulse.erp_document set status='declined' where id=%s", (q["lost"],))
    task = one(api, w, w.founder, "select pulse.task_save(null,%s) id", (Jsonb({"title": "Call Northstar about the quotation", "assigneeId": str(w.sales)}),))["id"]
    # task_manual_wins keeps what a person set (locked fields) against changes made without a viewer, as this setup is:
    # unlock first, in its own statement, so the follow-up's due day and assignee below stick.
    owner_sql(owner, w, "update pulse.task set locked='{}' where id=%s", (task,))
    owner_sql(owner, w, "update pulse.task set source='quote_followup',assignee_person_id=%s,due_at=now()-interval '1 day',work_on=null where id=%s", (w.sales, task))

    p = one(api, w, w.sales, "select pulse.sales_pipeline(null) p")["p"]
    stages = {s["key"]: (s["count"], s["value"]) for s in p["stages"]}
    assert stages == {"draft": (1, 100000), "approval": (0, 0), "sent": (1, 2000000), "won": (1, 3000000)}
    assert p["pipeline"]["value"] == 2000000 and p["person"]["self"] is True
    assert (p["won"]["count"], p["won"]["value"]) == (1, 3000000) and (p["lost"]["count"], p["lost"]["value"]) == (1, 400000)
    assert p["followUps"]["due"] == 1 and p["followUps"]["items"][0]["id"] == str(task) and p["followUps"]["items"][0]["overdue"] is True
    # Another person's pipeline is for leadership and Finance.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.sales, "select pulse.sales_pipeline(%s)", (w.finance,))
    assert one(api, w, w.founder, "select pulse.sales_pipeline(%s) p", (w.sales,))["p"]["person"]["self"] is False


def test_unfinished_forms_are_each_persons_own(api, world):
    w = world
    as_(api, w, w.sales, "insert into pulse.form_draft(org_id,person_id,key,title,href,data) values(%s,%s,'new-project','New project: Office move','/tasks?view=projects&newProject=1',%s)",
        (w.org, w.sales, Jsonb({"name": "Office move"})))
    assert [r["key"] for r in as_(api, w, w.sales, "select key from pulse.form_draft")] == ["new-project"]
    # Nobody else in the company reads it or writes one in their name.
    assert as_(api, w, w.member, "select key from pulse.form_draft") == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.member, "insert into pulse.form_draft(org_id,person_id,key,title,href,data) values(%s,%s,'x-y','x','/x','{}')", (w.org, w.sales))
    # A link out of Pulse is refused.
    with pytest.raises(psycopg.errors.CheckViolation):
        as_(api, w, w.sales, "insert into pulse.form_draft(org_id,person_id,key,title,href,data) values(%s,%s,'x-y','x','//evil.example','{}')", (w.org, w.sales))


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_kazuk_gaps_in_the_browser(api, worker, owner, world):
    """services/api/test/kazuk-gaps-browser-runner.mjs: the CEO screen's money at risk and client issues, a salesperson's
    pipeline, and Resume where you left off, at 1440 and 390, light and dark (PULSE_KG_SCREENSHOTS=<dir> keeps the shots)."""
    w = world
    with worker.transaction():
        set_tenant(worker, w.org)
        for who, handle in ((w.founder, "founder"), (w.sales, "sales")):
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (w.org, f"{handle}@{w.domain}", who))
    inv = draft(api, w, w.finance, taxable=10000000, client=w.client)
    owner_sql(owner, w, "update pulse.erp_document set due_date=(now() at time zone 'Asia/Kolkata')::date-10 where id=%s", (inv,))
    issue(api, w, w.finance, inv)
    big = draft(api, w, w.finance, "quotation", taxable=5000000, client=w.client)
    owner_sql(owner, w, "update pulse.erp_document set salesperson_id=%s where id=%s", (w.sales, big))
    issue(api, w, w.finance, big)
    backdate_issued(owner, w, "update pulse.erp_document set issued_at=now()-interval '12 days',updated_at=now()-interval '12 days' where id=%s", (big,))
    acc = draft(api, w, w.finance, "quotation", taxable=3000000, client=w.client)
    owner_sql(owner, w, "update pulse.erp_document set salesperson_id=%s where id=%s", (w.sales, acc))
    issue(api, w, w.finance, acc)
    owner_sql(owner, w, "update pulse.erp_document set status='accepted' where id=%s", (acc,))
    draft(api, w, w.founder, "quotation", taxable=700000, client=w.client)   # the founder's unfinished quotation
    owner_sql(owner, w, "update pulse.project set client_id=%s,title='Synthetic Riverside launch',status='active' where id=%s", (w.client, w.project))
    t = one(api, w, w.founder, "select pulse.task_save(null,%s) id", (Jsonb({"title": "Synthetic inputs missing from the client", "projectId": str(w.project)}),))["id"]
    owner_sql(owner, w, "insert into pulse.blocker(org_id,task_id,project_id,blocker_key,opened_at,owner_side,source) values(%s,%s,%s,'client_inputs',now(),'client','declared')", (w.org, t, w.project))
    f = one(api, w, w.founder, "select pulse.task_save(null,%s) id", (Jsonb({"title": "Synthetic call about the quotation", "assigneeId": str(w.sales)}),))["id"]
    owner_sql(owner, w, "update pulse.task set source='quote_followup',assignee_person_id=%s,due_at=now(),work_on=null where id=%s", (w.sales, f))
    as_(api, w, w.founder, "insert into pulse.form_draft(org_id,person_id,key,title,href,data) values(%s,%s,'new-project','New project: Synthetic office move','/tasks?view=projects&newProject=1',%s)",
        (w.org, w.founder, Jsonb({"name": "Synthetic office move", "lead": "", "plan": "", "pkg": ""})))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "TEST_IDS": json.dumps({"org": str(w.org), "project": str(w.project)}),
           "TEST_EMAILS": json.dumps({"founder": f"founder@{w.domain}", "sales": f"sales@{w.domain}"})}
    p = subprocess.run(["node", "test/kazuk-gaps-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    # The form was picked up, not lost: it is still kept until the project is made.
    assert one(api, w, w.founder, "select count(*)::int n from pulse.form_draft where key='new-project'")["n"] == 1
