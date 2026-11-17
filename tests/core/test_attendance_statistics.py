"""R18 parity, record preservation and correction reuse on a disposable synthetic tenant."""
import json
import os
import subprocess
from pathlib import Path

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from test_hr_suite import _staff


def test_attendance_statistics_api_browser(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    _staff(worker, w)
    def config(value):
        data = conninfo_to_dict(value)
        data['database'] = data.pop('dbname')
        return json.dumps(data)
    report_path = (Path(os.environ['PULSE_MATRIX_RECEIPT']).with_name('attendance-statistics.json')
                   if os.environ.get('PULSE_MATRIX_RECEIPT') else tmp_path / 'attendance.json')
    env = {**os.environ, 'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '0',
           'TEST_API_CONFIG': config(dsn('api')), 'TEST_OWNER_CONFIG': config(owner.info.dsn),
           'PULSE_ORG_ID': str(w.org), 'TEST_MEMBER': w.editor_handle,
           'TEST_MEMBER_ID': str(w.editor), 'TEST_EMPTY_ID': str(w.editor2),
           'PULSE_ATTENDANCE_REPORT': str(report_path)}
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(['node', 'test/attendance-statistics-runner.mjs'], cwd=root / 'services/api',
                            env=env, capture_output=True, text=True, timeout=360)
    assert result.returncode == 0, (result.stderr + result.stdout)[-6500:]
    report = json.loads(report_path.read_text())
    assert report['apiChecks'] >= 20
    assert report['originalsUnchanged']
    if os.environ.get('PULSE_AUTH_BROWSER') == '1':
        assert report['browserChecks'] >= 16
