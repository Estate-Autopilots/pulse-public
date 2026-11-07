"""ONBOARD: an invitation to a company Google address is accepted with Continue with Google (no Pulse password)."""
import json
import os
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_account_security import auth_world as auth_world, command, hashof
from test_google_sign_in import SETTINGS, google_world as google_world

TARA = 'tara.kapoor@example.test'
PROOF = dict(iss='https://accounts.google.com', sub='synthetic-tara', email=TARA, email_verified=True, hd='example.test')


@pytest.fixture
def invite_world(owner, google_world):
    """Tara (editor2) has never signed in: a work address on the allowed domain and no Pulse password yet."""
    w = google_world
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute('update pulse.people_profile set email=%s where person_id=%s', (TARA, w.editor2))
        owner.execute('delete from pulse.login_credential where person_id=%s', (w.editor2,))
    return w


def invite(api, w, person, name):
    """HR's per-person invitation (Account access → Send invitation): an auth_link of kind 'invite'."""
    return command(api, w, "pulse.auth_admin('staff',%s,'invite',%s)", (person, json.dumps({'hash': hashof(name)})), w.manager)


def peek(api, w, name, ticket):
    return command(api, w, 'pulse.google_invite_peek(%s,%s)', (hashof(name), hashof(ticket)))


def accept(api, w, ticket, **claims):
    return command(api, w, 'pulse.google_invite_accept(%s,%s,%s,%s,%s)', (hashof(ticket), json.dumps({**PROOF, **claims}), hashof('challenge-' + ticket), hashof('session-' + ticket), 'Test browser'))


def test_google_invitation_links_and_signs_in_without_a_password(api, owner, invite_world):
    w = invite_world
    invite(api, w, w.editor2, 'tara-invite')
    assert peek(api, w, 'unknown-token', 't0') is None
    assert peek(api, w, 'tara-invite', 't1') == {'google': True, 'email': TARA}
    assert command(api, w, 'pulse.google_invite_hint(%s)', (hashof('t1'),)) == TARA
    # Another Google account of the same company is refused, and the ticket is spent either way.
    assert accept(api, w, 't1', email='someone@example.test', sub='synthetic-other')['error'] == 'invite_email_mismatch'
    assert accept(api, w, 't1')['error'] == 'state_invalid'
    for claim, value, error in [('hd', 'other.test', 'domain_not_allowed'), ('email_verified', False, 'provider_error'), ('iss', 'https://evil.example', 'provider_error')]:
        assert peek(api, w, 'tara-invite', 'bad-' + claim)['google'] is True
        assert accept(api, w, 'bad-' + claim, **{claim: value})['error'] == error
    # A newer ticket replaces an older one for the same invitation.
    peek(api, w, 'tara-invite', 'old')
    assert peek(api, w, 'tara-invite', 't2')['google'] is True
    assert accept(api, w, 'old')['error'] == 'state_invalid'
    signed = accept(api, w, 't2', email=TARA.upper())
    assert signed['actor'] == str(w.editor2) and signed['mustChange'] is False and 'expiresAt' in signed
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute('select email,domain from pulse_priv.google_identity where person_id=%s', (w.editor2,)).fetchone() == {'email': TARA, 'domain': 'example.test'}
        assert owner.execute("select status,must_change from pulse.login_credential where person_id=%s", (w.editor2,)).fetchone() == {'status': 'active', 'must_change': False}
        assert owner.execute("select count(*) n from pulse.login_session where person_id=%s and via='google' and revoked_at is null", (w.editor2,)).fetchone()['n'] == 1
        assert owner.execute("select count(*) n from pulse_priv.auth_link where actor=%s and kind='invite' and used_at is null", (w.editor2,)).fetchone()['n'] == 0
        assert owner.execute("select count(*) n from pulse_priv.auth_event where actor=%s and action='google_linked'", (w.editor2,)).fetchone()['n'] == 1
        assert owner.execute('select count(*) n from pulse_priv.google_invite_ticket where person_id=%s', (w.editor2,)).fetchone()['n'] == 0
    # The link is used up; from now on Continue with Google signs Tara in like anyone linked.
    assert peek(api, w, 'tara-invite', 't3') is None
    assert command(api, w, 'pulse.google_identity_resolve(%s,%s)', (PROOF['iss'], PROOF['sub']))['personId'] == str(w.editor2)


def test_batch_invitation_personal_address_and_closed_cases(api, owner, invite_world):
    w = invite_world
    # The Onboard team batch (staff_invitation) works the same way.
    batch = command(api, w, 'pulse.invitation_prepare()', viewer=w.manager)
    command(api, w, 'pulse.invitation_link(%s,%s,%s)', (w.editor2, batch, hashof('tara-batch')), w.manager)
    assert peek(api, w, 'tara-batch', 'b1') == {'google': True, 'email': TARA}
    # A personal address keeps the password path only.
    invite(api, w, w.editor, 'personal-invite')
    assert peek(api, w, 'personal-invite', 'p1') == {'google': False}
    # A Google account already linked to someone else is refused; nothing is linked.
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute('insert into pulse_priv.google_identity(org_id,person_id,issuer,subject,email,domain) values(%s,%s,%s,%s,%s,%s)', (w.org, w.manager, PROOF['iss'], 'synthetic-admin', 'admin@example.test', 'example.test'))
    assert accept(api, w, 'b1', sub='synthetic-admin')['error'] == 'already_linked'
    # Google switched off, or the domain removed: no Google offer and no acceptance.
    command(api, w, 'pulse.google_settings(%s)', (json.dumps({**SETTINGS, 'allowedDomains': ['other.test']}),), w.manager)
    assert peek(api, w, 'tara-batch', 'b2') == {'google': False}
    command(api, w, 'pulse.google_settings(%s)', (json.dumps(SETTINGS),), w.manager)
    assert peek(api, w, 'tara-batch', 'b3')['google'] is True
    command(api, w, 'pulse.google_settings(%s)', (json.dumps({**SETTINGS, 'enabled': False}),), w.manager)
    assert accept(api, w, 'b3')['error'] == 'provider_error'
    command(api, w, 'pulse.google_settings(%s)', (json.dumps(SETTINGS),), w.manager)
    # Disabled sign-in closes the invitation.
    assert peek(api, w, 'tara-batch', 'b4')['google'] is True
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.login_credential(org_id,person_id,password_hash,must_change,status) values(%s,%s,'x',false,'disabled')", (w.org, w.editor2))
    assert accept(api, w, 'b4')['error'] == 'invite_used'
    assert peek(api, w, 'tara-batch', 'b5') is None
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute('select count(*) n from pulse_priv.google_identity where person_id=%s', (w.editor2,)).fetchone()['n'] == 0


def test_an_issued_temporary_password_stops_working(api, owner, invite_world):
    w = invite_world
    command(api, w, "pulse.login_issue(%s,'Synthetic-issued-2026!')", (w.editor2,), w.manager)
    invite(api, w, w.editor2, 'tara-reissue')
    assert peek(api, w, 'tara-reissue', 'r1')['google'] is True
    assert accept(api, w, 'r1')['actor'] == str(w.editor2)
    login = command(api, w, "pulse.auth_login('staff','auth.noemail','Synthetic-issued-2026!',%s,%s,false,'Browser')", (hashof(str(uuid4())), hashof(str(uuid4()))))
    assert not login or login.get('failed')


def test_public_tables_stay_closed_to_the_api_role(api, invite_world):
    import psycopg
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, invite_world.org, invite_world.manager)
        api.execute('select * from pulse_priv.google_invite_ticket')


# The runner drives invite-peek → google/start (mode=invite) → callback against the synthetic Google issuer.
def test_google_invitation_http(api, invite_world):
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_ORG_ID': str(invite_world.org), 'PULSE_PERSON_ID': str(invite_world.editor2),
           'TEST_PERSONAL_ID': str(invite_world.editor), 'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '1', 'PULSE_AUTH_MAIL_MODE': 'sink'}
    result = subprocess.run(['node', 'test/google-invite-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout[-3000:] + result.stderr[-3000:]
