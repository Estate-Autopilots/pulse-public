"""MAILBOX: each company on the platform connects its own Google Workspace mailbox. Admins only, one company's mailbox is
invisible to another, the refresh token is stored sealed, a company without a mailbox keeps its mail waiting (never
'disabled') and sends it from its own address once connected, and its disabled history is never re-sent. Synthetic
companies, a synthetic keyring and a fake Google: nothing leaves the machine."""
import base64
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import parse_qs

import psycopg
import pytest
from conftest import dsn
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_account_security import command, hashof

KEY = base64.b64encode(bytes(range(32))).decode()
REFRESH = 'synthetic-refresh-token-never-stored-plain'


def seal(plain: bytes, org) -> tuple[str, bytes, bytes]:
    """The TypeScript document-keys.ts v1 envelope (the API seals; the test stands in for it)."""
    context, kid, data_key = f'{org}/mailbox/google', 'mbx1', os.urandom(32)

    def enc(key, value, aad):
        iv = os.urandom(12)
        return bytes([1]) + iv + AESGCM(key).encrypt(iv, value, aad.encode())
    return kid, enc(bytes(range(32)), data_key, f'pulse.data-key.v1\n{kid}\n{context}'), enc(data_key, plain, f'pulse.sealed.v1\n{context}')


@pytest.fixture
def hosted(worker, owner, api, tmp_path):
    """A second company on the platform (the first world is the install's own company), with a password admin."""
    build_world(worker, owner, api)
    w = build_world(worker, owner, api)
    with worker.transaction():
        assert worker.execute('select pulse.install_org() o').fetchone()['o'] != w.org
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, w.manager))
        for person, username, email in [(w.manager, f'mbx.admin.{w.org.hex[:6]}', f'admin@{w.domain}'), (w.editor, f'mbx.person.{w.org.hex[:6]}', f'person@{w.domain}')]:
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,email,evidence) values(%s,%s,'Editor',%s,%s,'{}')", (w.org, person, username, email))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        for person in (w.manager, w.editor):
            api.execute("select pulse.login_issue(%s,'Synthetic-account-2026!')", (person,))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute('update pulse.login_credential set must_change=false where person_id = any(%s)', ([w.manager, w.editor],))
    keyring = tmp_path / 'document.key'
    keyring.write_text(f'mbx1 {KEY}\n')
    keyring.chmod(0o640)
    w.keyring = keyring
    return w


def state(api, w, viewer=None):
    return command(api, w, 'pulse.org_mailbox_state()', viewer=viewer or w.manager)


def connect(api, w, address='HR@Mailco.example.test'):
    kid, wrapped, sealed = seal(REFRESH.encode(), w.org)
    return command(api, w, 'pulse.org_mailbox_save(%s,%s,%s,%s,%s)', (address, 'platform', kid, wrapped, sealed), w.manager)


def test_mailbox_admin_only_sealed_and_per_company(api, owner, hosted):
    w = hosted
    s = state(api, w)
    assert s['connected'] is False and s['install'] is False and s['waiting'] == 0 and s['blocked'] == 0
    # Only an individual admin: a member is refused every function, before anything is read or written.
    for sql, args in [('pulse.org_mailbox_state()', ()), ('pulse.org_mailbox_begin(%s,%s,%s)', (hashof('s'), hashof('x'), 'v' * 64)),
                      ('pulse.org_mailbox_disconnect()', ()), ('pulse.org_mailbox_save(%s,%s,%s,%s,%s)', ('a@b.test', 'platform', 'k', b'x', b'y'))]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            command(api, w, sql, args, w.editor)
    # The Google sign-in attempt: the same admin and session only, used once.
    command(api, w, 'pulse.org_mailbox_begin(%s,%s,%s)', (hashof('state-1'), hashof('session-1'), 'v' * 64), w.manager)
    assert command(api, w, 'pulse.org_mailbox_take(%s,%s)', (hashof('state-1'), hashof('other-session')), w.manager) is None
    command(api, w, 'pulse.org_mailbox_begin(%s,%s,%s)', (hashof('state-2'), hashof('session-1'), 'w' * 64), w.manager)
    assert command(api, w, 'pulse.org_mailbox_take(%s,%s)', (hashof('state-2'), hashof('session-1')), w.manager) == 'w' * 64
    assert command(api, w, 'pulse.org_mailbox_take(%s,%s)', (hashof('state-2'), hashof('session-1')), w.manager) is None
    s = connect(api, w)
    assert s['connected'] is True and s['address'] == 'hr@mailco.example.test' and s['client'] == 'platform'
    with owner.transaction():
        set_tenant(owner, w.org)
        row = owner.execute('select * from pulse_priv.org_mailbox where org_id=%s', (w.org,)).fetchone()
        assert REFRESH.encode() not in bytes(row['token_sealed']) and REFRESH.encode() not in bytes(row['token_wrapped'])
        assert owner.execute("select count(*) n from pulse.audit_event where resource='org_mailbox' and action='mailbox.connect'").fetchone()['n'] == 1
    # The API role cannot read the table directly; another company sees no mailbox of its own.
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute('select * from pulse_priv.org_mailbox')
    with api.transaction():
        set_tenant(api, w.org)
        assert api.execute('select pulse.org_mailbox_ready() ok').fetchone()['ok'] is True
    s = command(api, w, 'pulse.org_mailbox_disconnect()', viewer=w.manager)
    assert s['connected'] is False
    with api.transaction():
        set_tenant(api, w.org)
        assert api.execute('select pulse.org_mailbox_ready() ok').fetchone()['ok'] is False


def test_other_company_cannot_see_or_use_a_mailbox(api, worker, owner, hosted):
    w = hosted
    connect(api, w)
    other = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, other.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (other.org, other.manager))
    assert command(api, other, 'pulse.org_mailbox_state()', viewer=other.manager)['connected'] is False
    with api.transaction():
        set_tenant(api, other.org)
        assert api.execute('select * from pulse.org_mailbox_sealed()').fetchall() == []
    with worker.transaction():
        set_tenant(worker, other.org)
        assert worker.execute('select * from pulse.org_mailbox_sealed()').fetchall() == []


def emit(owner, w, key, person):
    with owner.transaction():
        set_tenant(owner, w.org)
        nid = owner.execute("select pulse.notification_emit(%s,'approval.digest','person',%s,%s,'1 request waits for your decision','/me/approvals','approval',true) n",
                            (person, person, key)).fetchone()['n']
        assert nid
        return nid


def outbox(owner, w, nid):
    with owner.transaction():
        set_tenant(owner, w.org)
        return owner.execute('select status from pulse.hr_mail_outbox where notification_id=%s', (nid,)).fetchone()['status']


class FakeGoogle:
    def __init__(self):
        self.calls, self.grant = [], True

    def __call__(self, url, body, headers):
        self.calls.append((url, body, headers))
        if url.endswith('/token'):
            form = parse_qs(body.decode())
            assert form['refresh_token'] == [REFRESH] and form['client_id'] == ['synthetic-mail-client']
            return (200, {'access_token': 'synthetic-access', 'expires_in': 3600}) if self.grant else (400, {'error': 'invalid_grant'})
        assert headers['authorization'] == 'Bearer synthetic-access'
        return 200, {'id': 'synthetic-message'}

    def sent(self):
        out = []
        for url, body, _ in self.calls:
            if url.endswith('/send'):
                raw = json.loads(body)['raw']
                out.append(base64.urlsafe_b64decode(raw + '=' * (-len(raw) % 4)).decode())
        return out


def test_hosted_mail_waits_then_goes_out_from_its_own_mailbox(api, worker, owner, hosted, monkeypatch):
    from pulse_workers import notifications
    w = hosted
    for k in ('PULSE_NOTIFICATION_MODE', 'PULSE_AUTH_MAIL_MODE', 'PULSE_MAIL_GOOGLE_CLIENT_SECRET_FILE'):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv('PULSE_CI', '0')
    monkeypatch.setenv('PULSE_GMAIL_SEND_ENABLED', '0')        # the install's switch does not govern a company mailbox
    monkeypatch.setenv('PULSE_PUBLIC_URL', 'https://pulse-staging.example.test')
    monkeypatch.setenv('PULSE_MAIL_STAGING_ALLOW', f'person@{w.domain},admin@{w.domain}')
    monkeypatch.setenv('PULSE_MAIL_GOOGLE_CLIENT_ID', 'synthetic-mail-client')
    monkeypatch.setenv('PULSE_MAIL_GOOGLE_CLIENT_SECRET', 'synthetic-mail-secret')
    monkeypatch.setenv('PULSE_DOCUMENT_KEY_FILE', str(w.keyring))
    google = FakeGoogle()
    monkeypatch.setattr(notifications, '_google_post', google)
    notifications._mail_tokens.clear()
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.org_domain(org_id,host,sign_in,added_by) values(%s,%s,'password','synthetic')", (w.org, f'mailco-{w.org.hex[:8]}.example.test'))

    # Before: no mailbox. The mail waits; nothing is disabled and nothing reaches Google.
    history = emit(owner, w, 'history', w.editor2)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.hr_mail_outbox set status='disabled' where notification_id=%s", (history,))
    waiting = emit(owner, w, 'waiting', w.editor)
    assert notifications.drain_mail(worker, w.org).get('waiting') == 1
    assert outbox(owner, w, waiting) == 'waiting_mailbox' and outbox(owner, w, history) == 'disabled'
    assert google.calls == []
    assert state(api, w)['waiting'] == 1

    # Connected: what waited goes out from the company's own address, linking to the company's own Pulse address.
    connect(api, w)
    assert outbox(owner, w, waiting) == 'queued'
    result = notifications.drain_mail(worker, w.org)
    assert result['sent'] == 1, result
    assert outbox(owner, w, waiting) == 'sent' and outbox(owner, w, history) == 'disabled'
    [message] = google.sent()
    assert 'hr@mailco.example.test' in message and f'person@{w.domain}' in message
    assert f'https://mailco-{w.org.hex[:8]}.example.test/notifications?event=' in message.replace('=\r\n', '')
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select count(*) n from pulse.notification_delivery where notification_id=%s", (history,)).fetchone()['n'] == 0
    s = state(api, w)
    assert s['lastSentAt'] and s['lastError'] is None and s['waiting'] == 0

    # Google withdrew access: the mail waits again and the admin reads why in Settings -> Mail.
    google.grant = False
    notifications._mail_tokens.clear()
    later = emit(owner, w, 'later', w.manager)
    assert notifications.drain_mail(worker, w.org).get('waiting') == 1
    assert outbox(owner, w, later) == 'waiting_mailbox'
    assert 'connect it again' in state(api, w)['lastError']
    assert len(google.sent()) == 1


def test_routes_over_http(api, owner, hosted, tmp_path):
    w = hosted
    host = f'mailco-{w.org.hex[:8]}.example.test'
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.org_domain(org_id,host,sign_in,added_by) values(%s,%s,'password','synthetic')", (w.org, host))
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_ORG_ID': str(w.org), 'TEST_ADMIN': str(w.manager), 'TEST_PERSON': str(w.editor),
           'TEST_ADMIN_USER': f'mbx.admin.{w.org.hex[:6]}', 'TEST_PERSON_USER': f'mbx.person.{w.org.hex[:6]}', 'TEST_HOST': host,
           'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '1', 'PULSE_AUTH_MAIL_MODE': 'sink', 'PULSE_DOCUMENT_KEY_FILE': str(w.keyring),
           'PULSE_MAILBOX_REPORT': str(tmp_path / 'mailbox.json')}
    for k in ('PULSE_MAIL_GOOGLE_CLIENT_ID', 'PULSE_MAIL_GOOGLE_CLIENT_SECRET', 'PULSE_MAIL_GOOGLE_CLIENT_SECRET_FILE', 'PULSE_CONNECTOR_SECRETS_DIR'):
        env.pop(k, None)
    root = Path(__file__).resolve().parents[2]
    proc = subprocess.run(['node', 'test/mailbox-runner.mjs'], cwd=root / 'services/api', env=env, capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, (proc.stderr + proc.stdout)[-6000:]
    assert json.loads((tmp_path / 'mailbox.json').read_text())['checks'] >= 20
    with owner.transaction():
        set_tenant(owner, w.org)
        row = owner.execute('select address,client from pulse_priv.org_mailbox where org_id=%s', (w.org,)).fetchone()
        assert row is None  # the runner ends by disconnecting
