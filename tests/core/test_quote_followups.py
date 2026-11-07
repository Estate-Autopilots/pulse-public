"""EST-1238 (0520): a quotation marked Sent comes back to its salesperson at the company's follow-up hour (09:00), two
local days later: one open task and one notice per occurrence, until the customer answers or the quotation closes. The
clock is passed to the tick. Synthetic company and people only."""
import json
import os
import subprocess
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_erp_invoice import draft, erp, issue, one  # noqa: F401  (erp is a fixture)

IST = ZoneInfo("Asia/Kolkata")
API = r'''
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const { quote, emails } = JSON.parse(process.env.TEST_IDS);
const call = async (who, body) => {
  const r = await app.inject({ url: `/api/v0/quotes/${quote}/follow-up`, method: body ? 'POST' : 'GET', headers: { 'cf-access-authenticated-user-email': emails[who] }, ...(body ? { payload: body } : {}) });
  return { status: r.statusCode, body: r.json() };
};
let r = await call('finance');
assert.ok(r.status === 200 && r.body.state === 'scheduled' && r.body.canAnswer === true, JSON.stringify(r));
assert.equal((await call('member')).status, 404, 'another person sees nothing');
assert.equal((await call('member', { action: 'replied' })).status, 403, 'another person cannot answer');
assert.equal((await call('finance', { action: 'shout' })).status, 400);
assert.equal((await call('finance', { action: 'close' })).status, 400, 'a close needs its outcome');
r = await call('finance', { action: 'replied', note: 'Asked for a week' });
assert.ok(r.status === 200 && r.body.state === 'answered' && r.body.nextDueAt === null && r.body.answer.note === 'Asked for a week', JSON.stringify(r));
await app.close(); await pool.end();
'''


def at(*parts, tz=IST):
    return datetime(*parts, tzinfo=tz)


def own(owner, w, sql, args=()):
    with owner.transaction():
        set_tenant(owner, w.org)
        cur = owner.execute(sql, args)
        return cur.fetchall() if cur.description else []


def tick(worker, w, now):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select pulse.quote_followup_tick(%s) r", (now,)).fetchone()["r"]


def sent(api, owner, w, when):
    """An issued quotation handed over at `when` by Finance (what Mark sent records, at a chosen time)."""
    q = draft(api, w, w.finance, "quotation")
    issue(api, w, w.finance, q)
    own(owner, w, "update pulse.erp_document set status='sent',sent_at=%s,sent_by=%s where id=%s", (when, w.finance, q))
    return q


def followup(owner, w, q):
    return own(owner, w, "select * from pulse.erp_followup where document_id=%s", (q,))[0]


def tasks(owner, w, q):
    return own(owner, w, "select id,status,owner_id,due_at from pulse.task where source='quote_followup' and source_ref=%s order by created_at", (str(q),))


@pytest.fixture
def ist(owner, erp):  # noqa: F811
    own(owner, erp, "update pulse.org set time_zone='Asia/Kolkata' where id=%s", (erp.org,))
    return erp


def test_the_follow_up_hour_falls_on_the_local_date_two_days_later(owner, ist):
    w = ist
    slot = lambda sent_at: own(owner, w, "select pulse.erp_followup_slot(%s,2,9) s", (sent_at,))[0]["s"]
    assert slot(at(2026, 10, 20, 10, 30)) == at(2026, 10, 22, 9, 0)         # sent after 09:00
    assert slot(at(2026, 10, 18, 0, 30)) == at(2026, 10, 20, 9, 0)          # 17 Oct in UTC, 18 Oct in the company
    assert slot(at(2026, 10, 30, 21, 0)) == at(2026, 11, 1, 9, 0)           # month boundary
    assert slot(at(2026, 12, 30, 23, 59)) == at(2027, 1, 1, 9, 0)           # year boundary
    london = ZoneInfo("Europe/London")                                      # another company's zone (and a DST change)
    own(owner, w, "update pulse.org set time_zone='Europe/London' where id=%s", (w.org,))
    assert slot(at(2026, 10, 23, 23, 30, tz=london)) == at(2026, 10, 25, 9, 0, tz=london)


def test_an_unanswered_quotation_comes_back_once_per_occurrence(api, owner, worker, ist):
    w = ist
    q = sent(api, owner, w, at(2026, 10, 20, 10, 30))
    f = followup(owner, w, q)
    assert f["state"] == "scheduled" and f["person_id"] == w.finance and f["next_due_at"] == at(2026, 10, 22, 9, 0)
    one(api, w, w.finance, "select pulse.erp_document_mark(%s,'sent')", (q,))           # marked Sent again: nothing new
    assert followup(owner, w, q)["next_due_at"] == at(2026, 10, 22, 9, 0)
    assert tick(worker, w, at(2026, 10, 22, 8, 59)) == {"due": 0, "told": 0}
    assert tick(worker, w, at(2026, 10, 22, 9, 0)) == {"due": 1, "told": 1}
    assert tick(worker, w, at(2026, 10, 22, 9, 1)) == {"due": 0, "told": 0}
    [t] = tasks(owner, w, q)
    assert t["status"] == "open" and t["owner_id"] == w.finance and t["due_at"] == at(2026, 10, 22, 9, 0)
    assert tick(worker, w, at(2026, 10, 24, 9, 0)) == {"due": 1, "told": 1}             # the same open task, moved
    [t] = tasks(owner, w, q)
    assert t["due_at"] == at(2026, 10, 24, 9, 0)
    own(owner, w, "update pulse.task set status='done' where id=%s", (t["id"],))         # finishing it answers nothing
    assert tick(worker, w, at(2026, 10, 26, 9, 0)) == {"due": 1, "told": 1}
    assert [x["status"] for x in tasks(owner, w, q)] == ["done", "open"]
    assert tick(worker, w, at(2026, 11, 5, 12, 0)) == {"due": 1, "told": 1}             # after downtime: one notice
    f = followup(owner, w, q)
    assert f["last_due_at"] == at(2026, 11, 5, 9, 0) and f["next_due_at"] == at(2026, 11, 7, 9, 0) and f["occurrences"] == 4
    notices = own(owner, w, "select person_id,event_type from pulse.notification where event_key like %s", (f"quote_followup:{q}:%",))
    assert len(notices) == 4 and {(n["person_id"], n["event_type"]) for n in notices} == {(w.finance, "task.due_soon")}
    other = build_world(worker, owner, api)
    assert tick(worker, other, at(2026, 11, 7, 9, 0)) == {"due": 0, "told": 0}          # nothing crosses companies


def test_a_replaced_salesperson_takes_over_the_open_task_and_its_notices(api, owner, worker, ist):
    """CTO review @ cb75600c (P1): whoever marked it Sent leaves; the drafter gets a task of their own and the notice."""
    w = ist
    q = draft(api, w, w.finance, "quotation")
    issue(api, w, w.finance, q)
    own(owner, w, "update pulse.erp_document set status='sent',sent_at=%s,sent_by=%s where id=%s", (at(2026, 10, 20, 10, 30), w.editor, q))
    assert tick(worker, w, at(2026, 10, 22, 9, 0)) == {"due": 1, "told": 1}
    [t] = tasks(owner, w, q)
    assert t["owner_id"] == w.editor
    own(owner, w, "update pulse.person set status='inactive' where id=%s", (w.editor,))
    assert tick(worker, w, at(2026, 10, 24, 9, 0)) == {"due": 1, "told": 1}
    rows = own(owner, w, "select id,owner_id,status from pulse.task where source='quote_followup' and source_ref=%s", (str(q),))
    assert sorted((str(r["owner_id"]), r["status"]) for r in rows) == sorted([(str(w.editor), "cancelled"), (str(w.finance), "open")])
    [t] = [r for r in rows if r["status"] == "open"]
    assert followup(owner, w, q)["person_id"] == w.finance
    notices = own(owner, w, "select person_id,title,href from pulse.notification where event_key like %s", (f"quote_followup:{q}:%",))
    assert sorted(str(n["person_id"]) for n in notices) == sorted([str(w.editor), str(w.finance)])
    assert {n["title"] for n in notices} == {"Follow up on a quotation today"}
    assert {n["href"] for n in notices if n["person_id"] == w.finance} == {f"/tasks/{t['id']}"}


def test_reassigning_only_the_assignee_keeps_the_task_and_the_salesperson_is_told(api, owner, worker, ist):
    """CTO @ d60a50d7 (4): task.due_soon is owner-first, so the salesperson stays the owner and keeps hearing it."""
    w = ist
    q = sent(api, owner, w, at(2026, 10, 20, 10, 30))
    tick(worker, w, at(2026, 10, 22, 9, 0))
    [t] = tasks(owner, w, q)
    own(owner, w, "update pulse.task set assignee_person_id=%s where id=%s", (w.editor, t["id"]))
    assert tick(worker, w, at(2026, 10, 24, 9, 0)) == {"due": 1, "told": 1}
    assert [x["id"] for x in tasks(owner, w, q)] == [t["id"]]
    notices = own(owner, w, "select person_id from pulse.notification where event_key like %s", (f"quote_followup:{q}:%",))
    assert len(notices) == 2 and {n["person_id"] for n in notices} == {w.finance}


def test_two_ticks_never_take_the_same_quotation(api, owner, worker, ist):
    """CTO 2a: a second tick while the first holds the row skips it (SKIP LOCKED): one task, one notice."""
    from conftest import dsn
    from psycopg.rows import dict_row
    w = ist
    q = sent(api, owner, w, at(2026, 10, 20, 10, 30))
    with psycopg.connect(dsn("worker"), row_factory=dict_row) as other, worker.transaction():
        set_tenant(worker, w.org)
        first = worker.execute("select pulse.quote_followup_tick(%s) r", (at(2026, 10, 22, 9, 0),)).fetchone()["r"]
        with other.transaction():
            set_tenant(other, w.org)
            second = other.execute("select pulse.quote_followup_tick(%s) r", (at(2026, 10, 22, 9, 0),)).fetchone()["r"]
    assert first == {"due": 1, "told": 1} and second == {"due": 0, "told": 0}
    assert len(tasks(owner, w, q)) == 1


def test_converting_a_due_quotation_stops_it_and_cancels_its_task(api, owner, worker, ist):
    """CTO 2b: converted between occurrences: the open task is cancelled and the next due time tells nobody."""
    w = ist
    q = sent(api, owner, w, at(2026, 10, 20, 10, 30))
    tick(worker, w, at(2026, 10, 22, 9, 0))
    own(owner, w, "update pulse.erp_document set status='converted' where id=%s", (q,))
    f = followup(owner, w, q)
    assert (f["state"], f["stopped_reason"], f["next_due_at"]) == ("stopped", "converted", None)
    assert [t["status"] for t in tasks(owner, w, q)] == ["cancelled"]
    assert tick(worker, w, at(2026, 10, 24, 9, 0)) == {"due": 0, "told": 0}


def test_a_salesperson_without_erp_access_reads_and_answers_their_own_quotation(api, owner, worker, ist):
    """CTO 2c: the salesperson needs no ERP grant for their own quotation's follow-up; others still see nothing."""
    w = ist
    q = draft(api, w, w.finance, "quotation")
    issue(api, w, w.finance, q)
    own(owner, w, "update pulse.erp_document set status='sent',sent_at=%s,sent_by=%s where id=%s", (at(2026, 10, 20, 10, 30), w.editor, q))
    assert one(api, w, w.editor, "select pulse.erp_can(false) c")["c"] is False
    v = one(api, w, w.editor, "select pulse.erp_followup_view(%s) v", (q,))["v"]
    assert v["canAnswer"] is True and v["salesperson"]["id"] == str(w.editor)
    assert one(api, w, w.editor, "select pulse.erp_followup_answer(%s,'replied') v", (q,))["v"]["state"] == "answered"
    assert one(api, w, w.member, "select pulse.erp_followup_view(%s) v", (q,))["v"] is None


def test_a_tick_takes_at_most_100_quotations(api, owner, worker, ist):
    """CTO 2d: 101 due quotations: the first tick takes 100, the next one the last."""
    w = ist
    for _ in range(101):
        sent(api, owner, w, at(2026, 10, 20, 10, 30))
    assert tick(worker, w, at(2026, 10, 22, 9, 0))["due"] == 100
    assert tick(worker, w, at(2026, 10, 22, 9, 1))["due"] == 1
    assert tick(worker, w, at(2026, 10, 22, 9, 2))["due"] == 0


def test_answers_closes_and_quotation_status_stop_the_sequence(api, owner, worker, ist):
    w = ist
    q = sent(api, owner, w, at(2026, 10, 20, 10, 30))
    tick(worker, w, at(2026, 10, 22, 9, 0))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.member, "select pulse.erp_followup_answer(%s,'replied')", (q,))
    assert one(api, w, w.member, "select pulse.erp_followup_view(%s) v", (q,))["v"] is None
    assert one(api, w, w.founder, "select pulse.erp_followup_view(%s) v", (q,))["v"]["canAnswer"] is True
    v = one(api, w, w.finance, "select pulse.erp_followup_answer(%s,'replied',null,'Asked for a week') v", (q,))["v"]
    assert v["state"] == "answered" and v["nextDueAt"] is None and [t["status"] for t in tasks(owner, w, q)] == ["done"]
    assert tick(worker, w, at(2026, 10, 30, 9, 0))["due"] == 0
    assert one(api, w, w.finance, "select pulse.erp_followup_answer(%s,'later') v", (q,))["v"]["nextDueAt"] is not None
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="how it ended"):
        one(api, w, w.finance, "select pulse.erp_followup_answer(%s,'close')", (q,))
    v = one(api, w, w.finance, "select pulse.erp_followup_answer(%s,'close','converted',null) v", (q,))["v"]
    assert v["state"] == "closed" and v["closed"]["outcome"] == "converted"
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="closed"):
        one(api, w, w.finance, "select pulse.erp_followup_answer(%s,'replied') v", (q,))
    for action, note, reason in [("accepted", None, "accepted"), ("declined", None, "declined"), ("cancel", "Wrong client", "cancelled")]:
        q2 = sent(api, owner, w, at(2026, 10, 21, 11, 0))
        tick(worker, w, at(2026, 10, 23, 9, 0))
        one(api, w, w.finance, "select pulse.erp_document_mark(%s,%s,%s)", (q2, action, note))
        f = followup(owner, w, q2)
        assert (f["state"], f["stopped_reason"], f["next_due_at"]) == ("stopped", reason, None)
        assert [t["status"] for t in tasks(owner, w, q2)] == ["cancelled"]
    kinds = [r["kind"] for r in own(owner, w, "select kind from pulse.erp_event where subject_id=%s order by at", (q,))]
    assert {"followup_scheduled", "followup_due", "followup_replied", "followup_later", "followup_close"} <= set(kinds)


def test_the_salesperson_reads_and_answers_through_the_api(api, owner, worker, ist):
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = ist
    emails = {"finance": f"finance@{w.domain}", "member": f"member@{w.domain}"}
    with worker.transaction():
        set_tenant(worker, w.org)
        for who, pid in [("finance", w.finance), ("member", w.member)]:
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (w.org, emails[who], pid))
    q = sent(api, owner, w, at(2026, 10, 20, 10, 30))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "TEST_IDS": json.dumps({"quote": str(q), "emails": emails})}
    p = subprocess.run(["node", "--input-type=module", "-e", API], cwd=Path(__file__).resolve().parents[2] / "services/api",
                       env=env, capture_output=True, text=True, timeout=240, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]
