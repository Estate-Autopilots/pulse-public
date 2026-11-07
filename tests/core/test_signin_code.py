"""SIGNIN-CODE (owner, 2 Nov 2026): sign in with a 6-digit code e-mailed to the work e-mail on record, no password
(synthetic people only; no mail leaves: the API side runs with the mail sink). Database side: issuing, single use,
expiry, five tries, the per-person ration, no answer for unknown or refused people, the lockout ending, two-step still
asked, audit. The HTTP side (one answer whether or not anyone matched, the e-mail, the session cookie answer):
services/api/test/signin-code-runner.mjs, run from the last test."""
import json
import os
import subprocess
from pathlib import Path

from psycopg.conninfo import conninfo_to_dict
from conftest import dsn
from pulse_sdk.db import set_tenant
from test_account_security import auth_world, command, hashof  # noqa: F401 (auth_world is a fixture)

PW = 'Synthetic-account-2026!'


def issue(api, w, name):
    return command(api, w, "pulse.auth_signin_code_issue('staff',%s)", (name,))


def finish(api, w, name, code, tag, remember=False):
    return command(api, w, "pulse.auth_signin_code_finish('staff',%s,%s,%s,%s,%s,'Browser')",
                   (name, code, hashof(tag + '-challenge' + str(w.org)), hashof(tag + '-session' + str(w.org)), remember))


def rewind(owner, w, actor, **fields):
    """Moves this person's code row back in time (minutes), as if that long had passed."""
    with owner.transaction():
        set_tenant(owner, w.org)
        for column, minutes in fields.items():
            owner.execute(f"update pulse_priv.auth_signin_code set {column}={column}-make_interval(mins=>%s) where org_id=%s and actor=%s",
                          (minutes, w.org, actor))


def other(code):
    return '000000' if code != '000000' else '111111'


def events(owner, w, actor=None):
    with owner.transaction():
        set_tenant(owner, w.org)
        rows = owner.execute("select action from pulse_priv.auth_event where org_id=%s and (actor=%s or %s::uuid is null and actor is null) "
                             "and action like 'signin_code%%' order by at", (w.org, actor, actor)).fetchall()
    return [r['action'] for r in rows]


def test_code_signs_in_once_ends_the_lockout_and_is_audited(api, owner, auth_world):
    w = auth_world
    for n in range(5):
        assert command(api, w, "pulse.auth_login('staff','auth.person','wrong',%s,%s,false,'Browser')", (hashof('bad' + str(n)), hashof('b' + str(n))))['failed']
    assert command(api, w, "pulse.auth_login('staff','auth.person',%s,%s,%s,false,'Browser')", (PW, hashof('locked'), hashof('locked-s')))['failed']
    sent = issue(api, w, 'Auth.Person ')
    assert len(sent['code']) == 6 and sent['code'].isdigit()
    assert sent['delivery'] == 'personal@gmail.example' and sent['username'] == 'auth.person' and sent['actor'] == str(w.editor)
    with owner.transaction():
        set_tenant(owner, w.org)
        row = owner.execute("select code_hash from pulse_priv.auth_signin_code where actor=%s", (w.editor,)).fetchone()
        assert len(row['code_hash']) == 64 and sent['code'] not in row['code_hash']  # stored hashed, never the code
    assert finish(api, w, 'auth.person', other(sent['code']), 'wrong') is None
    done = finish(api, w, 'auth.person', sent['code'][:3] + ' ' + sent['code'][3:], 'ok')
    assert done['maxAge'] == 43200 and done['actor'] == str(w.editor) and done['delivery'] == 'personal@gmail.example'
    assert finish(api, w, 'auth.person', sent['code'], 'again') is None  # single use
    with owner.transaction():
        set_tenant(owner, w.org)
        cred = owner.execute("select failed_attempts,locked_until from pulse.login_credential where person_id=%s", (w.editor,)).fetchone()
        assert cred['failed_attempts'] == 0 and cred['locked_until'] is None
        assert owner.execute("select 1 from pulse.login_session where token_hash=%s", (hashof('ok-session' + str(w.org)),)).fetchone()
        audit = [r['action'] for r in owner.execute("select action from pulse.audit_event where org_id=%s and resource_id=%s", (w.org, str(w.editor))).fetchall()]
        assert {'signin_code_sent', 'signin_code_failed', 'signin_code_used', 'sign_in'} <= set(audit)
    # The lockout is over: the password works again.
    assert command(api, w, "pulse.auth_login('staff','auth.person',%s,%s,%s,false,'Browser')", (PW, hashof('after'), hashof('after-s')))['maxAge'] == 43200


def test_work_email_and_handle_find_the_person_and_keep_me_signed_in(api, owner, auth_world):
    w = auth_world
    sent = issue(api, w, 'Personal@Gmail.Example')
    assert sent and sent['actor'] == str(w.editor)
    assert finish(api, w, '@auth.person', sent['code'], 'remember', remember=True)['maxAge'] == 2592000


def test_codes_expire_after_ten_minutes(api, owner, auth_world):
    w = auth_world
    sent = issue(api, w, 'auth.person')
    with owner.transaction():
        set_tenant(owner, w.org)
        left = owner.execute("select expires_at-now() d from pulse_priv.auth_signin_code where actor=%s", (w.editor,)).fetchone()['d']
        assert 9 * 60 < left.total_seconds() <= 10 * 60
    rewind(owner, w, w.editor, expires_at=11)
    assert finish(api, w, 'auth.person', sent['code'], 'late') is None


def test_five_wrong_tries_kill_the_code(api, owner, auth_world):
    w = auth_world
    sent = issue(api, w, 'auth.person')
    for n in range(5):
        assert finish(api, w, 'auth.person', other(sent['code']), 'guess' + str(n)) is None
    assert finish(api, w, 'auth.person', sent['code'], 'right-too-late') is None


def test_sending_is_rationed_one_a_minute_five_an_hour_and_only_the_newest_works(api, owner, auth_world):
    w = auth_world
    first = issue(api, w, 'auth.person')
    assert first and issue(api, w, 'auth.person') is None  # within the minute
    codes = [first['code']]
    for _ in range(4):
        rewind(owner, w, w.editor, last_sent=2)
        codes.append(issue(api, w, 'auth.person')['code'])
    rewind(owner, w, w.editor, last_sent=2)
    assert issue(api, w, 'auth.person') is None  # a sixth within the hour
    assert 'signin_code_limited' in events(owner, w, w.editor)
    if codes[0] != codes[-1]:
        assert finish(api, w, 'auth.person', codes[0], 'old') is None
    assert finish(api, w, 'auth.person', codes[-1], 'newest')['maxAge'] == 43200
    rewind(owner, w, w.editor, last_sent=61, hour_start=61)
    assert issue(api, w, 'auth.person')


def test_nobody_unknown_or_refused_gets_a_code(api, owner, worker, auth_world):
    w = auth_world
    assert issue(api, w, 'nobody.here') is None
    assert issue(api, w, 'nobody@example.test') is None
    assert issue(api, w, '') is None
    assert issue(api, w, 'auth.noemail') is None  # no e-mail on record: nowhere to send it
    assert finish(api, w, 'nobody.here', '123456', 'nobody') is None
    assert 'signin_code_requested' in events(owner, w)
    # Disabled sign-in, then offboarded: refused, and an outstanding code stops working too.
    sent = issue(api, w, 'auth.admin')
    assert sent['delivery'] == 'admin@example.test'
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.login_credential set status='disabled' where person_id=%s", (w.manager,))
    assert finish(api, w, 'auth.admin', sent['code'], 'disabled') is None
    rewind(owner, w, w.manager, last_sent=2)
    assert issue(api, w, 'auth.admin') is None
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.login_credential set status='active' where person_id=%s", (w.manager,))
        owner.execute("update pulse.person set status='offboarded' where id=%s", (w.manager,))
    assert issue(api, w, 'auth.admin') is None
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.person set status='active' where id=%s", (w.manager,))
    # The table is private: the API role reaches it only through the functions, and cannot pick a person's code itself.
    with owner.transaction():
        privileges = owner.execute("select has_table_privilege('pulse_api','pulse_priv.auth_signin_code','select') t, "
                                   "has_function_privilege('pulse_api','pulse.auth_signin_code_actor(text,text)','execute') f").fetchone()
    assert not privileges['t'] and not privileges['f']


def test_an_authenticator_or_passkey_is_still_asked_and_email_codes_are_covered(api, owner, auth_world):
    w = auth_world
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse_priv.auth_passkey(org_id,realm,actor,credential_id,public_key) values(%s,'staff',%s,%s,'\\x00')",
                      (w.org, w.editor, 'cred-' + str(w.org)))
    sent = issue(api, w, 'auth.person')
    assert finish(api, w, 'auth.person', sent['code'], 'pk') == {'twoStep': True}
    assert command(api, w, "pulse.auth_challenge_methods('staff',%s)", (hashof('pk-challenge' + str(w.org)),))['passkey']
    with owner.transaction():
        set_tenant(owner, w.org)
        assert not owner.execute("select 1 from pulse.login_session where token_hash=%s", (hashof('pk-session' + str(w.org)),)).fetchone()
        owner.execute("delete from pulse_priv.auth_passkey where actor=%s", (w.editor,))
        owner.execute("insert into pulse_priv.auth_account(org_id,realm,actor,email_factor) values(%s,'staff',%s,true) "
                      "on conflict(org_id,realm,actor) do update set email_factor=true", (w.org, w.editor))
    rewind(owner, w, w.editor, last_sent=2)
    sent = issue(api, w, 'auth.person')
    assert finish(api, w, 'auth.person', sent['code'], 'em')['maxAge'] == 43200
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select second_factor_verified s from pulse.login_session where token_hash=%s", (hashof('em-session' + str(w.org)),)).fetchone()['s']


def test_http_answers_the_same_for_anyone_and_e_mails_the_code(api, worker, owner, auth_world, tmp_path):
    w = auth_world
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_ORG_ID': str(w.org), 'TEST_PERSON': str(w.editor),
           'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '1', 'PULSE_AUTH_MAIL_MODE': 'sink', 'PULSE_AUTH_REPORT': str(tmp_path / 'code.json')}
    root = Path(__file__).resolve().parents[2]
    proc = subprocess.run(['node', 'test/signin-code-runner.mjs'], cwd=root / 'services/api', env=env, capture_output=True, text=True, timeout=240)
    assert proc.returncode == 0, proc.stderr[-8000:]
    assert json.loads((tmp_path / 'code.json').read_text())['apiChecks'] >= 12
