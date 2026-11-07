"""TASKUX: My day across a Pulse account's organisations, one running clock per account, repeating work by a rule and
the finer task states (synthetic organisations and people only).

The owner's case (2 Nov 2026): one human works in three organisations on one Pulse account and must see one day: what
to do, which company needs attention, how long each thing takes, what is overdue, whether targets are met. Each
organisation's row-level security still decides what is read: My day reads every seat inside its own organisation as
the account's person there, and never shows a row that person could not see there.
"""
import base64
import hashlib
import json
import os
import secrets
import subprocess
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from conftest import dsn
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, new_task, one


def _account(owner, *seats):
    """One Pulse account holding the given (org, person) seats."""
    account, handle = uuid.uuid4(), 'u' + uuid.uuid4().hex[:10]
    with owner.transaction():
        owner.execute("insert into pulse_priv.pulse_account(id,handle,display_name,last_org) values(%s,%s,'Synthetic Sakobe',%s)", (account, handle, seats[0][0]))
        owner.execute("insert into pulse_priv.handle_name(handle,kind,ref) values(%s,'person',%s)", (handle, account))
        for org, person in seats:
            owner.execute("insert into pulse_priv.account_member(account_id,member_org,person_id,kind) values(%s,%s,%s,'staff')", (account, org, person))
    return account


@pytest.fixture
def three(worker, owner, api):
    """Sakobe: his own organisation (a), a sales job (b), and an organisation (c) he is not in. A colleague in each."""
    a, b, c = build_world(worker, owner, api), build_world(worker, owner, api), build_world(worker, owner, api)
    _account(owner, (a.org, a.editor), (b.org, b.editor))
    return a, b, c


def _seats(api, w, who):
    return as_(api, w, who, "select seat_org,seat_person,org_name,is_current from pulse.account_seats()")


def _day(api, org, person):
    with api.transaction():
        set_tenant(api, org, person)
        return api.execute("select pulse.my_day_seat() d").fetchone()["d"]


def _visible_ids(api, org, person):
    with api.transaction():
        set_tenant(api, org, person)
        return {r["id"] for r in api.execute("select id from pulse.task").fetchall()}


def test_seats_are_the_accounts_own_and_my_day_reads_each_inside_its_organisation(api, worker, owner, three):
    a, b, c = three
    today = datetime.now(timezone.utc).date().isoformat()
    mine_a = new_task(api, a, a.editor, title="Edit the podcast episode", dueOn=today, priority="high", estimateMinutes=90)
    theirs_a = new_task(api, a, a.editor2, title="A colleague's own work", dueOn=today)
    mine_b = new_task(api, b, b.editor, title="Call ten leads", dueOn=today, estimateMinutes=60)
    theirs_b = new_task(api, b, b.editor2, title="Sales team secret plan", dueOn=today)
    other_c = new_task(api, c, c.editor, title="Not Sakobe's company", dueOn=today)

    seats = _seats(api, a, a.editor)
    assert {(s["seat_org"], s["seat_person"]) for s in seats} == {(a.org, a.editor), (b.org, b.editor)}
    assert seats[0]["seat_org"] == a.org and seats[0]["is_current"] is True
    # The colleague in a has no account: only their own organisation, as themselves.
    assert [(s["seat_org"], s["seat_person"]) for s in _seats(api, a, a.editor2)] == [(a.org, a.editor2)]
    # Nobody signed in: no seats.
    assert as_(api, a, None, "select * from pulse.account_seats()") == []

    day_a, day_b = _day(api, a.org, a.editor), _day(api, b.org, b.editor)
    ids_a, ids_b = {t["id"] for t in day_a["tasks"]}, {t["id"] for t in day_b["tasks"]}
    assert str(mine_a) in ids_a and str(mine_b) in ids_b
    # Never another person's work, never another organisation's rows, never more than row security shows there.
    assert not ({str(theirs_a), str(theirs_b), str(other_c)} & (ids_a | ids_b))
    assert ids_a <= {str(x) for x in _visible_ids(api, a.org, a.editor)} and ids_b <= {str(x) for x in _visible_ids(api, b.org, b.editor)}
    assert str(mine_b) not in ids_a and str(mine_a) not in ids_b
    # A person read inside an organisation they are not in sees nothing of it.
    assert _day(api, c.org, a.editor)["tasks"] == []
    # The planned time is the estimate of today's work.
    assert {t["title"]: t["estimateMinutes"] for t in day_a["tasks"]} == {"Edit the podcast episode": 90}


def test_an_inactive_seat_or_closed_organisation_is_left_out(api, worker, owner, three):
    a, b, _ = three
    with worker.transaction():
        set_tenant(worker, b.org)
        worker.execute("update pulse.person set status='inactive' where id=%s", (b.editor,))
    assert [s["seat_org"] for s in _seats(api, a, a.editor)] == [a.org]


def test_one_running_clock_per_account(api, worker, owner, three):
    a, b, _ = three
    ta = new_task(api, a, a.editor, title="Write the newsletter")
    tb = new_task(api, b, b.editor, title="Follow up the demo")
    as_(api, b, b.editor, "select pulse.task_timer_set(%s,true)", (tb,))
    assert one(api, b, b.editor, "select count(*)::int n from pulse.task_timer where person_id=%s and ended_at is null", (b.editor,))["n"] == 1
    # Starting in a pauses b's clock (closed inside b, as b's person, its time kept as b's entry).
    as_(api, a, a.editor, "select pulse.task_timer_set(%s,true)", (ta,))
    assert one(api, a, a.editor, "select count(*)::int n from pulse.task_timer where person_id=%s and ended_at is null", (a.editor,))["n"] == 1
    closed = one(api, b, b.editor, "select ended_at,end_reason from pulse.task_timer where person_id=%s order by started_at desc limit 1", (b.editor,))
    assert closed["ended_at"] is not None and closed["end_reason"] == "switched"
    assert _day(api, a.org, a.editor)["timer"]["taskId"] == str(ta) and _day(api, b.org, b.editor)["timer"] is None
    # And back: b again pauses a.
    as_(api, b, b.editor, "select pulse.task_timer_set(%s,true)", (tb,))
    assert one(api, a, a.editor, "select count(*)::int n from pulse.task_timer where person_id=%s and ended_at is null", (a.editor,))["n"] == 0
    # The session's own organisation is restored after reaching into the others.
    with api.transaction():
        set_tenant(api, b.org, b.editor)
        api.execute("select pulse.task_timer_set(%s,false)", (tb,))
        api.execute("select pulse.task_timer_set(%s,true)", (tb,))
        assert api.execute("select current_setting('pulse.org_id') o, current_setting('pulse.viewer_id') v").fetchone() == {"o": str(b.org), "v": str(b.editor)}
    # A colleague without an account in a: their clock never touches anyone else's.
    tc = new_task(api, a, a.editor2, title="Colleague's task")
    as_(api, a, a.editor2, "select pulse.task_timer_set(%s,true)", (tc,))
    assert one(api, b, b.editor, "select count(*)::int n from pulse.task_timer where person_id=%s and ended_at is null", (b.editor,))["n"] == 1


def _after(api, w, every, n, days, skip, month_day, d):
    return one(api, w, w.editor, "select pulse.task_repeat_after(%s,%s,%s::smallint[],%s,%s,%s::date) d", (every, n, days, skip, month_day, d))["d"].isoformat()


def test_the_next_day_of_a_rule(api, worker, owner, three):
    a = three[0]
    assert _after(api, a, "day", 1, None, False, None, "2026-11-06") == "2026-11-07"          # Friday → Saturday
    assert _after(api, a, "day", 1, None, True, None, "2026-11-06") == "2026-11-09"           # skipping weekends → Monday
    assert _after(api, a, "day", 3, None, False, None, "2026-11-02") == "2026-11-05"
    assert _after(api, a, "week", 1, None, False, None, "2026-11-04") == "2026-11-11"
    assert _after(api, a, "week", 1, [1, 3, 5], False, None, "2026-11-04") == "2026-11-06"    # Wed → Fri
    assert _after(api, a, "week", 1, [1, 3, 5], False, None, "2026-11-06") == "2026-11-09"    # Fri → Mon
    assert _after(api, a, "week", 2, [2], False, None, "2026-11-03") == "2026-11-17"          # every other Tuesday
    assert _after(api, a, "week", 1, [6], True, None, "2026-11-02") == "2026-11-07"           # chosen Saturdays are kept
    assert _after(api, a, "month", 1, None, False, 31, "2026-01-31") == "2026-02-28"
    assert _after(api, a, "month", 1, None, False, 31, "2026-02-28") == "2026-03-31"          # the anchor day comes back
    assert _after(api, a, "month", 1, None, True, 7, "2026-10-07") == "2026-11-09"            # 7 Nov 2026 is a Saturday
    assert _after(api, a, "month", 3, None, False, 15, "2026-11-15") == "2027-02-15"


def _series(api, w, title):
    return as_(api, w, w.editor, "select id,status,due_at,starts_on from pulse.task where title=%s and deleted_at is null order by created_at", (title,))


def _tick(worker, w):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select pulse.task_repeat_tick() n").fetchone()["n"]


def test_repeating_by_rule_is_made_once_per_day_by_the_schedule_and_by_finishing(api, worker, owner, three):
    a = three[0]
    with worker.transaction():
        today = worker.execute("select (now() at time zone pulse.org_time_zone(%s))::date d", (a.org,)).fetchone()["d"]
    start = today - timedelta(days=3)
    t = new_task(api, a, a.editor, title="Post on Instagram", dueOn=start.isoformat(), priority="high")
    r = one(api, a, a.editor, "select pulse.task_repeat_rule_set(%s,%s) r", (t, Jsonb({"every": "day"})))["r"]
    assert r["every"] == "day" and r["lastOn"] == start.isoformat() and r["nextOn"] == (start + timedelta(days=1)).isoformat()
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, a, a.editor, "select pulse.task_repeat_rule_set(%s,%s)", (t, Jsonb({"every": "day", "until": (today - timedelta(days=1)).isoformat()})))
    with pytest.raises((psycopg.errors.InsufficientPrivilege, psycopg.errors.NoDataFound)):
        as_(api, a, three[2].editor, "select pulse.task_repeat_rule_set(%s,%s)", (t, Jsonb({"every": "week"})))
    # The schedule makes today's one (not one per missed day); the old one stays open, overdue. Running again makes nothing.
    assert _tick(worker, a) == 1
    rows = _series(api, a, "Post on Instagram")
    assert len(rows) == 2 and rows[0]["status"] == "open" and rows[1]["starts_on"] == today
    assert _tick(worker, a) == 0 and len(_series(api, a, "Post on Instagram")) == 2
    # Finishing today's makes tomorrow's at once; the schedule does not make it again tomorrow.
    as_(api, a, a.editor, "select pulse.task_move(%s,'done',null)", (rows[1]["id"],))
    rows = _series(api, a, "Post on Instagram")
    assert len(rows) == 3 and rows[2]["starts_on"] == today + timedelta(days=1)
    with worker.transaction():
        set_tenant(worker, a.org)
        assert worker.execute("select count(*)::int n from pulse.task_repeat_made m join pulse.task_repeat r on r.id=m.repeat_id where r.task_id=%s", (rows[2]["id"],)).fetchone()["n"] == 3
    assert _tick(worker, a) == 0
    # Finishing the old, overdue one makes nothing: the series moved on.
    as_(api, a, a.editor, "select pulse.task_move(%s,'done',null)", (rows[0]["id"],))
    assert len(_series(api, a, "Post on Instagram")) == 3
    # The notification worker's minute tick runs it too.
    with worker.transaction():
        set_tenant(worker, a.org)
        worker.execute("select pulse.task_due_tick()")


def test_repeating_stops_on_its_stop_date_and_weekly_on_chosen_days(api, worker, owner, three):
    a = three[0]
    with worker.transaction():
        today = worker.execute("select (now() at time zone pulse.org_time_zone(%s))::date d", (a.org,)).fetchone()["d"]
    t = new_task(api, a, a.editor, title="Last newsletter", dueOn=today.isoformat())
    one(api, a, a.editor, "select pulse.task_repeat_rule_set(%s,%s) r", (t, Jsonb({"every": "week", "until": today.isoformat()})))
    assert one(api, a, a.editor, "select pulse.task_repeat_get(%s) r", (t,))["r"]["nextOn"] is None
    as_(api, a, a.editor, "select pulse.task_move(%s,'done',null)", (t,))
    assert len(_series(api, a, "Last newsletter")) == 1
    assert one(api, a, a.editor, "select pulse.task_repeat_get(%s) r", (t,))["r"] == {"every": None}
    # Weekly on Monday, Wednesday and Friday, every other week.
    w = new_task(api, a, a.editor, title="Shoot reels", dueOn=today.isoformat())
    r = one(api, a, a.editor, "select pulse.task_repeat_rule_set(%s,%s) r", (w, Jsonb({"every": "week", "interval": 2, "weekdays": [5, 1, 3, 3]})))["r"]
    assert r["weekdays"] == [1, 3, 5] and r["interval"] == 2
    nxt = date.fromisoformat(r["nextOn"])
    assert nxt.isoweekday() in (1, 3, 5) and nxt > today


def test_finer_states_live_inside_the_existing_ones(api, worker, owner, three):
    a = three[0]
    t = new_task(api, a, a.editor, title="Send the cut to the client")
    r = one(api, a, a.editor, "select pulse.task_stage_set(%s,'waiting','Sent on WhatsApp') r", (t,))["r"]
    assert r == {"status": "blocked", "stage": "waiting"}
    assert one(api, a, a.editor, "select pulse.task_stage_set(%s,'on_hold',null) r", (t,))["r"] == {"status": "blocked", "stage": "on_hold"}
    assert one(api, a, a.editor, "select pulse.task_stage_set(%s,'revision',null) r", (t,))["r"] == {"status": "in_progress", "stage": "revision"}
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, a, a.editor, "select pulse.task_stage_set(%s,'parked',null)", (t,))
    # Moving on by the ordinary path drops the finer state; reports count it as the status it is in.
    as_(api, a, a.editor, "select pulse.task_move(%s,'done',null)", (t,))
    assert one(api, a, a.editor, "select status,stage from pulse.task where id=%s", (t,)) == {"status": "done", "stage": None}
    # Start date: not after the due day.
    d = new_task(api, a, a.editor, title="Plan the launch", dueOn="2026-12-10")
    assert one(api, a, a.editor, "select pulse.task_plan_set(%s,%s) r", (d, Jsonb({"startsOn": "2026-12-01"})))["r"] == {"startsOn": "2026-12-01"}
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="after the due date"):
        as_(api, a, a.editor, "select pulse.task_plan_set(%s,%s)", (d, Jsonb({"startsOn": "2026-12-11"})))
    with pytest.raises((psycopg.errors.InsufficientPrivilege, psycopg.errors.NoDataFound)):
        as_(api, a, three[1].editor, "select pulse.task_plan_set(%s,%s)", (d, Jsonb({"startsOn": None})))


def test_time_targets_are_the_persons_own(api, worker, owner, three):
    a = three[0]
    assert one(api, a, a.editor, "select pulse.time_target_set(%s) r", (Jsonb({"dailyMinutes": 240, "weeklyMinutes": 1200}),))["r"] == {"dailyMinutes": 240, "weeklyMinutes": 1200}
    assert _day(api, a.org, a.editor)["targets"]["dailyMinutes"] == 240
    assert one(api, a, a.editor2, "select count(*)::int n from pulse.person_time_target")["n"] == 0
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, a, a.editor, "select pulse.time_target_set(%s)", (Jsonb({"dailyMinutes": 5}),))


API_SCRIPT = r'''
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const E = process.env;
const call = async (url, token, payload) => { const r = await app.inject({ url, method: payload ? 'POST' : 'GET', headers: { 'x-pulse-session': token }, ...(payload ? { payload } : {}) }); return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body }; };
const ok = (cond, label, extra) => { if (!cond) { console.error('FAILED', label, JSON.stringify(extra ?? '').slice(0, 1500)); process.exit(1); } };
let r = await call('/api/v0/tasks/my-day', E.TOKEN_A);
ok(r.status === 200 && r.body.seats.length === 2, 'two seats', r);
const [sa, sb] = r.body.seats;
ok(sa.org === E.ORG_A && sa.current && sb.org === E.ORG_B && !sb.current && sa.ok && sb.ok, 'current first, both read', r);
const titles = r.body.seats.flatMap((s) => s.tasks.map((t) => `${s.org}:${t.title}`));
ok(titles.includes(`${E.ORG_A}:Edit the podcast episode`) && titles.includes(`${E.ORG_B}:Call ten leads`), 'my work in each organisation', titles);
ok(!JSON.stringify(r.body).includes('Sales team secret plan') && !JSON.stringify(r.body).includes("A colleague's own work") && !JSON.stringify(r.body).includes("Not Sakobe's company"), 'nothing the person cannot see', titles);
ok(!JSON.stringify(r.body).includes(E.PERSON_B), 'no person ids of other organisations', r);
// The same from b's session: the same two seats, b first.
r = await call('/api/v0/tasks/my-day', E.TOKEN_B);
ok(r.status === 200 && r.body.seats[0].org === E.ORG_B && r.body.seats.length === 2, 'b first from b', r);
// A colleague without an account: only their own organisation.
r = await call('/api/v0/tasks/my-day', E.TOKEN_OTHER);
ok(r.status === 200 && r.body.seats.length === 1 && r.body.seats[0].org === E.ORG_A && !JSON.stringify(r.body).includes('Call ten leads'), 'colleague sees only their own', r);
// Acting inside b from a's session: start the clock in b, then a pauses it.
r = await call('/api/v0/tasks/my-day/act', E.TOKEN_A, { org: E.ORG_B, task: E.TASK_B, action: 'start' });
ok(r.status === 200 && r.body.running === true, 'start in b', r);
r = await call(`/api/v0/tasks/${E.TASK_A}/timer`, E.TOKEN_A, { on: true });
ok(r.status === 200 && r.body.running === true, 'start in a', r);
r = await call('/api/v0/tasks/my-day', E.TOKEN_A);
ok(r.body.seats[0].timer?.taskId === E.TASK_A && r.body.seats[1].timer === null, 'one clock across the account', r.body.seats.map((s) => s.timer));
// Not a seat: refused. Someone else's task in b: refused inside b.
r = await call('/api/v0/tasks/my-day/act', E.TOKEN_A, { org: E.ORG_C, task: E.TASK_C, action: 'done' });
ok(r.status === 404, 'not my organisation', r);
r = await call('/api/v0/tasks/my-day/act', E.TOKEN_A, { org: E.ORG_B, task: E.TASK_SECRET, action: 'done' });
ok([403, 404].includes(r.status), "someone else's task in b", r);
r = await call('/api/v0/tasks/my-day/act', E.TOKEN_A, { org: E.ORG_B, task: E.TASK_B, action: 'done' });
ok(r.status === 200 && r.body.status === 'done', 'done in b', r);
// Plans, repeats and targets through the API.
r = await call(`/api/v0/tasks/${E.TASK_A}/schedule`, E.TOKEN_A, { stage: 'waiting', repeat: { every: 'week', weekdays: [1, 4] } });
ok(r.status === 200 && r.body.stage === 'waiting' && r.body.status === 'blocked' && r.body.repeat.every === 'week' && r.body.repeat.weekdays.join() === '1,4', 'plan', r);
r = await call(`/api/v0/tasks/${E.TASK_A}/schedule`, E.TOKEN_A, { stage: 'nonsense' });
ok(r.status === 400, 'a stage that does not exist', r);
r = await call('/api/v0/tasks/targets', E.TOKEN_A, { dailyMinutes: 300 });
ok(r.status === 200 && r.body.dailyMinutes === 300, 'targets', r);
await app.close(); await pool.end();
'''


def _token(api, w, viewer, org):
    """A session in `org` minted by the account switch (as the browser's switch does), and its raw token."""
    raw = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    with api.transaction():
        set_tenant(api, w.org, viewer)
        api.execute("select pulse.account_switch(%s,%s,'Browser')", (org, hashlib.sha256(raw.encode()).hexdigest()))
    return raw


def _other_token(owner, w, person):
    raw = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.login_session(org_id,person_id,token_hash,expires_at,device,remembered,via) values(%s,%s,%s,now()+interval '1 day','Browser',true,'account')",
                      (w.org, person, hashlib.sha256(raw.encode()).hexdigest()))
    return raw


def test_my_day_api_reads_each_seat_inside_its_organisation(api, worker, owner, three):
    a, b, c = three
    today = datetime.now(timezone.utc).date().isoformat()
    ta = new_task(api, a, a.editor, title="Edit the podcast episode", dueOn=today)
    new_task(api, a, a.editor2, title="A colleague's own work", dueOn=today)
    tb = new_task(api, b, b.editor, title="Call ten leads", dueOn=today)
    secret = new_task(api, b, b.editor2, title="Sales team secret plan", dueOn=today)
    tc = new_task(api, c, c.editor, title="Not Sakobe's company", dueOn=today)
    for w, person in ((a, a.editor), (a, a.editor2), (b, b.editor)):
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,evidence) values(%s,%s,'Editor',%s,'{}') on conflict do nothing", (w.org, person, 'u' + uuid.uuid4().hex[:8]))
        with api.transaction():
            set_tenant(api, w.org)
            api.execute("insert into privacy.notice_ack(org_id,person_id,notice_id,language,acknowledged_at,channel) values(%s,%s,'staff-v1','en',now()-interval '20 days','web') on conflict do nothing", (w.org, person))

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")),
           "TOKEN_A": _token(api, a, a.editor, a.org), "TOKEN_B": _token(api, a, a.editor, b.org), "TOKEN_OTHER": _other_token(owner, a, a.editor2),
           "ORG_A": str(a.org), "ORG_B": str(b.org), "ORG_C": str(c.org), "PERSON_B": str(b.editor),
           "TASK_A": str(ta), "TASK_B": str(tb), "TASK_SECRET": str(secret), "TASK_C": str(tc)}
    root = Path(__file__).resolve().parents[2] / "services/api"
    p = subprocess.run(["node", "--input-type=module", "-e", API_SCRIPT], cwd=root, env=env, capture_output=True, text=True, timeout=240)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]


# COMPANY-MARKS: a synthetic square logo (an SVG the brand upload accepts: no script, no outside references).
_MARK = (b'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
         b'<rect width="64" height="64" rx="14" fill="#1f6f5c"/><path d="M16 44V20h14a8 8 0 0 1 0 16h-6l10 8" fill="none" stroke="#fff" stroke-width="5"/></svg>')
_ACCENT = "#7a3db8"


def _staff_ready(api, worker, w, person):
    """The person may open the app (a profile and the staff privacy notice read), as a real staff seat."""
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,evidence) values(%s,%s,'Editor',%s,'{}') on conflict do nothing", (w.org, person, 'u' + uuid.uuid4().hex[:8]))
    with api.transaction():
        set_tenant(api, w.org)
        api.execute("insert into privacy.notice_ack(org_id,person_id,notice_id,language,acknowledged_at,channel) values(%s,%s,'staff-v1','en',now()-interval '20 days','web') on conflict do nothing", (w.org, person))


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_company_marks_in_my_day_in_the_browser(api, worker, owner):
    """services/api/test/company-marks-browser-runner.mjs: one account in three companies: one with its own logo, one
    with only a brand colour, one with neither. My day marks each by its logo, else its initials on its brand colour,
    else one neutral tile; stripes carry the brand colour. 390 and 1440, light and dark. Screenshots with
    PULSE_CM_SCREENSHOTS."""
    a, b, c = (build_world(worker, owner, api) for _ in range(3))
    other = build_world(worker, owner, api)
    today = datetime.now(timezone.utc).date()
    for w, name in ((a, "Synthetic Riverside Studio"), (b, "Synthetic Harbour Sales"), (c, "Synthetic Third Co")):
        with owner.transaction():
            set_tenant(owner, w.org)
            owner.execute("update pulse.org set name=%s where id=%s", (name, w.org))
            if w is a:
                # The browser signs in through Access as the editor's Workspace account.
                owner.execute("update pulse.account set purpose='Workspace account' where org_id=%s and handle=%s", (w.org, w.editor_handle))
                owner.execute("insert into pulse.org_brand(org_id,mark,mark_mime,version) values(%s,%s,'image/svg+xml',3)", (w.org, _MARK))
            if w is b:
                owner.execute("insert into pulse.org_brand(org_id,accent) values(%s,%s)", (w.org, _ACCENT))
        _staff_ready(api, worker, w, w.editor)
    _account(owner, (a.org, a.editor), (b.org, b.editor), (c.org, c.editor))
    new_task(api, a, a.editor, title="Synthetic edit the riverside reel", dueOn=(today - timedelta(days=5)).isoformat(), priority="high", estimateMinutes=60)
    new_task(api, b, b.editor, title="Synthetic call the harbour leads", dueOn=today.isoformat(), estimateMinutes=45)
    new_task(api, c, c.editor, title="Synthetic tidy the third ledger", dueOn=today.isoformat())
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config),
           "TEST_IDS": json.dumps({"token": _token(api, a, a.editor, a.org), "email": a.editor_handle, "orgA": str(a.org), "orgOther": str(other.org), "accent": _ACCENT})}
    p = subprocess.run(["node", "test/company-marks-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1500, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
