"""1048 (decision integrity-h5-salary-access = "Named list I approve", keeping the existing grants): an organisation can
switch salary access to a named list. Off by default (salary by the HR or leadership role, as before); on, hr.salary.read
and hr.salary.write need a named grant for HR, leadership and admins alike, and nothing else changes. In the team: lead
is HR (role only), manager is an admin holding named salary grants; editor2 is made leadership, hr2 HR with a named
"Read salary" grant, boss an admin and leader with no grant."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_hr_suite import _staff
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

DENIED = psycopg.errors.InsufficientPrivilege


@pytest.fixture
def world(worker, team):
    w = team
    w.hr2, w.boss = uuid.uuid4(), uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        for pid, name in ((w.hr2, "Second Hr"), (w.boss, "Boss Leader")):
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, name))
        for pid, role in ((w.editor2, "leadership"), (w.hr2, "hr"), (w.boss, "admin"), (w.boss, "leadership")):
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2026-01-01')", (w.org, pid, role))
        for pid, perm in ((w.manager, "hr.salary.read"), (w.manager, "hr.salary.write"), (w.hr2, "hr.salary.read")):
            worker.execute("insert into pulse.sensitive_permission(org_id,person_id,permission,granted_by) values(%s,%s,%s,'test')", (w.org, pid, perm))
    return w


def can(api, w, who):
    return one(api, w, who, "select pulse.hr_can('hr.salary.read') r,pulse.hr_can('hr.salary.write') w,pulse.hr_can('hr.contact.read') c,"
               "pulse.hr_can('hr.documents.read') d,pulse.comp_reader() reader")


def perm(owner, w, subject, p):
    """comp_perm (hr_can's rule for another person) is internal to the comp functions: read it as the owner."""
    with owner.transaction():
        set_tenant(owner, w.org)
        return owner.execute("select pulse.comp_perm(%s,%s) ok", (subject, p)).fetchone()["ok"]


def test_off_by_default_salary_stays_with_the_roles(api, owner, world):
    w = world
    assert one(api, w, w.lead, "select pulse.salary_named_list() named")["named"] is False
    for who in (w.lead, w.editor2, w.boss, w.manager):
        assert can(api, w, who)["r"] is True, who
    assert perm(owner, w, w.lead, "hr.salary.write") is True
    assert one(api, w, w.lead, "select pulse.hr_salary_write(%s,'2026-10-01','current',31000,'revision') id", (w.editor,))["id"]


def test_on_salary_is_by_named_list_and_nothing_else_changes(api, owner, world):
    w = world
    assert one(api, w, w.manager, "select pulse.salary_named_list_set(true) named")["named"] is True
    lead, leader, hr2, admin = can(api, w, w.lead), can(api, w, w.editor2), can(api, w, w.hr2), can(api, w, w.manager)
    assert (lead["r"], lead["w"], lead["reader"]) == (False, False, False), "HR by role alone no longer sees salaries"
    assert (lead["c"], lead["d"]) == (True, True), "contact and documents stay with the HR role"
    assert (leader["r"], leader["w"]) == (False, False)
    assert (hr2["r"], hr2["w"]) == (True, False), "a named grant gives exactly what it names"
    assert (admin["r"], admin["w"]) == (True, True)
    assert perm(owner, w, w.lead, "hr.salary.read") is False and perm(owner, w, w.hr2, "hr.salary.read") is True
    with pytest.raises(DENIED, match="salary access denied"):
        as_(api, w, w.lead, "select pulse.hr_salary_write(%s,'2026-10-01','current',31000,'revision')", (w.editor,))
    # Naming HR gives the access back; turning the list off returns salary to the roles.
    as_(api, w, w.manager, "select pulse.hr_permission_set(%s,'hr.salary.read',true)", (w.lead,))
    assert can(api, w, w.lead)["r"] is True and can(api, w, w.lead)["w"] is False
    assert one(api, w, w.manager, "select pulse.salary_named_list_set(false) named")["named"] is False
    assert can(api, w, w.editor2)["r"] is True and can(api, w, w.lead)["w"] is True


def test_who_may_change_the_switch(api, world):
    w = world
    with pytest.raises(DENIED, match="Only an organisation admin who holds salary access"):
        as_(api, w, w.lead, "select pulse.salary_named_list_set(true)")      # HR
    with pytest.raises(DENIED, match="Hold a named"):
        as_(api, w, w.boss, "select pulse.salary_named_list_set(true)")      # salary by role only: would lock themself out
    with pytest.raises(DENIED):
        as_(api, w, w.manager, "insert into pulse.comp_salary_list(org_id,named_list) values(%s,true)", (w.org,))
    one(api, w, w.manager, "select pulse.salary_named_list_set(true)")
    with pytest.raises(DENIED, match="Only an organisation admin who holds salary access"):
        as_(api, w, w.boss, "select pulse.salary_named_list_set(false)")     # no longer holds salary access
    assert one(api, w, w.lead, "select pulse.salary_named_list() named")["named"] is True


SCRIPT = r'''
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool,pool);
const call = async(url,email,payload) => {
 const r=await app.inject({url,method:payload?'POST':'GET',headers:{'cf-access-authenticated-user-email':email},...(payload?{payload}:{})});
 return {status:r.statusCode,body:r.json()};
};
const hr='hr@estateautopilots.com', admin='admin@estateautopilots.com', admin2='user-36310dc4@estateautopilots.com', step=process.env.TEST_STEP, out={};
if(step==='1'){
 out.onUnnamed=await call('/api/v0/settings/salary-list',admin,{on:true});
}else{
 out.before=await call('/api/v0/settings',admin);
 out.onHr=await call('/api/v0/settings/salary-list',hr,{on:true});
 out.onBad=await call('/api/v0/settings/salary-list',admin,{on:'yes'});
 out.on=await call('/api/v0/settings/salary-list',admin,{on:true});
 out.onAgain=await call('/api/v0/settings/salary-list',admin,{on:true});
 out.lastAdmin=await call('/api/v0/settings/roles',admin2,{personId:process.env.TEST_ADMIN_ID,role:'admin',action:'revoke'});
 out.payrollOn=await call('/api/v0/hr/payroll',hr);
 out.during=await call('/api/v0/settings',admin);
 out.off=await call('/api/v0/settings/salary-list',admin,{on:false});
 out.payrollOff=await call('/api/v0/hr/payroll',hr);
}
console.log('RESULT:'+JSON.stringify(out)); await app.close(); await pool.end();
'''


def test_the_switch_in_settings(worker, owner, api):
    """Settings -> Roles & permissions: who sees salaries by role only, the switch, its plain refusals and its record."""
    w = build_world(worker, owner, api)
    _staff(worker, w)
    admin2 = uuid.uuid4()
    with worker.transaction():                                 # the admin is a leader too: salary by role, no named grant
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'leadership','2026-01-01')", (w.org, w.manager))
        # A second admin without salary access.
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Second Admin','staff')", (admin2, w.org))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence,user_no,username) values(%s,%s,'Ops','test',8,'admin8x')", (w.org, admin2))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (w.org, admin2))
        worker.execute("insert into pulse.account(id,org_id,provider,handle,holder_person_id,purpose) values(%s,%s,'google','user-36310dc4@estateautopilots.com',%s,'Workspace account')",
                       (uuid.uuid4(), w.org, admin2))
    root = Path(__file__).resolve().parents[2]
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")

    def run(step):
        env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "PULSE_ORG_ID": str(w.org), "TEST_STEP": step, "TEST_ADMIN_ID": str(w.manager)}
        p = subprocess.run(["node", "--input-type=module", "-e", SCRIPT], cwd=root / "services/api", env=env, capture_output=True, text=True, timeout=60, check=False)
        assert p.returncode == 0, p.stderr[-2000:]
        return json.loads(next(line[7:] for line in p.stdout.splitlines() if line.startswith("RESULT:")))

    r = run("1")
    assert r["onUnnamed"]["status"] == 400 and "Hold a named" in r["onUnnamed"]["body"]["error"]
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.sensitive_permission(org_id,person_id,permission,granted_by) values(%s,%s,'hr.salary.read','another admin')", (w.org, w.manager))
    r = run("2")
    assert {k: v["status"] for k, v in r.items()} == {"before": 200, "onHr": 403, "onBad": 400, "on": 200, "onAgain": 200, "lastAdmin": 409,
                                                      "payrollOn": 403, "during": 200, "off": 200, "payrollOff": 200}
    before, during = r["before"]["body"]["salaryList"], r["during"]["body"]["salaryList"]
    # HR by role only loses salary; the admin and leader reads by grant and edits by role, so loses editing.
    assert before["on"] is False and [(p["name"], p["loses"]) for p in before["byRoleOnly"]] == [("Pod Manager", "edit"), ("Project Lead", "salary")]
    assert "only admin who holds" in r["lastAdmin"]["body"]["error"]
    assert during["on"] is True and during["changedBy"] == "Pod Manager"
    assert r["payrollOn"]["body"]["error"] == "Your account does not have permission to read salary"
    with worker.transaction():
        set_tenant(worker, w.org)
        log = worker.execute("select old_value,new_value from pulse.record_change where field='salary_named_list' order by changed_at,new_value").fetchall()
    assert [(x["old_value"], x["new_value"]) for x in log] == [("false", "true"), ("true", "false")]
