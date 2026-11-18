"""EST-1229 (0491): an organisation admin grants and ends the Finance role in Settings → Roles, and Finance saves this
year's numbering patterns in ERP settings, through the real API; a member is refused both. In the database: only an
admin grants or ends a role, the operator-only Privacy role stays out of Settings, the API changes a series' pattern but
never its running number, and only in its own organisation; 0491 applies again over a hand-made patch. Synthetic
tenant, people and company only."""
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
MIGRATION = ROOT / "db/migrations/0491_finance_role_erp_series.sql"

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
const finance = (who, action) => call('settings/roles', who, { personId: E.kedab, role: 'finance', action });
const save = (who, patterns) => call('erp/settings', who, { company: { legalName: 'Synthetic Solar LLP' }, dueDays: 15, patterns });
const pattern = async (docType) => { const r = await call('erp/settings', 'kedab'); return r.body.series.find((s) => s.docType === docType && s.fy === r.body.fy)?.pattern; };

let r = await finance('member', 'grant');
ok(r.status === 403, 'a member cannot grant a role', r);
r = await call('erp/settings', 'kedab');
ok(r.status === 403, 'no ERP before the Finance role', r);
r = await finance('admin', 'grant');
ok(r.status === 200, 'the admin grants Finance', r);
r = await call('erp/settings', 'kedab');
ok(r.status === 200 && r.body.canWrite === true, 'Finance reads and may write ERP settings', r);

// This year's patterns: new series (insert), then a changed pattern while nothing is numbered yet (update).
r = await save('kedab', { invoice: 'SS/{FY}/{N:3}', quotation: 'SQ/{FY}/{N:3}' });
ok(r.status === 200, 'Finance saves new numbering patterns', r);
ok(await pattern('invoice') === 'SS/{FY}/{N:3}' && await pattern('quotation') === 'SQ/{FY}/{N:3}', 'both series are stored', r);
r = await save('kedab', { invoice: 'SS-{FY}-{N:4}' });
ok(r.status === 200 && await pattern('invoice') === 'SS-{FY}-{N:4}', 'Finance changes a pattern before the first number', r);
r = await save('member', { invoice: 'X/{N}' });
ok(r.status === 403, 'a member cannot save ERP settings', r);
ok(await pattern('invoice') === 'SS-{FY}-{N:4}', 'the refused save changed nothing', r);

r = await finance('member', 'revoke');
ok(r.status === 403, 'a member cannot end a role', r);
r = await finance('admin', 'revoke');
ok(r.status === 200, 'the admin ends Finance', r);
r = await call('erp/settings', 'kedab');
ok(r.status === 403, 'no ERP once Finance has ended', r);
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
    w.kedab = _person(worker, w, "Synthetic Accounts", "kedab")
    w.member = _person(worker, w, "Synthetic Member", "member")
    return w


def _config(value):
    from psycopg.conninfo import conninfo_to_dict
    d = conninfo_to_dict(value)
    d["database"] = d.pop("dbname")
    return json.dumps(d)


def test_admin_grants_and_ends_finance_and_finance_saves_patterns_through_the_api(people):
    from conftest import dsn
    w = people
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": _config(dsn("api")),
           "TEST_IDS": json.dumps({"kedab": str(w.kedab)}),
           "TEST_EMAILS": json.dumps({k: f"{k}@{w.domain}" for k in ("admin", "kedab", "member")})}
    p = subprocess.run(["node", "--input-type=module", "-e", API], cwd=ROOT / "services/api", env=env, capture_output=True, text=True, timeout=240)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]


def test_only_an_admin_grants_or_ends_a_settings_role(api, people):
    w = people
    grant = "insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,current_date)"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.member, grant, (w.org, w.kedab, "finance"))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.admin, grant, (w.org, w.kedab, "privacy"))      # the operator's break-glass role (0176)
    as_(api, w, w.admin, grant, (w.org, w.kedab, "finance"))
    end = "update pulse.role_assignment set valid_to=current_date-1 where person_id=%s and role_key='finance' returning id"
    assert as_(api, w, w.member, end, (w.kedab,)) == []
    assert len(as_(api, w, w.admin, end, (w.kedab,))) == 1


def test_the_api_sets_a_pattern_but_never_the_running_number(api, worker, people):
    w = people
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'finance','2026-01-01')", (w.org, w.kedab))
    new = "insert into pulse.erp_series(org_id,doc_type,fy,pattern) values(%s,'invoice','2026-27',%s) returning id"
    sid = as_(api, w, w.kedab, new, (w.org, "T/{FY}/{N:3}"))[0]["id"]
    assert as_(api, w, w.kedab, "update pulse.erp_series set pattern='T-{FY}-{N:3}' where id=%s returning pattern", (sid,)) == [{"pattern": "T-{FY}-{N:3}"}]
    for sql in ("update pulse.erp_series set next_no=7 where id=%s", "update pulse.erp_series set last_date=current_date where id=%s",
                "delete from pulse.erp_series where id=%s"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, w.kedab, sql, (sid,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.kedab, "insert into pulse.erp_series(org_id,doc_type,fy,pattern,next_no) values(%s,'proforma','2026-27','P/{N:3}',9)", (w.org,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):    # another organisation's series
        as_(api, w, w.kedab, new, (uuid.uuid4(), "T/{FY}/{N:3}"))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):    # not an ERP writer
        as_(api, w, w.member, "insert into pulse.erp_series(org_id,doc_type,fy,pattern) values(%s,'quotation','2026-27','Q/{N:3}')", (w.org,))
    assert as_(api, w, w.kedab, "select next_no,last_date from pulse.erp_series where id=%s", (sid,)) == [{"next_no": 1, "last_date": None}]


def test_0491_applies_again_over_a_hand_made_patch(owner):
    up = MIGRATION.read_text().split("-- migrate:up", 1)[1].split("-- migrate:down", 1)[0]
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        owner.execute("grant insert, update on pulse.erp_series to pulse_api")     # the patch: table-wide writes
        owner.execute(up)
        owner.execute(up)
        got = owner.execute("""select has_table_privilege('pulse_api','pulse.erp_series','INSERT') ins, has_table_privilege('pulse_api','pulse.erp_series','UPDATE') upd,
            has_column_privilege('pulse_api','pulse.erp_series','pattern','UPDATE') pattern, has_column_privilege('pulse_api','pulse.erp_series','next_no','UPDATE') next_no,
            has_column_privilege('pulse_api','pulse.erp_series','fy','INSERT') fy, has_column_privilege('pulse_api','pulse.erp_series','next_no','INSERT') next_no_in""").fetchone()
        assert got == {"ins": False, "upd": False, "pattern": True, "next_no": False, "fy": True, "next_no_in": False}
        keys = {r["policyname"]: r["keys"] for r in owner.execute(
            "select policyname,case policyname when 'role_grant' then with_check else qual end keys from pg_policies where schemaname='pulse' and tablename='role_assignment' and policyname in ('role_grant','role_end')")}
        assert set(keys) == {"role_grant", "role_end"} and all("finance" in k and "privacy" not in k for k in keys.values())
        raise psycopg.Rollback()
