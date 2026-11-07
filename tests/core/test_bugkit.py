"""BUGKIT-TELEMETRY (1682): usage settings, replay chunks, picked elements and grouping (synthetic people only)."""
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


def test_bugkit_http(api, owner, auth_world):
    with owner.transaction():
        set_tenant(owner, auth_world.org)
        owner.execute('update pulse.login_credential set must_change=false where org_id=%s', (auth_world.org,))
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_ORG_ID': str(auth_world.org), 'PULSE_PERSON_ID': str(auth_world.editor2),
           'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '1', 'PULSE_AUTH_MAIL_MODE': 'sink'}
    result = subprocess.run(['node', 'test/bugkit-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, result.stdout[-3000:] + result.stderr[-3000:]


# A next dev server and four browser passes (~10 min): run on demand with PULSE_BK_BROWSER=1 (screenshots: PULSE_BK_SCREENSHOTS).
@pytest.mark.skipif(os.environ.get('PULSE_BK_BROWSER') != '1', reason='browser walk on demand: PULSE_BK_BROWSER=1')
def test_bugkit_in_the_browser(api, owner, auth_world):
    """services/api/test/bugkit-browser-runner.mjs: the picker (click, Shift-click), a comment thread, mark-up, sending,
    the soft prompt after a rage click, replay chunks without typed text, triage grouped by element and the App friction
    tab; 1440 and 390, light and dark. Screenshots with PULSE_BK_SCREENSHOTS."""
    with owner.transaction():
        set_tenant(owner, auth_world.org)
        owner.execute('update pulse.login_credential set must_change=false where org_id=%s', (auth_world.org,))
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_ORG_ID': str(auth_world.org), 'PULSE_PERSON_ID': str(auth_world.editor2),
           'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '1', 'PULSE_AUTH_MAIL_MODE': 'sink'}
    result = subprocess.run(['node', 'test/bugkit-browser-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, capture_output=True, text=True, timeout=1600)
    assert result.returncode == 0, result.stdout[-3000:] + result.stderr[-3000:]
