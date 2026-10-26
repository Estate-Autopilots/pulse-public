"""Production v1 task/project adapters under real tenant RLS; synthetic records and keys only."""
import json
import os
import subprocess
from pathlib import Path

from conftest import dsn
from helpers import build_world
from test_tasks_rt1 import team  # noqa: F401
from test_site_visit_settings import _config
from test_hr_suite import _staff
from v1_work_fixtures import work_fixture


def test_v1_work_matrix(api, owner, worker, team):  # noqa: F811
    w = team
    fixture = work_fixture(api, owner, w)
    other = build_world(worker, owner, api)
    _staff(worker, other)
    foreign = work_fixture(api, owner, other, app_key=False)
    env = {**os.environ, 'TEST_API_CONFIG': _config(dsn('api')), 'TEST_WORK': json.dumps(fixture), 'TEST_FOREIGN': json.dumps(foreign)}
    p = subprocess.run(['node', 'test/v1-work-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api',
                       env=env, text=True, capture_output=True, timeout=90)
    assert p.returncode == 0, (p.stdout + p.stderr)[-5000:]
