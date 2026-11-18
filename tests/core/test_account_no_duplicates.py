"""IDENTITY-SIGNIN (1841): a person added to a second organisation never gets a second Pulse account (synthetic only).

The record a second company keeps of a person whose e-mail already belongs to an account is matched to that account:
linked at once only on a proven match (the account's verified e-mail and the record's own Google sign-in), otherwise left
unlinked with the company's invitation open to the account, and accepting it from the signed-in account hangs the seat
off the existing account. A new account is made only when no account matches.
"""
import uuid

import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_account_security import command, hashof
from test_auth_unify import _accounts_of, _sign_in, _staff_login

PW_A = 'Synthetic-org-a-2026!'
PW_B = 'Synthetic-org-b-2026!'


@pytest.fixture
def person_in_two(worker, owner, api):
    """One human: an account (verified e-mail) with a seat in A, then a record of the same e-mail that B's HR adds."""
    home = build_world(worker, owner, api)          # the shared address
    a = build_world(worker, owner, api)
    b = build_world(worker, owner, api)
    name = 'n' + uuid.uuid4().hex[:10]
    email = name + '@person.example'
    _staff_login(worker, owner, api, a, a.editor, name + '.a', PW_A, email)
    _staff_login(worker, owner, api, b, b.editor, name + '.b', PW_B, email)
    account = uuid.uuid4()
    with owner.transaction():
        owner.execute("""insert into pulse_priv.pulse_account(id,handle,display_name,email,email_verified_at,last_org)
                         values(%s,%s,'Synthetic Person',%s,now(),%s)""", (account, name, email, a.org))
        owner.execute("insert into pulse_priv.handle_name(handle,kind,ref) values(%s,'person',%s)", (name, account))
        owner.execute("insert into pulse_priv.account_member(account_id,member_org,person_id,kind) values(%s,%s,%s,'staff')", (account, a.org, a.editor))
    return home, a, b, name, email, account


def _account_count(owner, email, handle):
    with owner.transaction():
        return owner.execute("""select count(*) n from pulse_priv.pulse_account where lower(email) = %s or handle like %s""",
                             (email, handle + '%')).fetchone()['n']


def _open_invites(owner, org, handle):
    with owner.transaction():
        set_tenant(owner, org)
        return owner.execute("select id, to_email, kind from pulse_priv.org_invite where org_id=%s and to_handle=%s and status='open'",
                             (org, handle)).fetchall()


def test_hr_adding_an_existing_persons_email_invites_their_account_instead_of_a_second_one(api, owner, person_in_two):
    home, a, b, name, email, account = person_in_two
    # HR adds them in B: the account is named and invited; nothing is linked yet, no account is made.
    offer = command(api, b, 'pulse.people_account_offer(%s)', (b.editor,), b.manager)
    assert offer['handle'] == name and offer['offered'] is True
    invites = _open_invites(owner, b.org, name)
    assert len(invites) == 1 and invites[0]['to_email'] == email and invites[0]['kind'] == 'staff'
    # Again: the same one invitation.
    assert command(api, b, 'pulse.people_account_offer(%s)', (b.editor,), b.manager)['invite'] == str(invites[0]['id'])
    assert len(_open_invites(owner, b.org, name)) == 1
    # Someone without HR rights learns nothing.
    assert command(api, b, 'pulse.people_account_offer(%s)', (b.editor,), b.editor2) is None

    # B's own username and password at the shared address: no second account, the account is asked to accept instead.
    r = _sign_in(api, home, name + '.b', PW_B, 'dup1')
    assert r == {'failed': True, 'linkPending': True}
    assert _accounts_of(owner, b.editor) == [] and _account_count(owner, email, name) == 1
    # Signed in at B's own address, first use of an account feature: refused, still no second account.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match='existing account'):
        command(api, b, 'pulse.account_claim(%s,%s)', ('', ''), b.editor)
    assert _accounts_of(owner, b.editor) == [] and _account_count(owner, email, name) == 1

    # The account accepts from its own session (in A): B's record hangs off the existing account.
    joined = command(api, a, 'pulse.org_invite_accept(%s,%s,%s,%s)', (str(invites[0]['id']), None, hashof('join' + name), 'Browser'), a.editor)
    assert joined['org'] == str(b.org) and joined['person'] == str(b.editor)
    rows = _accounts_of(owner, b.editor)
    assert len(rows) == 1 and rows[0]['id'] == account and rows[0]['member_org'] == b.org
    assert _account_count(owner, email, name) == 1
    # And B's password at the shared address now opens that one account.
    assert _sign_in(api, home, name + '.b', PW_B, 'dup2')['person'] in (str(a.editor), str(b.editor))
    assert _account_count(owner, email, name) == 1


def test_a_proven_match_links_at_once_and_an_unverified_one_links_nothing(api, owner, person_in_two):
    home, a, b, name, email, account = person_in_two
    # The record's own Google sign-in is the account's verified e-mail: linked on first use, no new account.
    with owner.transaction():
        set_tenant(owner, b.org)
        owner.execute("""insert into pulse_priv.google_identity(org_id,person_id,issuer,subject,email,domain)
                         values(%s,%s,'https://accounts.google.com',%s,%s,'person.example')""", (b.org, b.editor, 'g' + name, email))
    me = command(api, b, 'pulse.account_claim(%s,%s)', ('', ''), b.editor)
    assert me['account']['id'] == str(account) and me['account']['handle'] == name
    assert [x['id'] for x in _accounts_of(owner, b.editor)] == [account]
    assert _account_count(owner, email, name) == 1


def test_an_unverified_account_email_is_never_linked_or_named(api, owner, person_in_two):
    home, a, b, name, email, account = person_in_two
    with owner.transaction():
        owner.execute("update pulse_priv.pulse_account set email_verified_at=null, email_confirmed_at=null where id=%s", (account,))
    assert command(api, b, 'pulse.people_account_offer(%s)', (b.editor,), b.manager) == {'offered': False}
    assert _open_invites(owner, b.org, name) == []
    assert _sign_in(api, home, name + '.b', PW_B, 'unv1') == {'failed': True, 'linkPending': True}
    assert _accounts_of(owner, b.editor) == [] and _account_count(owner, email, name) == 1


def test_a_person_whose_email_names_no_account_still_gets_one(api, owner, worker):
    home = build_world(worker, owner, api)
    b = build_world(worker, owner, api)
    name = 'n' + uuid.uuid4().hex[:10]
    email = name + '@fresh.example'
    _staff_login(worker, owner, api, b, b.editor, name + '.b', PW_B, email)
    assert command(api, b, 'pulse.people_account_offer(%s)', (b.editor,), b.manager) is None
    r = _sign_in(api, home, name + '.b', PW_B, 'new1')
    assert r['org'] == str(b.org) and r['person'] == str(b.editor)
    rows = _accounts_of(owner, b.editor)
    assert len(rows) == 1 and rows[0]['email'] == email
