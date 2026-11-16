"""MAIL-IDENTITY: organisation mail (HR notices) carries the company's own name and logo and comes from the company's own
sender: the install's company from its configured sender, a company with a connected mailbox from that mailbox, and a
company with neither from the platform's address as "<Company> via Pulse" with Reply-To the company, only when Resend is
set up (else it waits, as before). The identity is read in one call (pulse.org_mail_identity, migration 1530). Synthetic
companies and a fake Resend: nothing leaves the machine."""
import base64
import importlib.util
import json
from email.message import EmailMessage
from pathlib import Path

from pulse_sdk.db import set_tenant
from test_company_mailbox import connect, emit, hosted, outbox  # noqa: F401  (hosted is a fixture)

ROOT = Path(__file__).resolve().parents[2]
PNG = base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'\x00' * 32).decode()


def bridge():
    spec = importlib.util.spec_from_file_location('bridge_under_test', ROOT / 'tools' / 'google-bridge.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def identity(conn, org):
    with conn.transaction():
        set_tenant(conn, org)
        return conn.execute('select pulse.org_mail_identity() m').fetchone()['m']


def test_org_mail_identity_names_the_company_its_sender_and_where_answers_go(api, worker, owner, hosted):
    w = hosted
    install = worker.execute('select pulse.install_org() o').fetchone()['o']
    mine = identity(worker, install)
    assert mine['install'] is True and str(mine['org']) == str(install)
    other = identity(worker, w.org)
    assert other['install'] is False and other['mailbox'] is None and other['logoPng'] is None
    assert other['replyTo'] == f'admin@{w.domain}'.lower()          # its admin, while no mailbox is connected
    connect(api, w)
    other = identity(api, w.org)                                      # the API may read it too
    assert other['mailbox'] == 'hr@mailco.example.test' and other['replyTo'] == 'hr@mailco.example.test'


def test_org_mail_route_per_company():
    from pulse_workers import notifications as n
    assert n.org_mail_route(True, None, {'RESEND_API_KEY': 'k'}) == 'install'       # the install keeps its own sender
    assert n.org_mail_route(False, {'address': 'hr@x.test'}, {'RESEND_API_KEY': 'k'}) == 'mailbox'
    assert n.org_mail_route(False, None, {'RESEND_API_KEY': 'k'}) == 'resend'
    assert n.org_mail_route(False, None, {}) == 'wait'
    assert n.platform_sender({}) == ('Pulse by Vitals', 'no-reply@org-9912dc.example')
    assert n.platform_sender({'PULSE_PLATFORM_MAIL_FROM': '"Pulse" <Hello@org-9912dc.example>'}) == ('Pulse', 'hello@org-9912dc.example')
    assert n.platform_sender({'PULSE_PLATFORM_MAIL_FROM': 'not an address', 'RESEND_FROM': 'user-b7ff0ea3@org-9912dc.example'}) == ('Pulse by Vitals', 'user-b7ff0ea3@org-9912dc.example')


def test_resend_request_for_a_company_without_a_mailbox():
    from pulse_workers import notifications as n
    who = {'name': 'Acme <Fake>', 'replyTo': 'Admin@Acme.example.test', 'origin': 'https://acme.example.test'}
    url, headers, payload, _ = n.resend_request(who, 'Person@Acme.example.test', 'Leave approved', '/me/leave', {'name': 'Acme', 'png': PNG},
                                                {'RESEND_API_KEY': 'synthetic-key'})
    assert url == 'https://api.resend.com/emails' and headers['authorization'] == 'Bearer synthetic-key'
    assert payload['from'] == 'Acme Fake via Pulse <no-reply@org-9912dc.example>'
    assert payload['to'] == ['person@acme.example.test'] and payload['reply_to'] == 'admin@acme.example.test'
    assert 'https://acme.example.test/me/leave' in payload['text'] and payload['text'].endswith('Acme Fake HR')
    assert 'cid:org-logo' in payload['html'] and payload['attachments'][0]['content_id'] == 'org-logo'
    assert 'Estate Autopilots' not in json.dumps(payload)


def test_hosted_notice_goes_from_the_platform_address_when_resend_is_set_up(worker, owner, hosted, monkeypatch):
    from pulse_workers import notifications
    w = hosted
    for k in ('PULSE_NOTIFICATION_MODE', 'PULSE_AUTH_MAIL_MODE', 'PULSE_PLATFORM_MAIL_FROM', 'RESEND_FROM'):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv('PULSE_CI', '0')
    monkeypatch.setenv('PULSE_GMAIL_SEND_ENABLED', '1')
    monkeypatch.setenv('RESEND_API_KEY', 'synthetic-key')
    monkeypatch.setenv('PULSE_PUBLIC_URL', 'https://pulse-staging.example.test')
    monkeypatch.setenv('PULSE_MAIL_STAGING_ALLOW', f'person@{w.domain}')
    sent = []

    class Answer:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    def fake_urlopen(request, timeout=0):
        sent.append((request.full_url, dict(request.header_items()), json.loads(request.data)))
        return Answer()
    monkeypatch.setattr(notifications.urllib.request, 'urlopen', fake_urlopen)
    nid = emit(owner, w, 'resend', w.editor)
    result = notifications.drain_mail(worker, w.org)
    assert result['sent'] == 1, result
    assert outbox(owner, w, nid) == 'sent'
    [(url, headers, payload)] = sent
    assert url == 'https://api.resend.com/emails'
    assert payload['from'].endswith('via Pulse <no-reply@org-9912dc.example>') and payload['to'] == [f'person@{w.domain}'.lower()]
    assert payload['reply_to'] == f'admin@{w.domain}'.lower()
    assert '/notifications?event=' in payload['text'] and '<h1' in payload['html']
    assert 'synthetic-key' not in json.dumps(payload)

    # Without Resend the mail waits for the company's mailbox, as before.
    monkeypatch.delenv('RESEND_API_KEY')
    later = emit(owner, w, 'later', w.manager)
    assert notifications.drain_mail(worker, w.org).get('waiting') == 1
    assert outbox(owner, w, later) == 'waiting_mailbox' and len(sent) == 1


def test_bridge_layout_is_gmail_safe_with_a_plain_text_part():
    b = bridge()
    page = b.branded_html('Your leave <approved>', 'Hi Rila,\n\nOpen Pulse: https://acme.example.test/me/leave', 'Acme & Co')
    assert 'Sent by Pulse for' not in page and 'Acme &amp; Co · Sent with Pulse' in page
    assert '<style' not in page and '<link' not in page and '<script' not in page and 'max-width:560px' in page
    assert 'name="viewport"' in page and 'Your leave &lt;approved&gt;' in page and 'cid:org-logo' in page
    assert 'href="https://acme.example.test/me/leave"' in page and '>Open Pulse</a>' in page
    assert 'cid:org-logo' not in b.branded_html('T', 'B', 'Acme', logo=False)
    code = b.branded_html('Your code', 'Your Pulse sign-in code is 482913\n\nIt expires.', 'Pulse', logo=False)
    assert 'letter-spacing:6px' in code and '482913' in code
    msg = EmailMessage()
    msg['Subject'] = 'T'
    msg.set_content('Plain words https://acme.example.test')
    b.add_html(msg, {'title': 'T', 'body': 'x', 'html': '<p>Hello</p>', 'inline': [{'cid': 'pulse-logo', 'png': PNG}]})
    raw = msg.as_string()
    assert 'multipart/alternative' in raw and 'text/plain' in raw and 'text/html' in raw and 'Content-ID: <pulse-logo>' in raw
