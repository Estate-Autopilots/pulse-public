"""MOBILE-READY (1260): "Sign in this device" on a disposable tenant with synthetic people only. The acceptance is
services/api/test/device-signin-runner.mjs against the built API: only admins make a one-time code for their own account;
it signs a phone in once within 10 minutes, by its 6 digits or its QR token; newer codes, Cancel, expiry and losing the
admin role end it; two-step is kept; guesses are limited per address; sign-in events are written; the table is closed."""
import json
import os
import subprocess
import uuid
from pathlib import Path

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def test_device_signin(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    roles = {r: uuid.uuid4() for r in ['person', 'hr', 'leadership', 'admin', 'nopass']}
    with worker.transaction():
        set_tenant(worker, w.org)
        for role, pid in roles.items():
            key = 'admin' if role == 'nopass' else role
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, 'Synthetic ' + role))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence,username,email) values(%s,%s,%s,'Pod 1','{}',%s,%s)",
                           (w.org, pid, key, 'synthetic.' + role, role + '@delivery.example'))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (w.org, role + '@people.example', pid))
            if role != 'person':
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, pid, key))
    # Everyone but "nopass" has a Pulse password (device codes sign in to an account that has one).
    with api.transaction():
        set_tenant(api, w.org, roles['admin'])
        for role in ['person', 'hr', 'leadership', 'admin']:
            api.execute("select pulse.login_issue(%s,'Synthetic-account-2026!')", (roles[role],))
    config = conninfo_to_dict(dsn('api')); config['database'] = config.pop('dbname')
    wc = conninfo_to_dict(dsn('migrate')); wc['database'] = wc.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_OWNER_CONFIG': json.dumps(wc), 'PULSE_ORG_ID': str(w.org),
           'TEST_ROLES': json.dumps({r: str(p) for r, p in roles.items()}), 'TEST_REPORT': str(tmp_path / 'device-signin.json'), 'PULSE_CI': '1'}
    result = subprocess.run(['node', 'test/device-signin-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, text=True,
                            capture_output=True, timeout=240)
    assert result.returncode == 0, result.stdout + '\n' + result.stderr
    report = json.loads((tmp_path / 'device-signin.json').read_text())
    assert report['checks'] >= 38
