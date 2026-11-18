"""EST-1542 (0640): the private WhatsApp-name matching screen through the real API. An admin loads a recorded list
(counts only); leadership and HR read it most-used first with suggested colleagues and answer each name; a member and an
admin without leadership are refused; a reload refreshes counts but never a person's answer. In the database: the names
table has no service-role grant at all, and another organisation sees nothing. Synthetic tenant, people and names."""
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
const names = [{ label: 'Kedab Office', messages: 40, groups: 6 }, { label: 'Riverside Sales', messages: 300, groups: 1 }, { label: 'Notice Bot', messages: 5, groups: 9 }];

let r = await call('chat-names/load', 'member', { source: 'wp-group-data', names }); ok(r.status === 403, 'a member does not load the list', r);
r = await call('chat-names/load', 'admin', { source: 'wp-group-data', names }); ok(r.status === 200 && r.body.added === 3, 'the admin loads three names', r);
r = await call('chat-names', 'admin'); ok(r.status === 403, 'an admin without leadership or HR does not see the names', r);
r = await call('chat-names', 'member'); ok(r.status === 403, 'a member does not see the names', r);
ok((await call('chat-names', 'lead')).body.canLoad === true && (await call('chat-names', 'hr')).body.canLoad === true, 'leadership and HR may load (0680)', null);
// The Pulse CEO's condition 1: the server checks too. Anything but a name with its counts is refused, and so is a number.
for (const bad of [{ label: 'Extra Field', messages: 1, groups: 1, phone: '1' }, { label: 'Odd Count', messages: 1.5, groups: 1 }, { label: '' }, { label: 'X'.repeat(81) }])
  ok((await call('chat-names/load', 'lead', { source: 'wp-group-data', names: [bad] })).status === 400, 'a load with anything but a name and its counts is refused', bad);
ok((await call('chat-names/load', 'lead', { source: 'wp-group-data', names: [{ label: '+91 99999 00001', messages: 1, groups: 1 }] })).status === 400, 'a phone number is never loaded', null);
// EST-1913: in any script's digits too (the reviewed synthetic 98123 45678 in fullwidth, Devanagari and Arabic-Indic).
const inScript = (zero) => '9812345678'.replace(/[0-9]/g, (d) => String.fromCodePoint(zero + Number(d)));
for (const zero of [0xff10, 0x0966, 0x0660, 0x10d40])   // ... and Garay (Unicode 17)
  ok((await call('chat-names/load', 'lead', { source: 'wp-group-data', names: [{ label: `Ravi ${inScript(zero)}`, messages: 1, groups: 1 }] })).status === 400, `a number in U+${zero.toString(16)} digits is never loaded`, null);
ok(!(await call('chat-names', 'lead')).body.rows.some((x) => x.label.startsWith('Ravi')), 'and nothing of it was stored', null);
ok((await call('chat-names/load', 'lead', { source: 'wp-group-data', names, extra: true })).status === 400, 'an extra field on the load is refused', null);
r = await call('chat-names', 'lead');
ok(r.status === 200 && r.body.rows.map((x) => x.label).join() === 'Riverside Sales,Kedab Office,Notice Bot', 'leadership reads them most-used first', r);
const kedab = r.body.rows.find((x) => x.label === 'Kedab Office');
ok(kedab.suggestions.length === 1 && kedab.suggestions[0].id === E.kedab, 'the colleague whose first name matches is suggested', r);
ok(r.body.progress.important === 2 && r.body.progress.importantDone === 0, 'two names are in 5+ groups', r);

r = await call(`chat-names/${kedab.id}`, 'hr', { decision: 'colleague' }); ok(r.status === 400, 'a colleague answer names the person', r);
r = await call(`chat-names/${kedab.id}`, 'hr', { decision: 'colleague', personId: E.kedab }); ok(r.status === 200, 'HR answers: colleague', r);
const bot = (await call('chat-names', 'lead')).body.rows.find((x) => x.label === 'Notice Bot');
r = await call(`chat-names/${bot.id}`, 'member', { decision: 'skip' }); ok(r.status === 403, 'a member cannot answer', r);
r = await call(`chat-names/${bot.id}`, 'lead', { decision: 'skip' }); ok(r.status === 200, 'leadership answers: skip', r);
r = await call('chat-names', 'lead');
ok(r.body.progress.importantDone === 2 && r.body.progress.done === 2, 'progress counts the answers', r);
ok(r.body.rows.find((x) => x.label === 'Kedab Office').person.id === E.kedab && r.body.rows.find((x) => x.label === 'Kedab Office').decidedBy === 'Synthetic HR', 'who answered is kept', r);

r = await call('chat-names/load', 'lead', { source: 'wp-group-data', names: names.map((n) => ({ ...n, messages: n.messages + 10 })) });
ok(r.status === 200 && r.body.updated === 3 && r.body.added === 0, 'a reload updates the counts', r);
r = await call('chat-names', 'lead');
ok(r.body.rows.find((x) => x.label === 'Kedab Office').decision === 'colleague' && r.body.rows.find((x) => x.label === 'Kedab Office').messages === 50, 'a reload never changes an answer', r);
r = await call(`chat-names/${bot.id}`, 'lead', { decision: null }); ok(r.status === 200, 'an answer can be taken back', r);
console.log(JSON.stringify({ ok: true }));
await app.close(); await pool.end();
'''


def _person(worker, w, name, handle, roles=()):
    pid = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, name))
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                       (w.org, f"{handle}@{w.domain}", pid))
        for role in roles:
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2026-01-01')", (w.org, pid, role))
    return pid


@pytest.fixture
def people(worker, owner, api):
    w = build_world(worker, owner, api)
    w.admin = _person(worker, w, "Synthetic Admin", "admin", ("admin",))
    w.lead = _person(worker, w, "Synthetic Lead", "lead", ("leadership",))
    w.hr = _person(worker, w, "Synthetic HR", "hr", ("hr",))
    w.member = _person(worker, w, "Synthetic Member", "member")
    w.kedab = _person(worker, w, "Kedab Synthetic", "kedab")
    return w


def _config(value):
    from psycopg.conninfo import conninfo_to_dict
    d = conninfo_to_dict(value)
    d["database"] = d.pop("dbname")
    return json.dumps(d)


def test_names_are_matched_through_the_api(people):
    from conftest import dsn
    w = people
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": _config(dsn("api")),
           "TEST_IDS": json.dumps({"kedab": str(w.kedab)}),
           "TEST_EMAILS": json.dumps({k: f"{k}@{w.domain}" for k in ("admin", "lead", "hr", "member")})}
    p = subprocess.run(["node", "--input-type=module", "-e", API], cwd=ROOT / "services/api", env=env, capture_output=True, text=True, timeout=240)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]


def test_the_names_table_has_no_service_grant_and_stays_in_its_organisation(api, people, worker, owner):
    w = people
    with api.transaction():
        set_tenant(api, w.org, w.admin)
        api.execute("select pulse.chat_names_load('wp-group-data', %s::jsonb)", (json.dumps([{"label": "Some Name", "messages": 3, "groups": 1}]),))
    in_script = lambda zero: "".join(chr(zero + int(d)) for d in "9812345678")  # reviewed synthetic 98123 45678, other scripts
    for bad in ([{"label": "Ravi 98123 45678", "messages": 1, "groups": 1}], [{"label": "Extra", "messages": 1, "groups": 1, "phone": "1"}],
                [{"label": "Odd", "messages": -1, "groups": 1}], ["not an object"],
                *([{"label": f"Ravi {in_script(z)}", "messages": 1, "groups": 1}] for z in (0xFF10, 0x0966, 0x0660, 0x10D40))):
        with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():   # the function checks too (0680)
            set_tenant(api, w.org, w.lead)
            api.execute("select pulse.chat_names_load('wp-group-data', %s::jsonb)", (json.dumps(bad),))
    for source, names in ((None, "[]"), ("wp-group-data", None)):                     # EST-1913: no load without both
        with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():
            set_tenant(api, w.org, w.lead)
            api.execute("select pulse.chat_names_load(%s, %s::jsonb)", (source, names))
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, w.org)
        loads = owner.execute("select changed_by, new_value from pulse.record_change where entity_type='org' and field='chat_names_load'").fetchall()
    assert [(x["changed_by"], json.loads(x["new_value"])["added"]) for x in loads] == [(w.admin, 1)], "each load names who ran it and its counts"
    for sql in ("select count(*) from pulse_priv.chat_name", "delete from pulse_priv.chat_name"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            set_tenant(api, w.org, w.lead)
            api.execute(sql)
    other = build_world(worker, owner, api)
    otherlead = _person(worker, other, "Other Lead", "otherlead", ("leadership",))
    with api.transaction():
        set_tenant(api, other.org, otherlead)
        assert api.execute("select pulse.chat_names_read('wp-group-data') r").fetchone()["r"] == []
