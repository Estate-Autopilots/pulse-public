"""LOGIN-OTP (owner, 6 Nov 2026: "Everyone, including me, is able to log in with our emails, with one-time login, just by
putting it in there ... they can select their own username as well"). Synthetic people only; no mail leaves (the database
returns what the API would e-mail; the HTTP side's one-answer-for-everyone is account-code-runner.mjs).
- a merged account gets a code at every linked e-mail (its own and the merged one's), each into that account;
- an unknown e-mail: the same nothing (no code, no row, nothing to mail);
- the five-tries lockout and the per-account ration hold across all of an account's addresses;
- the company policy (auth_policy.email_codes) and the company-password rule (verified address or the seat's work e-mail);
- the @handle: change, uniqueness, reserved names, the old one kept."""
import json
import uuid

import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_account_security import command, hashof
from test_account_code import owner_do, make_account, issue, finish, rewind, other, events, sessions


def verified(owner, account, email):
    owner_do(owner, "update pulse_priv.pulse_account set email=%s, email_verified_at=now() where id=%s", (email, account))


@pytest.fixture
def merged(worker, owner, api):
    """a: the install's own organisation (the shared address), with a staff person who has a company password (the
    owner's case: install staff with a company password). keep: an account with a staff seat there and a seat in b;
    drop: a second account of the same human (verified Gmail) with a seat in c, merged into keep."""
    a = build_world(worker, owner, api)
    b = build_world(worker, owner, api)
    c = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, a.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01') on conflict do nothing", (a.org, a.manager))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,email,evidence) values(%s,%s,'Editor','owner.like','owner.like@work.example','{}')", (a.org, a.editor))
    with api.transaction():
        set_tenant(api, a.org, a.manager)
        api.execute("select pulse.login_issue(%s,'Synthetic-owner-2026!')", (a.editor,))
    with owner.transaction():  # an issued password asks for a change first; the owner's own password does not
        set_tenant(owner, a.org)
        owner.execute("update pulse.login_credential set must_change=false where person_id=%s", (a.editor,))
    keep_handle, keep = make_account(owner, b.org, b.editor2)
    with worker.transaction():  # staff seats have a profile, as every real seat does (the session lookup joins it)
        set_tenant(worker, b.org)
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,evidence) values(%s,%s,'Editor',%s,'{}') on conflict do nothing", (b.org, b.editor2, keep_handle + '.s'))
    owner_do(owner, "insert into pulse_priv.account_member(account_id,member_org,person_id,kind) values(%s,%s,%s,'staff')", (keep, a.org, a.editor))
    keep_mail = f'{keep_handle}@own.example'
    verified(owner, keep, keep_mail)
    drop_handle, drop = make_account(owner, c.org, c.editor2)
    with worker.transaction():  # staff seats have a profile, as every real seat does (the session lookup joins it)
        set_tenant(worker, c.org)
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,evidence) values(%s,%s,'Editor',%s,'{}') on conflict do nothing", (c.org, c.editor2, drop_handle + '.s'))
    drop_mail = f'{drop_handle}@gmail.example'
    verified(owner, drop, drop_mail)
    rec = owner_do(owner, "select pulse.account_merge(%s,%s,null,'LOGIN-OTP test') r", (keep, drop))[0]['r']
    return a, b, c, keep, keep_handle, keep_mail, drop_handle, drop_mail, rec


def test_a_merged_account_gets_codes_at_every_linked_e_mail(api, owner, merged):
    a, b, c, keep, keep_handle, keep_mail, drop_handle, drop_mail, rec = merged
    assert rec['login_email'] == drop_mail
    # Its own e-mail (the install-staff seat with a company password no longer refuses it).
    sent = issue(api, a, keep_mail)
    assert sent and sent['delivery'] == keep_mail and sent['account'] == str(keep)
    done = finish(api, a, keep_mail, sent['code'], 'own')
    assert done['person'] in (str(b.editor2), str(a.editor), str(c.editor2))
    # The merged account's e-mail: the code goes to that e-mail and opens the same (kept) account.
    rewind(owner, keep, last_sent=2)
    sent = issue(api, a, drop_mail.upper())
    assert sent['delivery'] == drop_mail and sent['account'] == str(keep) and sent['handle'] == keep_handle
    done = finish(api, a, drop_mail, sent['code'], 'linked')
    assert sessions(owner, done['org'], hashof('acodelinked')) == [{'person_id': uuid.UUID(done['person']), 'via': 'account'}]
    # The merged account's old handle means the kept account too.
    rewind(owner, keep, last_sent=2)
    assert issue(api, a, '@' + drop_handle)['account'] == str(keep)
    # Nobody else can take the linked address.
    with pytest.raises(psycopg.errors.UniqueViolation):
        owner_do(owner, "insert into pulse_priv.pulse_account(id,handle,display_name,email) values(%s,%s,'Synthetic Person',%s)", (uuid.uuid4(), 'q' + uuid.uuid4().hex[:10], drop_mail))
    # Undoing the merge gives the e-mail back to the returning account.
    rewind(owner, keep, last_sent=2)
    owner_do(owner, "select pulse.account_unmerge(%s,'LOGIN-OTP test')", (json.dumps(rec),))
    assert owner_do(owner, "select count(*) n from pulse_priv.account_login_email where email=%s", (drop_mail,))[0]['n'] == 0
    back = issue(api, a, drop_mail)
    assert back['delivery'] == drop_mail and back['account'] == rec['drop']


def test_a_code_to_a_linked_e_mail_does_not_confirm_the_account_e_mail(api, owner, merged):
    a, b, c, keep, keep_handle, keep_mail, drop_handle, drop_mail, rec = merged
    owner_do(owner, "update pulse_priv.pulse_account set email_verified_at=null, email_confirmed_at=null where id=%s", (keep,))
    sent = issue(api, a, drop_mail)
    assert finish(api, a, drop_mail, sent['code'], 'noconfirm')['org']
    acc = owner_do(owner, "select email_verified_at, email_confirmed_at from pulse_priv.pulse_account where id=%s", (keep,))[0]
    assert acc['email_verified_at'] is None and acc['email_confirmed_at'] is None


def test_merges_from_before_are_restored_from_their_records(api, owner, merged):
    a, b, c, keep, keep_handle, keep_mail, drop_handle, drop_mail, rec = merged
    owner_do(owner, "delete from pulse_priv.account_login_email where email=%s", (drop_mail,))
    assert issue(api, a, drop_mail) is None  # no longer known
    old = {k: v for k, v in rec.items() if k != 'login_email'}
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        owner_do(owner, "select pulse.account_login_email_restore(%s,'')", (json.dumps({'records': [old]}),))
    out = owner_do(owner, "select pulse.account_login_email_restore(%s,'LOGIN-OTP test') r", (json.dumps({'applied': True, 'records': [old]}),))[0]['r']
    assert out['linked'] == [drop_mail]
    again = owner_do(owner, "select pulse.account_login_email_restore(%s,'LOGIN-OTP test') r", (json.dumps([old]),))[0]['r']
    assert again['linked'] == [] and len(again['skipped']) == 1
    assert issue(api, a, drop_mail)['delivery'] == drop_mail


def test_an_unknown_e_mail_gets_the_same_nothing(api, owner, merged):
    a, *_ = merged
    before = owner_do(owner, "select count(*) n from pulse_priv.account_signin_code")[0]['n']
    for login in (f'nobody.{uuid.uuid4().hex[:8]}@gmail.example', 'nobody.' + uuid.uuid4().hex[:8], '@' + uuid.uuid4().hex[:8]):
        assert issue(api, a, login) is None
        assert finish(api, a, login, '123456', 'unknown') is None
    assert owner_do(owner, "select count(*) n from pulse_priv.account_signin_code")[0]['n'] == before
    assert 'account_code_requested' in events(owner)


def test_lockout_and_ration_hold_across_every_address(api, owner, merged):
    a, b, c, keep, keep_handle, keep_mail, drop_handle, drop_mail, rec = merged
    sent = issue(api, a, drop_mail)
    # One a minute per account, whichever of its addresses asks.
    assert issue(api, a, keep_mail) is None and issue(api, a, keep_handle) is None
    assert 'account_code_limited' in events(owner, keep)
    # Five wrong tries (from any of its names) kill the code.
    for n, login in enumerate([drop_mail, keep_mail, keep_handle, drop_mail, '@' + drop_handle]):
        assert finish(api, a, login, other(sent['code']), 'lock' + str(n)) is None
    assert finish(api, a, drop_mail, sent['code'], 'lock-right') is None
    # Five an hour.
    for _ in range(4):
        rewind(owner, keep, last_sent=2)
        assert issue(api, a, keep_mail)
    rewind(owner, keep, last_sent=2)
    assert issue(api, a, drop_mail) is None


def test_a_company_can_turn_e_mail_codes_off_for_its_seats(api, owner, merged):
    a, b, c, keep, keep_handle, keep_mail, drop_handle, drop_mail, rec = merged
    owner_do(owner, "insert into pulse_priv.auth_policy(org_id,email_codes) values(%s,false) on conflict(org_id) do update set email_codes=false", (b.org,), b.org)
    assert issue(api, a, drop_mail) is None and issue(api, a, keep_mail) is None
    assert 'account_code_refused' in events(owner, keep)
    # The install's own staff code (1449) follows its company's switch too.
    assert command(api, a, "pulse.auth_signin_code_issue('staff',%s)", ('owner.like',))
    owner_do(owner, "insert into pulse_priv.auth_policy(org_id,email_codes) values(%s,false) on conflict(org_id) do update set email_codes=false", (a.org,), a.org)
    owner_do(owner, "update pulse_priv.auth_signin_code set last_sent=last_sent-interval '2 minutes' where org_id=%s", (a.org,), a.org)
    assert command(api, a, "pulse.auth_signin_code_issue('staff',%s)", ('owner.like',)) is None
    # Back on: codes again.
    for org in (a.org, b.org):
        owner_do(owner, "update pulse_priv.auth_policy set email_codes=true where org_id=%s", (org,), org)
    assert issue(api, a, drop_mail)['delivery'] == drop_mail


def test_company_password_seats_get_codes_only_at_a_verified_or_work_address(api, owner, worker, merged):
    a, *_ = merged
    d = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, d.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01') on conflict do nothing", (d.org, d.manager))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,email,evidence) values(%s,%s,'Editor',%s,%s,'{}')",
                       (d.org, d.editor2, 'ac.' + uuid.uuid4().hex[:8], 'colleague@company.example'))
    with api.transaction():
        set_tenant(api, d.org, d.manager)
        api.execute("select pulse.login_issue(%s,'Synthetic-colleague-2026!')", (d.editor2,))
    handle, account = make_account(owner, d.org, d.editor2)
    # Its own e-mail is unverified and not the company's work e-mail for the seat: nothing.
    assert issue(api, a, handle) is None
    # The same as the seat's work e-mail (as the company's own code would use): a code, to that address.
    owner_do(owner, "update pulse_priv.pulse_account set email='colleague@company.example' where id=%s", (account,))
    sent = issue(api, a, handle)
    assert sent['delivery'] == 'colleague@company.example'
    assert finish(api, a, 'colleague@company.example', sent['code'], 'ac')['org'] == str(d.org)


def test_a_person_picks_and_changes_their_handle(api, owner, worker, merged):
    a, b, c, keep, keep_handle, keep_mail, drop_handle, drop_mail, rec = merged
    claim = lambda h: command(api, b, 'pulse.account_claim(%s,%s)', (h, None), b.editor2)
    new = 'n' + uuid.uuid4().hex[:9]
    assert claim('@' + new.upper())['account']['handle'] == new
    # The old handle stays reserved for them (it still finds them), and they can take it back.
    assert command(api, a, 'pulse.handle_check(%s)', (keep_handle,)) == 'taken'
    assert issue(api, a, '@' + keep_handle)['account'] == str(keep)
    assert claim(keep_handle)['account']['handle'] == keep_handle
    # Someone else's handle, a merged one, an organisation's, and reserved names: refused.
    other_handle, _ = make_account(owner, c.org, c.lead)
    for taken in (other_handle,):
        with pytest.raises(psycopg.errors.UniqueViolation):
            claim(taken)
    for reserved in ('admin', 'support', 'pulse'):
        assert command(api, a, 'pulse.handle_check(%s)', (reserved,)) == 'taken'
        with pytest.raises(psycopg.errors.UniqueViolation):
            claim(reserved)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        claim('a!')
    assert 'handle_changed' in events(owner, keep)


# ------------------------------------------------------------------------------------------------ two-step at the shared address
import hashlib
import os
import subprocess
from pathlib import Path

from psycopg.conninfo import conninfo_to_dict
from conftest import dsn


def two_step_account(owner, worker, api, backups=('synthetic-backup-one', 'synthetic-backup-two')):
    """An account (own password) whose only seat uses an authenticator (stored like a real one; the tests use its backup
    codes, which the same check takes)."""
    e = build_world(worker, owner, api)
    password = 'Synthetic-two-step-2026!'
    handle, account = make_account(owner, e.org, e.editor2, password=password)
    with worker.transaction():  # a staff person has a profile (the session lookup joins it), as every real seat does
        set_tenant(worker, e.org)
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,evidence) values(%s,%s,'Editor',%s,'{}') on conflict do nothing", (e.org, e.editor2, handle + '.e'))
    owner_do(owner, "insert into pulse_priv.auth_account(org_id,realm,actor,totp,recovery) values(%s,'staff',%s,'\\x00',%s)",
             (e.org, e.editor2, [hashlib.sha256(b.replace('-', '').lower().encode()).hexdigest() for b in backups]), e.org)
    return e, handle, account, password


def test_two_step_accounts_finish_with_their_authenticator_at_the_shared_address(api, owner, worker, merged):
    a = merged[0]
    e, handle, account, password = two_step_account(owner, worker, api)
    # The 4-argument sign-in (no challenge) still refuses, as before.
    assert command(api, a, "pulse.account_sign_in(%s,%s,%s,'Browser')", (handle, password, hashof('2s-old'))) == {'failed': True, 'twoStep': True}
    first = command(api, a, "pulse.account_sign_in(%s,%s,%s,'Browser',%s)", (handle, password, hashof('2s-a'), hashof('ch-a')))
    assert first == {'twoStep': True, 'challenge': True}
    assert sessions(owner, e.org, hashof('2s-a')) == []
    fin = lambda ch, code, tag: command(api, a, "pulse.account_two_step_finish(%s,%s,%s,'Browser')", (hashof(ch), code, hashof(tag)))
    assert fin('ch-a', 'wrong-backup', '2s-w') is None
    assert fin('ch-unknown', 'synthetic-backup-one', '2s-u') is None
    done = fin('ch-a', 'synthetic-backup-one', '2s-ok')
    assert done['org'] == str(e.org) and done['person'] == str(e.editor2)
    row = owner_do(owner, "select via, second_factor_verified, remembered, expires_at > now() + interval '29 days' long from pulse.login_session where org_id=%s and token_hash=%s",
                   (e.org, hashof('2s-ok')), e.org)[0]
    assert row == {'via': 'account', 'second_factor_verified': True, 'remembered': True, 'long': True}
    assert fin('ch-a', 'synthetic-backup-two', '2s-again') is None  # once
    assert {'account_two_step_asked', 'account_two_step_failed', 'account_two_step_used'} <= set(events(owner, account))
    # Expired challenges die.
    command(api, a, "pulse.account_sign_in(%s,%s,%s,'Browser',%s)", (handle, password, hashof('2s-b'), hashof('ch-b')))
    owner_do(owner, "update pulse_priv.account_challenge set expires_at=now()-interval '1 second' where hash=%s", (hashof('ch-b'),))
    assert fin('ch-b', 'synthetic-backup-two', '2s-late') is None
    # The company's own two-step try limit holds (five a quarter hour, shared with its own sign-in).
    command(api, a, "pulse.account_sign_in(%s,%s,%s,'Browser',%s)", (handle, password, hashof('2s-c'), hashof('ch-c')))
    for n in range(5):
        fin('ch-c', 'wrong-' + str(n), '2s-c' + str(n))
    assert fin('ch-c', 'synthetic-backup-two', '2s-c-right') is None
    # A wrong password still counts toward the account lockout and opens no challenge.
    assert command(api, a, "pulse.account_sign_in(%s,%s,%s,'Browser',%s)", (handle, 'Wrong-password-2026!', hashof('2s-d'), hashof('ch-d')))['failed'] is True
    assert owner_do(owner, "select count(*) n from pulse_priv.account_challenge where hash=%s", (hashof('ch-d'),))[0]['n'] == 0
    assert owner_do(owner, "select failed from pulse_priv.pulse_account where id=%s", (account,))[0]['failed'] == 1
    privileges = owner_do(owner, "select has_table_privilege('pulse_api','pulse_priv.account_challenge','select') t, "
                                 "has_table_privilege('pulse_api','pulse_priv.account_login_email','select') u, "
                                 "has_function_privilege('pulse_api','pulse.acct_challenge_begin(uuid,text,text,uuid)','execute') f")[0]
    assert not privileges['t'] and not privileges['u'] and not privileges['f']


def test_http_two_step_and_linked_e_mail_at_the_shared_address(api, owner, worker, merged, tmp_path):
    a, b, c, keep, keep_handle, keep_mail, drop_handle, drop_mail, rec = merged
    e, handle, account, password = two_step_account(owner, worker, api)
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_ORG_ID': str(a.org), 'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '1',
           'PULSE_AUTH_MAIL_MODE': 'sink', 'PULSE_AUTH_REPORT': str(tmp_path / 'lotp.json'),
           'TEST_2S_HANDLE': handle, 'TEST_2S_PASSWORD': password, 'TEST_2S_ORG': str(e.org),
           'TEST_2S_BACKUP': 'synthetic-backup-one', 'TEST_2S_BACKUP2': 'synthetic-backup-two',
           'TEST_LINKED': drop_mail, 'TEST_KEEP_HANDLE': keep_handle}
    root = Path(__file__).resolve().parents[2]
    proc = subprocess.run(['node', 'test/login-otp-runner.mjs'], cwd=root / 'services/api', env=env, capture_output=True, text=True, timeout=240)
    assert proc.returncode == 0, proc.stderr[-8000:]
    assert json.loads((tmp_path / 'lotp.json').read_text())['apiChecks'] >= 13


# LAND-CAPTAIN: the API calls the 5-argument sign-in, so WL-MOVE's first sign-in of staff without a Pulse account must
# hold there too (account made once, on the right password only), and their authenticator opens a challenge.
def test_staff_without_an_account_sign_in_with_a_challenge_too(api, owner, worker):
    from test_auth_unify import _staff_login, _accounts_of, PW_B
    home = build_world(worker, owner, api)
    b = build_world(worker, owner, api)
    name = 'n' + uuid.uuid4().hex[:10]
    _staff_login(worker, owner, api, b, b.editor, name, PW_B)
    sign = lambda login, pw, tag: command(api, home, "pulse.account_sign_in(%s,%s,%s,'Browser',%s)", (login, pw, hashof('fa' + tag), hashof('fc' + tag)))
    assert sign(name, 'Wrong-password-2026!', '0')['failed'] is True
    assert _accounts_of(owner, b.editor) == []
    r = sign(name, PW_B, '1')
    assert r['org'] == str(b.org) and r['person'] == str(b.editor)
    assert len(_accounts_of(owner, b.editor)) == 1
    assert sign(name, PW_B, '2')['person'] == str(b.editor) and len(_accounts_of(owner, b.editor)) == 1
    # With an authenticator on the seat: the account is made, a challenge opens, no session yet.
    other_name = 'n' + uuid.uuid4().hex[:10]
    _staff_login(worker, owner, api, b, b.editor2, other_name, PW_B)
    owner_do(owner, "insert into pulse_priv.auth_account(org_id,realm,actor,totp) values(%s,'staff',%s,'\\x00')", (b.org, b.editor2), b.org)
    assert sign(other_name, PW_B, '3') == {'twoStep': True, 'challenge': True}
    assert len(_accounts_of(owner, b.editor2)) == 1
    assert sessions(owner, b.org, hashof('fa3')) == []
    assert owner_do(owner, "select count(*) n from pulse_priv.account_challenge where hash=%s", (hashof('fc3'),))[0]['n'] == 1
