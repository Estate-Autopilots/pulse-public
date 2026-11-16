"""BUGKIT-TELEMETRY (1682): usage events, masked replays, friction alerts, the dashboard and adoption (synthetic people only)."""
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_account_security import auth_world as auth_world


def test_friction_http(api, owner, auth_world):
    with owner.transaction():
        set_tenant(owner, auth_world.org)
        owner.execute('update pulse.login_credential set must_change=false where org_id=%s', (auth_world.org,))
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_ORG_ID': str(auth_world.org), 'PULSE_PERSON_ID': str(auth_world.editor2),
           'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '1', 'PULSE_AUTH_MAIL_MODE': 'sink'}
    result = subprocess.run(['node', 'test/friction-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout[-3000:] + result.stderr[-3000:]


def test_replays_settings_and_alerts_stay_in_their_company(api, auth_world):
    w = auth_world
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("""insert into pulse.telemetry_replay(org_id, session_id, seq, person_id, route, started_at, ended_at, events, bytes, data)
                       values (%s, 'EXMPsession0001', 0, %s, '/tasks', now(), now(), 1, 20, '\x1f8b'::bytea)""", (w.org, w.editor))
        api.execute("insert into pulse.friction_alert(org_id, kind, route, target, hits, people) values (%s, 'rage', '/tasks', 'button.save', 5, 2)", (w.org,))
        api.execute("insert into pulse.telemetry_setting(org_id, retention_days) values (%s, 30)", (w.org,))
    other = '00000000-0000-4000-8000-00000000e1e1'
    with api.transaction():
        api.execute("select set_config('pulse.org_id', %s, true)", (other,))
        assert api.execute('select count(*) n from pulse.telemetry_replay').fetchone()['n'] == 0
        assert api.execute('select count(*) n from pulse.friction_alert').fetchone()['n'] == 0
        assert api.execute('select count(*) n from pulse.telemetry_setting').fetchone()['n'] == 0
    # Retention is bounded; kinds and statuses are closed lists.
    with pytest.raises(psycopg.errors.CheckViolation), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute('update pulse.telemetry_setting set retention_days=3 where org_id=%s', (w.org,))
    with pytest.raises(psycopg.errors.CheckViolation), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("update pulse.friction_alert set status='gone' where org_id=%s", (w.org,))
    # The hourly retention runs as the API; a replay inside the retention stays.
    with api.transaction():
        api.execute('select pulse.telemetry_retention()')
        set_tenant(api, w.org, w.editor)
        assert api.execute("select count(*) n from pulse.telemetry_replay where session_id='EXMPsession0001'").fetchone()['n'] == 1
