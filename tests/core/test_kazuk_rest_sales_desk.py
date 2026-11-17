"""KAZUK-REST (1711): a salesperson's desk on My sales (Kazuk's A19). Their leads from Sales X-Ray (and Pulse enquiries)
by stage, their calls of the last 14 days with outcomes, follow-ups due today, and quotations waiting for approval, for
the person themselves or for leadership and Finance; never another company's. Synthetic tenants, people and figures."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import (  # noqa: F401  (erp is a fixture)
    as_,
    build_world,
    draft,
    erp,
    one,
    person,
)


def owner_sql(owner, w, sql, args=()):
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute(sql, args)


def seed(api, owner, w):
    """Synthetic leads, calls, a follow-up and quotations around one salesperson."""
    w.sales = person(owner, w, "Synthetic Sales")
    other = person(owner, w, "Synthetic Other Seller")
    for name, stage, who, ago in (("Synthetic Lead One", "new", "Synthetic Sales", 1), ("Synthetic Lead Two", "contacted", " synthetic sales ", 2),
                                  ("Synthetic Lead Won", "won", "Synthetic Sales", 3), ("Synthetic Lead Elsewhere", "new", "Synthetic Other Seller", 1)):
        owner_sql(owner, w, """insert into pulse.sales_xray_lead(org_id,sx_lead_id,name,company,stage,owner_name,sx_created_at)
            values(%s,%s,%s,'Synthetic Towers',%s,%s,now()-%s*interval '1 day')""", (w.org, uuid.uuid4(), name, stage, who, ago))
    for title, who, ago in (("Synthetic call with Lead One", w.sales, 2), ("Synthetic old call", w.sales, 30), ("Synthetic call of another", other, 1)):
        owner_sql(owner, w, """insert into pulse.sales_xray_call(org_id,sx_call_id,title,call_at,duration_seconds,person_id,status,summary)
            values(%s,%s,%s,now()-%s*interval '1 day',600,%s,'ready',%s)""",
                  (w.org, uuid.uuid4(), title, ago, who, Jsonb({"score": 7, "outcome": "Synthetic: asked for a revised quotation"})))
    t = one(api, w, w.founder, "select pulse.task_save(null,%s) id", (Jsonb({"title": "Synthetic follow-up call", "assigneeId": str(w.sales)}),))["id"]
    owner_sql(owner, w, "update pulse.task set locked='{}' where id=%s", (t,))
    owner_sql(owner, w, "update pulse.task set source='quote_followup',assignee_person_id=%s,due_at=now(),work_on=null where id=%s", (w.sales, t))
    waiting = draft(api, w, w.finance, "quotation", taxable=2500000, client=w.client)
    owner_sql(owner, w, "update pulse.erp_document set salesperson_id=%s,approval_asked_by=%s,approval_to=%s,approval_asked_at=now() where id=%s", (w.sales, w.sales, w.founder, waiting))
    for_me = draft(api, w, w.finance, "quotation", taxable=900000, client=w.client)
    owner_sql(owner, w, "update pulse.erp_document set approval_asked_by=%s,approval_to=%s,approval_asked_at=now() where id=%s", (other, w.sales, for_me))
    return t, waiting, for_me


def test_a_salesperson_sees_their_leads_calls_follow_ups_and_approvals(api, owner, erp):  # noqa: F811
    w = erp
    task, waiting, for_me = seed(api, owner, w)
    d = one(api, w, w.sales, "select pulse.sales_desk(null) d")["d"]
    assert d["person"]["self"] is True
    assert (d["leads"]["count"], d["leads"]["xray"]) == (3, 3)
    assert [(s["stage"], s["count"]) for s in d["leads"]["stages"]] == [("new", 1), ("contacted", 1), ("won", 1)]
    assert [x["name"] for x in d["leads"]["items"]] == ["Synthetic Lead One", "Synthetic Lead Two"]  # open ones, newest first
    assert d["calls"]["count"] == 1 and d["calls"]["minutes"] == 10
    c = d["calls"]["items"][0]
    assert (c["title"], c["score"], c["outcome"]) == ("Synthetic call with Lead One", 7, "Synthetic: asked for a revised quotation")
    assert d["today"]["due"] == 1 and d["today"]["items"][0]["id"] == str(task) and d["today"]["items"][0]["kind"] == "quotation"
    assert [(x["id"], x["to"]) for x in d["approval"]["waiting"]] == [(str(waiting), "Synthetic Founder")]
    assert [(x["id"], x["by"]) for x in d["approval"]["forMe"]] == [(str(for_me), "Synthetic Other Seller")]
    assert d["approval"]["on"] is True


def test_the_desk_shows_approvals_only_when_the_sales_flow_has_them(api, owner, erp):  # noqa: F811
    w = erp
    _, waiting, for_me = seed(api, owner, w)
    # The EA preset (no approval, no price gate): no approval panel and nothing listed.
    one(api, w, w.founder, "select pulse.erp_flow_save(%s) r", (Jsonb({"preset": "ea"}),))
    d = one(api, w, w.sales, "select pulse.sales_desk(null) d")["d"]
    assert d["approval"] == {"on": False, "waiting": [], "forMe": []}
    assert d["leads"]["count"] == 3 and d["today"]["due"] == 1
    # The Willow Lane preset keeps approvals: both lists come back.
    one(api, w, w.founder, "select pulse.erp_flow_save(%s) r", (Jsonb({"preset": "wl"}),))
    d = one(api, w, w.sales, "select pulse.sales_desk(null) d")["d"]
    assert d["approval"]["on"] is True
    assert [x["id"] for x in d["approval"]["waiting"]] == [str(waiting)] and [x["id"] for x in d["approval"]["forMe"]] == [str(for_me)]


def test_another_persons_desk_is_for_leadership_and_finance_only(api, owner, erp):  # noqa: F811
    w = erp
    seed(api, owner, w)
    assert one(api, w, w.founder, "select pulse.sales_desk(%s) d", (w.sales,))["d"]["person"]["self"] is False
    assert one(api, w, w.finance, "select pulse.sales_desk(%s) d", (w.sales,))["d"]["leads"]["count"] == 3
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.member, "select pulse.sales_desk(%s)", (w.sales,))
    # A member's own desk is theirs (empty here).
    assert one(api, w, w.member, "select pulse.sales_desk(null) d")["d"]["leads"]["count"] == 0


def test_a_desk_never_reaches_another_company(worker, owner, api, erp):  # noqa: F811
    a = erp
    seed(api, owner, a)
    b = build_world(worker, owner, api)
    b.founder = person(worker, b, "Synthetic Founder B", "leadership")
    b.sales = person(worker, b, "Synthetic Sales")   # the same name in another company
    with pytest.raises(psycopg.errors.NoDataFound):
        one(api, b, b.founder, "select pulse.sales_desk(%s)", (a.sales,))
    d = one(api, b, b.sales, "select pulse.sales_desk(null) d")["d"]
    assert (d["leads"]["count"], d["calls"]["count"], d["today"]["due"], d["approval"]["waiting"]) == (0, 0, 0, [])


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_sales_desk_in_the_browser(api, worker, owner, erp):  # noqa: F811
    """services/api/test/kazuk-rest-sales-desk-browser-runner.mjs: My sales with the desk at 1440 and 390, light and dark
    (PULSE_KR_SCREENSHOTS=<dir> keeps the shots)."""
    w = erp
    seed(api, owner, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"sales@{w.domain}", w.sales))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "TEST_IDS": json.dumps({"org": str(w.org)}),
           "TEST_EMAILS": json.dumps({"sales": f"sales@{w.domain}"})}
    p = subprocess.run(["node", "test/kazuk-rest-sales-desk-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
