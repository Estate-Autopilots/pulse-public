"""ACCOUNT-META (owner, 15 Nov 2026): a person signs in only with the e-mail they name as their own; "admin@ addresses
that I and others control cannot be able to log in — it is a security issue." Synthetic companies, people and
addresses only (*.example, and consumer-mail addresses that are made up); no mail leaves (the database answers what the
API would send).
- shared mailboxes (admin@, info@ ...) never sign anyone in: no staff code, no Google, no account code or password, never
  an account's e-mail or a linked sign-in e-mail, and they were taken off existing accounts with a record;
- a seat's profile e-mail (the company's record) no longer names the person's account; linked sign-in e-mails now work
  with the password too;
- personal vs company sessions: the account's own password or a code to a personal e-mail proves the person; a company's
  sign-in stays in that company (no switch, no landing elsewhere, never the personal space) and cannot change the
  account's sign-in; an account nobody has claimed yet keeps switching between its companies as before;
- Settings -> Account access: add an e-mail (code + "only I read this mailbox"), remove (never the last personal
  sign-in), make primary; shared mailboxes refused; another account's address refused after the code."""
import uuid

import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_account_security import command, hashof
from test_account_code import owner_do, make_account, events


def seat(worker, org, person, username, email=None):
    with worker.transaction():
        set_tenant(worker, org)
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,email,evidence) values(%s,%s,'Editor',%s,%s,'{}')", (org, person, username, email))


def member(owner, account, org, person):
    owner_do(owner, "insert into pulse_priv.account_member(account_id,member_org,person_id,kind) values(%s,%s,%s,'staff')", (account, org, person))


def company_password(api, owner, w, person, password='Synthetic-company-2026!'):
    owner_do(owner, "insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01') on conflict do nothing", (w.org, w.manager), w.org)
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.login_issue(%s,%s)", (person, password))
    owner_do(owner, "update pulse.login_credential set must_change=false where person_id=%s", (person,), w.org)
    return password


def session(owner, org, person, tag, personal=False):
    """A live session in org, as a company's own sign-in (or a personal one) leaves it."""
    h = hashof('meta-' + tag)
    owner_do(owner, "insert into pulse.login_session(org_id,person_id,token_hash,expires_at,via,personal) values(%s,%s,%s,now()+interval '1 day','password',%s)",
             (org, person, h, personal), org)
    return h


def as_session(api, org, person, h, sql, args=()):
    with api.transaction():
        set_tenant(api, org, person)
        api.execute("select set_config('pulse.viewer_session',%s,true)", (h,))
        return api.execute('select ' + sql + ' d', args).fetchone()['d']


def own(owner, sql, args=(), org=None):
    """An owner-only function (the API reaches it only through the functions that use it)."""
    return owner_do(owner, 'select ' + sql + ' d', args, org)[0]['d']


def live(owner, org, h):
    return owner_do(owner, "select person_id, personal from pulse.login_session where org_id=%s and token_hash=%s and revoked_at is null", (org, h), org)


@pytest.fixture
def two(worker, owner, api):
    """One human with seats in two companies (b, c) and the install's address a. The account has its own password and a
    personal (consumer) e-mail; in b the company's record has them as admin@ (a shared mailbox) and in c as a work e-mail."""
    a = build_world(worker, owner, api)
    b = build_world(worker, owner, api)
    c = build_world(worker, owner, api)
    for w in (b, c):
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01') on conflict do nothing", (w.org, w.manager))
    handle, account = make_account(owner, b.org, b.editor, email=False, password='Synthetic-own-2026!')
    personal = f'{handle}@gmail.com'
    owner_do(owner, "update pulse_priv.pulse_account set email=%s, email_verified_at=now() where id=%s", (personal, account))
    member(owner, account, c.org, c.editor)
    seat(worker, b.org, b.editor, handle + '.b', f'admin@{b.domain}')
    seat(worker, c.org, c.editor, handle + '.c', f'{handle}@{c.domain}')
    return a, b, c, handle, account, personal


# ------------------------------------------------------------------------------------------------ shared mailboxes
def test_shared_mailboxes_are_listed_by_name_and_exact_address(owner):
    assert owner_do(owner, "select pulse.mailbox_shared('Admin@Some.example') a, pulse.mailbox_shared('billing+x@some.example') b, "
                           "pulse.mailbox_shared('person@some.example') c, pulse.mailbox_shared(null) d, pulse.mailbox_consumer('user-adc073dc@gmail.com') e, "
                           "pulse.mailbox_consumer('x@company.example') f")[0] == {'a': True, 'b': True, 'c': False, 'd': False, 'e': True, 'f': False}
    owner_do(owner, "insert into pulse_priv.shared_mailbox(pattern,note) values('team.desk@fake.example','test')")
    assert owner_do(owner, "select pulse.mailbox_shared('team.desk@fake.example') x")[0]['x'] is True


def test_a_shared_mailbox_is_never_an_accounts_email_or_linked_sign_in(owner, worker, api):
    w = build_world(worker, owner, api)
    handle, account = make_account(owner, w.org, w.editor, email=False)
    owner_do(owner, "update pulse_priv.pulse_account set email=%s, email_verified_at=now() where id=%s", (f'admin@{w.domain}', account))
    row = owner_do(owner, "select email, email_verified_at from pulse_priv.pulse_account where id=%s", (account,))[0]
    assert row == {'email': None, 'email_verified_at': None}
    kept = owner_do(owner, "select email, reason from pulse_priv.account_login_email_removed where account_id=%s", (account,))
    assert kept == [{'email': f'admin@{w.domain}', 'reason': 'shared_mailbox'}]  # recorded, never the only copy gone
    with pytest.raises(psycopg.errors.InvalidParameterValue, match='shared mailbox'):
        owner_do(owner, "insert into pulse_priv.account_login_email(email,account_id,verified_at,source) values(%s,%s,now(),'restore')", (f'info@{w.domain}', account))


def test_a_shared_mailbox_gets_no_staff_code_and_no_google(owner, worker, api):
    w = build_world(worker, owner, api)
    seat(worker, w.org, w.editor, 'shared.box', f'admin@{w.domain}')
    company_password(api, owner, w, w.editor)
    # The company's own e-mailed code: nothing to send (the next address on record would be used; there is none).
    assert own(owner, "pulse.auth_delivery('staff',%s)", (w.editor,), w.org) is None
    assert command(api, w, "pulse.auth_signin_code_issue('staff',%s)", (f'admin@{w.domain}',)) is None
    assert command(api, w, "pulse.auth_signin_code_issue('staff','shared.box')") is None
    # Continue with Google / Microsoft / Apple with that address: not linked, even with Google on and the domain allowed.
    owner_do(owner, "insert into pulse_priv.google_settings(org_id,enabled,allowed_domains) values(%s,true,array[%s]) on conflict (org_id) do update set enabled=true, allowed_domains=excluded.allowed_domains", (w.org, w.domain), w.org)
    proof = '{"iss":"https://accounts.google.com","sub":"1","email":"admin@%s","email_verified":true,"hd":"%s"}' % (w.domain, w.domain)
    assert command(api, w, "pulse.google_sign_in_any(%s::jsonb,%s,%s,'Browser')", (proof, hashof('gc'), hashof('gs'))) == {'error': 'not_linked'}
    ms = '{"iss":"https://login.microsoftonline.com/x","email":"admin@%s","email_verified":true}' % w.domain
    assert command(api, w, "pulse.oidc_sign_in_any('microsoft',%s::jsonb,%s,%s,'Browser')", (ms, hashof('mc'), hashof('ms'))) == {'error': 'not_linked'}



# ------------------------------------------------------------------------------------------------ the owner's case
def test_the_owners_case_only_the_personal_email_signs_in(api, owner, two):
    a, b, c, handle, account, personal = two
    # admin@ (company b's record) and the work e-mail (company c's record) name nobody, for the code and the password.
    for typed in (f'admin@{b.domain}', f'{handle}@{c.domain}'):
        assert own(owner, 'pulse.acct_code_target(%s)', (typed,), a.org) is None
        assert command(api, a, 'pulse.account_code_issue(%s)', (typed,)) is None
        assert command(api, a, "pulse.account_sign_in(%s,'Synthetic-own-2026!',%s,'Browser',%s)", (typed, hashof('x' + typed), hashof('y' + typed))) is None
    # The personal e-mail: the code goes there, and the account's password works with it.
    sent = command(api, a, 'pulse.account_code_issue(%s)', (personal,))
    assert sent['delivery'] == personal and sent['account'] == str(account)
    # A username gets the code at the personal e-mail, never at a work one.
    owner_do(owner, "update pulse_priv.account_signin_code set last_sent=now()-interval '2 minutes' where account_id=%s", (account,))
    again = command(api, a, 'pulse.account_code_issue(%s)', ('@' + handle,))
    assert again['delivery'] == personal
    done = command(api, a, "pulse.account_code_finish(%s,%s,%s,'Browser',null)", ('@' + handle, again['code'], hashof('own-code')))
    assert live(owner, done['org'], hashof('own-code'))[0]['personal'] is True
    pw = command(api, a, "pulse.account_sign_in(%s,'Synthetic-own-2026!',%s,'Browser',%s)", (personal, hashof('own-pw'), hashof('own-ch')))
    assert pw['org'] in (str(b.org), str(c.org))
    assert live(owner, pw['org'], hashof('own-pw')) == [{'person_id': b.editor if pw['org'] == str(b.org) else c.editor, 'personal': True}]


def test_a_code_to_the_personal_email_opens_a_personal_session(api, owner, two):
    a, b, c, handle, account, personal = two
    sent = command(api, a, 'pulse.account_code_issue(%s)', (personal,))
    done = command(api, a, "pulse.account_code_finish(%s,%s,%s,'Browser',%s)", (personal, sent['code'], hashof('pc'), c.org))
    assert done['org'] == str(c.org)
    assert live(owner, c.org, hashof('pc')) == [{'person_id': c.editor, 'personal': True}]
    # A personal session crosses: the same token moves to b.
    moved = as_session(api, c.org, c.editor, hashof('pc'), 'pulse.account_move(%s,%s)', (b.org, hashof('pc')))
    assert moved['org'] == str(b.org) and live(owner, b.org, hashof('pc')) == [{'person_id': b.editor, 'personal': True}]


# ------------------------------------------------------------------------------------------------ company sessions
def test_a_company_sign_in_stays_in_its_company(api, owner, two):
    a, b, c, handle, account, personal = two
    h = session(owner, b.org, b.editor, 'company')  # e.g. b's own password, staff code, Google or Access
    # It does not land elsewhere after the sign-in, and the switcher says why.
    with api.transaction():
        set_tenant(api, b.org)
        assert api.execute('select pulse.account_land(%s) d', (h,)).fetchone()['d'] is None
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match='sign in as yourself'):
        as_session(api, b.org, b.editor, h, 'pulse.account_move(%s,%s)', (c.org, h))
    assert live(owner, b.org, h) == [{'person_id': b.editor, 'personal': False}]
    assert live(owner, c.org, h) == []
    # An Access identity (no session) gets no session elsewhere either.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match='sign in as yourself'):
        as_session(api, b.org, b.editor, '', "pulse.account_switch(%s,%s,'Browser')", (c.org, hashof('access-new')))
    # Nor may it change the account's own sign-in (password, handle, e-mails, one password for all).
    for sql, args in (("pulse.account_claim(null,'Taken-over-2026!')", ()), ("pulse.account_claim('otherhandle',null)", ()),
                      ("pulse.account_password_unify('x','Taken-over-2026!')", ()), ('pulse.account_email_start(%s)', ('user-e714be3c@gmail.com',)),
                      ('pulse.account_email_remove(%s)', (personal,)), ("pulse.acct_email_change('user-e714be3c@gmail.com',%s)", (hashof('chg'),))):
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match='[Ss]ign in as yourself'):
            as_session(api, b.org, b.editor, h, sql, args)
    # The person's own password can still reach everything (and a personal session may change things).
    pw = command(api, a, "pulse.account_sign_in(%s,'Synthetic-own-2026!',%s,'Browser',%s)", (handle, hashof('mine'), hashof('mine-ch')))
    assert live(owner, pw['org'], hashof('mine'))[0]['personal'] is True


def test_a_company_password_opens_only_that_company_once_the_account_is_protected(api, owner, worker, two):
    a, b, c, handle, account, personal = two
    owner_do(owner, "update pulse_priv.pulse_account set password_hash=null where id=%s", (account,))  # protected by the Gmail only
    pw = company_password(api, owner, c, c.editor)
    r = command(api, a, "pulse.account_sign_in(%s,%s,%s,'Browser',%s)", (handle, pw, hashof('cp'), hashof('cp-ch')))
    assert r['org'] == str(c.org) and r.get('companyOnly') is True
    assert live(owner, c.org, hashof('cp')) == [{'person_id': c.editor, 'personal': False}]
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match='sign in as yourself'):
        as_session(api, c.org, c.editor, hashof('cp'), 'pulse.account_move(%s,%s)', (b.org, hashof('cp')))


def test_an_unclaimed_account_keeps_switching_but_never_into_a_personal_space(api, owner, worker):
    b = build_world(worker, owner, api)
    c = build_world(worker, owner, api)
    s = build_world(worker, owner, api)
    handle, account = make_account(owner, b.org, b.editor)  # a company's e-mail (unproved), no password: nobody claimed it
    member(owner, account, c.org, c.editor)
    member(owner, account, s.org, s.editor)
    owner_do(owner, "update pulse.org set kind='personal', personal_account=%s where id=%s", (account, s.org), s.org)
    assert own(owner, 'pulse.org_is_personal(%s)', (s.org,)) is True
    for w, p in ((b, b.editor), (c, c.editor), (s, s.editor)):
        seat(worker, w.org, p, handle + '.' + w.code.lower())
    h = session(owner, b.org, b.editor, 'legacy')
    assert as_session(api, b.org, b.editor, h, 'pulse.account_move(%s,%s)', (c.org, h))['org'] == str(c.org)
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match='sign in as yourself'):
        as_session(api, c.org, c.editor, h, 'pulse.account_move(%s,%s)', (s.org, h))


def test_a_code_to_a_company_mailbox_opens_only_that_company(api, owner, worker):
    """A password-only account whose e-mail is the work address company c has on record: the code proves c's seat only."""
    a = build_world(worker, owner, api)
    b = build_world(worker, owner, api)
    c = build_world(worker, owner, api)
    handle, account = make_account(owner, b.org, b.editor, email=False, password='Synthetic-own-2026!')
    member(owner, account, c.org, c.editor)
    work = f'{handle}@{c.domain}'
    owner_do(owner, "update pulse_priv.pulse_account set email=%s, last_org=%s where id=%s", (work, b.org, account))
    seat(worker, b.org, b.editor, handle + '.b')
    seat(worker, c.org, c.editor, handle + '.c', work)
    sent = command(api, a, 'pulse.account_code_issue(%s)', ('@' + handle,))
    assert sent['delivery'] == work  # no personal e-mail yet: the account's own (work) e-mail gets it, as before
    done = command(api, a, "pulse.account_code_finish(%s,%s,%s,'Browser',%s)", ('@' + handle, sent['code'], hashof('wc'), b.org))
    assert done['org'] == str(c.org)  # not b, although b was asked first and used last
    assert live(owner, c.org, hashof('wc')) == [{'person_id': c.editor, 'personal': False}]


# ------------------------------------------------------------------------------------------------ Account access
def test_account_access_add_remove_primary(api, owner, two):
    a, b, c, handle, account, personal = two
    pw = command(api, a, "pulse.account_sign_in(%s,'Synthetic-own-2026!',%s,'Browser',%s)", (handle, hashof('acc'), hashof('acc-ch')))
    org, person = uuid.UUID(pw['org']), uuid.UUID(pw['person'])
    h = hashof('acc')
    view = as_session(api, org, person, h, 'pulse.account_access()')
    assert view['protected'] is True and view['personalSession'] is True and view['password'] is True
    assert [e['email'] for e in view['emails']] == [personal] and view['emails'][0]['personal'] is True
    assert any(s['current'] for s in view['sessions'])
    # A shared mailbox is refused before any code; a work e-mail needs the code and "only I read this".
    with pytest.raises(psycopg.errors.InvalidParameterValue, match='shared mailbox'):
        as_session(api, org, person, h, 'pulse.account_email_start(%s)', (f'hr@{c.domain}',))
    work = f'{handle}@{c.domain}'
    sent = as_session(api, org, person, h, 'pulse.account_email_start(%s)', (work,))
    assert sent['delivery'] == work and sent['masked'].endswith('@' + c.domain) and '••••' in sent['masked']
    with pytest.raises(psycopg.errors.InvalidParameterValue, match='Only I can read'):
        as_session(api, org, person, h, 'pulse.account_email_finish(%s,%s,false)', (work, sent['code']))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match='isn.t right'):
        as_session(api, org, person, h, "pulse.account_email_finish(%s,'000000',true)" if sent['code'] != '000000' else "pulse.account_email_finish(%s,'111111',true)", (work,))
    view = as_session(api, org, person, h, 'pulse.account_email_finish(%s,%s,true)', (work, sent['code']))
    added = [e for e in view['emails'] if e['email'] == work][0]
    assert added['personal'] is True and added['kind'] == 'work'  # proved and confirmed: it now signs in
    assert own(owner, 'pulse.acct_code_target(%s)', (work,), a.org) == account
    # Make it the main one: the Gmail stays a sign-in e-mail.
    view = as_session(api, org, person, h, 'pulse.account_email_primary(%s)', (work,))
    assert [e['email'] for e in view['emails'] if e['primary']] == [work] and personal in [e['email'] for e in view['emails']]
    # Remove one; the last personal sign-in can't go while there is no password.
    view = as_session(api, org, person, h, 'pulse.account_email_remove(%s)', (personal,))
    assert [e['email'] for e in view['emails']] == [work]
    owner_do(owner, "update pulse_priv.pulse_account set password_hash=null where id=%s", (account,))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match='Keep one e-mail'):
        as_session(api, org, person, h, 'pulse.account_email_remove(%s)', (work,))
    assert {'login_email_code_sent', 'login_email_added', 'login_email_primary', 'login_email_removed'} <= set(events(owner, account))


def test_an_email_of_another_account_is_refused_after_the_code(api, owner, worker, two):
    a, b, c, handle, account, personal = two
    other_handle, other = make_account(owner, None, None, email=False)
    taken = f'{other_handle}@gmail.com'
    owner_do(owner, "update pulse_priv.pulse_account set email=%s, email_verified_at=now() where id=%s", (taken, other))
    pw = command(api, a, "pulse.account_sign_in(%s,'Synthetic-own-2026!',%s,'Browser',%s)", (handle, hashof('o1'), hashof('o1-ch')))
    org, person = uuid.UUID(pw['org']), uuid.UUID(pw['person'])
    sent = as_session(api, org, person, hashof('o1'), 'pulse.account_email_start(%s)', (taken,))  # the same answer: nothing told yet
    with pytest.raises(psycopg.errors.UniqueViolation, match='another Pulse account'):
        as_session(api, org, person, hashof('o1'), 'pulse.account_email_finish(%s,%s,true)', (taken, sent['code']))


def test_the_report_lists_every_address_taken_off(owner, worker, api):
    w = build_world(worker, owner, api)
    handle, account = make_account(owner, w.org, w.editor, email=False)
    owner_do(owner, "update pulse_priv.pulse_account set email=%s where id=%s", (f'billing@{w.domain}', account))
    report = owner_do(owner, 'select pulse.account_meta_report() r')[0]['r']
    assert {'handle': handle, 'email': f'billing@{w.domain}', 'was': 'account', 'reason': 'shared_mailbox'}.items() <= \
        [r for r in report['removed'] if r['handle'] == handle][0].items()


# ------------------------------------------------------------------------------------------------ one photo everywhere
def test_the_persons_own_photo_reaches_every_seat_and_an_hr_photo_stays_put(owner, worker, api):
    b = build_world(worker, owner, api)
    c = build_world(worker, owner, api)
    d = build_world(worker, owner, api)
    handle, account = make_account(owner, b.org, b.editor)
    member(owner, account, c.org, c.editor)
    other_handle, other = make_account(owner, d.org, d.editor)
    owner_do(owner, "insert into pulse.person_photo(org_id,person_id,mime,bytes,updated_by) values(%s,%s,'image/png','\\x89504e47'::bytea,%s)", (b.org, b.editor, b.editor), b.org)
    owner_do(owner, "insert into pulse.person_photo(org_id,person_id,mime,bytes,updated_by) values(%s,%s,'image/png','\\x89504e48'::bytea,%s)", (d.org, d.editor, d.manager), d.org)
    owner_do(owner, "delete from pulse_priv.account_profile where account_id in (%s,%s)", (account, other))
    r = owner_do(owner, 'select pulse.account_photo_backfill() r')[0]['r']
    assert r['accounts'] >= 1 and r['seats'] >= 1
    seat_c = owner_do(owner, "select bytes from pulse.person_photo where person_id=%s", (c.editor,), c.org)
    assert seat_c and bytes(seat_c[0]['bytes']) == b'\x89PNG'  # the photo b's seat had, set by the person, now in c too
    assert owner_do(owner, "select photo_bytes from pulse_priv.account_profile where account_id=%s", (other,)) == []  # HR's photo is d's own
