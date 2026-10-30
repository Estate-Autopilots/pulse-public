"""AUTH-UNIFY: one sign-in identity per human across organisations (synthetic people only).

1153: a staff password is checked only against the credential of the organisation the sign-in runs in.
1291: a session belongs to the account and moves between its organisations (same token, membership checked, audited in
both, never readable from the organisation it left); a username or e-mail with any of the person's organisation
passwords signs in at the shared address until one password is set; "one password for all your workspaces"; a sign-in
lands in the workspace used last; an issued password to change lands where it must be changed.
"""
import json
import uuid

import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_account_security import command, hashof

PW_A = 'Synthetic-org-a-2026!'
PW_B = 'Synthetic-org-b-2026!'
PW_ONE = 'Synthetic-one-for-all-2026!'


def _staff_login(worker, owner, api, w, person, username, password, email=None):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01') on conflict do nothing", (w.org, w.manager))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,email,evidence) values(%s,%s,'Editor',%s,%s,'{}')", (w.org, person, username, email))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.login_issue(%s,%s)", (person, password))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.login_credential set must_change=false where person_id=%s", (person,))


def _login(api, w, username, password, tag):
    return command(api, w, "pulse.auth_login('staff',%s,%s,%s,%s,false,'Browser')",
                   (username, password, hashof('challenge' + tag + str(w.org)), hashof('session' + tag + str(w.org))))


@pytest.fixture
def two_orgs(worker, owner, api):
    a = build_world(worker, owner, api)
    b = build_world(worker, owner, api)
    _staff_login(worker, owner, api, a, a.editor, 'same.name', PW_A)
    _staff_login(worker, owner, api, b, b.editor, 'same.name', PW_B)
    return a, b


def test_same_username_in_two_orgs_checks_only_this_orgs_credential(api, two_orgs):
    a, b = two_orgs
    ok = _login(api, a, 'same.name', PW_A, 'a1')
    assert not ok.get('failed') and ok['actor'] == str(a.editor)
    # B's password at A's address never opens a session (and never one for B's person).
    assert _login(api, a, 'same.name', PW_B, 'a2').get('failed') is True
    ok = _login(api, b, 'same.name', PW_B, 'b1')
    assert not ok.get('failed') and ok['actor'] == str(b.editor)
    with api.transaction():
        set_tenant(api, a.org)
        assert api.execute("select count(*) n from pulse.login_session where person_id=%s", (b.editor,)).fetchone()['n'] == 0


@pytest.fixture
def one_human(worker, owner, api):
    """One human with a person row (and a password) in each of two organisations, linked to one account, plus a
    colleague in A who is someone else."""
    a = build_world(worker, owner, api)
    b = build_world(worker, owner, api)
    handle = 'u' + uuid.uuid4().hex[:10]
    _staff_login(worker, owner, api, a, a.editor, handle + '.a', PW_A)
    _staff_login(worker, owner, api, b, b.editor, handle + '.b', PW_B)
    _staff_login(worker, owner, api, a, a.editor2, handle + '.other', 'Synthetic-colleague-2026!')
    account = uuid.uuid4()
    with owner.transaction():
        owner.execute("insert into pulse_priv.pulse_account(id,handle,display_name,last_org) values(%s,%s,'Synthetic Human',%s)", (account, handle, a.org))
        owner.execute("insert into pulse_priv.handle_name(handle,kind,ref) values(%s,'person',%s)", (handle, account))
        owner.execute("insert into pulse_priv.account_member(account_id,member_org,person_id,kind) values(%s,%s,%s,'staff'),(%s,%s,%s,'staff')",
                      (account, a.org, a.editor, account, b.org, b.editor))
    return a, b, handle, account


def _sign_in(api, w, login, password, tag):
    return command(api, w, 'pulse.account_sign_in(%s,%s,%s,%s)', (login, password, hashof('acct' + tag), 'Browser'))


def _live(api, w, token_hash, viewer=None):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        return api.execute("select person_id from pulse.login_session where token_hash=%s and revoked_at is null and expires_at>now()", (token_hash,)).fetchall()


def test_either_orgs_password_signs_in_and_lands_in_last_used(api, one_human):
    a, b, handle, _ = one_human
    # B's own username and B's password, at the shared address (A here): into the workspace used last (A).
    r = _sign_in(api, a, handle + '.b', PW_B, 's1')
    assert r['org'] == str(a.org) and r['person'] == str(a.editor) and r['unify'] is True
    assert len(_live(api, a, hashof('acct' + 's1'))) == 1
    # The account handle and A's password work too; a wrong password does not; nobody else's login opens it.
    assert _sign_in(api, a, '@' + handle, PW_A, 's2')['org'] == str(a.org)
    assert _sign_in(api, a, handle + '.a', 'Wrong-password-2026!', 's3')['failed'] is True
    assert not (_sign_in(api, a, handle + '.other', PW_A, 's4') or {}).get('org')   # no account: the org's own sign-in only


def test_switch_moves_the_same_session_and_never_leaks(api, owner, one_human):
    a, b, handle, account = one_human
    r = _sign_in(api, a, handle + '.a', PW_A, 'm1'); h = hashof('acct' + 'm1')
    assert r['org'] == str(a.org)
    moved = command(api, a, 'pulse.account_move(%s,%s)', (str(b.org), h), a.editor)
    assert moved['org'] == str(b.org) and moved['person'] == str(b.editor) and moved['moved'] is True
    # The token now opens B only: A's row security never shows it again, B's does, for B's person.
    assert _live(api, a, h) == []
    assert [x['person_id'] for x in _live(api, b, h)] == [b.editor]
    with owner.transaction():
        set_tenant(owner, a.org)
        assert owner.execute("select count(*) n from pulse.audit_event where org_id=%s and action='org_switch' and resource_id=%s", (a.org, str(b.org))).fetchone()['n'] == 1
        set_tenant(owner, b.org)
        assert owner.execute("select count(*) n from pulse.audit_event where org_id=%s and action='org_switch_in' and resource_id=%s", (b.org, str(a.org))).fetchone()['n'] == 1
        assert owner.execute("select last_org from pulse_priv.pulse_account where id=%s", (account,)).fetchone()['last_org'] == b.org
    # Seen from B, A's people stay invisible.
    with api.transaction():
        set_tenant(api, b.org, b.editor)
        assert api.execute("select count(*) n from pulse.person where id=%s", (a.editor,)).fetchone()['n'] == 0
    # And back, still the same token.
    assert command(api, b, 'pulse.account_move(%s,%s)', (str(a.org), h), b.editor)['org'] == str(a.org)
    assert [x['person_id'] for x in _live(api, a, h)] == [a.editor]


def test_switch_refuses_strangers_and_other_peoples_sessions(api, one_human, worker, owner):
    a, b, handle, _ = one_human
    _sign_in(api, a, handle + '.a', PW_A, 'x1'); h = hashof('acct' + 'x1')
    # A colleague in A (another human) cannot move the session, nor switch into B.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        command(api, a, 'pulse.account_move(%s,%s)', (str(b.org), h), a.editor2)
    # An organisation the account is not in.
    c = build_world(worker, owner, api)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        command(api, a, 'pulse.account_move(%s,%s)', (str(c.org), h), a.editor)
    assert [x['person_id'] for x in _live(api, a, h)] == [a.editor]


def test_issued_password_lands_where_it_must_be_changed(api, owner, one_human):
    a, b, handle, _ = one_human
    with owner.transaction():
        set_tenant(owner, b.org)
        owner.execute("update pulse.login_credential set must_change=true, issued_at=now() where person_id=%s", (b.editor,))
    r = _sign_in(api, a, handle + '.b', PW_B, 'c1')
    assert r['org'] == str(b.org) and r['mustChange'] is True
    # With A's own password, the person lands in A (never in B, where a change still waits).
    r = _sign_in(api, a, handle + '.a', PW_A, 'c2')
    assert r['org'] == str(a.org) and not r.get('mustChange')


def test_one_password_for_all_workspaces(api, one_human):
    a, b, handle, _ = one_human
    assert command(api, a, 'pulse.account_password_unify(%s,%s)', ('Not-my-password-2026', PW_ONE), a.editor)['error']
    r = command(api, a, 'pulse.account_password_unify(%s,%s)', (PW_B, PW_ONE), a.editor)
    assert r['ok'] is True and r['workspaces'] == 2 and r['account']['unify'] is False
    assert _sign_in(api, a, handle + '.b', PW_ONE, 'u1')['org'] == str(a.org)
    assert _sign_in(api, a, handle + '.b', PW_B, 'u2')['failed'] is True          # the old passwords stop
    ok = _login(api, b, handle + '.b', PW_ONE, 'u3')                               # the organisation's own sign-in too
    assert not ok.get('failed') and ok['actor'] == str(b.editor) and not ok.get('mustChange')


def test_org_sign_in_lands_in_the_workspace_used_last(api, owner, one_human):
    a, b, handle, account = one_human
    with owner.transaction():
        owner.execute("update pulse_priv.pulse_account set last_org=%s where id=%s", (b.org, account))
    ok = _login(api, a, handle + '.a', PW_A, 'l1')
    assert not ok.get('failed')
    h = hashof('session' + 'l1' + str(a.org))
    landed = command(api, a, 'pulse.account_land(%s)', (h,))
    assert landed['org'] == str(b.org)
    assert [x['person_id'] for x in _live(api, b, h)] == [b.editor] and _live(api, a, h) == []
    # Someone without an account stays where they signed in.
    ok = _login(api, a, handle + '.other', 'Synthetic-colleague-2026!', 'l2')
    assert command(api, a, 'pulse.account_land(%s)', (hashof('session' + 'l2' + str(a.org)),)) is None


def test_own_address_sign_in_lands_in_that_organisation(api, owner, one_human):
    """SIGNIN-OFFICE: at an organisation's own address the account sign-in opens that organisation, although another
    was used last; at an address without its own domain it still opens the workspace used last."""
    a, b, handle, account = one_human
    with owner.transaction():
        owner.execute("update pulse_priv.pulse_account set last_org=%s where id=%s", (a.org, account))
        set_tenant(owner, b.org)
        owner.execute("insert into pulse.org_domain(org_id,host,sign_in,added_by,is_primary) values(%s,%s,'password','test',true)",
                      (b.org, 'own-' + uuid.uuid4().hex[:10] + '.example.test'))
    r = _sign_in(api, b, '@' + handle, PW_A, 'own1')
    assert r['org'] == str(b.org) and r['person'] == str(b.editor)
    assert [x['person_id'] for x in _live(api, b, hashof('acct' + 'own1'))] == [b.editor]
    with owner.transaction():
        owner.execute("update pulse_priv.pulse_account set last_org=%s where id=%s", (b.org, account))
    r = _sign_in(api, a, '@' + handle, PW_A, 'own2')
    assert r['org'] == str(b.org) and r['person'] == str(b.editor)


def test_account_password_proves_it_is_me_for_account_security(api, owner, one_human):
    """TWO-STEP-GUIDE: someone signed in through their Pulse account can set up two-step with the Pulse account's
    password as well as the organisation's own; a wrong password is refused."""
    a, b, handle, account = one_human
    with owner.transaction():
        owner.execute("update pulse_priv.pulse_account set password_hash=crypt(%s,gen_salt('bf',4)) where id=%s", ('Synthetic-account-pass-2026!', account))

    assert not _login(api, a, handle + '.a', PW_A, 'acctsec').get('failed')
    live = hashof('session' + 'acctsec' + str(a.org))

    def start(pw):
        return command(api, a, "pulse.auth_account_action('staff','totp-start',%s,%s)", (json.dumps({'current': pw}), live), a.editor)
    assert start('Synthetic-account-pass-2026!').get('secretHex')
    assert start(PW_A).get('secretHex')
    assert start('Not-the-password-2026!').get('error') == 'The current password is not right'
