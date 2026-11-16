"""MY-TASKS (owner, 28 Oct 2026): My tasks says who gave each task and lists what I created and what I review; the
Home's money belongs to whoever holds Finance or Leadership. Synthetic tenants only."""
import json
import os
import subprocess
from pathlib import Path

from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import team  # noqa: F401  (the fixture)

SCRIPT = r'''
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const call = async (url, email, payload) => { const r = await app.inject({ url, method: payload ? 'POST' : 'GET', headers: { 'cf-access-authenticated-user-email': email }, ...(payload ? { payload } : {}) }); return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body }; };
const ok = (cond, label, extra) => { if (!cond) { console.error('FAILED', label, JSON.stringify(extra ?? '').slice(0, 900)); process.exit(1); } };
const member = process.env.TEST_MEMBER, admin = 'admin@estateautopilots.com', hr = 'hr@estateautopilots.com';
const MEMBER = process.env.TEST_MEMBER_ID, LEAD = process.env.TEST_LEAD_ID;
let r;
if (process.env.TEST_MODE === 'nobody') {
  // Nobody holds Finance or Leadership: the admin keeps the company's money on their Home.
  r = await call('/api/v0/me', admin);
  ok(r.status === 200 && r.body.moneyHome === true, 'with nobody in finance or leadership the admin keeps the money', r.body?.moneyHome);
} else {
  // The lead holds Leadership: the money is theirs; an admin without either role and a member are not asked about it.
  r = await call('/api/v0/me', hr); ok(r.status === 200 && r.body.moneyHome === true, 'leadership has the money on Home', r.body?.moneyHome);
  r = await call('/api/v0/me', admin); ok(r.status === 200 && r.body.moneyHome === false, 'an admin without finance or leadership does not', r.body?.moneyHome);
  r = await call('/api/v0/me', member); ok(r.status === 200 && r.body.moneyHome === false, 'a member does not', r.body?.moneyHome);

  r = await call('/api/v0/work/tasks', hr, { title: 'Synthetic EXMP0001234 teaser cut', assigneeId: MEMBER });
  ok(r.status === 200 && r.body.id, 'the lead gives the member a task', r); const given = r.body.id;
  r = await call('/api/v0/work/tasks', member, { title: 'Synthetic EXMP0001234 own note' });
  ok(r.status === 200 && r.body.id, 'the member writes their own', r); const own = r.body.id;

  r = await call('/api/v0/tasks/home', member);
  ok(r.status === 200 && Array.isArray(r.body.created) && Array.isArray(r.body.reviewing), 'my tasks carries the lenses', r);
  const g = r.body.rows.find((t) => t.id === given), o = r.body.rows.find((t) => t.id === own);
  ok(g && g.assignerId === LEAD && g.assignerName === 'Project Lead' && 'assignerPhotoAt' in g && g.createdBy === LEAD, 'a given task says who gave it', g);
  ok(o && o.assignerId === MEMBER && o.createdBy === MEMBER, 'my own note is from me (I created)', o);
  ok(!r.body.created.some((t) => t.id === own) && !r.body.reviewing.some((t) => t.id === given), 'created and reviewing hold other people\'s tasks only', r.body);

  r = await call('/api/v0/tasks/home', hr);
  const c = r.body.created.find((t) => t.id === given), v = r.body.reviewing.find((t) => t.id === given);
  ok(c && c.assigneeId === MEMBER && c.assigneeName === 'Editor One', 'the lead sees it under I created, with who has it', r.body.created);
  ok(v && v.reviewerId === LEAD, 'and under I am reviewing (whoever assigned it reviews it)', r.body.reviewing);
  ok(!r.body.rows.some((t) => t.id === given), 'it is not on the lead\'s own plate', r.body.rows);

}
console.log(JSON.stringify({ ok: true }));
await app.close(); await pool.end();
'''


def _run(w, mode):
    d = conninfo_to_dict(dsn("api"))
    d["database"] = d.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(d), "TEST_MODE": mode,
           "TEST_MEMBER": w.editor_handle, "TEST_MEMBER_ID": str(w.editor), "TEST_LEAD_ID": str(w.lead)}
    root = Path(__file__).resolve().parents[2] / "services/api"
    p = subprocess.run(["node", "--input-type=module", "-e", SCRIPT], cwd=root, env=env, capture_output=True, text=True, timeout=240)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]


def test_my_tasks_lenses_and_whose_money(worker, owner, api, team):  # noqa: F811
    w = team
    _run(w, "nobody")
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values (%s,%s,'leadership','2026-01-01')", (w.org, w.lead))
    _run(w, "roles")
