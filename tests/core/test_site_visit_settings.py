"""EST-1407 (0630): Settings → Site visit through the real API. Everyone who works with customers reads it (version 1
is the defaults); only an admin saves, each save adds the next version, a save from an older version is 409 and a save
that leaves out a key is 422 with the keys. An HR-only account is refused. In the database: nothing is written directly,
an older version stays as it was, and another organisation still sees the defaults. Synthetic tenant and people only."""
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
const emails = JSON.parse(process.env.TEST_EMAILS);
const call = async (path, role, body, method) => {
  const r = await app.inject({ url: '/api/v0/' + path, method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'cf-access-authenticated-user-email': emails[role] }, ...(body === undefined ? {} : { payload: body }) });
  let json = null; try { json = r.json(); } catch { /* empty */ }
  return { status: r.statusCode, body: json };
};
const ok = (c, m, r) => assert.ok(c, `${m}: ${JSON.stringify(r?.body ?? r).slice(0, 1500)}`);
const field = (key, extra = {}) => ({ key, label: key.replace(/_/g, ' '), hint: null, exampleImageId: null, required: false, maxPhotos: 1, position: 0, state: 'active', appliesTo: null, ...extra });

let r = await call('settings/site-visit', 'member');
ok(r.status === 200 && r.body.fieldSetVersion === 1 && r.body.visitTypes.length === 3 && r.body.fields.length === 0 && r.body.canEdit === false, 'a member reads the defaults', r);
const { canEdit, ...v1 } = r.body;
r = await call('settings/site-visit', 'hr'); ok(r.status === 403, 'an HR-only account is refused', r);

const v2body = { ...v1, fields: [field('roof_overview', { maxPhotos: 6 }), field('voltmeter_reading', { required: true, appliesTo: ['installation'], position: 1 })] };
r = await call('settings/site-visit', 'member', v2body, 'PUT'); ok(r.status === 403, 'a member cannot save', r);
r = await call('settings/site-visit', 'admin', v2body, 'PUT');
ok(r.status === 200 && r.body.fieldSetVersion === 2 && r.body.fields.length === 2, 'the admin saves version 2', r);
r = await call('settings/site-visit', 'admin', v2body, 'PUT'); ok(r.status === 409, 'a save from version 1 after version 2 exists is 409', r);
r = await call('settings/site-visit', 'admin', { ...v2body, fieldSetVersion: 2, fields: [v2body.fields[0]] }, 'PUT');
ok(r.status === 422 && r.body.error === 'keys_removed' && r.body.keys.join() === 'voltmeter_reading', 'leaving a key out is 422 and names it', r);
r = await call('settings/site-visit', 'admin', { ...v2body, fieldSetVersion: 2, fields: [v2body.fields[0], { ...v2body.fields[1], state: 'archived', label: 'Voltmeter (old)' }] }, 'PUT');
ok(r.status === 200 && r.body.fieldSetVersion === 3 && r.body.fields[1].state === 'archived', 'archiving and renaming save version 3', r);
r = await call('settings/site-visit', 'admin', { ...v2body, fieldSetVersion: 3, extra: true }, 'PUT'); ok(r.status === 400, 'an unknown property is refused', r);
r = await call('settings/site-visit', 'member');
ok(r.body.fieldSetVersion === 3 && r.body.fields[1].label === 'Voltmeter (old)', 'everyone reads the newest version', r);
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
    w.member = _person(worker, w, "Synthetic Member", "member")
    w.hr = _person(worker, w, "Synthetic HR", "hr", "hr")
    return w


def _config(value):
    from psycopg.conninfo import conninfo_to_dict
    d = conninfo_to_dict(value)
    d["database"] = d.pop("dbname")
    return json.dumps(d)


def test_site_visit_settings_through_the_api(people):
    from conftest import dsn
    w = people
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": _config(dsn("api")),
           "TEST_EMAILS": json.dumps({k: f"{k}@{w.domain}" for k in ("admin", "member", "hr")})}
    p = subprocess.run(["node", "--input-type=module", "-e", API], cwd=ROOT / "services/api", env=env, capture_output=True, text=True, timeout=240)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]


def test_versions_are_history_and_stay_in_their_organisation(api, people, worker, owner):
    w = people
    body = json.dumps({"visitTypes": [{"key": "survey", "label": "Survey", "state": "active", "position": 0}], "fields": [], "banner": {}})
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.member)
        api.execute("select pulse.site_visit_settings_save(1,%s::jsonb)", (body,))
    with api.transaction():
        set_tenant(api, w.org, w.admin)
        assert api.execute("select pulse.site_visit_settings_save(1,%s::jsonb) v", (body,)).fetchone()["v"] == 2
    with pytest.raises(psycopg.errors.SerializationFailure), api.transaction():    # made from version 1 again
        set_tenant(api, w.org, w.admin)
        api.execute("select pulse.site_visit_settings_save(1,%s::jsonb)", (body,))
    for sql in ("update pulse.site_visit_field_set set body='{}' where org_id=%s", "delete from pulse.site_visit_field_set where org_id=%s"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            set_tenant(api, w.org, w.admin)
            api.execute(sql, (w.org,))
    other = build_world(worker, owner, api)
    with api.transaction():
        set_tenant(api, other.org)
        assert api.execute("select count(*)::int n from pulse.site_visit_field_set").fetchone()["n"] == 0
