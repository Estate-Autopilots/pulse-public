"""EST-1240 (0650) and EST-1241: the sales home. sales_home_summary returns only the signed-in person's own work, in the
company's day: urgent tasks (overdue, due today or marked urgent/high; calls left out), the calls due by the end of today
(known by their record: the quotation follow-up task), and the five quotations they most recently changed hands on as
the salesperson. A salesperson needs no ERP grant; nobody sees another person's or another company's work. Through
the API: an admin chooses the sales home per role in the screens choice, /me names each person's home, and
/api/v0/sales-home answers each section on its own. Synthetic tenant and people only."""
import json
import os
import subprocess
import uuid
from datetime import datetime, timedelta

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_erp_invoice import draft, erp, issue, one  # noqa: F401  (erp is a fixture)
from test_quote_followups import IST, at, ist, own, tick  # noqa: F401  (ist is a fixture)
from test_screen_visibility import ROOT, _config, people  # noqa: F401  (people is a fixture)


def _task(worker, w, person, title, status="open", work_on=None, due_at=None, priority="normal"):
    tid = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.task(id,org_id,title,assignee_person_id,status,work_on,due_at,priority) values(%s,%s,%s,%s,%s,%s,%s,%s)",
                       (tid, w.org, title, person, status, work_on, due_at, priority))
    return tid


def summary(api, w, who, section="all"):
    return one(api, w, who, "select pulse.sales_home_summary(%s) s", (section,))["s"]


def test_the_summary_is_the_viewers_own_work_in_the_company_day(api, owner, worker, ist):
    w = ist
    now = datetime.now(IST)
    today = now.date()
    overdue = _task(worker, w, w.member, "Synthetic overdue site check", work_on=today - timedelta(days=2))
    due_today = _task(worker, w, w.member, "Synthetic panel order", due_at=datetime(today.year, today.month, today.day, 23, 0, tzinfo=IST))
    urgent = _task(worker, w, w.member, "Synthetic urgent reply", priority="urgent")
    _task(worker, w, w.member, "Synthetic later task", work_on=today + timedelta(days=5))                 # not urgent yet
    _task(worker, w, w.member, "Synthetic finished task", status="done", work_on=today - timedelta(days=1))
    gone = _task(worker, w, w.member, "Synthetic deleted task", work_on=today - timedelta(days=1))
    own(owner, w, "update pulse.task set deleted_at=now() where id=%s", (gone,))
    others = _task(worker, w, w.finance, "Synthetic finance overdue", work_on=today - timedelta(days=1))

    # A quotation the member sent two days ago: its follow-up call falls due today at 09:00 (0520).
    sent_q = draft(api, w, w.finance, "quotation")
    issue(api, w, w.finance, sent_q)
    two_days_ago = now - timedelta(days=2)
    own(owner, w, "update pulse.erp_document set status='sent',sent_at=%s,sent_by=%s where id=%s",
        (at(two_days_ago.year, two_days_ago.month, two_days_ago.day, 10, 30), w.member, sent_q))
    tick(worker, w, at(today.year, today.month, today.day, 9, 0))
    call = own(owner, w, "select id from pulse.task where source='quote_followup' and source_ref=%s", (str(sent_q),))[0]["id"]
    # A quotation that names the member as salesperson, Finance's own draft, and a cancelled one.
    named = draft(api, w, w.finance, "quotation")
    own(owner, w, "update pulse.erp_document set salesperson_id=%s where id=%s", (w.member, named))
    finance_own = draft(api, w, w.finance, "quotation")
    cancelled = draft(api, w, w.finance, "quotation")
    own(owner, w, "update pulse.erp_document set salesperson_id=%s where id=%s", (w.member, cancelled))
    issue(api, w, w.finance, cancelled)                                           # only a numbered document is cancelled
    own(owner, w, "update pulse.erp_document set status='cancelled',cancelled_at=now(),cancel_reason='Synthetic cancel' where id=%s", (cancelled,))

    s = summary(api, w, w.member)
    assert s["today"] == today.isoformat() and s["greeting"] in ("morning", "afternoon", "evening")
    assert [t["id"] for t in s["urgent"]["items"]] == [str(overdue), str(due_today), str(urgent)], s["urgent"]
    assert s["urgent"]["total"] == 3
    assert [t["overdue"] for t in s["urgent"]["items"]] == [True, False, False]
    assert s["urgent"]["items"][2]["priority"] == "urgent" and s["urgent"]["items"][2]["dueOn"] is None
    assert [(k["id"], k["kind"], k["dueOn"], k["overdue"]) for k in s["calls"]["items"]] == [(str(call), "quotation", today.isoformat(), False)]
    assert s["calls"]["total"] == 1 and str(call) not in [t["id"] for t in s["urgent"]["items"]], "a call is listed once, as a call"
    quotes = [q["id"] for q in s["quotes"]["items"]]
    assert set(quotes) == {str(sent_q), str(named)}, s["quotes"]
    assert s["quotes"]["canOpenErp"] is False, "the salesperson reads their own quotations without an ERP grant"
    assert one(api, w, w.member, "select count(*) n from pulse.erp_document")["n"] == 0, "and still cannot read ERP itself"

    mine = summary(api, w, w.finance)
    assert [t["id"] for t in mine["urgent"]["items"]] == [str(others)], "each person sees only their own tasks"
    assert str(finance_own) in [q["id"] for q in mine["quotes"]["items"]] and str(sent_q) not in [q["id"] for q in mine["quotes"]["items"]]
    assert mine["quotes"]["canOpenErp"] is True and mine["calls"]["items"] == []

    only_calls = summary(api, w, w.member, "calls")
    assert set(only_calls) == {"today", "greeting", "calls"}, "one section at a time"
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        summary(api, w, w.member, "everything")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        summary(api, w, None)


API = r'''
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const emails = JSON.parse(process.env.TEST_EMAILS);
const call = async (path, role, body) => {
  const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': emails[role] }, ...(body === undefined ? {} : { payload: body }) });
  let json = null; try { json = r.json(); } catch { /* empty */ }
  return { status: r.statusCode, body: json };
};
const ok = (c, m, r) => assert.ok(c, `${m}: ${JSON.stringify(r?.body ?? r).slice(0, 1500)}`);
const home = async (role) => (await call('me', role)).body.home;

ok(await home('member') === 'dashboard' && await home('admin') === 'dashboard', 'everyone lands on the Dashboard until an admin chooses', null);
let r = await call('sales-home', 'member');
ok(r.status === 200 && r.body.eligible === false && Array.isArray(r.body.urgent.items) && Array.isArray(r.body.calls.items) && Array.isArray(r.body.quotes.items), 'the summary answers, not yet the home', r);

r = await call('settings/screens', 'admin', { newScreensHidden: false, hidden: {}, home: { person: 'sales' } });
ok(r.status === 200 && r.body.home.person === 'sales' && r.body.home.admin === 'dashboard' && r.body.homes.join() === 'dashboard,sales', 'the admin gives members the sales home', r);
ok(await home('member') === 'sales' && await home('admin') === 'dashboard', 'members land on it; other roles keep theirs', null);
r = await call('sales-home', 'member');
ok(r.status === 200 && r.body.eligible === true && r.body.person.name === 'Synthetic Member', 'the member\'s own sales home', r);
r = await call('sales-home?section=quotes', 'member');
ok(r.status === 200 && 'quotes' in r.body && !('urgent' in r.body) && !('calls' in r.body), 'one section at a time', r);
ok((await call('sales-home?section=nope', 'member')).status === 400, 'an unknown section is refused', null);
ok((await call('sales-home', 'admin')).body.eligible === false, 'the admin\'s role keeps the Dashboard', null);

r = await call('settings/screens', 'admin', { newScreensHidden: false, hidden: { person: ['map'] } });
ok(r.status === 200 && await home('member') === 'sales', 'a save without homes keeps the homes already chosen', r);
for (const bad of [{ person: 'crm' }, { hr: 'sales' }, { owner: 'sales' }]) {
  r = await call('settings/screens', 'admin', { newScreensHidden: false, hidden: {}, home: bad });
  ok(r.status === 400, 'an unknown home or role is refused', r);
}
ok((await call('settings/screens', 'member', { newScreensHidden: false, hidden: {}, home: { person: 'dashboard' } })).status === 403, 'only an admin chooses', null);
r = await call('settings/screens', 'admin', { newScreensHidden: false, hidden: {}, home: { person: 'dashboard' } });
ok(r.status === 200 && await home('member') === 'dashboard', 'and can take it back', r);
console.log(JSON.stringify({ ok: true }));
await app.close(); await pool.end();
'''


def test_an_admin_gives_a_role_the_sales_home_through_the_api(people):
    from conftest import dsn
    w = people
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": _config(dsn("api")),
           "TEST_EMAILS": json.dumps({k: f"{k}@{w.domain}" for k in ("admin", "member")})}
    p = subprocess.run(["node", "--input-type=module", "-e", API], cwd=ROOT / "services/api", env=env, capture_output=True, text=True, timeout=240)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]
