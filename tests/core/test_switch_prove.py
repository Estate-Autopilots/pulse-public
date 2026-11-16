"""BUGFIX #29 (EA #29, 15 Nov 2026): "I am not able to switch from EA to Vitals OS." A member of two companies signed in
with the first company's own sign-in and pressed the other company in the switcher; every switch answered 403
(ACCOUNT-META 2125: a company's sign-in opens that company only). Synthetic companies, people and passwords only.
- After "one password for all" the company's password IS the account's own password: a sign-in with it now proves the
  person (pulse.acct_session_prove), so the switch goes through in one tap. Before 2142 it stayed company-only.
- A different company password still stays company-only (the owner's rule is unchanged).
- "Confirm it's you" (pulse.account_prove): the signed-in person types their own Pulse password once; the session becomes
  theirs and the switch goes through. A wrong password is counted (five lock the account for 15 minutes); an account
  with no password is told to sign in with their own e-mail; only the caller's own live session is ever changed."""
import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_account_security import command, hashof
from test_account_code import owner_do, make_account
from test_account_meta import seat, member, company_password, session, as_session, live

OWN = 'Synthetic-own-2026!'


@pytest.fixture
def pair(worker, owner, api):
    """One human with seats in two companies (b, c). The account has its own Pulse password and no personal e-mail (as a
    person who chose "one password for all"); each company has them under its own username."""
    b = build_world(worker, owner, api)
    c = build_world(worker, owner, api)
    handle, account = make_account(owner, b.org, b.editor, email=False, password=OWN)
    member(owner, account, c.org, c.editor)
    seat(worker, b.org, b.editor, handle + '.b')
    seat(worker, c.org, c.editor, handle + '.c')
    return b, c, handle, account


def username(owner, w, person):
    """The seat's username as the database keeps it (a seat of an account takes the account's handle)."""
    return owner_do(owner, "select username from pulse.people_profile where person_id=%s", (person,), w.org)[0]['username']


def sign_in_with_company_password(api, w, username, password, tag):
    h = hashof('prove-' + tag)
    r = command(api, w, "pulse.auth_login('staff',%s,%s,%s,%s,false,'Browser')", (username, password, hashof('prove-ch-' + tag), h))
    assert r and not r.get('failed') and not r.get('twoStep'), r
    return h


def test_the_company_password_that_is_the_accounts_own_proves_the_person(api, owner, pair):
    b, c, handle, account = pair
    company_password(api, owner, b, b.editor, password=OWN)  # one password for all
    h = sign_in_with_company_password(api, b, username(owner, b, b.editor), OWN, 'same')
    assert live(owner, b.org, h) == [{'person_id': b.editor, 'personal': False}]  # what 2125 left: company-only, so 403
    assert command(api, b, 'pulse.acct_session_prove(%s,%s)', (h, OWN)) is True  # what the sign-in route now does
    assert live(owner, b.org, h) == [{'person_id': b.editor, 'personal': True}]
    moved = as_session(api, b.org, b.editor, h, 'pulse.account_move(%s,%s)', (c.org, h))
    assert moved['org'] == str(c.org)
    assert live(owner, c.org, h) == [{'person_id': c.editor, 'personal': True}]


def test_a_different_company_password_still_opens_that_company_only(api, owner, pair):
    b, c, handle, account = pair
    company_password(api, owner, b, b.editor, password='Synthetic-company-2026!')
    h = sign_in_with_company_password(api, b, username(owner, b, b.editor), 'Synthetic-company-2026!', 'other')
    assert command(api, b, 'pulse.acct_session_prove(%s,%s)', (h, 'Synthetic-company-2026!')) is False
    assert live(owner, b.org, h) == [{'person_id': b.editor, 'personal': False}]
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match='sign in as yourself') as e:
        as_session(api, b.org, b.editor, h, 'pulse.account_move(%s,%s)', (c.org, h))
    assert e.value.diag.message_hint == 'personal_sign_in'
    # Nothing was counted against the account: the person signed in correctly with the company's password.
    assert owner_do(owner, 'select failed from pulse_priv.pulse_account where id=%s', (account,))[0]['failed'] == 0


def test_confirm_its_you_makes_the_session_theirs_and_the_switch_goes_through(api, owner, pair):
    b, c, handle, account = pair
    h = session(owner, b.org, b.editor, 'prove-step')  # e.g. the company's e-mailed staff code to the work address
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match='sign in as yourself'):
        as_session(api, b.org, b.editor, h, 'pulse.account_move(%s,%s)', (c.org, h))
    assert as_session(api, b.org, b.editor, h, 'pulse.account_prove(%s)', ('Not-my-password-1!',)) == {'personal': False, 'wrong': True}
    assert owner_do(owner, 'select failed from pulse_priv.pulse_account where id=%s', (account,))[0]['failed'] == 1  # counted, kept
    assert live(owner, b.org, h) == [{'person_id': b.editor, 'personal': False}]
    assert as_session(api, b.org, b.editor, h, 'pulse.account_prove(%s)', (OWN,)) == {'personal': True}
    assert owner_do(owner, 'select failed from pulse_priv.pulse_account where id=%s', (account,))[0]['failed'] == 0
    assert as_session(api, b.org, b.editor, h, 'pulse.account_prove(%s)', ('anything',)) == {'personal': True}  # already theirs
    assert as_session(api, b.org, b.editor, h, 'pulse.account_move(%s,%s)', (c.org, h))['org'] == str(c.org)


def test_five_wrong_passwords_lock_it_for_15_minutes(api, owner, pair):
    b, c, handle, account = pair
    h = session(owner, b.org, b.editor, 'prove-lock')
    for _ in range(5):
        assert as_session(api, b.org, b.editor, h, 'pulse.account_prove(%s)', ('Wrong-guess-2026!',))['wrong'] is True
    with pytest.raises(psycopg.errors.ProgramLimitExceeded, match='15 minutes'):
        as_session(api, b.org, b.editor, h, 'pulse.account_prove(%s)', (OWN,))
    assert live(owner, b.org, h) == [{'person_id': b.editor, 'personal': False}]


def test_no_password_of_their_own_means_sign_in_with_your_own_email(api, owner, pair):
    b, c, handle, account = pair
    owner_do(owner, "update pulse_priv.pulse_account set password_hash=null, email=%s, email_verified_at=now() where id=%s", (handle + '@gmail.com', account))
    h = session(owner, b.org, b.editor, 'prove-nopw')
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match='sign in as yourself') as e:
        as_session(api, b.org, b.editor, h, 'pulse.account_prove(%s)', (OWN,))
    assert e.value.diag.message_hint == 'personal_sign_in'


def test_only_the_callers_own_live_session_is_changed(api, owner, worker, pair):
    b, c, handle, account = pair
    mine = session(owner, b.org, b.editor, 'prove-mine')
    other = session(owner, b.org, b.manager, 'prove-other')  # a colleague's session in the same company
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match='browser you signed in on'):
        as_session(api, b.org, b.editor, other, 'pulse.account_prove(%s)', (OWN,))  # someone else's session hash
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match='browser you signed in on'):
        as_session(api, b.org, b.editor, '', 'pulse.account_prove(%s)', (OWN,))  # no session (an Access identity)
    owner_do(owner, "update pulse.login_session set revoked_at=now() where token_hash=%s", (mine,), b.org)
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match='browser you signed in on'):
        as_session(api, b.org, b.editor, mine, 'pulse.account_prove(%s)', (OWN,))  # signed out
    assert live(owner, b.org, other) == [{'person_id': b.manager, 'personal': False}]
    # The sign-in route's proof touches only the session it names, in this company.
    assert command(api, c, 'pulse.acct_session_prove(%s,%s)', (other, OWN)) is False


def _tab(api, parent, child, org, reopen=False):
    with api.transaction():
        return api.execute('select * from pulse.account_tab_session(%s,%s,%s,%s)', (parent, child, str(org), reopen)).fetchone()


def test_a_company_only_sign_in_opens_no_other_company_in_a_tab_until_it_is_proved(api, owner, pair):
    """ORG-PER-TAB (2141) opens a company per tab from the browser's sign-in: the same rule as a switch (2142)."""
    b, c, handle, account = pair
    h = session(owner, b.org, b.editor, 'prove-tab')
    child = hashof('prove-tab-child')
    assert _tab(api, h, child, c.org, True)['state'] == 'personal'  # tab-open: the API answers 403 personal_sign_in
    # ...with the switch's sentence, which the API reads as its own role (2156: before it, that read was refused and the
    # answer became "Access denied for this account" with no code, so the switcher never asked "Confirm it's you").
    assert command(api, b, 'pulse.acct_personal_needed()').startswith('To open your other companies, sign in as yourself')
    assert _tab(api, h, child, c.org)['state'] == 'personal'  # any page request naming that company: refused
    assert live(owner, c.org, child) == []  # and no session was made there
    assert _tab(api, h, hashof('prove-tab-own'), b.org)['state'] == 'parent'  # its own company opens as before
    assert as_session(api, b.org, b.editor, h, 'pulse.account_prove(%s)', (OWN,)) == {'personal': True}
    assert _tab(api, h, child, c.org, True)['state'] == 'open'
    assert live(owner, c.org, child) == [{'person_id': c.editor, 'personal': True}]
