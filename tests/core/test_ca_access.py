"""CA-ACCESS (owner, 8 Nov 2026): the CA preset's access matrix, on the database (db/migrations/1892_ca_access.sql).

Add people -> CA / accountant: only an admin adds one; the join link makes a CA seat with Finance read, Verified / Ask and
comments, and never salaries or HR unless the owner ticked that box. A CA's session must be past its second step. The
API's route list for a CA is services/api/test/accountant-access.test.mjs. Synthetic people and companies only."""
from __future__ import annotations

import hashlib
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb

from helpers import build_world
from pulse_sdk.db import set_tenant

PASSWORD = 'Synthetic-account-2026!'


def h(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def call(api, w, expression, args=(), viewer=None, session=None):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        if session:
            api.execute("select set_config('pulse.session_hash',%s,true)", (session,))
        return api.execute('select ' + expression + ' result', args).fetchone()['result']


def invite(api, w, viewer, **row):
    token = uuid.uuid4().hex
    row = {'hash': h(token), **row}
    out = call(api, w, 'pulse.onboard_invites(%s)', (Jsonb({'rows': [row]}),), viewer)
    return token, out[0]


def join(api, w, token, name, handle, email=None):
    """The signed-out join (POST /api/v0/auth/join): a new Pulse account and its seat; returns (person, session hash)."""
    session = h('session-' + token)
    with api.transaction():
        set_tenant(api, w.org)
        r = api.execute('select pulse.account_join(%s,%s,%s,%s) r', (h(token), Jsonb({'name': name, 'handle': handle, 'password': PASSWORD, **({'email': email} if email else {})}), session, 'Fixture')).fetchone()['r']
    return r['person'], session


def second_step(owner, w, person, session):
    """The sign-in finished its second step (only the sign-in functions set this flag; pulse_api cannot)."""
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute('update pulse.login_session set second_factor_verified=true where person_id=%s and token_hash=%s', (person, session))


@pytest.fixture
def world(worker, owner, api):
    w = build_world(worker, owner, api)
    tag = uuid.uuid4().hex[:8]
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, w.manager))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'hr','2020-01-01')", (w.org, w.lead))
        # The month's books: a bill, an invoice, a receipt; payroll as a monthly total and as one person's line.
        for kind, key, body in [
            ('purchase', f'bill-{tag}', {'date': 'today', 'vendor': 'Synthetic Prints', 'vendorGSTIN': '27ABCDE1234F1Z5', 'invoiceNo': 'SYN-101', 'taxable': 100, 'cgst': 9, 'sgst': 9, 'total': 118}),
            ('sales', f'inv-{tag}', {'date': 'today', 'vendor': 'Synthetic Homes', 'clientGSTIN': '27ABCDE1234F1Z5', 'invoiceNo': 'INV-7', 'taxable': 1000, 'igst': 180, 'total': 1180}),
            ('reimbursement', f'rcpt-{tag}', {'date': 'today', 'name': 'Editor One', 'vendor': 'Synthetic Cabs', 'total': 300}),
            ('payroll', f'pay-total-{tag}', {'month': '2026-10', 'name': 'All staff (monthly total)', 'kind': 'salary', 'amount': 90000, 'currency': 'INR'}),
            ('payroll', f'pay-one-{tag}', {'month': '2026-10', 'name': 'Synthetic Asha Line', 'kind': 'salary', 'amount': 45000, 'currency': 'INR'}),
        ]:
            if body.get('date') == 'today':
                body['date'] = worker.execute("select to_char(now() at time zone 'Asia/Kolkata','YYYY-MM-DD') d").fetchone()['d']
            worker.execute('insert into pulse_priv.finance_desk_record(org_id,kind,key,body,synthetic) values(%s,%s,%s,%s,false)', (w.org, kind, key, Jsonb(body)))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute('insert into pulse.hr_cofounder(org_id,person_id,assigned_by) values(%s,%s,%s)', (w.org, w.manager, w.manager))
        for permission in ['money.read', 'money.amount.read', 'money.plan.write']:
            owner.execute('insert into pulse.money_permission(org_id,person_id,permission) values(%s,%s,%s)', (w.org, w.manager, permission))
    w.tag = tag
    return w


def add_ca(api, owner, w, salaries=False):
    token, made = invite(api, w, w.manager, seat='accountant', channel='email', email=f'ca-{w.tag}-{int(salaries)}@example.test', caSalaries=salaries)
    assert made['status'] == 'created' and made['seat'] == 'accountant'
    ca, session = join(api, w, token, 'Synthetic CA Soniba', f'ca.{w.tag}.{int(salaries)}')
    return ca, session


def test_only_an_admin_adds_a_ca_and_the_link_says_what_they_get(api, world):
    w = world
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        invite(api, w, w.lead, seat='accountant', channel='email', email=f'hr-try-{w.tag}@example.test')   # HR is not an admin
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        invite(api, w, w.editor, seat='staff', channel='email', email=f'member-try-{w.tag}@example.test')
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        invite(api, w, w.lead, seat='partner', channel='email', email=f'hr-partner-{w.tag}@example.test')
    token, made = invite(api, w, w.manager, seat='accountant', channel='whatsapp', name='Synthetic CA Mifos', caSalaries=True)
    assert made['status'] == 'created' and made['email'] is None and made['channel'] == 'whatsapp'
    with api.transaction():
        peek = api.execute('select pulse.org_invite_peek(%s) p', (h(token),)).fetchone()['p']
    assert peek['seat'] == 'accountant' and peek['caSalaries'] is True and 'email' not in peek
    listed = call(api, w, 'pulse.org_invite_list()', viewer=w.manager)
    row = next(i for i in listed if i['name'] == 'Synthetic CA Mifos')
    assert (row['seat'], row['channel'], row['caSalaries'], row['email']) == ('accountant', 'whatsapp', True, None)


def test_ca_reads_finance_only_after_a_second_step(api, owner, world):
    w = world
    ca, session = add_ca(api, owner, w)
    assert call(api, w, 'pulse.is_accountant(%s)', (ca,), w.manager)
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute('select side from pulse.person where id=%s', (ca,)).fetchone()['side'] == 'staff'
        assert owner.execute('select count(*) n from pulse.role_assignment where person_id=%s', (ca,)).fetchone()['n'] == 0
        access = owner.execute('select salaries, revoked_at, expires_on > current_date + 300 long from pulse_priv.accountant_access where person_id=%s', (ca,)).fetchone()
        assert (access['salaries'], access['revoked_at'], access['long']) == (False, None, True)
    # A password alone opens nothing.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(api, w, 'pulse.finance_desk_state(false)', viewer=ca, session=session)
    second_step(owner, w, ca, session)
    state = call(api, w, 'pulse.finance_desk_state(false)', viewer=ca, session=session)
    kinds = {r['kind'] for r in state['records']}
    assert {'purchase', 'sales', 'reimbursement', 'payroll'} <= kinds
    assert state['salaries'] is False
    # No tick: payroll as the monthly total only, never a person's line.
    names = [r['body'].get('name') for r in state['records'] if r['kind'] == 'payroll']
    assert 'All staff (monthly total)' in names and 'Synthetic Asha Line' not in str(state)
    # A session of another person, or none, never borrows the CA's.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(api, w, 'pulse.finance_desk_state(false)', viewer=ca, session=h('someone-else'))


def test_ca_never_reaches_salaries_hr_or_the_owners_controls(api, owner, world):
    w = world
    ca, session = add_ca(api, owner, w)
    second_step(owner, w, ca, session)
    refused = [
        ('pulse.finance_desk_authorize(true)', ()),                      # no Finance writes
        ('pulse.finance_state()', ()),                                    # the owner's live Finance
        ('pulse.finance_ca_set(%s,true,false)', (ca,)),                   # cannot tick their own salaries
        ("pulse.accountant_grant(%s,'2099-12-31')", (ca,)),               # nor grant access
        ('pulse.onboard_invites(%s)', (Jsonb({'rows': [{'seat': 'staff', 'email': 'x@example.test', 'hash': h('x')}]}),)),
    ]
    for expression, args in refused:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            call(api, w, expression, args, viewer=ca, session=session)
    assert call(api, w, "pulse.hr_can('hr.salary.read')", viewer=ca, session=session) is False
    assert call(api, w, 'pulse.finance_ca_people()', viewer=ca, session=session) == []
    # The HR and pay tables are not the API role's to read at all.
    for table in ('pulse_priv.hr_compensation', 'pulse_priv.accountant_access', 'pulse_priv.finance_doc_check'):
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            set_tenant(api, w.org, ca)
            api.execute(f'select count(*) from {table}')


def test_the_owners_tick_shows_salaries_and_ending_access_closes_it(api, owner, world):
    w = world
    ca, session = add_ca(api, owner, w)
    cas = call(api, w, 'pulse.finance_ca_set(%s,true,false)', (ca,), w.manager)
    assert [c['salaries'] for c in cas if c['id'] == str(ca)] == [True]
    # The change signs the CA out: the old session no longer opens the books.
    second_step(owner, w, ca, session)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(api, w, 'pulse.finance_desk_state(false)', viewer=ca, session=session)
    fresh = h('fresh-' + w.tag)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.login_session(org_id,person_id,token_hash,expires_at,second_factor_verified) values(%s,%s,%s,now()+interval '1 day',true)", (w.org, ca, fresh))
    state = call(api, w, 'pulse.finance_desk_state(false)', viewer=ca, session=fresh)
    assert state['salaries'] is True and 'Synthetic Asha Line' in str(state)
    # A CA added with the tick from the start sees salaries too.
    ca2, s2 = add_ca(api, owner, w, salaries=True)
    second_step(owner, w, ca2, s2)
    assert call(api, w, 'pulse.finance_ca_salaries()', viewer=ca2, session=s2) is True
    # End access: closed at once.
    call(api, w, 'pulse.finance_ca_set(%s,null,true)', (ca,), w.manager)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.login_session(org_id,person_id,token_hash,expires_at,second_factor_verified) values(%s,%s,%s,now()+interval '1 day',true)", (w.org, ca, h('after-end')))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(api, w, 'pulse.finance_desk_state(false)', viewer=ca, session=h('after-end'))


def test_verified_ask_thread_and_month_close(api, owner, world):
    w = world
    ca, session = add_ca(api, owner, w)
    second_step(owner, w, ca, session)
    bill, inv = f'bill-{w.tag}', f'inv-{w.tag}'
    t = call(api, w, "pulse.finance_doc_mark(%s,'verified',null,false)", (bill,), ca, session)
    assert t['check']['status'] == 'verified' and t['notes'] == []
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        call(api, w, "pulse.finance_doc_mark(%s,'asked','',false)", (inv,), ca, session)          # a question needs words
    t = call(api, w, "pulse.finance_doc_mark(%s,'asked','The GSTIN on this invoice: is it the right branch?',false)", (inv,), ca, session)
    assert t['check']['status'] == 'asked' and t['notes'][0]['ca'] is True
    with pytest.raises(psycopg.errors.NoDataFound):
        call(api, w, "pulse.finance_doc_mark('not-a-bill','verified',null,false)", (), ca, session)
    with pytest.raises(psycopg.errors.NoDataFound):
        call(api, w, "pulse.finance_doc_mark(%s,'verified',null,false)", (f'pay-one-{w.tag}',), ca, session)   # payroll is no document to verify
    # Only the CA verifies; the owner answers in the thread.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(api, w, "pulse.finance_doc_mark(%s,'verified',null,false)", (inv,), w.manager)
    t = call(api, w, "pulse.finance_doc_note_add(%s,'Yes, it is our Pune branch.',false)", (inv,), w.manager)
    assert [n['ca'] for n in t['notes']] == [True, False] and t['notes'][1]['mine'] is True
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(api, w, "pulse.finance_doc_note_add(%s,'A member has no Finance',false)", (inv,), w.editor)
    t = call(api, w, "pulse.finance_doc_mark(%s,null,null,false)", (bill,), ca, session)
    assert t['check'] is None
    # The month-close steps.
    month = call(api, w, "to_char(now() at time zone 'Asia/Kolkata','YYYY-MM-01')::date")
    ticks = call(api, w, "pulse.finance_close_mark(%s,'gstr1',true,false)", (month,), ca, session)
    assert [x['item'] for x in ticks] == ['gstr1']
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        call(api, w, "pulse.finance_close_mark(%s,'itr',true,false)", (month,), ca, session)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        call(api, w, "pulse.finance_close_mark((now()+interval '2 months')::date,'gstr1',true,false)", (), ca, session)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(api, w, "pulse.finance_close_mark(%s,'tds',true,false)", (month,), w.editor)
    state = call(api, w, 'pulse.finance_desk_state(false)', viewer=w.manager)
    assert {(c['key'], c['status']) for c in state['checks']} == {(inv, 'asked')}
    assert [x['item'] for x in state['ticks']] == ['gstr1']


def test_switcher_counts_and_start_here(api, owner, world):
    w = world
    ca, session = add_ca(api, owner, w)
    second_step(owner, w, ca, session)
    looks = call(api, w, 'pulse.account_seat_looks()', viewer=ca, session=session)
    here = next(x for x in looks if x['id'] == str(w.org))
    assert here['access'] == 'accountant' and here['toVerify'] == 3   # the bill, the invoice and the receipt
    call(api, w, "pulse.finance_doc_mark(%s,'verified',null,false)", (f'bill-{w.tag}',), ca, session)
    call(api, w, "pulse.finance_doc_mark(%s,'asked','Which project is this cab for?',false)", (f'rcpt-{w.tag}',), ca, session)
    here = next(x for x in call(api, w, 'pulse.account_seat_looks()', viewer=ca, session=session) if x['id'] == str(w.org))
    assert here['toVerify'] == 2
    guide = call(api, w, 'pulse.onboarding_guide(false)', viewer=ca, session=session)
    assert guide['seat'] == 'accountant' and guide['roleSteps'] is True and guide['dismissed'] is False
    guide = call(api, w, "pulse.onboarding_mark('dismissed',true)", viewer=ca, session=session)
    assert guide['dismissed'] is True


def test_partner_vendor_and_client_seats(api, owner, world):
    w = world
    token, _ = invite(api, w, w.manager, seat='partner', channel='email', email=f'partner-{w.tag}@example.test')
    partner, _ = join(api, w, token, 'Synthetic Partner Rao', f'partner.{w.tag}')
    token, _ = invite(api, w, w.manager, seat='vendor', channel='sms', name='Synthetic Vendor')
    vendor, _ = join(api, w, token, 'Synthetic Vendor Kale', f'vendor.{w.tag}', email=f'vendor-{w.tag}@example.test')
    with owner.transaction():
        set_tenant(owner, w.org)
        assert [r['role_key'] for r in owner.execute('select role_key from pulse.role_assignment where person_id=%s', (partner,)).fetchall()] == ['leadership']
        v = owner.execute('select p.side, pp.role from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.id=%s', (vendor,)).fetchone()
        assert (v['side'], v['role']) == ('client', 'Vendor')
        rows = owner.execute('select person_id::text p, seat from pulse.onboarding_person where person_id in (%s,%s)', (partner, vendor)).fetchall()
        assert {r['p']: r['seat'] for r in rows} == {str(partner): 'partner', str(vendor): 'vendor'}
        assert owner.execute('select count(*) n from pulse_priv.accountant_access where person_id in (%s,%s)', (partner, vendor)).fetchone()['n'] == 0
    assert call(api, w, 'pulse.is_accountant(%s)', (vendor,), w.manager) is False
