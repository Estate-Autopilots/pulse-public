"""Existing-person-only Google links, real-role tenant boundaries and strict HTTP contracts."""
import json
import os
import subprocess
import time
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_account_security import auth_world as auth_world, command, hashof

SETTINGS = dict(enabled=True, allowedDomains=['example.test'], trustGoogle2Step=False, passwordSignIn='on')
PROOF = dict(iss='https://accounts.google.com', sub='synthetic-subject', email='different@example.test', email_verified=True, hd='example.test')


@pytest.fixture
def google_world(api, owner, auth_world):
    w = auth_world
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute('update pulse.login_credential set must_change=false where org_id=%s', (w.org,))
    assert command(api, w, 'pulse.google_policy()') == {**SETTINGS, 'enabled': False, 'allowedDomains': []}
    command(api, w, 'pulse.google_settings(%s)', (json.dumps(SETTINGS),), w.manager)
    return w


def attempt(api, w, op, b):
    return command(api, w, 'pulse.google_link_attempt(%s,%s)', (op, json.dumps(b)), w.editor)


def begin(api, w, session=None):
    b = dict(stateHash=hashof(str(uuid4())), cookieHash=hashof('cookie'), sessionHash=session or hashof('fixture-session' + str(w.org)), nonce='synthetic-nonce', verifier='synthetic-pkce')
    assert attempt(api, w, 'begin', b) == {'ok': True}
    return b


def finish(api, w, b, **claims):
    return attempt(api, w, 'finish', {**b, 'proof': {**PROOF, 'auth_time': time.time(), **claims}})


def test_link_once_unlink_and_password_recovery(api, owner, google_world):
    w = google_world
    assert command(api, w, 'pulse.google_settings()', viewer=w.manager)['trustGoogle2Step'] is False
    assert command(api, w, 'pulse.google_link_state()', viewer=w.editor) is None
    assert command(api, w, 'pulse.google_identity_resolve(%s,%s)', (PROOF['iss'], PROOF['sub']))['error'] == 'not_linked'
    b = begin(api, w)
    assert attempt(api, w, 'read', {**b, 'cookieHash': hashof('wrong')})['error'] == 'state_invalid'
    assert finish(api, w, b) == {'ok': True}
    assert command(api, w, 'pulse.google_identity_resolve(%s,%s)', (PROOF['iss'], PROOF['sub']))['personId'] == str(w.editor)
    for change, error in [({'allowedDomains': ['other.test']}, 'domain_not_allowed'), ({'enabled': False}, 'provider_error'), ({}, None)]:
        command(api, w, 'pulse.google_settings(%s)', (json.dumps({**SETTINGS, **change}),), w.manager)
        assert command(api, w, 'pulse.google_identity_resolve(%s,%s)', (PROOF['iss'], PROOF['sub'])).get('error') == error
    assert finish(api, w, b)['error'] == 'state_invalid'
    state = command(api, w, 'pulse.google_link_state()', viewer=w.editor)
    assert set(state) == {'email', 'linkedAt', 'lastUsedAt'} and state['email'] == PROOF['email']
    assert finish(api, w, begin(api, w), sub='another-subject')['error'] == 'already_linked'
    command(api, w, 'pulse.google_settings(%s)', (json.dumps({**SETTINGS, 'passwordSignIn': 'off_for_linked'}),), w.manager)
    assert not command(api, w, 'pulse.google_password_allowed(%s)', (w.editor,))
    assert command(api, w, 'pulse.google_password_allowed(%s)', (w.manager,))
    assert command(api, w, "(select to_jsonb(v) from pulse.login_verify('auth.person','Synthetic-account-2026!') v)") is None
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        command(api, w, 'pulse.google_settings(%s)', (json.dumps({**SETTINGS, 'enabled': False, 'passwordSignIn': 'off_for_linked'}),), w.manager)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.login_session(org_id,person_id,token_hash,expires_at,via) values(%s,%s,%s,now()+interval '1 hour','google')", (w.org, w.editor, hashof(str(uuid4()))))
    command(api, w, 'pulse.google_unlink()', viewer=w.editor)
    assert command(api, w, 'pulse.google_link_state()', viewer=w.editor) is None
    assert command(api, w, 'pulse.google_password_allowed(%s)', (w.editor,))
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select count(*) n from pulse.login_session where person_id=%s and via='google' and revoked_at is null", (w.editor,)).fetchone()['n'] == 0
        assert owner.execute("select count(*) n from pulse_priv.auth_event where actor=%s and action in('google_linked','google_unlinked')", (w.editor,)).fetchone()['n'] == 2


@pytest.mark.parametrize('claim,value,error', [('iss', 'https://evil.example', 'provider_error'), ('hd', 'evil.example', 'domain_not_allowed'), ('email_verified', False, 'provider_error'), ('auth_time', 1, 'provider_error')])
def test_invalid_verified_claims_consume_attempt(api, google_world, claim, value, error):
    b = begin(api, google_world)
    assert finish(api, google_world, b, **{claim: value})['error'] == error
    assert finish(api, google_world, b)['error'] == 'state_invalid'


def test_expired_disabled_duplicate_and_foreign_tenant(api, worker, owner, google_world):
    w = google_world
    b = begin(api, w)
    other = build_world(worker, owner, api)
    assert attempt(api, other, 'finish', b)['error'] == 'state_invalid'
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse_priv.google_link_attempt set expires_at=now()-interval '1 second' where person_id=%s", (w.editor,))
    assert finish(api, w, b)['error'] == 'state_invalid'
    b = begin(api, w)
    command(api, w, "pulse.auth_admin('staff',%s,'disable','{}')", (w.editor,), w.manager)
    assert finish(api, w, b)['error'] == 'account_disabled'
    command(api, w, "pulse.auth_admin('staff',%s,'enable','{}')", (w.editor,), w.manager)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute('insert into pulse_priv.google_identity(org_id,person_id,issuer,subject,email,domain) values(%s,%s,%s,%s,%s,%s)', (w.org, w.editor2, PROOF['iss'], PROOF['sub'], PROOF['email'], PROOF['hd']))
    fresh = hashof(str(uuid4()))
    command(api, w, "pulse.auth_login('staff','auth.person','Synthetic-account-2026!',%s,%s,false,'Browser')", (hashof(str(uuid4())), fresh))
    assert finish(api, w, begin(api, w, fresh))['error'] == 'already_linked'
    for sql, args in [('pulse.google_settings(%s)', (json.dumps(SETTINGS),)), ('pulse.google_unlink(%s)', (w.editor2,))]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            command(api, w, sql, args, w.editor)
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute('select * from pulse_priv.google_identity')


# EST-1397's runner drives start/callback against a synthetic Google issuer (PKCE, RS256 JWKS) on 127.0.0.1.
@pytest.mark.parametrize('runner', ['google-sign-in-runner.mjs', 'google-sign-in-flow-runner.mjs'])
def test_google_http_contract(api, google_world, runner):
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_ORG_ID': str(google_world.org), 'PULSE_PERSON_ID': str(google_world.editor), 'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '1', 'PULSE_AUTH_MAIL_MODE': 'sink'}
    result = subprocess.run(['node', 'test/' + runner], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, capture_output=True, text=True, timeout=45)
    assert result.returncode == 0, result.stdout[-3000:] + result.stderr[-3000:]
    if runner == 'google-sign-in-flow-runner.mjs':
        # Contract §3: the API's request logs never carry the callback's code, state or query string.
        assert 'Google sign-in refused' in result.stdout
        seen = json.loads(result.stderr.split('GOOGLE-QUERY ', 1)[1].splitlines()[0])
        assert seen and not [v for v in seen if v in result.stdout]


def test_hosted_google_http_contract(api, worker, owner, google_world, tmp_path):
    worlds = [build_world(worker, owner, api) for _ in range(2)]
    for i, w in enumerate(worlds):
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, w.manager))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,email,evidence) values(%s,%s,'Editor','hosted.admin','admin@example.test','{}')", (w.org, w.manager))
        command(api, w, 'pulse.google_settings(%s)', (json.dumps(SETTINGS),), w.manager)
        command(api, w, "pulse.login_issue(%s,'Synthetic-account-2026!')", (w.manager,), w.manager)
        with owner.transaction():
            set_tenant(owner, w.org)
            owner.execute("insert into pulse.org_domain(host,org_id,added_by) values(%s,%s,'test')", (f'hosted-{i}.example.test', w.org))
            owner.execute('update pulse.login_credential set must_change=false where org_id=%s', (w.org,))
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_ORG_ID': str(google_world.org),
           'TEST_HOSTED_ORG': str(worlds[0].org), 'PULSE_CONNECTOR_SECRETS_DIR': str(tmp_path),
           'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '1', 'PULSE_AUTH_MAIL_MODE': 'sink'}
    result = subprocess.run(['node', 'test/hosted-google-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api',
                            env=env, capture_output=True, text=True, timeout=45)
    assert result.returncode == 0, result.stdout[-3000:] + result.stderr[-3000:]


def test_trust_change_requires_fresh_admin_factor(api, owner, google_world):
    w = google_world
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse_priv.auth_key values(%s,gen_random_bytes(32)) on conflict do nothing", (w.org,))
        owner.execute("insert into pulse_priv.auth_account(org_id,realm,actor,totp) select %s,'staff',%s,pgp_sym_encrypt_bytea(decode('0102030405060708091011121314151617181920','hex'),encode(key,'hex')) from pulse_priv.auth_key where org_id=%s", (w.org, w.manager, w.org))
        code = owner.execute("select pulse.auth_totp(decode('0102030405060708091011121314151617181920','hex'),floor(extract(epoch from now())/30)::bigint) c").fetchone()['c']
    trust = json.dumps({**SETTINGS, 'trustGoogle2Step': True})
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        command(api, w, 'pulse.google_settings(%s)', (trust,), w.manager)
    assert command(api, w, 'pulse.google_settings(%s,%s)', (trust, code), w.manager)['notices']
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        command(api, w, 'pulse.google_settings(%s,%s)', (json.dumps(SETTINGS), code), w.manager)
