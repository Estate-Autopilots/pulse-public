"""ONBOARD: the public team setup page and HR → Onboard team → Team setup (synthetic people only)."""
import json
import os
import re
import subprocess
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_account_security import auth_world as auth_world, command

TARA = 'tara.kapoor@example.test'


def admin(api, w, op, b=None, viewer=None):
    return command(api, w, 'pulse.team_setup_admin(%s,%s)', (op, json.dumps(b or {})), viewer or w.manager)


def check(api, w, code, name):
    return command(api, w, 'pulse.team_setup_check(%s,%s)', (code, name))


def submit(api, w, **b):
    return command(api, w, 'pulse.team_setup_submit(%s)', (json.dumps(b),))


def test_code_directory_requests_and_decisions(api, owner, auth_world):
    w = auth_world
    # Only admins and HR see or change it; a colleague, and anyone without a code, gets nothing.
    for sql, args in [('pulse.team_setup_state()', ()), ('pulse.team_setup_admin(%s,%s)', ('rotate', '{}'))]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            command(api, w, sql, args, w.editor)
    assert check(api, w, 'ABCD-EFGH', 'Tara Kapoor') == {'error': 'code'}
    state = admin(api, w, 'rotate')
    code = state['setup']['code']
    assert re.fullmatch(r'[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}', code) and state['setup']['enabled'] is True
    assert state['setup']['domain'] == 'example.test', 'the admin’s own work domain by default'
    assert check(api, w, 'WRONG-CODE', 'Tara Kapoor') == {'error': 'code'}
    assert check(api, w, code.lower().replace('-', ' '), 'Tara Kapoor') == {'ok': True, 'domain': 'example.test', 'suggestion': None}
    # The Workspace list (GAM "print users"): only the company domain is kept; it suggests one address for one name.
    state = admin(api, w, 'directory', {'accounts': [{'email': TARA, 'givenName': 'Tara', 'familyName': 'Kapoor'}, {'email': 'someone@other.test', 'givenName': 'Some'},
                                                    {'email': 'admin@example.test', 'givenName': 'Admin', 'familyName': 'Desk'}, {'email': 'old@example.test', 'givenName': 'Tara', 'suspended': True}]})
    assert state['directory']['count'] == 3 and TARA in state['directory']['emails']
    assert check(api, w, code, '  tara   KAPOOR ')['suggestion'] == TARA
    assert check(api, w, code, 'Tara')['suggestion'] == TARA, 'one active account has the first name'
    assert check(api, w, code, 'Someone Else')['suggestion'] is None
    # Yes: the company address (on the domain); No: a personal address and a WhatsApp number. One open request per name.
    assert submit(api, w, code=code, name='Tara Kapoor', hasGoogle=True, email='tara@other.test') == {'error': 'domain', 'domain': 'example.test'}
    assert submit(api, w, code=code, name='T', hasGoogle=True, email=TARA) == {'error': 'name'}
    assert submit(api, w, code=code, name='Tara Kapoor', hasGoogle=True, email=TARA) == {'ok': True}
    assert submit(api, w, code=code, name='tara kapoor', hasGoogle=True, email=TARA.upper()) == {'ok': True}
    assert submit(api, w, code=code, name='Kedab Mifos', hasGoogle=False, personalEmail='kedab@example.test', whatsapp='8000111222')['error'] == 'personal_is_company'
    assert submit(api, w, code=code, name='Kedab Mifos', hasGoogle=False, personalEmail='kedab.mifos@synthetic.invalid', whatsapp='12') == {'error': 'whatsapp'}
    assert submit(api, w, code=code, name='Kedab Mifos', hasGoogle=False, personalEmail='kedab.mifos@synthetic.invalid', whatsapp='80001 11222') == {'ok': True}
    state = command(api, w, 'pulse.team_setup_state()', viewer=w.manager)
    reqs = {r['name']: r for r in state['requests']}
    assert set(reqs) == {'tara kapoor', 'Kedab Mifos'} and all(r['status'] == 'new' for r in reqs.values())
    tara, kedab = reqs['tara kapoor'], reqs['Kedab Mifos']
    assert tara['email'] == TARA and tara['workspace'] is True and tara['personalEmail'] is None
    assert kedab['email'] is None and kedab['workspace'] is None and kedab['whatsapp'].endswith('8000111222') and kedab['whatsapp'].startswith('+')
    # Use this email: the same audited write as Account access → Work e-mail; the request is done.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        command(api, w, 'pulse.team_setup_admin(%s,%s)', ('decide', json.dumps({'id': tara['id'], 'action': 'use-email', 'personId': str(w.editor2), 'email': TARA})), w.editor)
    state = admin(api, w, 'decide', {'id': tara['id'], 'action': 'use-email', 'personId': str(w.editor2), 'email': TARA})
    done = next(r for r in state['requests'] if r['id'] == tara['id'])
    assert done['status'] == 'done' and done['personId'] == str(w.editor2) and [m['id'] for m in done['matches']] == [str(w.editor2)]
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute('select email from pulse.people_profile where person_id=%s', (w.editor2,)).fetchone()['email'] == TARA
        assert owner.execute("select count(*) n from pulse.record_change where entity_id=%s and field='email' and new_value=%s", (w.editor2, TARA)).fetchone()['n'] == 1
    # Dismiss, reopen; close and open the page; a new code stops the old one.
    assert next(r for r in admin(api, w, 'decide', {'id': kedab['id'], 'action': 'dismiss'})['requests'] if r['id'] == kedab['id'])['status'] == 'dismissed'
    assert next(r for r in admin(api, w, 'decide', {'id': kedab['id'], 'action': 'reopen'})['requests'] if r['id'] == kedab['id'])['status'] == 'new'
    admin(api, w, 'disable')
    assert check(api, w, code, 'Tara Kapoor') == {'error': 'closed'}
    assert submit(api, w, code=code, name='Tara Kapoor', hasGoogle=True, email=TARA) == {'error': 'closed'}
    admin(api, w, 'enable')
    fresh = admin(api, w, 'rotate')['setup']['code']
    assert fresh != code and check(api, w, code, 'Tara')['error'] == 'code' and check(api, w, fresh, 'Tara')['ok']
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        admin(api, w, 'domain', {'domain': 'not a domain'})
    assert admin(api, w, 'domain', {'domain': 'Example.Test'})['setup']['domain'] == 'example.test'
    # The tables stay closed to the API role; the list of names never leaves the admin view.
    for table in ['team_setup', 'team_setup_request', 'workspace_account']:
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            set_tenant(api, w.org, w.manager)
            api.execute(f'select * from pulse_priv.{table}')


def test_team_setup_http(api, owner, auth_world):
    with owner.transaction():
        set_tenant(owner, auth_world.org)
        owner.execute('update pulse.login_credential set must_change=false where org_id=%s', (auth_world.org,))
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_ORG_ID': str(auth_world.org), 'PULSE_PERSON_ID': str(auth_world.editor2),
           'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '1', 'PULSE_AUTH_MAIL_MODE': 'sink'}
    result = subprocess.run(['node', 'test/team-setup-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout[-3000:] + result.stderr[-3000:]
