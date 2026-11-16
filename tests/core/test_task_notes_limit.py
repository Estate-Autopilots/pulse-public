"""EST-1072 (0500): a task's notes hold up to 20,000 characters, saved whole; longer is refused, never cut. Synthetic
tenants and text only."""
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
from test_tasks_rt1 import as_, new_task, one, team  # noqa: F401  (team is a fixture)

LINE = "09:30 synthetic status: cut 3 of 8 done, waiting on the music file.\n"


def status_lines(n):
    """Short status lines, the way a busy task's notes fill up in a day: exactly n characters, ending in a full stop."""
    return (LINE * (n // len(LINE) + 1))[: n - 1] + "."


def test_task_save_keeps_notes_up_to_20000_characters_whole(api, team):  # noqa: F811
    w = team
    tid = new_task(api, w, w.editor, title="Edit the synthetic teaser", notes=status_lines(4001))
    assert one(api, w, w.editor, "select notes from pulse.task where id=%s", (tid,))["notes"] == status_lines(4001)
    full = status_lines(20000)
    as_(api, w, w.editor, "select pulse.task_save(%s,%s)", (tid, Jsonb({"notes": full})))
    assert one(api, w, w.editor, "select notes from pulse.task where id=%s", (tid,))["notes"] == full
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Keep notes under 20,000 characters"):
        as_(api, w, w.editor, "select pulse.task_save(%s,%s)", (tid, Jsonb({"notes": full + "x"})))
    # "Why it matters" keeps its own 1,000 and now says so.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Keep why it matters under 1,000 characters"):
        as_(api, w, w.editor, "select pulse.task_save(%s,%s)", (tid, Jsonb({"valueNote": "v" * 1001})))
    # The refused saves changed nothing.
    assert one(api, w, w.editor, "select notes from pulse.task where id=%s", (tid,))["notes"] == full


def test_the_column_allows_20000_and_no_more(api, worker, team):  # noqa: F811
    w = team
    tid = new_task(api, w, w.editor, title="Synthetic column check")
    with worker.transaction():
        set_tenant(worker, w.org)
        checks = [r["d"] for r in worker.execute(
            "select pg_get_constraintdef(oid) d from pg_constraint where conrelid='pulse.task'::regclass and contype='c'"
            " and pg_get_constraintdef(oid) like '%(notes)%'").fetchall()]
        worker.execute("update pulse.task set notes=repeat('x',20000) where id=%s", (tid,))
    assert checks == ["CHECK ((length(notes) <= 20000))"]
    with pytest.raises(psycopg.errors.CheckViolation):
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("update pulse.task set notes=repeat('x',20001) where id=%s", (tid,))


API_SCRIPT = r'''
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const call = async (url, email, payload) => { const r = await app.inject({ url, method: payload ? 'POST' : 'GET', headers: { 'cf-access-authenticated-user-email': email }, ...(payload ? { payload } : {}) }); return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body }; };
const ok = (cond, label, extra) => { if (!cond) { console.error('FAILED', label, JSON.stringify(extra ?? '').slice(0, 600)); process.exit(1); } };
const member = process.env.TEST_MEMBER;
const line = '09:30 synthetic status: cut 3 of 8 done, waiting on the music file.\n';
const note = (n) => line.repeat(Math.ceil(n / line.length) + 1).slice(0, n - 1) + '.';
const notesOf = async (tid) => (await call(`/api/v0/tasks/${tid}`, member)).body?.task?.notes;
const size = (r) => ({ status: r.status, error: r.body?.error ?? r.body?.message });
// Before EST-1072 the API cut a note at 4,000 characters without a word.
let r = await call('/api/v0/tasks', member, { title: 'Edit the synthetic teaser', notes: note(4001) });
ok(r.status === 200 && r.body.id, 'create with a 4,001-character note', size(r)); const tid = r.body.id;
ok(await notesOf(tid) === note(4001), 'the 4,001-character note is kept whole', (await notesOf(tid))?.length);
r = await call(`/api/v0/tasks/${tid}`, member, { notes: note(20000) });
ok(r.status === 200, 'edit to 20,000 characters', size(r));
ok(await notesOf(tid) === note(20000), '20,000 characters kept whole', (await notesOf(tid))?.length);
// Characters are counted as the database counts them: 20,000 emoji fit, though JavaScript counts 40,000 units.
r = await call(`/api/v0/tasks/${tid}`, member, { notes: '🙂'.repeat(20000) });
ok(r.status === 200, '20,000 emoji fit', size(r));
r = await call(`/api/v0/tasks/${tid}`, member, { notes: note(20000) });
r = await call(`/api/v0/tasks/${tid}`, member, { notes: note(20001) });
ok(r.status === 400 && JSON.stringify(r.body).includes('20,000'), 'an edit over 20,000 is refused, not cut', size(r));
ok(await notesOf(tid) === note(20000), 'a refused edit leaves the note as it was', (await notesOf(tid))?.length);
r = await call('/api/v0/tasks', member, { title: 'Too long a note', notes: note(20001) });
ok(r.status === 400 && JSON.stringify(r.body).includes('20,000'), 'a new task over 20,000 is refused', size(r));
// + Create (work/tasks) keeps a long note whole too, and refuses one over 20,000.
r = await call('/api/v0/work/tasks', member, { title: 'Cut the synthetic reel', notes: note(4001) });
const wid = r.body?.id ?? r.body?.task?.id ?? r.body?.taskId;
ok(r.status === 200 && wid, '+ Create with a 4,001-character note', size(r));
ok(await notesOf(wid) === note(4001), '+ Create keeps the note whole', (await notesOf(wid))?.length);
r = await call('/api/v0/work/tasks', member, { title: 'Too long again', notes: note(20001) });
ok(r.status === 400 && JSON.stringify(r.body).includes('20,000'), '+ Create over 20,000 is refused', size(r));
console.log(JSON.stringify({ ok: true }));
await app.close(); await pool.end();
'''


def test_task_api_keeps_long_notes_whole_and_refuses_over_20000(worker, owner, api, team):  # noqa: F811
    w = team

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")),
           "TEST_MEMBER": w.editor_handle}
    root = Path(__file__).resolve().parents[2] / "services/api"
    p = subprocess.run(["node", "--input-type=module", "-e", API_SCRIPT], cwd=root, env=env, capture_output=True, text=True, timeout=240)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]
