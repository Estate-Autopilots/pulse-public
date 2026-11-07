"""ACCOUNT-CODE (owner, 2 Nov 2026: Pulse as a SaaS): personal Pulse accounts sign in with a 6-digit code e-mailed to the
account's address, and sign up without a password (synthetic people only; no mail leaves: the API side runs with the
mail sink). Database side: issuing, single use, expiry, five tries, the per-account ration, nothing for unknown,
staff-first or refused logins, the lockout ending, two-step refusing, never a seat the account does not hold, audit;
passwordless sign-up with its confirmation code (personal workspace or a company), and the company switch. The HTTP side
(one answer whether or not anything matched, the e-mails, the account session cookie answer, sign-up to account home,
the shared address against a company's own): services/api/test/account-code-runner.mjs, run from the last test."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict
from conftest import dsn
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_account_security import command, hashof


def owner_do(owner, sql, args=(), org=None):
    with owner.transaction():
        if org:
            set_tenant(owner, org)
        cur = owner.execute(sql, args)
        return cur.fetchall() if cur.description else None


def make_account(owner, org, person, kind='staff', email=True, password=None):
    handle = 'p' + uuid.uuid4().hex[:10]
    account = uuid.uuid4()
    owner_do(owner, "insert into pulse_priv.pulse_account(id,handle,display_name,email,password_hash) values(%s,%s,'Synthetic Person',%s,"
                    "case when %s::text is null then null else crypt(%s, gen_salt('bf',4)) end)",
             (account, handle, f'{handle}@gmail.example' if email else None, password, password))
    owner_do(owner, "insert into pulse_priv.handle_name(handle,kind,ref) values(%s,'person',%s)", (handle, account))
    if org:
        owner_do(owner, "insert into pulse_priv.account_member(account_id,member_org,person_id,kind) values(%s,%s,%s,%s)", (account, org, person, kind))
    return handle, account


@pytest.fixture
def world(worker, owner, api):
    """a: the install's own organisation (the shared address); b: a company where a personal account holds a seat
    with no company password (as one who joined or signed up); a staff person of a with a login, for staff-first."""
    a = build_world(worker, owner, api)
    b = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, a.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01') on conflict do nothing", (a.org, a.manager))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,email,evidence) values(%s,%s,'Editor','staff.person','staff@example.test','{}')", (a.org, a.editor))
    with api.transaction():
        set_tenant(api, a.org, a.manager)
        api.execute("select pulse.login_issue(%s,'Synthetic-account-2026!')", (a.editor,))
    with worker.transaction():
        set_tenant(worker, b.org)
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,evidence) values(%s,%s,'Editor','seat.person','{}')", (b.org, b.editor2))
    handle, account = make_account(owner, b.org, b.editor2)
    return a, b, handle, account


def issue(api, a, login):
    return command(api, a, 'pulse.account_code_issue(%s)', (login,))


def finish(api, a, login, code, tag, own=None):
    return command(api, a, "pulse.account_code_finish(%s,%s,%s,'Browser',%s)", (login, code, hashof('acode' + tag), own))


def rewind(owner, account, **fields):
    for column, minutes in fields.items():
        owner_do(owner, f"update pulse_priv.account_signin_code set {column}={column}-make_interval(mins=>%s) where account_id=%s", (minutes, account))


def other(code):
    return '000000' if code != '000000' else '111111'


def events(owner, account=None):
    return [r['action'] for r in owner_do(owner, "select action from pulse_priv.account_auth_event where account_id is not distinct from %s order by at, id", (account,))]


def sessions(owner, org, token_hash):
    return owner_do(owner, "select person_id, via from pulse.login_session where org_id=%s and token_hash=%s and revoked_at is null", (org, token_hash), org)


def test_code_signs_in_to_the_account_once_ends_the_lockout_confirms_and_is_audited(api, owner, world):
    a, b, handle, account = world
    owner_do(owner, "update pulse_priv.pulse_account set failed=4, locked_until=now()+interval '10 minutes' where id=%s", (account,))
    sent = issue(api, a, '@' + handle.upper())
    assert len(sent['code']) == 6 and sent['code'].isdigit()
    assert sent['delivery'] == f'{handle}@gmail.example' and sent['handle'] == handle and sent['account'] == str(account)
    row = owner_do(owner, "select code_hash from pulse_priv.account_signin_code where account_id=%s", (account,))[0]
    assert len(row['code_hash']) == 64 and sent['code'] not in row['code_hash']  # stored hashed, never the code
    assert finish(api, a, handle, other(sent['code']), 'wrong') is None
    done = finish(api, a, f'{handle}@gmail.example', sent['code'][:3] + ' ' + sent['code'][3:], 'ok')
    assert done['org'] == str(b.org) and done['person'] == str(b.editor2) and done['kind'] == 'staff'
    assert sessions(owner, b.org, hashof('acodeok')) == [{'person_id': b.editor2, 'via': 'account'}]
    assert finish(api, a, handle, sent['code'], 'again') is None  # single use
    acc = owner_do(owner, "select failed, locked_until, email_confirmed_at, last_org from pulse_priv.pulse_account where id=%s", (account,))[0]
    assert acc['failed'] == 0 and acc['locked_until'] is None and acc['email_confirmed_at'] is not None and acc['last_org'] == b.org
    assert {'account_code_sent', 'account_code_failed', 'account_code_used'} <= set(events(owner, account))
    audit = owner_do(owner, "select action from pulse.audit_event where org_id=%s and resource_id=%s", (b.org, str(b.editor2)), b.org)
    assert 'account_code_sign_in' in [r['action'] for r in audit]


def test_codes_expire_after_ten_minutes(api, owner, world):
    a, b, handle, account = world
    sent = issue(api, a, handle)
    left = owner_do(owner, "select expires_at-now() d from pulse_priv.account_signin_code where account_id=%s", (account,))[0]['d']
    assert 9 * 60 < left.total_seconds() <= 10 * 60
    rewind(owner, account, expires_at=11)
    assert finish(api, a, handle, sent['code'], 'late') is None


def test_five_wrong_tries_kill_the_code(api, owner, world):
    a, b, handle, account = world
    sent = issue(api, a, handle)
    for n in range(5):
        assert finish(api, a, handle, other(sent['code']), 'guess' + str(n)) is None
    assert finish(api, a, handle, sent['code'], 'right-too-late') is None


def test_sending_is_rationed_one_a_minute_five_an_hour_and_only_the_newest_works(api, owner, world):
    a, b, handle, account = world
    first = issue(api, a, handle)
    assert first and issue(api, a, handle) is None  # within the minute
    codes = [first['code']]
    for _ in range(4):
        rewind(owner, account, last_sent=2)
        codes.append(issue(api, a, handle)['code'])
    rewind(owner, account, last_sent=2)
    assert issue(api, a, handle) is None  # a sixth within the hour
    assert 'account_code_limited' in events(owner, account)
    if codes[0] != codes[-1]:
        assert finish(api, a, handle, codes[0], 'old') is None
    assert finish(api, a, handle, codes[-1], 'newest')['org'] == str(b.org)
    rewind(owner, account, last_sent=61, hour_start=61)
    assert issue(api, a, handle)


def test_nobody_unknown_staff_first_or_refused_gets_an_account_code(api, owner, worker, world):
    a, b, handle, account = world
    assert issue(api, a, 'nobody.here') is None
    assert issue(api, a, 'nobody@example.test') is None
    assert issue(api, a, '') is None
    assert finish(api, a, 'nobody.here', '123456', 'nobody') is None
    assert 'account_code_requested' in events(owner)
    # A staff person of the organisation this address belongs to: their own code (1449) comes first, even when an
    # account has that same e-mail.
    _, staff_like = make_account(owner, b.org, b.lead)
    owner_do(owner, "update pulse_priv.pulse_account set email='staff@example.test' where id=%s", (staff_like,))
    assert issue(api, a, 'staff@example.test') is None and issue(api, a, 'staff.person') is None
    # No address on the account: nowhere to send it.
    nomail, _ = make_account(owner, b.org, b.manager, email=False)
    assert issue(api, a, nomail) is None
    # A seat that signs in with a company password keeps that company's own sign-in (and its rules).
    with worker.transaction():
        set_tenant(worker, b.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01') on conflict do nothing", (b.org, b.manager))
    with api.transaction():
        set_tenant(api, b.org, b.manager)
        api.execute("select pulse.login_issue(%s,'Synthetic-colleague-2026!')", (b.editor2,))
    assert issue(api, a, handle) is None
    assert 'account_code_refused' in events(owner, account)
    # An outstanding code stops working once the seat has a company password.
    owner_do(owner, "delete from pulse.login_credential where person_id=%s", (b.editor2,), b.org)
    sent = issue(api, a, handle)
    with api.transaction():
        set_tenant(api, b.org, b.manager)
        api.execute("select pulse.login_issue(%s,'Synthetic-colleague-2026!')", (b.editor2,))
    assert finish(api, a, handle, sent['code'], 'credentialed') is None
    # The tables are private: the API role reaches them only through the functions.
    privileges = owner_do(owner, "select has_table_privilege('pulse_api','pulse_priv.account_signin_code','select') t, "
                                 "has_table_privilege('pulse_api','pulse_priv.account_signup_code','select') u, "
                                 "has_function_privilege('pulse_api','pulse.acct_code_target(text)','execute') f")[0]
    assert not privileges['t'] and not privileges['u'] and not privileges['f']


def test_a_code_never_opens_a_seat_the_account_does_not_hold(api, owner, worker, world):
    a, b, handle, account = world
    c = build_world(worker, owner, api)
    # The account was last in c and this is c's own address: it still lands only where it has a seat (b), as b's person.
    owner_do(owner, "update pulse_priv.pulse_account set last_org=%s where id=%s", (c.org, account))
    sent = issue(api, a, handle)
    done = finish(api, a, handle, sent['code'], 'seat', own=str(c.org))
    assert done['org'] == str(b.org) and done['person'] == str(b.editor2)
    for org in (a.org, c.org):
        assert sessions(owner, org, hashof('acodeseat')) == []
    # Its only seat inactive: no session anywhere.
    owner_do(owner, "update pulse.person set status='offboarded' where id=%s", (b.editor2,), b.org)
    rewind(owner, account, last_sent=2)
    sent = issue(api, a, handle)
    assert finish(api, a, handle, sent['code'], 'none') == {'failed': True, 'noOrg': True}
    for org in (a.org, b.org, c.org):
        assert sessions(owner, org, hashof('acodenone')) == []
    # Another account's code never opens this one (codes are bound to their account).
    owner_do(owner, "update pulse.person set status='active' where id=%s", (b.editor2,), b.org)
    other_handle, _ = make_account(owner, c.org, c.editor2)
    theirs = issue(api, a, other_handle)
    rewind(owner, account, last_sent=2)
    mine = issue(api, a, handle)
    assert finish(api, a, handle, theirs['code'], 'cross') is None or theirs['code'] == mine['code']


def test_two_step_on_a_seat_refuses_the_code(api, owner, world):
    a, b, handle, account = world
    owner_do(owner, "insert into pulse_priv.auth_account(org_id,realm,actor,totp) values(%s,'staff',%s,'\\x00')", (b.org, b.editor2), b.org)
    sent = issue(api, a, handle)
    assert finish(api, a, handle, sent['code'], 'totp') == {'failed': True, 'twoStep': True}
    assert sessions(owner, b.org, hashof('acodetotp')) == []


def test_a_company_allows_personal_accounts_only_when_it_says_so(api, owner, world):
    a, b, handle, account = world
    assert command(api, a, 'pulse.personal_accounts_allowed(%s)', (str(b.org),)) is False
    owner_do(owner, "insert into pulse_priv.auth_policy(org_id,personal_accounts) values(%s,true) on conflict(org_id) do update set personal_accounts=true", (b.org,), b.org)
    assert command(api, a, 'pulse.personal_accounts_allowed(%s)', (str(b.org),)) is True
    assert command(api, a, 'pulse.personal_accounts_allowed(%s)', (None,)) is False


# ------------------------------------------------------------------------------------------------ sign-up
def signup_issue(api, a, email):
    return command(api, a, 'pulse.account_signup_code_issue(%s)', (email,))


def signup_confirm(api, a, details, code, tag):
    return command(api, a, "pulse.account_signup_confirm(%s,%s,%s,'Browser')", (json.dumps(details), code, hashof('signup' + tag)))


def test_passwordless_sign_up_confirms_the_e_mail_and_opens_a_personal_workspace(api, owner, world):
    a, b, _, _ = world
    email = f'sakobe.{uuid.uuid4().hex[:8]}@gmail.example'
    details = {'name': 'Sakobe Synthetic', 'email': email.upper(), 'handle': '', 'orgName': ''}
    assert command(api, a, 'pulse.account_signup_problem(%s)', (json.dumps(details),)) is None
    assert command(api, a, 'pulse.account_signup_problem(%s)', (json.dumps({**details, 'name': 'S'}),)) == 'Give your name'
    assert command(api, a, 'pulse.account_signup_problem(%s)', (json.dumps({**details, 'email': 'nope'}),)) == 'Give your e-mail address'
    sent = signup_issue(api, a, email)
    assert len(sent['code']) == 6 and sent['delivery'] == email
    assert signup_issue(api, a, email) is None  # one a minute
    assert signup_confirm(api, a, details, other(sent['code']), 'wrong') is None
    done = signup_confirm(api, a, details, sent['code'], 'ok')
    assert done['personal'] is True and done['kind'] == 'staff'
    assert signup_confirm(api, a, details, sent['code'], 'again') is None  # single use
    acc = owner_do(owner, "select id, handle, password_hash, email_confirmed_at, last_org from pulse_priv.pulse_account where email=%s", (email,))[0]
    assert acc['password_hash'] is None and acc['email_confirmed_at'] is not None and acc['last_org'] == uuid.UUID(done['org'])
    assert acc['handle'].startswith('sakobe')
    org = owner_do(owner, "select name from pulse.org where id=%s", (done['org'],), done['org'])[0]
    assert org['name'] == "Sakobe Synthetic's Pulse"
    assert sessions(owner, done['org'], hashof('signupok')) == [{'person_id': uuid.UUID(done['person']), 'via': 'account'}]
    roles = owner_do(owner, "select role_key from pulse.role_assignment where org_id=%s and person_id=%s", (done['org'], done['person']), done['org'])
    # SELFSERVE-P1 (1540): the founder runs their workspace, Finance and Billing included.
    assert sorted(r['role_key'] for r in roles) == ['admin', 'leadership']
    assert 'signup_code_used' in events(owner, acc['id'])
    # The sign-up path continues: the new account signs in later with an e-mailed code, into its workspace.
    code = issue(api, a, email)['code']
    assert finish(api, a, acc['handle'], code, 'later')['org'] == done['org']
    # Asking to sign up again with the address: no code, a "sign in instead" (the API answers the same).
    owner_do(owner, "update pulse_priv.account_signup_code set last_sent=last_sent-interval '2 minutes' where email=%s", (email,))
    again = signup_issue(api, a, email)
    assert again == {'existing': True, 'delivery': email}
    assert owner_do(owner, "select code_hash from pulse_priv.account_signup_code where email=%s", (email,))[0]['code_hash'] is None


def test_sign_up_with_a_company_and_a_password_and_the_refusals(api, owner, world):
    a, b, _, _ = world
    email = f'founder.{uuid.uuid4().hex[:8]}@example.test'
    handle = 'f' + uuid.uuid4().hex[:9]
    details = {'name': 'Founder Synthetic', 'email': email, 'handle': '@' + handle, 'orgName': 'Synthetic Studio', 'password': 'Synthetic-founder-2026!'}
    sent = signup_issue(api, a, email)
    done = signup_confirm(api, a, details, sent['code'], 'co')
    assert done['personal'] is False
    assert owner_do(owner, "select name from pulse.org where id=%s", (done['org'],), done['org'])[0]['name'] == 'Synthetic Studio'
    acc = owner_do(owner, "select password_hash is not null p, handle from pulse_priv.pulse_account where email=%s", (email,))[0]
    assert acc['p'] and acc['handle'] == handle
    # The password also signs in (the existing account sign-in).
    assert command(api, a, "pulse.account_sign_in(%s,%s,%s,'Browser')", (handle, 'Synthetic-founder-2026!', hashof('pw-after')))['org'] == done['org']
    # A taken handle is said before any code goes out; and after a right code it still refuses (nothing is made).
    assert command(api, a, 'pulse.account_signup_problem(%s)', (json.dumps({**details, 'email': 'x@example.test'}),)).startswith('Someone already has @')
    email2 = f'late.{uuid.uuid4().hex[:8]}@example.test'
    sent = signup_issue(api, a, email2)
    with pytest.raises(psycopg.errors.UniqueViolation):
        signup_confirm(api, a, {**details, 'email': email2}, sent['code'], 'taken')
    assert owner_do(owner, "select count(*) n from pulse_priv.pulse_account where email=%s", (email2,))[0]['n'] == 0
    # Sign-up codes expire after ten minutes and die after five wrong tries.
    owner_do(owner, "update pulse_priv.account_signup_code set expires_at=now()-interval '1 minute' where email=%s", (email2,))
    assert signup_confirm(api, a, {**details, 'email': email2, 'handle': ''}, sent['code'], 'late') is None
    owner_do(owner, "update pulse_priv.account_signup_code set last_sent=last_sent-interval '2 minutes' where email=%s", (email2,))
    sent = signup_issue(api, a, email2)
    for n in range(5):
        assert signup_confirm(api, a, {**details, 'email': email2, 'handle': ''}, other(sent['code']), 'g' + str(n)) is None
    assert signup_confirm(api, a, {**details, 'email': email2, 'handle': ''}, sent['code'], 'too-late') is None
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        signup_issue(api, a, 'not-an-email')


def test_http_answers_the_same_for_anyone_signs_up_and_signs_in(api, worker, owner, world, tmp_path):
    a, b, handle, account = world
    host = f'co-{b.org.hex[:8]}.example.test'
    owner_do(owner, "insert into pulse.org_domain(org_id,host,sign_in,added_by) values(%s,%s,'password','synthetic')", (b.org, host), b.org)
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_ORG_ID': str(a.org), 'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '1',
           'PULSE_AUTH_MAIL_MODE': 'sink', 'PULSE_AUTH_REPORT': str(tmp_path / 'acode.json'), 'TEST_HANDLE': handle,
           'TEST_EMAIL': f'{handle}@gmail.example', 'TEST_COMPANY_HOST': host, 'TEST_COMPANY_ORG': str(b.org), 'TEST_SEAT': str(b.editor2),
           'TEST_SIGNUP_EMAIL': f'new.{uuid.uuid4().hex[:8]}@gmail.example'}
    root = Path(__file__).resolve().parents[2]

    def run(phase):
        proc = subprocess.run(['node', 'test/account-code-runner.mjs'], cwd=root / 'services/api', env={**env, 'TEST_PHASE': phase},
                              capture_output=True, text=True, timeout=240)
        assert proc.returncode == 0, proc.stderr[-8000:]
        return json.loads((tmp_path / 'acode.json').read_text())['apiChecks']

    assert run('shared') >= 25
    # The company allows personal accounts: its own address now takes the account's code (into its seat there).
    owner_do(owner, "insert into pulse_priv.auth_policy(org_id,personal_accounts) values(%s,true) on conflict(org_id) do update set personal_accounts=true", (b.org,), b.org)
    rewind(owner, account, last_sent=2)
    assert run('company') >= 4
    assert owner_do(owner, "select count(*) n from pulse.login_session where org_id=%s and person_id=%s and via='account'", (b.org, b.editor2), b.org)[0]['n'] >= 2
