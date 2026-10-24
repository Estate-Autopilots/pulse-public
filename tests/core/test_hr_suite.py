"""The Team & HR suite: who may see and decide what, through the HTTP handlers and directly against row-level security.
Synthetic tenants only."""
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

ADMIN, HR = "admin@estateautopilots.com", "hr@estateautopilots.com"


def _enable_attendance(owner, w):
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("select pulse.hr_defaults()")
        # Today is a working day whatever day CI runs (check-in refuses a weekly off): no change Monday to Saturday.
        owner.execute("update pulse.hr_policy set work_days=array(select distinct d from unnest(work_days||extract(isodow from now() at time zone 'Asia/Kolkata')::int) d order by d)")
        owner.execute("update pulse.hr_policy set attendance_enabled=true where org_id=%s", (w.org,))


def _staff(worker, w):
    """The editor signs in with a Workspace account; the lead is HR, the manager is an admin; all have staff records."""
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.account set purpose='Workspace account' where handle=%s", (w.editor_handle,))
        for email, pid, role in ((ADMIN, w.manager, "admin"), (HR, w.lead, "hr")):
            worker.execute("insert into pulse.account(id,org_id,provider,handle,holder_person_id,purpose) "
                           "values (%s,%s,'google',%s,%s,'Workspace account')", (uuid.uuid4(), w.org, email, pid))
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) "
                           "values (%s,%s,%s,'2026-01-01')", (w.org, pid, role))
        worker.execute("insert into pulse.account(id,org_id,provider,handle,holder_person_id,purpose) "
                       "values (%s,%s,'google',%s,%s,'Workspace account')",
                       (uuid.uuid4(), w.org, f"editor2@{w.domain}", w.editor2))
        for n, pid in enumerate((w.editor, w.editor2, w.lead, w.manager), start=1):
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence,user_no,username) "
                           "values (%s,%s,'Editor','test',%s,%s) on conflict (person_id) do nothing", (w.org, pid, n, f"user{n}x"))


SCRIPT = r'''
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool,pool);
const call = async(url,email,payload) => {
 const r=await app.inject({url,method:payload?'POST':'GET',headers:{'cf-access-authenticated-user-email':email},...(payload?{payload}:{})});
 return {status:r.statusCode,body:r.json()};
};
const member=process.env.TEST_MEMBER, memberId=process.env.TEST_MEMBER_ID, hr='hr@estateautopilots.com', admin='admin@estateautopilots.com';
const iso=d=>d.toISOString().slice(0,10), shift=(d,n)=>iso(new Date(Date.parse(d+'T00:00:00Z')+n*86400000));
const today=(await call('/api/v0/hr/policy',member)).body.today;
let monday=shift(today,7); while(new Date(monday+'T00:00:00Z').getUTCDay()!==1) monday=shift(monday,1);
const out={};
// attendance: check in from home, a break, out, back in (the gap is a break), out
out.checkIn=await call('/api/v0/attendance/check-in',member,{mode:'wfh'});
out.breakStart=await call('/api/v0/attendance/break',member,{action:'start'});
out.breakTwice=await call('/api/v0/attendance/break',member,{action:'start'});
out.breakEnd=await call('/api/v0/attendance/break',member,{action:'end'});
out.checkOut=await call('/api/v0/attendance/check-out',member,{});
out.resume=await call('/api/v0/attendance/check-in',member,{});
out.checkOut2=await call('/api/v0/attendance/check-out',member,{});
out.self=await call('/api/v0/hr/self',member);
// a correction for yesterday: the person cannot approve their own, HR can
const yesterday=shift(today,-1);
out.reg=await call('/api/v0/hr/regularisations',member,{kind:'missed_punch',date:yesterday,inTime:'10:00',outTime:'19:00',reason:'Forgot to check in at the shoot'});
out.regNoReason=await call('/api/v0/hr/regularisations',member,{kind:'missed_punch',date:shift(today,-2),inTime:'10:00',outTime:'19:00',reason:'x'});
out.regOwn=await call(`/api/v0/hr/regularisations/${out.reg.body.id}`,member,{decision:'approved'});
out.regHr=await call(`/api/v0/hr/regularisations/${out.reg.body.id}`,hr,{decision:'approved'});
out.person=await call(`/api/v0/hr/person/${memberId}?month=${yesterday.slice(0,7)}`,hr);
out.behalf=await call('/api/v0/hr/regularisations',hr,{personId:memberId,kind:'wfh',date:shift(today,-3),reason:'Worked from home, recorded by HR'});
out.behalfMember=await call('/api/v0/hr/regularisations',member,{personId:process.env.TEST_OTHER_ID,kind:'wfh',date:shift(today,-3),reason:'Not mine to record'});
// leave: two working days, an overlap, a half day, a wrong type; HR decides; the person cancels leave that has not started
out.leave=await call('/api/v0/leave',member,{kind:'annual',fromDate:monday,toDate:shift(monday,1),reason:'Family function'});
out.personalLeave=await call('/api/v0/leave',member,{kind:'personal',fromDate:shift(monday,7),toDate:shift(monday,7),reason:'Personal day'});
out.overlap=await call('/api/v0/leave',member,{kind:'sick',fromDate:shift(monday,1),toDate:shift(monday,2)});
out.half=await call('/api/v0/leave',member,{kind:'sick',fromDate:shift(monday,3),toDate:shift(monday,3),halfDay:'first',reason:'Dentist'});
out.badKind=await call('/api/v0/leave',member,{kind:'sabbatical',fromDate:shift(monday,4),toDate:shift(monday,4)});
out.deskMember=await call('/api/v0/hr/desk',member);
out.desk=await call('/api/v0/hr/desk',hr);
out.deskAdmin=await call('/api/v0/hr/desk',admin);
out.leaveMember=await call('/api/v0/hr/leave',member);
out.rejectNoNote=await call(`/api/v0/leave/${out.half.body.id}/decision`,hr,{decision:'rejected',note:''});
out.approve=await call(`/api/v0/leave/${out.leave.body.id}/decision`,hr,{decision:'approved'});
out.personalApprove=await call(`/api/v0/leave/${out.personalLeave.body.id}/decision`,hr,{decision:'approved'});
out.adjust=await call('/api/v0/hr/leave-adjustments',hr,{personId:memberId,kind:'annual',days:3,reason:'Opening balance from the sheet'});
out.adjustMember=await call('/api/v0/hr/leave-adjustments',member,{personId:memberId,kind:'annual',days:30,reason:'More please'});
out.selfAfter=await call('/api/v0/hr/self',member);
out.cancel=await call(`/api/v0/leave/${out.leave.body.id}/decision`,member,{decision:'cancelled'});
// requests desk: only the raiser and HR see a request; HR notes stay with HR; resolving needs a resolution
out.ticket=await call('/api/v0/hr/tickets',member,{category:'payroll',subject:'Salary slip is missing',body:'September',priority:'high'});
const tid=out.ticket.body.id;
out.note=await call(`/api/v0/hr/tickets/${tid}`,hr,{comment:'Check with accounts',internal:true,assigneeId:process.env.TEST_HR_ID});
out.reply=await call(`/api/v0/hr/tickets/${tid}`,hr,{comment:'Looking into it'});
out.ticketMember=await call(`/api/v0/hr/tickets/${tid}`,member);
out.ticketHr=await call(`/api/v0/hr/tickets/${tid}`,hr);
out.resolveEmpty=await call(`/api/v0/hr/tickets/${tid}`,hr,{status:'resolved'});
out.resolve=await call(`/api/v0/hr/tickets/${tid}`,hr,{status:'resolved',resolution:'Slip sent by e-mail'});
out.memberProgress=await call(`/api/v0/hr/tickets/${tid}`,member,{status:'in_progress'});
out.reopen=await call(`/api/v0/hr/tickets/${tid}`,member,{status:'open'});
out.listMember=await call('/api/v0/hr/tickets?scope=all',member);
out.listAdmin=await call('/api/v0/hr/tickets?scope=all',admin);
// policy, leave types and holidays are HR's; payroll needs the named permission as well as the role
out.policyMember=await call('/api/v0/hr/policy',member,{graceMinutes:60});
out.policyHr=await call('/api/v0/hr/policy',hr,{graceMinutes:20,workDays:[1,2,3,4,5]});
out.holiday=await call('/api/v0/hr/holidays',hr,{day:shift(monday,5),name:'Test holiday'});
out.leaveHr=await call(`/api/v0/hr/leave?month=${shift(monday,7).slice(0,7)}`,hr);
out.leaveAdmin=await call(`/api/v0/hr/leave?month=${shift(monday,7).slice(0,7)}`,admin);
out.type=await call('/api/v0/hr/leave-types',hr,{name:'Comp off',annualDays:null});
out.typeMember=await call('/api/v0/hr/leave-types',member,{name:'Free days',annualDays:99});
out.policy=await call('/api/v0/hr/policy',member);
out.payrollHr=await call('/api/v0/hr/payroll',hr);
out.payrollMember=await call('/api/v0/hr/payroll',member);
out.skills=await call(`/api/v0/people/${memberId}/self`,member,{skills:['Premiere Pro','premiere pro ','Colour grading'],phone:'98200 00000'});
out.skillsOther=await call(`/api/v0/people/${process.env.TEST_OTHER_ID}/self`,member,{skills:['x']});
// reporting lines cannot loop; restricted permissions are an admin's to give, and only with salary access
out.manager=await call(`/api/v0/people/${memberId}`,hr,{managerId:process.env.TEST_OTHER_ID});
out.managerRecord=await call(`/api/v0/hr/person/${memberId}`,process.env.TEST_OTHER);
out.cycle=await call(`/api/v0/people/${process.env.TEST_OTHER_ID}`,hr,{managerId:memberId});
out.permHr=await call('/api/v0/settings/permissions',hr,{personId:process.env.TEST_HR_ID,permission:'hr.salary.read',action:'grant'});
out.permUnknown=await call('/api/v0/settings/permissions',admin,{personId:process.env.TEST_HR_ID,permission:'hr.everything',action:'grant'});
out.permNoAccess=await call('/api/v0/settings/permissions',admin,{personId:process.env.TEST_HR_ID,permission:'hr.salary.read',action:'grant'});
console.log('RESULT:'+JSON.stringify(out)); await app.close(); await pool.end();
'''


def test_hr_suite_through_the_api(worker, owner, api):
    w = build_world(worker, owner, api)
    _enable_attendance(owner, w)
    _staff(worker, w)
    root = Path(__file__).resolve().parents[2]
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "PULSE_ORG_ID": str(w.org), "TEST_MEMBER": w.editor_handle,
           "TEST_MEMBER_ID": str(w.editor), "TEST_OTHER_ID": str(w.editor2), "TEST_OTHER": f"editor2@{w.domain}", "TEST_HR_ID": str(w.lead)}
    p = subprocess.run(["node", "--input-type=module", "-e", SCRIPT], cwd=root / "services/api",
                       env=env, capture_output=True, text=True, timeout=60, check=False)
    assert p.returncode == 0, p.stderr[-2000:]
    r = json.loads(next(line[7:] for line in p.stdout.splitlines() if line.startswith("RESULT:")))
    status = {k: v["status"] for k, v in r.items()}
    assert status == {
        "checkIn": 200, "breakStart": 200, "breakTwice": 409, "breakEnd": 200, "checkOut": 200, "resume": 200, "checkOut2": 200, "self": 200,
        "reg": 200, "regNoReason": 400, "regOwn": 403, "regHr": 200, "person": 200, "behalf": 200, "behalfMember": 403,
        "leave": 200, "personalLeave": 200, "overlap": 409, "half": 200, "badKind": 400, "deskMember": 403, "desk": 200, "deskAdmin": 200,
        "leaveMember": 403, "personalApprove": 200, "rejectNoNote": 400, "approve": 200,
        "adjust": 200, "adjustMember": 403, "selfAfter": 200, "cancel": 200,
        "ticket": 200, "note": 200, "reply": 200, "ticketMember": 200, "ticketHr": 200, "resolveEmpty": 400, "resolve": 200,
        "memberProgress": 403, "reopen": 200, "listMember": 200, "listAdmin": 200,
        "policyMember": 403, "policyHr": 200, "holiday": 200, "leaveHr": 200, "leaveAdmin": 200, "managerRecord": 200, "type": 200, "typeMember": 403, "policy": 200,
        "payrollHr": 200, "payrollMember": 403, "skills": 200, "skillsOther": 403,
        "manager": 200, "cycle": 400, "permHr": 403, "permUnknown": 400, "permNoAccess": 403,
    }
    assert r["checkIn"]["body"]["mode"] == "wfh" and r["resume"]["body"]["resumed"] is True
    me = r["self"]["body"]
    assert me["now"]["state"] == "done" and me["wfh"]["used"] == 1 and me["month"]["summary"]["present"] >= 1
    assert me["can"] == {"act": True, "decide": False, "record": False, "performance": True, "adjust": False}
    assert {b["key"] for b in me["leave"]["balances"]} == {"annual", "personal", "sick", "comp_off"} and me["leave"]["provisional"] is True
    corrected = [d for d in r["person"]["body"]["month"]["days"] if d["entry"] and d["entry"]["source"] == "regularised"]
    assert corrected and r["person"]["body"]["can"]["decide"] is True
    assert r["behalf"]["body"]["status"] == "approved"
    assert r["leave"]["body"]["days"] == 2 and r["half"]["body"]["days"] == 0.5
    pending = r["desk"]["body"]["pending"]
    assert len(pending["leave"]) == 3 and {request["balance"]["key"] for request in pending["leave"]} == {"annual", "personal", "sick"}
    before = next(b for b in me["leave"]["balances"] if b["key"] == "annual")
    after = next(b for b in r["selfAfter"]["body"]["leave"]["balances"] if b["key"] == "annual")
    assert after["used"] == 2 and after["adjusted"] == 3 and after["available"] == before["available"] + 3 - 2
    personal_before = next(b for b in me["leave"]["balances"] if b["key"] == "personal")
    personal_after = next(b for b in r["selfAfter"]["body"]["leave"]["balances"] if b["key"] == "personal")
    assert personal_after["used"] == 1 and personal_after["available"] == personal_before["available"] - 1
    assert r["managerRecord"]["body"]["leave"]["balances"] == []
    assert any(h["name"] == "Test holiday" for h in r["leaveHr"]["body"]["holidays"])
    for key in ("leaveHr", "leaveAdmin"):
        calendar = r[key]["body"]
        personal = next(entry for entry in calendar["calendar"] if entry["id"] == r["personalLeave"]["body"]["id"])
        assert calendar["people"] and calendar["month"] == personal["fromDate"][:7]
        assert personal["status"] == "approved"
        assert all(entry["id"] != r["leave"]["body"]["id"] for entry in calendar["calendar"])
    assert r["cancel"]["body"]["status"] == "cancelled"
    seen_by_member = [e["body"] for e in r["ticketMember"]["body"]["events"] if e["kind"] == "comment"]
    seen_by_hr = [e["body"] for e in r["ticketHr"]["body"]["events"] if e["kind"] == "comment"]
    assert seen_by_member == ["Looking into it"] and seen_by_hr == ["Check with accounts", "Looking into it"]
    assert r["ticketHr"]["body"]["no"] == 1 and r["ticketHr"]["body"]["assigneeId"] == str(w.lead)
    assert len(r["listMember"]["body"]["tickets"]) == 1 and len(r["listAdmin"]["body"]["tickets"]) == 1
    policy = r["policy"]["body"]["policy"]
    assert policy["graceMinutes"] == 20 and policy["workDays"] == [1, 2, 3, 4, 5] and policy["confirmedAt"]
    assert any(t["name"] == "Comp off" and t["annualDays"] is None for t in r["policy"]["body"]["types"])
    with worker.transaction():
        set_tenant(worker, w.org)
        row = worker.execute("select skills,phone from pulse.people_profile where person_id=%s", (w.editor,)).fetchone()
    assert row["skills"] == ["Premiere Pro", "Colour grading"] and row["phone"] == "98200 00000"


def test_requests_and_leave_are_private_to_the_person_their_manager_and_hr(worker, owner, api):
    w = build_world(worker, owner, api)
    _staff(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.people_profile set manager_id=%s where person_id=%s", (w.editor2, w.editor))
        worker.execute("select pulse.hr_defaults()")
        worker.execute("insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,reason,days) "
                       "values (%s,%s,'2026-11-02','2026-11-03','annual','private reason',2)", (w.org, w.editor))
        worker.execute("insert into pulse.leave_adjustment(org_id,person_id,type_key,leave_year,days,reason,created_by) "
                       "values (%s,%s,'annual',2026,1,'Synthetic opening balance',%s)", (w.org, w.editor, w.lead))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        ticket = api.execute("select pulse.hr_ticket_open('grievance','About my lead','details','normal') id").fetchone()["id"]
    seen = {}
    for name, viewer in (("self", w.editor), ("manager", w.editor2), ("hr", w.lead), ("admin", w.manager)):
        with api.transaction():
            set_tenant(api, w.org, viewer)
            seen[name] = (api.execute("select count(*) n from pulse.leave_request").fetchone()["n"],
                          api.execute("select count(*) n from pulse.hr_ticket").fetchone()["n"],
                          api.execute("select count(*) n from pulse.leave_adjustment").fetchone()["n"])
    # The manager sees and decides leave, but a request raised with HR stays between the person and HR.
    assert seen == {"self": (1, 1, 1), "manager": (1, 0, 0), "hr": (1, 1, 1), "admin": (1, 1, 1)}
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.people_profile set manager_id=null where person_id=%s", (w.editor,))
        worker.execute("update pulse.leave_request set status='approved' where person_id=%s", (w.editor,))
    with api.transaction():
        set_tenant(api, w.org, w.editor2)                      # a colleague: no rows, and the calendar gives dates without the reason
        assert api.execute("select count(*) n from pulse.leave_request").fetchone()["n"] == 0
        away = api.execute("select * from pulse.team_away('2026-11-01','2026-11-30')").fetchall()
        assert [(r["person_id"], str(r["from_date"])) for r in away] == [(w.editor, "2026-11-02")] and "reason" not in away[0]
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():   # nobody edits another person's skills
        set_tenant(api, w.org, w.editor2)
        api.execute("select pulse.profile_self_update(%s,array['x'],null)", (w.editor,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():   # an HR note cannot be written by the raiser
        set_tenant(api, w.org, w.editor)
        api.execute("insert into pulse.hr_ticket_event(org_id,ticket_id,author_id,kind,body,internal) values (%s,%s,%s,'comment','x',true)",
                    (w.org, ticket, w.editor))


    with api.transaction():                                     # HR raising their own request does not see what HR and admins note about it
        set_tenant(api, w.org, w.lead)
        own = api.execute("select pulse.hr_ticket_open('payroll','My own request','x','normal') id").fetchone()["id"]
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("insert into pulse.hr_ticket_event(org_id,ticket_id,author_id,kind,body,internal) values (%s,%s,%s,'comment','about them',true)",
                    (w.org, own, w.manager))
    for viewer, count in ((w.lead, 0), (w.manager, 1)):
        with api.transaction():
            set_tenant(api, w.org, viewer)
            assert api.execute("select count(*) n from pulse.hr_ticket_event where ticket_id=%s", (own,)).fetchone()["n"] == count


def test_payroll_roles_and_admin_named_permissions_are_logged(worker, owner, api):
    w = build_world(worker, owner, api)
    _staff(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        for permission in ("hr.salary.read",):
            worker.execute("insert into pulse.sensitive_permission(org_id,person_id,permission,granted_by) values (%s,%s,%s,'test')", (w.org, w.manager, permission))
        for person, amount in ((w.editor, 111), (w.editor2, 222)):
            worker.execute("insert into pulse_priv.hr_compensation(org_id,person_id,effective_month,kind,amount,source_file_id,source_name,source_sheet,basis) "
                           "values (%s,%s,'2026-07-01','monthly',%s,'f','sheet','july','test')", (w.org, person, amount))
    for viewer in (w.editor,):                                 # employees cannot read payroll
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            set_tenant(api, w.org, viewer)
            api.execute("select * from pulse.hr_salary_overview()")
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        rows = api.execute("select person_id,amount from pulse.hr_salary_overview()").fetchall()
        log = api.execute("select viewer,people from pulse.hr_payroll_log()").fetchall()
    assert {(r["person_id"], int(r["amount"])) for r in rows} == {(w.editor, 111), (w.editor2, 222)}
    assert [r["people"] for r in log] == [2]                    # one access-log row per person whose salary was returned
    with api.transaction():                                    # HR role owns payroll access
        set_tenant(api, w.org, w.lead)
        assert len(api.execute("select * from pulse.hr_salary_overview()").fetchall()) == 2
        assert api.execute("select pulse.hr_can('hr.salary.write') ok").fetchone()["ok"] is True

    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():   # reading does not allow writing
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.hr_salary_write(%s,'2026-10-01','current',333,'revision')", (w.editor,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():   # HR cannot hand out permissions
        set_tenant(api, w.org, w.lead)
        api.execute("select pulse.hr_permission_set(%s,'hr.salary.read',true)", (w.lead,))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.hr_permission_set(%s,'hr.salary.write',true)", (w.manager,))
        api.execute("select pulse.hr_salary_write(%s,'2026-10-01','current',333,'revision')", (w.editor,))
        newest = api.execute("select kind,amount,source_name from pulse.hr_salary_read(%s) limit 1", (w.editor,)).fetchone()
    assert (newest["kind"], int(newest["amount"]), newest["source_name"]) == ("current", 333, "Entered in Pulse")
    with api.transaction():                                     # ending a permission keeps the row, so a sync cannot hand it back
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.hr_permission_set(%s,'hr.salary.write',false)", (w.manager,))
        assert api.execute("select pulse.hr_can('hr.salary.write') ok").fetchone()["ok"] is False
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.sensitive_permission(org_id,person_id,permission,granted_by) values (%s,%s,'hr.salary.write','sync') "
                       "on conflict do nothing", (w.org, w.manager))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        assert api.execute("select pulse.hr_can('hr.salary.write') ok").fetchone()["ok"] is False
