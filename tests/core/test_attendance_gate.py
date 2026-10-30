"""Attendance privacy gate contract against a synthetic tenant and real API handlers."""
import json
import os
import subprocess
from pathlib import Path

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_hr_suite import _staff


def _config(value):
    data = conninfo_to_dict(value)
    data['database'] = data.pop('dbname')
    return json.dumps(data)


def test_attendance_gate_capture_reads_presence_and_enabled_roles(worker, owner, api):
    w = build_world(worker, owner, api)
    _staff(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.people_profile set manager_id=%s where person_id=%s", (w.editor2, w.editor))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,unit_id,role_key,is_manager_of_unit,valid_from) "
                       "values(%s,%s,%s,'pgs',false,'2026-01-01')", (w.org, w.editor2, w.pod))
    env = {**os.environ, 'TEST_API_CONFIG': _config(dsn('api')),
           'TEST_OWNER_CONFIG': _config(owner.info.dsn), 'TEST_WORKER_CONFIG': _config(dsn('worker')),
           'PULSE_ORG_ID': str(w.org), 'TEST_MEMBER': w.editor_handle,
           'TEST_MEMBER_ID': str(w.editor), 'TEST_OTHER_ID': str(w.editor2),
           'TEST_OTHER': f'editor2@{w.domain}'}
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(['node', 'test/attendance-gate-runner.mjs'], cwd=root / 'services/api', env=env,
                            capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, (result.stderr + result.stdout)[-6500:]
    receipt = json.loads(result.stdout.splitlines()[-1])
    assert receipt['checks'] >= 95
    assert receipt['syntheticOnly'] and receipt['attendanceEnabledOff'] and receipt['attendanceEnabledOn']
