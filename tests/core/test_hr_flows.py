"""HR request paths through the real API and phone/desktop web on a disposable tenant only."""
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_hr_suite import _staff


@pytest.fixture
def flow_world(worker, owner, api):
    w = build_world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("select pulse.hr_defaults()")
        owner.execute("update pulse.hr_policy set attendance_enabled=true where org_id=%s", (w.org,))
    _staff(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google','head@hrflow.example.test',%s,'Workspace account')", (w.org, w.editor2))
        worker.execute("update pulse.people_profile set pod='Pod 1' where org_id=%s", (w.org,))
    return w


def test_hr_flows_api_and_browser(worker, owner, api, flow_world, tmp_path):
    w = flow_world
    # INTEGRITY part 2 (1002): co-founders are named by leadership or an admin, never by HR (the runner checks HR is refused).
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.hr_cofounder(org_id,person_id,assigned_by) values(%s,%s,%s) on conflict do nothing", (w.org, w.manager, w.manager))
    def config(dsn_value):
        value = conninfo_to_dict(dsn_value)
        value['database'] = value.pop('dbname')
        return json.dumps(value)
    env = {**os.environ, 'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '0',
           'TEST_API_CONFIG': config(dsn('api')), 'TEST_OWNER_CONFIG': config(owner.info.dsn),
           'PULSE_ORG_ID': str(w.org), 'TEST_MEMBER': w.editor_handle,
           'TEST_MEMBER_ID': str(w.editor), 'TEST_HEAD_ID': str(w.editor2),
           'TEST_HR_ID': str(w.lead), 'TEST_CO_ID': str(w.manager),
           'PULSE_HRFLOW_REPORT': str(tmp_path / 'hrflow.json')}
    root = Path(__file__).resolve().parents[2]
    p = subprocess.run(['node', 'test/hr-flow-runner.mjs'], cwd=root / 'services/api', env=env,
                       capture_output=True, text=True, timeout=480)
    assert p.returncode == 0, (p.stderr + p.stdout)[-6500:]
    report = json.loads((tmp_path / 'hrflow.json').read_text())
    assert report['apiChecks'] >= 55
    if os.environ.get('PULSE_AUTH_BROWSER') == '1':
        assert report['browserChecks'] >= 35
    # Email and personal Telegram copies use a sink during this run, with no private notes in their text.
    from pulse_workers.notifications import drain, drain_mail, test_sink
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse_priv.telegram_person(org_id,person_id,chat_id,verified_by) values(%s,%s,'123456789',%s)", (w.org, w.editor, w.manager))
        worker.execute("update pulse.notification set telegram_status='queued' where person_id=%s and title like 'HR request %%'", (w.editor,))
    tg = drain(worker, w.org)
    mail = drain_mail(worker, w.org)
    assert tg['sent'] > 0 and tg['failed'] == 0
    assert mail['sink'] > 0
    assert all('private emergency note' not in str(item) for item in test_sink)


def test_hr_flow_sql_scope_history_and_policy(worker, owner, api, flow_world):
    w = flow_world
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute('select pulse.hr_flow_defaults()')
        api.execute("select pulse.hr_pod_set('Pod 1',%s,%s)", (w.editor2, [w.editor, w.editor2]))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        leave = api.execute("insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,days,reason) values(%s,%s,(now() at time zone \'Asia/Kolkata\')::date+10,(now() at time zone \'Asia/Kolkata\')::date+14,'unpaid',5,'private emergency note') returning id", (w.org, w.editor)).fetchone()['id']
        flow = api.execute('select id,stage,needs_hr from pulse.hr_flow where source_id=%s', (leave,)).fetchone()
        assert flow['stage'] == 'hr' and 'unpaid leave' in flow['needs_hr'] and 'long leave' in flow['needs_hr']
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.hr_flow_decide(%s,'approved','self approval')", (flow['id'],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor2)
        api.execute("update pulse.leave_request set status='approved',decision_note='head approval' where id=%s", (leave,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("insert into pulse.hr_flow_event(org_id,flow_id,action) values(%s,%s,'forged')", (w.org, flow['id']))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor2)
        api.execute("select pulse.hr_pattern_set(%s,array[2,3,4,5,6,7],(now() at time zone \'Asia/Kolkata\')::date,null,'not HR')", (w.editor,))
    other = build_world(worker, owner, api)
    with api.transaction():
        set_tenant(api, other.org, other.editor)
        assert api.execute('select id from pulse.hr_flow where id=%s', (flow['id'],)).fetchall() == []
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("select pulse.hr_flow_decide(%s,'approved','HR approved extra leave')", (flow['id'],))
        assert len(api.execute('select * from pulse.hr_flow_event where flow_id=%s', (flow['id'],)).fetchall()) == 2
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute('update pulse.hr_flow_event set note=\'edited\' where flow_id=%s', (flow['id'],))


def test_comp_off_ledger_expiry_and_pattern_versions(worker, owner, api, flow_world):
    w = flow_world
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute('select pulse.hr_flow_defaults()')
        api.execute("select pulse.hr_pod_set('Pod 1',%s,%s)", (w.editor2, [w.editor, w.editor2]))
        api.execute("insert into pulse.holiday(org_id,day,name) values(%s,(now() at time zone \'Asia/Kolkata\')::date,'Synthetic day off')", (w.org,))
        api.execute('update pulse.hr_flow_policy set comp_credit=0.5,comp_expiry_days=10')
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        fid = api.execute("select pulse.hr_work_request((now() at time zone \'Asia/Kolkata\')::date,'Half credit policy') id").fetchone()['id']
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        api.execute("select pulse.hr_flow_decide(%s,'approved',null)", (fid,))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute('insert into pulse.attendance_entry(org_id,person_id,work_date,checked_out_at) values(%s,%s,(now() at time zone \'Asia/Kolkata\')::date,now())', (w.org, w.editor))
        api.execute('update pulse.attendance_entry set checked_out_at=now() where person_id=%s', (w.editor,))
        assert len(api.execute('select * from pulse.hr_comp_credit').fetchall()) == 1
        assert api.execute('select pulse.hr_comp_balance(%s,(now() at time zone \'Asia/Kolkata\')::date+10) n', (w.editor,)).fetchone()['n'] == .5
        assert api.execute('select pulse.hr_comp_balance(%s,(now() at time zone \'Asia/Kolkata\')::date+11) n', (w.editor,)).fetchone()['n'] == 0
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("select pulse.hr_pattern_set(%s,array[2,3,4,5,6,7],(now() at time zone \'Asia/Kolkata\')::date+1,null,'Sunday pattern')", (w.editor,))
        api.execute("select pulse.hr_pattern_set(%s,array[1,2,3,4,5],(now() at time zone \'Asia/Kolkata\')::date+8,null,'Changed pattern')", (w.editor,))
        assert len(api.execute('select * from pulse.hr_work_pattern where person_id=%s', (w.editor,)).fetchall()) == 2
        assert api.execute('select pulse.hr_work_days(%s,(now() at time zone \'Asia/Kolkata\')::date+2,array[1,2,3,4,5,6]) d', (w.editor,)).fetchone()['d'] == [2,3,4,5,6,7]
        assert api.execute('select pulse.hr_work_days(%s,(now() at time zone \'Asia/Kolkata\')::date+9,array[1,2,3,4,5,6]) d', (w.editor,)).fetchone()['d'] == [1,2,3,4,5]

    # A voided correction retains its credit/history, but the debit allocator must skip that lot.
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("update pulse.attendance_entry set voided_at=now() where person_id=%s", (w.editor,))
    with owner.transaction():
        owner.execute('set local role pulse_owner')
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.hr_flow(org_id,person_id,kind,source_id,from_date,to_date,subject,status) values(%s,%s,'work',gen_random_uuid(),(now() at time zone 'Asia/Kolkata')::date+1,(now() at time zone 'Asia/Kolkata')::date+1,'Synthetic second worked off day','approved')", (w.org, w.editor))
        owner.execute("insert into pulse.attendance_entry(org_id,person_id,work_date,checked_out_at) values(%s,%s,(now() at time zone 'Asia/Kolkata')::date+1,now())", (w.org, w.editor))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        lid = api.execute("insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,days,reason) values(%s,%s,(now() at time zone 'Asia/Kolkata')::date+2,(now() at time zone 'Asia/Kolkata')::date+2,'comp_off',0.5,'Synthetic earned credit use') returning id", (w.org, w.editor)).fetchone()['id']
        flow_id = api.execute("select id from pulse.hr_flow where source_id=%s", (lid,)).fetchone()['id']
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        api.execute("select pulse.hr_flow_decide(%s,'approved',null)", (flow_id,))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        assert api.execute("select sum(days) n from pulse.hr_comp_use where credit_id in(select id from pulse.hr_comp_credit where earned_on=(now() at time zone 'Asia/Kolkata')::date)").fetchone()['n'] is None
        assert api.execute("select sum(days) n from pulse.hr_comp_use where leave_id=%s", (lid,)).fetchone()['n'] == .5
        assert api.execute("select pulse.hr_comp_balance(%s,(now() at time zone 'Asia/Kolkata')::date+2) n", (w.editor,)).fetchone()['n'] == 0


def test_pod_head_own_requests_need_hr_across_reporting_pods(worker, owner, api, flow_world):
    w = flow_world
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("select pulse.hr_pod_set('Pod 1',%s,%s)", (w.editor2, [w.editor2]))
        api.execute("select pulse.hr_pod_set('Pod 2',%s,%s)", (w.editor, [w.editor, w.editor2]))
        api.execute("insert into pulse.leave_adjustment(org_id,person_id,type_key,leave_year,days,reason,created_by) values(%s,%s,'annual',extract(year from now())::int,10,'Synthetic head allowance',%s)", (w.org, w.editor2, w.lead))
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        sunday = api.execute("select (now() at time zone 'Asia/Kolkata')::date+14-extract(isodow from (now() at time zone 'Asia/Kolkata'))::int d").fetchone()['d']
        work = api.execute("select pulse.hr_work_request(%s,'Head own Sunday work') id", (sunday,)).fetchone()['id']
        leave = api.execute("insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,days,reason) values(%s,%s,%s,%s,'annual',1,'Head own leave') returning id", (w.org, w.editor2, sunday, sunday)).fetchone()['id']
        correction = api.execute("insert into pulse.attendance_regularisation(org_id,person_id,work_date,kind,in_time,out_time,reason) values(%s,%s,(now() at time zone 'Asia/Kolkata')::date-1,'missed_punch','10:00','19:00','Head own correction') returning id", (w.org, w.editor2)).fetchone()['id']
        request = api.execute("select pulse.hr_ticket_open('equipment','Head own request','Equipment request','normal') id").fetchone()['id']
        rows = api.execute("select id,stage,needs_hr from pulse.hr_flow where id=%s or source_id=any(%s)", (work, [leave, correction, request])).fetchall()
        assert len(rows) == 4 and all(r['stage'] == 'hr' for r in rows)
        assert all(not r['needs_hr'] for r in rows)
    for row in rows:
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            set_tenant(api, w.org, w.editor)
            api.execute("select pulse.hr_flow_decide(%s,'approved',null)", (row['id'],))


def test_explicit_cofounder_policy_does_not_require_pod_assignment(worker, owner, api, flow_world):
    w = flow_world
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute('select pulse.hr_flow_defaults()')
        api.execute("update pulse.hr_flow_policy set leave_approver='cofounder',work_approver='cofounder'")
        api.execute("update pulse.people_profile set manager_id=null,pod=null where person_id=%s", (w.editor,))
        api.execute("insert into pulse.leave_adjustment(org_id,person_id,type_key,leave_year,days,reason,created_by) values(%s,%s,'annual',extract(year from now())::int,10,'Synthetic opening allowance',%s)", (w.org, w.editor, w.lead))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        sunday = api.execute("select (now() at time zone 'Asia/Kolkata')::date+14-extract(isodow from (now() at time zone 'Asia/Kolkata'))::int d").fetchone()['d']
        work = api.execute("select pulse.hr_work_request(%s,'Explicit co-founder policy') id", (sunday,)).fetchone()['id']
        leave = api.execute("insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,days,reason) values(%s,%s,%s,%s,'annual',1,'Explicit policy leave') returning id", (w.org, w.editor, sunday, sunday)).fetchone()['id']
        rows = api.execute('select stage from pulse.hr_flow where id=%s or source_id=%s', (work, leave)).fetchall()
        assert len(rows) == 2 and all(row['stage'] == 'cofounder' for row in rows)
