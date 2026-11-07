"""UX-DELIGHT (6 Nov 2026): "Not applicable" closes a task without counting it as done. It is kept as Cancelled plus
closed_as, read back as the status not_applicable on v0 and v1, stays on My tasks (with the done ones), releases what
waits on it, and reopening drops the reason. Synthetic tenants only."""
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
const member = process.env.TEST_MEMBER;
let r;
r = await call('/api/v0/work/tasks', member, { title: 'Synthetic EXMP0001234 brochure reprint' }); ok(r.status === 200 && r.body.id, 'a task', r); const na = r.body.id;
r = await call('/api/v0/work/tasks', member, { title: 'Synthetic EXMP0001234 waits on the reprint' }); ok(r.status === 200 && r.body.id, 'a second task', r); const waiting = r.body.id;
r = await call(`/api/v0/tasks/${waiting}/block`, member, { blockerId: na }); ok(r.status === 200, 'the second waits on the first', r);

r = await call(`/api/v0/tasks/${na}/move`, member, { status: 'not_applicable', note: 'The client dropped the reprint' });
ok(r.status === 200 && r.body.status === 'not_applicable' && r.body.released === 1, 'not applicable closes it and releases what waited', r.body);
r = await call(`/api/v0/tasks/${na}/move`, member, { status: 'not_applicable' }); ok(r.status === 200 && r.body.status === 'not_applicable', 'again is a no-op', r.body);

r = await call('/api/v0/tasks/home', member);
const row = r.body.rows.find((t) => t.id === na), w = r.body.rows.find((t) => t.id === waiting);
ok(row && row.status === 'not_applicable', 'my tasks keeps it, read as not applicable', row);
ok(w && w.status !== 'blocked' && !w.openBlockers, 'the waiting task is free', w);

r = await call(`/api/v0/tasks/${na}`, member); ok(r.status === 200 && r.body.task.status === 'not_applicable', 'its page reads not applicable', r.body?.task?.status);
r = await call(`/api/v0/tasks/${na}/move`, member, { status: 'cancelled' }); ok(r.status === 200 && r.body.status === 'cancelled', 'not applicable to cancelled changes only the reason', r.body);
r = await call(`/api/v0/tasks/${na}/move`, member, { status: 'not_applicable' }); ok(r.status === 200 && r.body.status === 'not_applicable', 'and back', r.body);
r = await call(`/api/v0/tasks/${na}/move`, member, { status: 'open' }); ok(r.status === 200 && r.body.status === 'open', 'reopening works', r.body);
r = await call(`/api/v0/tasks/${na}/move`, member, { status: 'sideways' }); ok(r.status >= 400, 'an unknown status is refused', r);
console.log(JSON.stringify({ ok: true, na }));
await app.close(); await pool.end();
'''


def _run(w):
    d = conninfo_to_dict(dsn("api"))
    d["database"] = d.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(d), "TEST_MEMBER": w.editor_handle}
    root = Path(__file__).resolve().parents[2] / "services/api"
    p = subprocess.run(["node", "--input-type=module", "-e", SCRIPT], cwd=root, env=env, capture_output=True, text=True, timeout=240)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]
    for line in reversed(p.stdout.strip().splitlines()):  # the runner's own JSON line (the API may log after it)
        try:
            out = json.loads(line)
        except ValueError:
            continue
        if isinstance(out, dict) and out.get("ok"):
            return out
    raise AssertionError("the runner printed no result: " + p.stdout[-2000:])


def test_not_applicable_is_closed_not_done(worker, owner, api, team):  # noqa: F811
    w = team
    out = _run(w)
    with worker.transaction():
        set_tenant(worker, w.org)
        row = worker.execute("select status,closed_as from pulse.task where id=%s", (out["na"],)).fetchone()
        assert (row["status"], row["closed_as"]) == ("open", None), "reopening drops the reason"
        worker.execute("update pulse.task set status='cancelled',closed_as='not_applicable' where id=%s", (out["na"],))
        worker.execute("update pulse.task set status='in_progress' where id=%s", (out["na"],))
        assert worker.execute("select closed_as from pulse.task where id=%s", (out["na"],)).fetchone()["closed_as"] is None, "any move out of cancelled drops it"
