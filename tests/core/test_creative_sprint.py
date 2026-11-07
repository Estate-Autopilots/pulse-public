"""EST-1474 (0620): Creative Strategy slice 1 through the real API. A growth strategist starts a sprint on a client
project; the sprint's strategists, leadership and admins open it, a colleague outside it gets 403 and an HR-only account
is refused; a late input moves the clock; an older edit arriving after a newer one changes nothing; CS Home lists the
strategist's alerts and deliverables and only leadership opens someone else's. EST-1792: a sprint needs its approver and
both strategists, and every person given work (on start, on reassigning, as an item's owner) is an active colleague of the
same organisation. In the database: another organisation sees none of it and nothing is deleted. Synthetic tenant, people
and project only."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant

ROOT = Path(__file__).resolve().parents[2]

API = r'''
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), emails = JSON.parse(process.env.TEST_EMAILS);
const call = async (path, role, body) => {
  const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': emails[role] }, ...(body === undefined ? {} : { payload: body }) });
  let json = null; try { json = r.json(); } catch { /* empty */ }
  return { status: r.statusCode, body: json };
};
const ok = (c, m, r) => assert.ok(c, `${m}: ${JSON.stringify(r?.body ?? r).slice(0, 1500)}`);
const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);   // the synthetic org's zone is India
const dayOne = new Date(Date.parse(today + 'T00:00:00Z') - 2 * 86400e3).toISOString().slice(0, 10);

let r = await call('creative/sprints', 'cs', { projectId: E.project, package: 'growth', dayOne });
ok(r.status === 403, 'a creative strategist without a manager role cannot start a sprint', r);
// EST-1792: the approver and both strategists are needed, and only active colleagues of this organisation.
const start = { projectId: E.project, package: 'growth', dayOne, csPersonId: E.cs, approver: 'Synthetic Approver' };
for (const [change, why] of [[{ approver: undefined }, 'no approver'], [{ approver: '   ' }, 'a blank approver'], [{ csPersonId: undefined }, 'no creative strategist'],
  [{ csPersonId: '' }, 'a cleared creative strategist'], [{ csPersonId: E.foreign }, 'a person from another organisation'], [{ csPersonId: E.inactive }, 'an inactive person'],
  [{ csPersonId: E.unknown }, 'an unknown id'], [{ gsPersonId: E.foreign }, 'a growth strategist from another organisation']]) {
  r = await call('creative/sprints', 'gs', { ...start, ...change }); ok(r.status === 400, `no sprint starts with ${why}`, r);
}
r = await call('creative/sprints', 'gs', start);
ok(r.status === 200 && r.body.sprint.gsPersonId === E.gs && r.body.inputs.length === 8 && r.body.milestones.length === 8, 'the growth strategist starts a Growth sprint', r);
const id = r.body.sprint.id;
r = await call('creative/sprints', 'admin', { ...start, package: 'starter' });
ok(r.status === 409, 'one active sprint per project', r);

for (const who of ['cs', 'gs', 'admin']) { r = await call(`creative/sprints/${id}`, who); ok(r.status === 200, `${who} opens the sprint`, r); }
r = await call(`creative/sprints/${id}`, 'other'); ok(r.status === 403, 'a colleague outside the sprint gets 403', r);
r = await call(`creative/sprints/${id}`, 'hr'); ok(r.status === 403, 'an HR-only account is refused', r);
r = await call('creative/sprints', 'other'); ok(r.status === 200 && r.body.sprints.length === 0, 'a non-member lists no sprints', r);

// Every input in on Day 1 except MahaRERA, which arrives today (two days late): the Blueprint moves two days, the meet does not.
for (const i of (await call(`creative/sprints/${id}`, 'gs')).body.inputs)
  await call(`creative/sprints/${id}/items`, 'gs', { kind: 'input', key: i.key, ownerPersonId: E.gs, doneOn: i.key === 'maharera' ? today : dayOne });
r = await call(`creative/sprints/${id}`, 'cs');
ok(r.body.clock.shift === 2 && r.body.clock.missingInputs === 0, 'a late input moves the clock day for day', r);
ok(r.body.milestones.find((m) => m.key === 'research_meet').due === dayOne, 'the research meet stays on Day 1', r);
ok(r.body.milestones.find((m) => m.key === 'deep_research').day === 4, 'Deep Research (Growth, Day 2) is now Day 4', r);

// Concurrent edits keep the newest: the later edit wins even when the older one arrives last.
const newer = new Date().toISOString(), older = new Date(Date.now() - 5000).toISOString();
await call(`creative/sprints/${id}/items`, 'cs', { kind: 'milestone', key: 'research_meet', doneOn: dayOne, note: 'newest', editedAt: newer });
r = await call(`creative/sprints/${id}/items`, 'cs', { kind: 'milestone', key: 'research_meet', doneOn: null, note: 'older', editedAt: older });
const meet = r.body.milestones.find((m) => m.key === 'research_meet');
ok(meet.doneOn === dayOne && meet.note === 'newest' && meet.state === 'done', 'an older edit arriving later changes nothing', r);
r = await call(`creative/sprints/${id}`, 'cs', { approver: 'Older Name', editedAt: older });
r = await call(`creative/sprints/${id}`, 'cs', { approver: 'Newest Name', editedAt: new Date(Date.now() + 1000).toISOString() });
ok(r.body.sprint.approver === 'Newest Name', 'intake edits keep the newest too', r);
r = await call(`creative/sprints/${id}`, 'cs', { csPersonId: E.other });
ok(r.status === 403, 'a strategist cannot move the strategists', r);
r = await call(`creative/sprints/${id}/items`, 'cs', { kind: 'input', key: 'no_such_input', doneOn: today });
ok(r.status === 400, 'only the sprint\'s own inputs and deliverables', r);

// EST-1792: reassigning and item owners take only active colleagues of this organisation; the intake people stay named.
for (const [who, why] of [[E.foreign, 'another organisation'], [E.inactive, 'inactive'], [E.unknown, 'unknown']]) {
  r = await call(`creative/sprints/${id}`, 'gs', { csPersonId: who }); ok(r.status === 400, `the creative strategist cannot become a person who is ${why}`, r);
  r = await call(`creative/sprints/${id}`, 'admin', { gsPersonId: who }); ok(r.status === 400, `the growth strategist cannot become a person who is ${why}`, r);
  r = await call(`creative/sprints/${id}/items`, 'cs', { kind: 'input', key: 'brochure', ownerPersonId: who, doneOn: dayOne }); ok(r.status === 400, `an input's owner cannot be ${why}`, r);
  r = await call(`creative/sprints/${id}/items`, 'cs', { kind: 'milestone', key: 'deep_research', ownerPersonId: who }); ok(r.status === 400, `a deliverable's owner cannot be ${why}`, r);
}
for (const [change, why] of [[{ approver: '' }, 'the approver'], [{ gsPersonId: null }, 'the growth strategist'], [{ csPersonId: '' }, 'the creative strategist']]) {
  r = await call(`creative/sprints/${id}`, 'admin', change); ok(r.status === 400, `${why} cannot be cleared`, r);
}
r = await call(`creative/sprints/${id}`, 'gs');
ok(r.body.sprint.gsPersonId === E.gs && r.body.sprint.csPersonId === E.cs && r.body.sprint.approver === 'Newest Name', 'nothing refused was stored', r);
ok(r.body.inputs.find((i) => i.key === 'brochure').ownerPersonId === E.gs && r.body.milestones.find((m) => m.key === 'deep_research').ownerPersonId === E.cs, 'the owners stayed', r);
r = await call(`creative/sprints/${id}/items`, 'cs', { kind: 'milestone', key: 'deep_research', ownerPersonId: E.other });
ok(r.status === 200 && r.body.milestones.find((m) => m.key === 'deep_research').ownerPersonId === E.other, 'an active colleague can own a deliverable', r);
r = await call(`creative/sprints/${id}/items`, 'cs', { kind: 'milestone', key: 'deep_research', ownerPersonId: null });
ok(r.status === 200 && r.body.milestones.find((m) => m.key === 'deep_research').ownerPersonId === null, 'a deliverable may have no owner', r);

r = await call('creative/home', 'cs');
ok(r.status === 200 && r.body.person.id === E.cs && r.body.rows.length > 0 && r.body.rows.every((x) => x.href.startsWith(`/creative/sprints/${id}#`)), 'CS Home lists the strategist\'s work', r);
ok(!r.body.rows.some((x) => x.kind === 'alert'), 'no Day-1 alert once inputs are in and the meet is saved', r);
r = await call(`creative/home?person=${E.cs}`, 'other'); ok(r.status === 403, 'only leadership opens someone else\'s Home', r);
r = await call(`creative/home?person=${E.cs}`, 'admin'); ok(r.status === 200 && r.body.person.id === E.cs, 'an admin opens the strategist\'s Home', r);
console.log(JSON.stringify({ ok: true }));
await app.close(); await pool.end();
'''


def _person(worker, w, name, handle, role=None):
    pid = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, name))
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                       (w.org, f"{handle}@{w.domain}", pid))
        if role:
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2026-01-01')", (w.org, pid, role))
    return pid


@pytest.fixture
def people(worker, owner, api):
    w = build_world(worker, owner, api)
    w.admin = _person(worker, w, "Synthetic Admin", "admin", "admin")
    w.gs = _person(worker, w, "Synthetic Growth", "gs", "pgs")
    w.cs = _person(worker, w, "Synthetic Creative", "cs")
    w.other = _person(worker, w, "Synthetic Other", "other")
    w.hr = _person(worker, w, "Synthetic HR", "hr", "hr")
    w.inactive = _person(worker, w, "Synthetic Former", "former")
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.person set status='inactive' where id=%s", (w.inactive,))
    elsewhere = build_world(worker, owner, api)
    w.foreign = _person(worker, elsewhere, "Synthetic Elsewhere", "elsewhere")
    return w


def _config(value):
    from psycopg.conninfo import conninfo_to_dict
    d = conninfo_to_dict(value)
    d["database"] = d.pop("dbname")
    return json.dumps(d)


def test_creative_sprint_through_the_api(people):
    from conftest import dsn
    w = people
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "PULSE_CREATIVE": "1", "TEST_API_CONFIG": _config(dsn("api")),
           "TEST_IDS": json.dumps({"project": str(w.project), "gs": str(w.gs), "cs": str(w.cs), "other": str(w.other), "inactive": str(w.inactive),
                                   "foreign": str(w.foreign), "unknown": str(uuid.uuid4())}),
           "TEST_EMAILS": json.dumps({k: f"{k}@{w.domain}" for k in ("admin", "gs", "cs", "other", "hr")})}
    p = subprocess.run(["node", "--input-type=module", "-e", API], cwd=ROOT / "services/api", env=env, capture_output=True, text=True, timeout=240)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]


def test_another_organisation_sees_no_sprint_and_nothing_is_deleted(api, people, worker, owner):
    w = people
    with api.transaction():
        set_tenant(api, w.org, w.admin)
        sid = api.execute("""insert into pulse.creative_sprint(org_id,project_id,package,day_one,cs_person_id) values(%s,%s,'starter','2026-11-02',%s)
                             returning id""", (w.org, w.project, w.cs)).fetchone()["id"]
        api.execute("insert into pulse.creative_sprint_item(org_id,sprint_id,kind,key) values(%s,%s,'input','brochure')", (w.org, sid))
    for sql in ("delete from pulse.creative_sprint_item where sprint_id=%s", "delete from pulse.creative_sprint where id=%s"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            set_tenant(api, w.org, w.admin)
            api.execute(sql, (sid,))
    other = build_world(worker, owner, api)
    with api.transaction():
        set_tenant(api, other.org)
        assert api.execute("select count(*)::int n from pulse.creative_sprint").fetchone()["n"] == 0
        assert api.execute("select count(*)::int n from pulse.creative_sprint_item").fetchone()["n"] == 0
        with pytest.raises(psycopg.errors.InsufficientPrivilege):    # writing into another organisation
            api.execute("insert into pulse.creative_sprint(org_id,project_id,package,day_one) values(%s,%s,'starter','2026-11-02')", (w.org, w.project))
