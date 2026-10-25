"""INTEGRITY (owner, 22 Oct 2026: "Remove all loopholes and things like that which can harm us"): nobody moves money,
pay, leave, attendance or a scorecard on their own (1002). Each test proves one hole is closed. In the team: lead is HR,
manager is an admin, editor2 is editor's pod head."""
import base64
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

DENIED = psycopg.errors.InsufficientPrivilege


def test_nobody_writes_their_own_pay_or_terms(api, team):
    w = team
    for sql, args in (("select pulse.hr_salary_write(%s,'2026-10-01','current',999999,'self raise')", (w.lead,)),
                      ("select pulse.hr_payslip_issue(%s,'2026-10-01','x')", (w.lead,)),
                      ("select pulse.hr_employment_save(%s,%s)", (w.lead, Jsonb({"ptExempt": True}))),
                      ("select pulse.hr_pattern_set(%s,array[1,2,3],current_date,null,'own pattern')", (w.lead,))):
        with pytest.raises(DENIED, match="Someone else in HR changes your own record"):
            as_(api, w, w.lead, sql, args)
    # HR still writes a colleague's salary.
    assert one(api, w, w.lead, "select pulse.hr_salary_write(%s,'2026-10-01','current',30000,'revision') id", (w.editor,))["id"]
    with pytest.raises(DENIED):
        as_(api, w, w.manager, "select pulse.hr_permission_set(%s,'hr.salary.write',true)", (w.manager,))


def test_nobody_adjusts_their_own_leave_balance(api, team):
    w = team
    with pytest.raises(DENIED):
        as_(api, w, w.lead, "insert into pulse.leave_adjustment(org_id,person_id,type_key,leave_year,days,reason,created_by) values(%s,%s,'annual',extract(year from now())::int,30,'own',%s) returning id",
            (w.org, w.lead, w.lead))
    as_(api, w, w.lead, "insert into pulse.leave_adjustment(org_id,person_id,type_key,leave_year,days,reason,created_by) values(%s,%s,'annual',extract(year from now())::int,1,'opening',%s) returning id",
        (w.org, w.editor, w.lead))


def test_pay_approvers_are_named_by_leadership_never_themselves(api, team):
    w = team
    sql = "insert into pulse.hr_cofounder(org_id,person_id,active,assigned_by) values(%s,%s,true,%s) returning person_id"
    with pytest.raises(DENIED):
        as_(api, w, w.lead, sql, (w.org, w.lead, w.lead))      # HR names themselves
    with pytest.raises(DENIED):
        as_(api, w, w.lead, sql, (w.org, w.editor, w.lead))    # HR names anyone
    with pytest.raises(DENIED):
        as_(api, w, w.manager, sql, (w.org, w.manager, w.manager))  # an admin names themselves
    as_(api, w, w.manager, sql, (w.org, w.lead, w.manager))
    assert one(api, w, w.manager, "select count(*)::int n from pulse.hr_cofounder where person_id=%s", (w.lead,))["n"] == 1


def test_what_hr_files_for_a_colleague_someone_else_decides(api, team):
    w = team
    # Filed already decided: refused.
    with pytest.raises(DENIED):
        as_(api, w, w.lead, "insert into pulse.attendance_regularisation(org_id,person_id,work_date,kind,in_time,out_time,reason,status,decided_by,decided_at,filed_by) "
            "values(%s,%s,current_date-1,'missed_punch','10:00','19:00','filed approved','approved',%s,now(),%s) returning id", (w.org, w.editor, w.lead, w.lead))
    leave = one(api, w, w.lead, "insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,days,reason,filed_by) values(%s,%s,current_date+20,current_date+20,'annual',1,'for Kabir',%s) returning id",
                (w.org, w.editor, w.lead))["id"]
    flow = one(api, w, w.lead, "select id from pulse.hr_flow where source_id=%s", (leave,))["id"]
    with pytest.raises(DENIED, match="Someone else decides what you filed"):
        as_(api, w, w.lead, "select pulse.hr_flow_decide(%s,'approved','ok')", (flow,))
    with pytest.raises(DENIED, match="Someone else decides what you filed"):
        as_(api, w, w.lead, "update pulse.leave_request set status='approved',decided_by=%s,decided_at=now() where id=%s returning id", (w.lead, leave))


def b64(s):
    return base64.b64encode(s.encode()).decode()


def test_bank_details_need_a_second_person(api, owner, team):
    w = team
    data = {"masked": "XXXX1234", "sealed": b64("sealed"), "dataKey": b64("k" * 40), "keyId": "k1",
            "summary": {"last4": "1234", "ifsc": "HDFC0001234", "holder": "Editor", "bank": "HDFC"}}
    r = one(api, w, w.lead, "select pulse.bank_save(%s,%s) r", (w.editor, Jsonb(data)))["r"]
    assert r["status"] == "pending", "an HR edit is not confirmed by itself"
    with pytest.raises(DENIED, match="Someone other than whoever entered"):
        as_(api, w, w.lead, "select pulse.bank_confirm(%s)", (w.editor,))
    data["summary"]["last4"] = "5678"
    one(api, w, w.editor, "select pulse.bank_save(%s,%s) r", (w.editor, Jsonb(data)))
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select bank_status s from pulse_priv.person_onboarding where person_id=%s", (w.editor,)).fetchone()["s"] == "pending"
        assert owner.execute("select count(*)::int n from pulse_priv.bank_history where person_id=%s", (w.editor,)).fetchone()["n"] >= 1


def test_a_kpi_owner_does_not_mark_it_met(api, worker, team):
    w = team
    with worker.transaction():
        set_tenant(worker, w.org)
        k = worker.execute("insert into pulse.kpi(org_id,person_id,title,source,source_key) values(%s,%s,'Ship 4 reels','test',%s) returning id",
                           (w.org, w.editor, str(uuid.uuid4()))).fetchone()["id"]
    as_(api, w, w.editor, "select pulse.kpi_progress(%s,60,'on_track','halfway')", (k,))
    with pytest.raises(DENIED, match="marks a KPI met"):
        as_(api, w, w.editor, "select pulse.kpi_progress(%s,100,'met','done')", (k,))
    as_(api, w, w.editor2, "select pulse.kpi_progress(%s,100,'met','checked')", (k,))

