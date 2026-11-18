"""R19 real API and SQL acceptance on a disposable synthetic tenant."""
import json
import os
import subprocess
from pathlib import Path
from psycopg.conninfo import conninfo_to_dict
from conftest import dsn
from helpers import build_world
from test_hr_suite import _staff


def test_attendance_reconciliation_api(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    _staff(worker, w)
    def config(value):
        data = conninfo_to_dict(value)
        data['database'] = data.pop('dbname')
        return json.dumps(data)
    report = (Path(os.environ['PULSE_MATRIX_RECEIPT']).with_name('attendance-reconciliation.json')
              if os.environ.get('PULSE_MATRIX_RECEIPT') else tmp_path / 'reconciliation.json')
    env = {**os.environ, 'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '0',
           'TEST_API_CONFIG': config(dsn('api')), 'TEST_OWNER_CONFIG': config(owner.info.dsn),
           'PULSE_ORG_ID': str(w.org), 'TEST_MEMBER': w.editor_handle,
           'TEST_MEMBER_ID': str(w.editor), 'PULSE_RECONCILIATION_REPORT': str(report)}
    result = subprocess.run(['node', 'test/attendance-reconciliation-runner.mjs'],
                            cwd=Path(__file__).resolve().parents[2] / 'services/api',
                            env=env, capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, (result.stderr + result.stdout)[-6500:]
    receipt = json.loads(report.read_text())
    assert receipt['apiChecks'] >= 35
    if os.environ.get('PULSE_AUTH_BROWSER') == '1':
        assert receipt['browserChecks'] >= 36
    assert receipt['originalsUnchanged'] and receipt['workerReadOnly'] and receipt['unknownMonthlyExcluded']


def test_reconciliation_tenant_and_self_approval_boundaries(worker, owner, api):
    import psycopg
    import pytest
    from pulse_sdk.db import set_tenant
    w = build_world(worker, owner, api)
    _staff(worker, w)
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        version = api.execute("select pulse.attendance_policy_propose(120,960,10,'America/New_York','HR reviews long shifts') version").fetchone()['version']
        assert version == 2
        entry = api.execute("insert into pulse.attendance_entry(org_id,person_id,work_date,checked_in_at,checked_out_at) values(%s,%s,'2026-10-01','2026-10-01T10:00Z','2026-10-01T18:00Z') returning id", (w.org, w.editor)).fetchone()['id']
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        request = api.execute("insert into pulse.attendance_regularisation(org_id,person_id,work_date,kind,reason,in_time,out_time,entry_id) values(%s,%s,'2026-10-01','missed_punch','Synthetic review request','10:00','18:00',%s) returning id", (w.org, w.editor, entry)).fetchone()['id']
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.attendance_accept_time(%s,%s,'2026-10-01T10:00Z','2026-10-01T18:00Z','office',0)", (request, entry))
    other = build_world(worker, owner, api)
    with api.transaction():
        set_tenant(api, other.org, other.editor)
        assert api.execute('select * from pulse.attendance_close_policy').fetchall() == []
        assert api.execute('select * from pulse.attendance_effective where id=%s', (entry,)).fetchall() == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, other.org, other.editor)
        api.execute("select pulse.attendance_accept_time(%s,%s,'2026-10-01T10:00Z','2026-10-01T18:00Z','office',0)", (request, entry))
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        # Conversion uses the configured IANA zone across both DST transitions.
        stamps = api.execute("select ('2026-03-08'::date+time '03:00') at time zone 'America/New_York' spring, ('2026-11-01'::date+time '03:00') at time zone 'America/New_York' autumn").fetchone()
        assert stamps['spring'].hour == 7 and stamps['autumn'].hour == 8
        policy = api.execute('select mode,approved_at from pulse.attendance_close_policy').fetchone()
        assert policy['mode'] == 'suggestion' and policy['approved_at'] is None
