"""BUG-REPORT (1201): reports, triage and the owner's Telegram feed (synthetic people only)."""
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


def test_reported_bugs_http(api, owner, auth_world):
    with owner.transaction():
        set_tenant(owner, auth_world.org)
        owner.execute('update pulse.login_credential set must_change=false where org_id=%s', (auth_world.org,))
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_ORG_ID': str(auth_world.org), 'PULSE_PERSON_ID': str(auth_world.editor2),
           'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '1', 'PULSE_AUTH_MAIL_MODE': 'sink'}
    result = subprocess.run(['node', 'test/bug-reports-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, result.stdout[-3000:] + result.stderr[-3000:]


def test_reports_stay_in_their_company_and_the_feed_is_short(api, worker, auth_world):
    w = auth_world
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("""insert into pulse.reported_bug(org_id, number, person_id, command_id, words, route, fingerprint)
                       values (%s, 1, %s, 'cmd-synthetic-1', 'Synthetic: the page is blank', '/tasks', repeat('a', 64))""", (w.org, w.editor))
    # The worker's feed: a short line and the number, never the picture, errors or steps.
    with worker.transaction():
        rows = worker.execute("select * from pulse.reported_bug_feed(now() - interval '1 hour', 100)").fetchall()
    mine = [r for r in rows if r['words'] == 'Synthetic: the page is blank']
    assert mine and mine[0]['number'] == 1
    assert set(mine[0].keys()) == {'id', 'org_name', 'number', 'words', 'route', 'blocks_work', 'severity', 'platform', 'reporter', 'signed_out', 'created_at'}
    # Statuses are a closed list.
    with pytest.raises(psycopg.errors.CheckViolation), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("update pulse.reported_bug set status='done' where org_id=%s", (w.org,))
