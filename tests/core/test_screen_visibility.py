"""EST-1419 (0610): an organisation admin hides screens per role through the real API, and /me tells each person which
screens their role does not see. A member cannot read or change the choice, the fixed screens (Dashboard, Chats, My desk,
HR desk) cannot be hidden, unknown roles and screens are refused, and hiding changes no permission: the hidden screen's
API still answers. In the database: only an admin writes, only in its own organisation, and each change is recorded.
Synthetic tenant and people only."""
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
const call = async (path, role, body) => {
  const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': emails[role] }, ...(body === undefined ? {} : { payload: body }) });
  let json = null; try { json = r.json(); } catch { /* empty */ }
  return { status: r.statusCode, body: json };
};
const ok = (c, m, r) => assert.ok(c, `${m}: ${JSON.stringify(r?.body ?? r).slice(0, 1500)}`);
const hidden = async (role) => (await call('me', role)).body.hiddenScreens;

let r = await call('settings/screens', 'admin');
ok(r.status === 200 && r.body.canEdit === true && r.body.newScreensHidden === false, 'the admin reads the choice', r);
ok(r.body.screens.length === 17 && r.body.screens.filter((s) => s.fixed).map((s) => s.key).join() === 'dashboard,chats,me,hr', 'seventeen screens, four fixed', r);
ok(Object.values(r.body.hidden).every((keys) => keys.length === 0), 'nothing is hidden before a save', r);
ok((await hidden('member')).keys.length === 0, 'a member sees every screen at first', r);

r = await call('settings/screens', 'member');
ok(r.status === 403, 'a member cannot read the choice', r);
r = await call('settings/screens', 'member', { newScreensHidden: false, hidden: { person: ['map'] } });
ok(r.status === 403, 'a member cannot change it', r);

r = await call('settings/screens', 'admin', { newScreensHidden: false, hidden: { person: ['clients', 'map'], admin: ['audit'] } });
ok(r.status === 200 && r.body.hidden.person.join() === 'clients,map' && r.body.hidden.admin.join() === 'audit', 'the admin hides two screens for members and one for admins', r);
let m = await hidden('member');
ok(m.keys.join() === 'clients,map' && m.paths.includes('/projects') && m.paths.includes('/map'), 'the member\'s /me names them and their pages', m);
ok((await hidden('admin')).keys.join() === 'audit', 'the admin\'s own role follows its list', r);
r = await call('projects', 'member');
ok(r.status === 200, 'hiding is not a permission: the hidden screen\'s API still answers', r);

r = await call('settings/screens', 'admin', { newScreensHidden: false, hidden: { person: ['chats'] } });
ok(r.status === 400 && /always stay visible/.test(r.body.error), 'Chats cannot be hidden', r);
for (const bad of [{ newScreensHidden: false, hidden: { owner: ['map'] } }, { newScreensHidden: false, hidden: { person: ['nowhere'] } }, { newScreensHidden: false, hidden: {}, extra: 1 }]) {
  r = await call('settings/screens', 'admin', bad);
  ok(r.status === 400, 'an unknown role, screen or field is refused', r);
}
ok((await hidden('member')).keys.join() === 'clients,map', 'a refused save changes nothing', r);

r = await call('settings/screens', 'admin', { newScreensHidden: true, hidden: { person: [] } });
ok(r.status === 200 && r.body.newScreensHidden === true && (await hidden('member')).keys.length === 0, 'unhide restores; the switch alone hides nothing known today', r);
console.log(JSON.stringify({ ok: true }));
await app.close(); await pool.end();
'''


def as_(api, w, who, sql, args=()):
    with api.transaction():
        set_tenant(api, w.org, who)
        cur = api.execute(sql, args)
        return cur.fetchall() if cur.description else []


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
    return w


def _config(value):
    from psycopg.conninfo import conninfo_to_dict
    d = conninfo_to_dict(value)
    d["database"] = d.pop("dbname")
    return json.dumps(d)


def test_admin_hides_screens_per_role_through_the_api(people):
    from conftest import dsn
    w = people
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": _config(dsn("api")),
           "TEST_EMAILS": json.dumps({k: f"{k}@{w.domain}" for k in ("admin", "member")})}
    p = subprocess.run(["node", "--input-type=module", "-e", API], cwd=ROOT / "services/api", env=env, capture_output=True, text=True, timeout=240)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]


CHOICE = {"newScreensHidden": False, "known": ["map"], "hidden": {"person": ["map"]}}


def test_only_an_admin_writes_only_its_own_organisation_and_each_change_is_recorded(api, people, worker, owner):
    w = people
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.member, "select pulse.org_screen_view_set(%s::jsonb)", (json.dumps(CHOICE),))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):            # no direct writes, even for an admin
        as_(api, w, w.admin, "insert into pulse.org_screen_view(org_id,body) values(%s,'{}')", (w.org,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.admin, "select pulse.org_screen_view_set(%s::jsonb)", (json.dumps({"hidden": {"person": ["hr"]}}),))
    as_(api, w, w.admin, "select pulse.org_screen_view_set(%s::jsonb)", (json.dumps(CHOICE),))
    as_(api, w, w.admin, "select pulse.org_screen_view_set(%s::jsonb)", (json.dumps(CHOICE),))   # unchanged: no second record
    assert as_(api, w, w.member, "select pulse.org_screen_view_get() v") == [{"v": CHOICE}]
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, w.org)
        changes = owner.execute("select field,changed_by from pulse.record_change where entity_type='org' and field='screens'").fetchall()
    assert changes == [{"field": "screens", "changed_by": w.admin}]
    other = build_world(worker, owner, api)
    assert as_(api, other, None, "select pulse.org_screen_view_get() v") == [{"v": {}}], "another organisation sees nothing hidden"
    assert as_(api, other, None, "select count(*)::int n from pulse.org_screen_view") == [{"n": 0}]
