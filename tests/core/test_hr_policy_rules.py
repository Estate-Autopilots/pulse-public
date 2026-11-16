"""R19b: inert migration, explicit confirmations, real balance/routing/attendance with isolated tenants."""
import json
from datetime import date, timedelta
import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_hr_suite import _staff

CONFIG = {
    'late_marks': {'threshold': 3, 'window': 'calendar_month', 'deduction': .5, 'balanceKind': 'annual'},
    'half_day': {'netMinutes': 270, 'arrivalCutoff': '13:00', 'timezone': 'Asia/Kolkata'},
    'advance_notice': {'shortWorkingDays': 3, 'longCalendarDays': 14, 'longFromDays': 3},
    'emergency': {'recordWorkingDays': 2, 'notifyHours': 2},
    'special_routing': {'unpaidDays': 5, 'probationDays': 2},
    'leave_balance': {'yearStart': 4, 'monthlyDays': 2, 'carryMax': 12, 'balanceKind': 'annual'},
    'professional_tax': {'state': 'MH', 'slabs': [{'category': 'men', 'upTo': 7500, 'monthly': 0, 'february': 0}, {'category': 'men', 'upTo': 10000, 'monthly': 175, 'february': 175}, {'category': 'men', 'upTo': None, 'monthly': 200, 'february': 300}, {'category': 'women', 'upTo': 25000, 'monthly': 0, 'february': 0}, {'category': 'women', 'upTo': None, 'monthly': 200, 'february': 300}]},
    'exit': {'confirmedDays': 30, 'probationDays': 15, 'settlementDays': 45},
}

@pytest.fixture
def rules_world(worker, owner, api):
    w = build_world(worker, owner, api)
    _staff(worker, w)
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute('select pulse.hr_flow_defaults()')
        api.execute("update pulse.hr_policy set work_days=array[1,2,3,4,5,6,7],tracking_from='2026-01-01'")
    return w


def today(api):
    return api.execute("select (now() at time zone 'Asia/Kolkata')::date d").fetchone()['d']


def confirm(api, w, key, config=None, effective=None, hash_value=None):
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        return api.execute('select pulse.hr_rule_confirm(%s,%s,%s,0,%s) v', (key, json.dumps(config or CONFIG[key]), effective or today(api), hash_value)).fetchone()['v']


def punch(worker, w, d, start='10:16', end='15:00', late=16):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("insert into pulse.attendance_entry(org_id,person_id,work_date,checked_in_at,checked_out_at,late_minutes) values(%s,%s,%s,(%s::date+%s::time) at time zone 'Asia/Kolkata',(%s::date+%s::time) at time zone 'Asia/Kolkata',%s) returning id", (w.org, w.editor, d, d, start, d, end, late)).fetchone()['id']


def detail(api, w, d):
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        return api.execute("select pulse.hr_balance_detail(%s,'annual',%s) b", (w.editor, d)).fetchone()['b']


def test_every_rule_is_off_and_confirmation_is_hr_only(api, worker, rules_world):
    w = rules_world
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        for key in CONFIG:
            assert api.execute('select pulse.hr_rule_at(%s,%s) r', (key, today(api))).fetchone()['r'] is None
    for key in CONFIG:
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            set_tenant(api, w.org, w.editor)
            api.execute('select pulse.hr_rule_confirm(%s,%s,%s,0)', (key, json.dumps(CONFIG[key]), today(api)))
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute('select count(*) n from pulse.hr_rule_version').fetchone()['n'] == 0


def test_late_groups_waiver_dedup_month_and_off(api, worker, rules_world):
    w = rules_world
    # Keep all three late days in one month, even when CI runs at month end.
    d = (today(api).replace(day=1) + timedelta(days=32)).replace(day=1)
    before = detail(api, w, d + timedelta(days=2))['available']
    for offset in range(3):
        punch(worker, w, d + timedelta(days=offset))
    assert detail(api, w, d + timedelta(days=2))['available'] == before
    confirm(api, w, 'late_marks', effective=d)
    assert detail(api, w, d + timedelta(days=2))['available'] == before - .5
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("select pulse.hr_late_waive(%s,%s,'Approved disruption')", (w.editor, d))
    assert detail(api, w, d + timedelta(days=2))['available'] == before
    # Multiple punches on the same day count once.
    punch(worker, w, d + timedelta(days=1), start='16:00', end='18:00', late=360)
    assert detail(api, w, d + timedelta(days=2))['available'] == before
    with pytest.raises(psycopg.errors.CheckViolation), api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("select pulse.hr_late_waive(%s,%s,' ')", (w.editor, d))


def test_late_groups_reset_at_calendar_month_boundary(api, worker, rules_world):
    w = rules_world
    effective = (today(api).replace(day=1) + timedelta(days=32)).replace(day=1)
    boundary = (effective + timedelta(days=32)).replace(day=1)
    as_of = boundary + timedelta(days=2)
    # Compare the same as-of date so monthly leave accrual is held constant.
    before = detail(api, w, as_of)
    for offset in (-2, -1, 0):
        punch(worker, w, boundary + timedelta(days=offset))
    assert detail(api, w, as_of) == before
    confirm(api, w, 'late_marks', effective=effective)
    # Two marks last month and one this month do not form a group of three.
    assert detail(api, w, as_of) == before
    for offset in (1, 2):
        punch(worker, w, boundary + timedelta(days=offset))
    after = detail(api, w, as_of)
    assert after['accrued'] == before['accrued']
    assert after['adjusted'] == before['adjusted'] - .5
    assert after['available'] == before['available'] - .5


def test_automatic_half_day_strict_and_remote(api, worker, rules_world):
    w = rules_world
    d = today(api)
    punch(worker, w, d, start='13:00', end='17:30')
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        assert not api.execute('select * from pulse.hr_rule_days(%s,%s,%s)', (w.editor, d, d)).fetchone()['half_day']
    confirm(api, w, 'half_day')
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        assert not api.execute('select * from pulse.hr_rule_days(%s,%s,%s)', (w.editor, d, d)).fetchone()['half_day']
    punch(worker, w, d + timedelta(days=1), start='13:01', end='17:31')
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        assert api.execute('select * from pulse.hr_rule_days(%s,%s,%s)', (w.editor, d + timedelta(days=1), d + timedelta(days=1))).fetchone()['half_day']
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.attendance_regularisation(org_id,person_id,work_date,kind,reason,status) values(%s,%s,%s,'wfh','Approved remote work','approved')", (w.org, w.editor, d + timedelta(days=1)))
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        assert not api.execute('select * from pulse.hr_rule_days(%s,%s,%s)', (w.editor, d + timedelta(days=1), d + timedelta(days=1))).fetchone()['half_day']


def test_balance_preview_and_stale_confirmation(api, worker, rules_world):
    w = rules_world
    effective = (today(api).replace(day=1) + timedelta(days=32)).replace(day=1)
    config = CONFIG['leave_balance']
    before = detail(api, w, effective)
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        preview = api.execute('select pulse.hr_balance_preview(%s,%s) p', (json.dumps(config), effective)).fetchone()['p']
        mine = next(r for r in preview['rows'] if r['personId'] == str(w.editor))
        assert mine['before'] == before
        assert mine['after']['available'] == before['available'] + 1
        assert len(preview['rows']) == api.execute("select count(*) n from pulse.person where side='staff'").fetchone()['n']
    assert detail(api, w, effective) == before
    with pytest.raises(psycopg.errors.SerializationFailure):
        confirm(api, w, 'leave_balance', effective=effective, hash_value='stale')
    confirm(api, w, 'leave_balance', effective=effective, hash_value=preview['hash'])
    assert detail(api, w, effective) == mine['after']
    assert detail(api, w, today(api))['available'] == before['available'] - 1
    april = date(effective.year + 1, 4, 1)
    assert detail(api, w, april)['carried'] <= 12
    assert detail(api, w, april)['accrued'] == 2


def test_special_routing_and_emergency_off_on(api, worker, rules_world):
    w = rules_world
    d = today(api)
    def leave(day):
        with api.transaction():
            set_tenant(api, w.org, w.editor)
            return api.execute("insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,days,reason) values(%s,%s,%s,%s,'unpaid',6,'Synthetic request') returning id", (w.org, w.editor, day, day + timedelta(days=5))).fetchone()['id']
    first = leave(d + timedelta(days=7))
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        assert api.execute('select stage from pulse.hr_flow where source_id=%s', (first,)).fetchone()['stage'] == 'hr'
    confirm(api, w, 'special_routing')
    second = leave(d + timedelta(days=20))
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        assert api.execute('select stage from pulse.hr_flow where source_id=%s', (second,)).fetchone()['stage'] == 'cofounder'
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.hr_emergency_notify(%s,%s,'Synthetic emergency')", (d, d + timedelta(days=1)))
    confirm(api, w, 'emergency')
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        emergency = api.execute("select pulse.hr_emergency_notify(%s,%s,'Synthetic emergency') id", (d, d + timedelta(days=1))).fetchone()['id']
        assert api.execute('select record_by from pulse.hr_emergency where id=%s', (emergency,)).fetchone()['record_by'] == d + timedelta(days=3)


def test_employment_security_and_dated_versions(api, rules_world):
    w = rules_world
    data = {'probationFrom':'2026-09-01','probationTo':'2026-11-30','noticeFrom':None,'noticeTo':None,'handover':[{'label':'Return assets','done':False}],'ptCategory':'women','ptState':'MH'}
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute('select pulse.hr_employment_save(%s,%s)', (w.editor, json.dumps(data)))
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute('select pulse.hr_employment_save(%s,%s)', (w.editor, json.dumps(data)))
    confirm(api, w, 'professional_tax', effective=today(api)+timedelta(days=3))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        assert api.execute("select pulse.hr_rule_at('professional_tax',%s) r", (today(api),)).fetchone()['r'] is None
        assert api.execute("select pulse.hr_rule_at('professional_tax',%s) r", (today(api)+timedelta(days=3),)).fetchone()['r']['slabs'] == CONFIG['professional_tax']['slabs']
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("update pulse.hr_rule_version set config='{}'")


def test_partial_emergency_record_keeps_follow_up_open(api, rules_world):
    w = rules_world
    d = today(api)
    confirm(api, w, 'emergency')
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        emergency = api.execute("select pulse.hr_emergency_notify(%s,%s,'Synthetic multi-day emergency') id", (d, d + timedelta(days=4))).fetchone()['id']
        leave = api.execute("insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,days,reason) values(%s,%s,%s,%s,'annual',1,'Partial emergency record') returning id", (w.org, w.editor, d, d)).fetchone()['id']
    with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute('select pulse.hr_emergency_record(%s,%s)', (emergency, leave))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        assert api.execute('select leave_id from pulse.hr_emergency where id=%s', (emergency,)).fetchone()['leave_id'] is None


def test_rules_through_api_and_browser(worker, owner, api, rules_world, tmp_path):
    import os
    import subprocess
    from pathlib import Path
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = rules_world
    with worker.transaction():
        set_tenant(worker, w.org)
        for permission in ['hr.salary.read', 'hr.salary.write']:
            worker.execute("insert into pulse.sensitive_permission(org_id,person_id,permission,granted_by) values(%s,%s,%s,'synthetic test')", (w.org, w.lead, permission))
    def config(value):
        values = conninfo_to_dict(value)
        values['database'] = values.pop('dbname')
        return json.dumps(values)
    env = {**os.environ,'PULSE_CI':'1','PULSE_PUBLIC_LOGIN_ENABLED':'0','PULSE_ORG_ID':str(w.org),
           'TEST_API_CONFIG':config(dsn('api')),'TEST_OWNER_CONFIG':config(owner.info.dsn),
           'TEST_MEMBER':w.editor_handle,'TEST_MEMBER_ID':str(w.editor),'TEST_OTHER_ID':str(w.editor2),
           'PULSE_R19B_REPORT':str(tmp_path/'rules.json')}
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(['node','test/hr-rule-runner.mjs'],cwd=root/'services/api',env=env,capture_output=True,text=True,timeout=480)
    assert result.returncode == 0, (result.stderr+result.stdout)[-6000:]
    report = json.loads((tmp_path/'rules.json').read_text())
    assert report['apiChecks'] >= 45
    if os.environ.get('PULSE_AUTH_BROWSER') == '1':
        assert report['browserChecks'] >= 35


def test_breaks_and_incomplete_records_never_force_half_day(api, worker, rules_world):
    w = rules_world
    d = today(api)
    eid = punch(worker, w, d, start='10:00', end='14:30', late=0)
    confirm(api, w, 'half_day')
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        assert not api.execute('select * from pulse.hr_rule_days(%s,%s,%s)', (w.editor,d,d)).fetchone()['half_day']
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.attendance_break(org_id,entry_id,person_id,started_at,ended_at) values(%s,%s,%s,(%s::date+time '12:00') at time zone 'Asia/Kolkata',(%s::date+time '12:30') at time zone 'Asia/Kolkata')", (w.org,eid,w.editor,d,d))
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        row = api.execute('select * from pulse.hr_rule_days(%s,%s,%s)', (w.editor,d,d)).fetchone()
        assert row['net_minutes'] == 240 and row['half_day']
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute('update pulse.attendance_entry set missed_out=true where id=%s',(eid,))
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        assert not api.execute('select * from pulse.hr_rule_days(%s,%s,%s)', (w.editor,d,d)).fetchone()['half_day']


def test_database_rejects_unvalidated_rule_settings(api, rules_world):
    w = rules_world
    for key,config in [('late_marks',dict(CONFIG['late_marks'],threshold=0)),('half_day',dict(CONFIG['half_day'],arrivalCutoff='25:00')),('leave_balance',dict(CONFIG['leave_balance'],yearStart=13))]:
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            confirm(api,w,key,config)


def test_balance_preview_rechecks_a_real_adjustment_before_activation(api, rules_world):
    w = rules_world
    d = today(api)
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        preview = api.execute('select pulse.hr_balance_preview(%s,%s) p', (json.dumps(CONFIG['leave_balance']),d)).fetchone()['p']
        api.execute("insert into pulse.leave_adjustment(org_id,person_id,type_key,leave_year,days,reason,created_by) values(%s,%s,'annual',%s,.5,'Synthetic opening correction',%s)", (w.org,w.editor,d.year,w.lead))
    with pytest.raises(psycopg.errors.SerializationFailure):
        confirm(api,w,'leave_balance',effective=d,hash_value=preview['hash'])
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        assert api.execute("select count(*) n from pulse.hr_rule_version where key='leave_balance'").fetchone()['n'] == 0


def test_adjustment_after_effective_date_is_counted_once(api, rules_world):
    w = rules_world
    d = today(api)
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        preview = api.execute('select pulse.hr_balance_preview(%s,%s) p',(json.dumps(CONFIG['leave_balance']),d)).fetchone()['p']
    confirm(api,w,'leave_balance',effective=d,hash_value=preview['hash'])
    before = detail(api,w,d)['available']
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        year = d.year - (d.month < 4)
        api.execute("insert into pulse.leave_adjustment(org_id,person_id,type_key,leave_year,days,reason,created_by) values(%s,%s,'annual',%s,.5,'Synthetic post-transition adjustment',%s)", (w.org,w.editor,year,w.lead))
    assert detail(api,w,d)['available'] == before + .5
