"""SWITCH-SMOOTH (owner, 16 Nov 2026 03:18 IST): "Once you are in the Pulse account, switching between companies should be
easy ... I don't even know what my password is. Asking again and again is a hazard." Synthetic companies, people, devices
and addresses only (*.example and made-up consumer addresses); no mail leaves (the database answers what the API sends).
- a trusted device: a browser that proved the person (any personal session on it) is theirs for 180 days, and every
  session of that account on it, in every company, is personal; never another account's, never a desktop device's or a
  tab's child session, never renewed by its own lift; forgetting it asks there again;
- Google / Microsoft with the account's own personal address prove the person; a company's Google stays in its company;
  a shared mailbox (admin@) is still refused;
- a session from before 2125 (personal = false) on a browser that proved the person is lifted silently; on any other
  browser it is asked once;
- "Email me a code": the code goes only to the account's own e-mail (never admin@ or a company's record), wrong codes
  count, the right one makes the session personal and the switch goes through;
- the switcher knows before it starts which companies need a proof."""
import psycopg
import pytest
from test_account_security import command, hashof
from test_account_code import owner_do, make_account
from test_account_meta import seat, member, company_password, session, as_session, live, two  # noqa: F401  (two: fixture)

D = hashof('device-laptop')      # the hash of a browser's device key, as the API passes it
E = hashof('device-other-pc')


def seen(api, h, device):
    with api.transaction():
        return api.execute('select pulse.acct_device_seen(%s,%s) d', (h, device)).fetchone()['d']


def trust(api, h, device, proof='code'):
    with api.transaction():
        return api.execute('select pulse.acct_device_trust(%s,%s,%s) d', (h, device, proof)).fetchone()['d']


def device_rows(owner, account):
    return owner_do(owner, "select device_hash, proof, revoked_at is not null gone, expires_at > now() + interval '179 days' fresh "
                           "from pulse_priv.account_device where account_id=%s order by created_at", (account,))


def refused(api, org, person, h, to):
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match='sign in as yourself') as e:
        as_session(api, org, person, h, 'pulse.account_move(%s,%s)', (to, h))
    assert e.value.diag.message_hint == 'personal_sign_in'


# ------------------------------------------------------------------------------------------------ 1. trusted device
def test_a_browser_that_proved_the_person_makes_every_sign_in_of_theirs_on_it_personal(api, owner, two):
    a, b, c, handle, account, personal = two
    company = session(owner, b.org, b.editor, 'td-company')            # e.g. company b's own password, staff code or Google
    assert seen(api, company, D) == 'company' and live(owner, b.org, company)[0]['personal'] is False
    refused(api, b.org, b.editor, company, c.org)
    # The person proves themselves on this browser once (their Gmail code, say): the browser is theirs from then on.
    proved = session(owner, c.org, c.editor, 'td-proved', personal=True)
    assert seen(api, proved, D) == 'trusted'
    assert device_rows(owner, account) == [{'device_hash': D, 'proof': 'session', 'gone': False, 'fresh': True}]
    assert seen(api, proved, D) == 'personal'                           # nothing more to do
    # Every session of the account on it, in every company, is personal: the company sign-in is lifted and switches.
    assert seen(api, company, D) == 'lifted' and live(owner, b.org, company)[0]['personal'] is True
    moved = as_session(api, b.org, b.editor, company, 'pulse.account_move(%s,%s)', (c.org, company))
    assert moved['org'] == str(c.org)
    assert owner_do(owner, "select count(*) n from pulse.audit_event where action='device_trusted_sign_in' and org_id=%s", (b.org,), b.org)[0]['n'] == 1
    # Another browser that never proved the person: its company sign-in stays in its company (owner's rule unchanged).
    elsewhere = session(owner, b.org, b.editor, 'td-elsewhere')
    assert seen(api, elsewhere, E) == 'company' and live(owner, b.org, elsewhere)[0]['personal'] is False
    refused(api, b.org, b.editor, elsewhere, c.org)


def test_a_trusted_browser_never_lifts_another_account_a_desktop_device_or_a_tab_child(api, owner, worker, two):
    a, b, c, handle, account, personal = two
    assert seen(api, session(owner, c.org, c.editor, 'tn-proved', personal=True), D) == 'trusted'
    # Someone else signs in on the same browser with their company's sign-in: not lifted (the trust is the account's).
    _, other = make_account(owner, b.org, b.manager, email=False, password='Synthetic-other-2026!')
    member(owner, other, c.org, c.manager)
    theirs = session(owner, b.org, b.manager, 'tn-theirs')
    assert seen(api, theirs, D) == 'company' and live(owner, b.org, theirs)[0]['personal'] is False
    # A person with no account (a company's staff only): nothing.
    assert seen(api, session(owner, a.org, a.editor, 'tn-noacct'), D) == 'none'
    # A tab's child session and a desktop device's session are never lifted here (the browser's own sign-in is).
    child = hashof('tn-child')
    owner_do(owner, "insert into pulse.login_session(org_id,person_id,token_hash,expires_at,via,parent_hash) values(%s,%s,%s,now()+interval '1 day','account',%s)",
             (b.org, b.editor, child, hashof('tn-parent')), b.org)
    assert seen(api, child, D) == 'none' and live(owner, b.org, child)[0]['personal'] is False
    assert seen(api, hashof('tn-nobody'), D) == 'none' and seen(api, None, D) == 'none' and seen(api, theirs, 'short') == 'none'


def test_a_trust_runs_out_after_180_days_and_its_own_lift_never_renews_it(api, owner, two):
    a, b, c, handle, account, personal = two
    assert seen(api, session(owner, c.org, c.editor, 'tr-proved', personal=True), D) == 'trusted'
    lifted = session(owner, b.org, b.editor, 'tr-lifted')
    assert seen(api, lifted, D) == 'lifted'
    owner_do(owner, "update pulse_priv.account_device set expires_at=now()-interval '1 second' where account_id=%s", (account,))
    assert seen(api, lifted, D) == 'personal'                            # the session keeps what it had, until it ends
    assert device_rows(owner, account)[0]['fresh'] is False              # ... but the trust is not renewed by it
    fresh = session(owner, b.org, b.editor, 'tr-fresh')
    assert seen(api, fresh, D) == 'company'                              # a new company sign-in is asked again
    refused(api, b.org, b.editor, fresh, c.org)
    # A new proof (the API calls acct_device_trust right after it) trusts the browser for 180 days from now.
    assert trust(api, fresh, D) is False                                 # a company session proves nothing
    proved = session(owner, c.org, c.editor, 'tr-new-proof', personal=True)
    assert trust(api, proved, D, 'google') is True
    assert device_rows(owner, account) == [{'device_hash': D, 'proof': 'google', 'gone': False, 'fresh': True}]
    assert seen(api, fresh, D) == 'lifted'


def test_forgetting_a_browser_asks_there_again_and_only_the_persons_own_sign_in_may(api, owner, two):
    a, b, c, handle, account, personal = two
    proved = session(owner, c.org, c.editor, 'tf-proved', personal=True)
    assert seen(api, proved, D) == 'trusted'
    lifted = session(owner, b.org, b.editor, 'tf-lifted')
    assert seen(api, lifted, D) == 'lifted'
    other = session(owner, c.org, c.editor, 'tf-other-pc', personal=True)
    assert seen(api, other, E) == 'trusted'
    listed = as_session(api, c.org, c.editor, other, 'pulse.account_devices(%s)', (E,))
    assert listed['personal'] is True and [d['thisDevice'] for d in listed['devices']] == [True, False]
    # A company-only session cannot forget anyone's browsers.
    company = session(owner, b.org, b.editor, 'tf-company')
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match='Sign in as yourself'):
        as_session(api, b.org, b.editor, company, 'pulse.account_device_forget(null,%s)', (E,))
    # From the other PC, forget the laptop: the laptop's sessions are no longer personal (still signed in, in b / c).
    laptop = next(d['id'] for d in listed['devices'] if not d['thisDevice'])
    after = as_session(api, c.org, c.editor, other, 'pulse.account_device_forget(%s,%s)', (laptop, E))
    assert after['forgotten'] == 1 and len(after['devices']) == 1
    assert live(owner, b.org, lifted)[0]['personal'] is False and live(owner, c.org, proved)[0]['personal'] is False
    assert live(owner, c.org, other)[0]['personal'] is True
    assert seen(api, lifted, D) == 'company' and seen(api, proved, D) == 'company'   # forgotten stays forgotten
    refused(api, b.org, b.editor, lifted, c.org)
    # Proving again there trusts it again.
    again = session(owner, c.org, c.editor, 'tf-again', personal=True)
    assert trust(api, again, D, 'code') is True and seen(api, lifted, D) == 'lifted'


# ------------------------------------------------------------------------------------------------ 2. Google / Microsoft
def test_google_or_microsoft_with_the_persons_own_gmail_is_a_personal_proof(api, owner, two):
    a, b, c, handle, account, personal = two
    company_password(api, owner, c, c.editor)
    owner_do(owner, "insert into pulse_priv.google_settings(org_id,enabled,allowed_domains) values(%s,true,array[%s]) on conflict (org_id) do update set enabled=true, allowed_domains=excluded.allowed_domains", (c.org, c.domain), c.org)
    own_google = '{"iss":"https://accounts.google.com","sub":"g-own","email":"%s","email_verified":true}' % personal
    r = command(api, c, "pulse.google_sign_in_any(%s::jsonb,%s,%s,'Browser')", (own_google, hashof('g-own-ch'), hashof('g-own')))
    assert 'error' not in r, r
    assert live(owner, c.org, hashof('g-own')) == [{'person_id': c.editor, 'personal': True}]
    as_session(api, c.org, c.editor, hashof('g-own'), 'pulse.account_move(%s,%s)', (b.org, hashof('g-own')))
    # The company's Google with the work e-mail on company c's record: that company only.
    work = '{"iss":"https://accounts.google.com","sub":"g-work","email":"%s@%s","email_verified":true,"hd":"%s"}' % (handle, c.domain, c.domain)
    r = command(api, c, "pulse.google_sign_in_any(%s::jsonb,%s,%s,'Browser')", (work, hashof('g-work-ch'), hashof('g-work')))
    assert 'error' not in r, r
    assert live(owner, c.org, hashof('g-work')) == [{'person_id': c.editor, 'personal': False}]
    refused(api, c.org, c.editor, hashof('g-work'), b.org)
    # An address Google did not verify proves nothing, even the right one.
    unverified = '{"iss":"https://accounts.google.com","sub":"g-unv","email":"%s","email_verified":false}' % personal
    assert command(api, c, "pulse.google_sign_in_any(%s::jsonb,%s,%s,'Browser')", (unverified, hashof('g-unv-ch'), hashof('g-unv'))) == {'error': 'provider_error'}
    # Microsoft with the same own address proves the person too; admin@ is still nobody.
    ms = '{"iss":"https://login.microsoftonline.com/x","email":"%s","email_verified":true}' % personal
    r = command(api, c, "pulse.oidc_sign_in_any('microsoft',%s::jsonb,%s,%s,'Browser')", (ms, hashof('ms-own-ch'), hashof('ms-own')))
    assert 'error' not in r, r
    assert live(owner, c.org, hashof('ms-own'))[0]['personal'] is True
    shared = '{"iss":"https://accounts.google.com","sub":"g-admin","email":"admin@%s","email_verified":true,"hd":"%s"}' % (c.domain, c.domain)
    assert command(api, c, "pulse.google_sign_in_any(%s::jsonb,%s,%s,'Browser')", (shared, hashof('g-adm-ch'), hashof('g-adm'))) == {'error': 'not_linked'}
    assert live(owner, c.org, hashof('g-adm')) == []


# ------------------------------------------------------------------------------------------------ 3. sessions from before 2125
def test_a_session_from_before_2125_on_a_browser_that_proved_the_person_is_lifted_silently(api, owner, two):
    a, b, c, handle, account, personal = two
    old = hashof('pre-2125-laptop')
    owner_do(owner, "insert into pulse.login_session(org_id,person_id,token_hash,created_at,expires_at,via,device) values(%s,%s,%s,'2026-11-01',now()+interval '10 days','account','Chrome on Windows')",
             (b.org, b.editor, old), b.org)
    # The browser proved the person before (a personal session there: e.g. "Confirm it's you" at 03:20).
    assert seen(api, session(owner, c.org, c.editor, 'pre-proved', personal=True), D) == 'trusted'
    assert seen(api, old, D) == 'lifted'
    assert as_session(api, b.org, b.editor, old, 'pulse.account_move(%s,%s)', (c.org, old))['org'] == str(c.org)
    # The same kind of session on a phone that never proved the person: asked once (4), never lifted silently.
    phone = hashof('pre-2125-phone')
    owner_do(owner, "insert into pulse.login_session(org_id,person_id,token_hash,created_at,expires_at,via,device) values(%s,%s,%s,'2026-11-01',now()+interval '10 days','account','Safari on iPhone')",
             (b.org, b.editor, phone), b.org)
    assert seen(api, phone, E) == 'company'
    refused(api, b.org, b.editor, phone, c.org)


# ------------------------------------------------------------------------------------------------ 4. "Email me a code"
def test_email_me_a_code_proves_the_person_without_a_password(api, owner, two):
    a, b, c, handle, account, personal = two
    h = session(owner, b.org, b.editor, 'code-company')                 # company b's own sign-in (its record says admin@)
    sent = as_session(api, b.org, b.editor, h, 'pulse.account_prove_code_start()')
    assert sent['delivery'] == personal and sent['masked'] == personal[0] + '••••@gmail.com'   # never admin@ or the work e-mail
    assert as_session(api, b.org, b.editor, h, 'pulse.account_prove_code_finish(%s)', ('000000' if sent['code'] != '000000' else '111111',)) == {'wrong': True, 'expired': False}
    assert owner_do(owner, 'select tries from pulse_priv.account_prove_code where account_id=%s', (account,))[0]['tries'] == 1
    assert live(owner, b.org, h)[0]['personal'] is False
    # Pasted with spaces: still the code.
    assert as_session(api, b.org, b.editor, h, 'pulse.account_prove_code_finish(%s)', (' ' + sent['code'][:3] + ' ' + sent['code'][3:],)) == {'personal': True}
    assert live(owner, b.org, h)[0]['personal'] is True
    assert as_session(api, b.org, b.editor, h, 'pulse.account_move(%s,%s)', (c.org, h))['org'] == str(c.org)
    # A used code does not work twice; the browser is trusted by the API right after (acct_device_trust).
    assert trust(api, h, D, 'code') is True
    again = session(owner, b.org, b.editor, 'code-again')
    assert as_session(api, b.org, b.editor, again, 'pulse.account_prove_code_finish(%s)', (sent['code'],)) == {'wrong': True, 'expired': True}
    # One a minute.
    with pytest.raises(psycopg.errors.ProgramLimitExceeded, match='a moment ago'):
        as_session(api, b.org, b.editor, again, 'pulse.account_prove_code_start()')


def test_five_wrong_codes_end_the_code(api, owner, two):
    a, b, c, handle, account, personal = two
    h = session(owner, b.org, b.editor, 'code-five')
    sent = as_session(api, b.org, b.editor, h, 'pulse.account_prove_code_start()')
    wrong = '000000' if sent['code'] != '000000' else '111111'
    for _ in range(4):
        assert as_session(api, b.org, b.editor, h, 'pulse.account_prove_code_finish(%s)', (wrong,))['wrong'] is True
    assert as_session(api, b.org, b.editor, h, 'pulse.account_prove_code_finish(%s)', (wrong,)) == {'wrong': True, 'expired': True}
    assert as_session(api, b.org, b.editor, h, 'pulse.account_prove_code_finish(%s)', (sent['code'],)) == {'wrong': True, 'expired': True}
    assert live(owner, b.org, h)[0]['personal'] is False


def test_a_shared_or_company_mailbox_never_gets_a_proof_code(api, owner, worker, two):
    a, b, c, handle, account, personal = two
    # An account whose e-mail would be admin@ (taken off by 2125) and whose only other address is a company's work e-mail.
    _, work_only = make_account(owner, b.org, b.manager, email=False, password='Synthetic-work-2026!')
    owner_do(owner, "update pulse_priv.pulse_account set email=%s, email_verified_at=now() where id=%s", (f'admin@{b.domain}', work_only))
    owner_do(owner, "insert into pulse_priv.account_login_email(email,account_id,verified_at,source,kind) values(%s,%s,now(),'self','work')", (f'synthetic.lead@{b.domain}', work_only))
    h = session(owner, b.org, b.manager, 'code-shared')
    assert as_session(api, b.org, b.manager, h, 'pulse.account_prove_code_start()') == {'noEmail': True}
    assert owner_do(owner, 'select count(*) n from pulse_priv.account_prove_code where account_id=%s', (work_only,))[0]['n'] == 0
    # Signed out, or from a session that is not the caller's own: refused.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_session(api, b.org, b.manager, hashof('not-a-session'), 'pulse.account_prove_code_start()')


# ------------------------------------------------------------------------------------------------ 5. the switcher
def test_the_switcher_knows_which_companies_need_a_proof_before_it_starts(api, owner, two):
    a, b, c, handle, account, personal = two
    company = session(owner, b.org, b.editor, 'sw-company')
    known = as_session(api, b.org, b.editor, company, 'pulse.account_crossing()')
    assert known == {'personal': False, 'locked': [str(c.org)], 'ways': {'code': personal[0] + '••••@gmail.com', 'password': True}}
    mine = session(owner, b.org, b.editor, 'sw-personal', personal=True)
    assert as_session(api, b.org, b.editor, mine, 'pulse.account_crossing()')['locked'] == []
    # After one proof on the browser (trusted, then lifted), nothing is locked any more.
    assert seen(api, mine, D) == 'trusted' and seen(api, company, D) == 'lifted'
    assert as_session(api, b.org, b.editor, company, 'pulse.account_crossing()')['locked'] == []
