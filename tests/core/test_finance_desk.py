"""RF1 real service-role checks: expiring Accountant access and private evidence."""
import hashlib

import psycopg
import pytest
from psycopg.types.json import Jsonb

from helpers import build_world
from pulse_sdk.db import set_tenant


def hashof(value):
    return hashlib.sha256(value.encode()).hexdigest()


def call(api, w, expression, args=(), viewer=None, session=None):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        if session:
            api.execute("select set_config('pulse.session_hash',%s,true)", (session,))
        return api.execute('select ' + expression + ' result', args).fetchone()['result']


@pytest.fixture
def finance_world(worker, owner, api):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, w.manager))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,email,evidence) values(%s,%s,'Accountant','rf1.ca','ca@example.test','{}')", (w.org, w.editor))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,email,evidence) values(%s,%s,'CS','rf1.cs','cs@example.test','{}')", (w.org, w.editor2))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.hr_cofounder(org_id,person_id,assigned_by) values(%s,%s,%s)", (w.org,w.manager,w.manager))
        owner.execute("delete from pulse.role_assignment where person_id in (%s,%s)", (w.editor, w.editor2))
        for permission in ['money.read', 'money.amount.read', 'money.plan.write']:
            owner.execute("insert into pulse.money_permission(org_id,person_id,permission) values(%s,%s,%s)", (w.org, w.manager, permission))
    call(api, w, "pulse.accountant_grant(%s,'2099-12-31')", (w.editor,), w.manager)
    call(api, w, "pulse.accountant_grant(%s,'2099-12-31')", (w.editor2,), w.manager)
    call(api, w, "pulse.login_issue(%s,'Synthetic-account-2026!')", (w.editor,), w.manager)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.login_credential set must_change=false where person_id=%s", (w.editor,))
    bootstrap = hashof('rf1-bootstrap' + str(w.org))
    call(api, w, "pulse.auth_login('staff','rf1.ca','Synthetic-account-2026!',%s,%s,false,'Fixture')", (hashof('bootstrap-challenge' + str(w.org)), bootstrap))
    setup = call(api, w, "pulse.auth_account_action('staff','totp-start',%s,%s)", (Jsonb({'current': 'Synthetic-account-2026!'}), bootstrap), w.editor)
    with owner.transaction():
        otp = owner.execute("select pulse.auth_totp(decode(%s,'hex'),floor(extract(epoch from clock_timestamp())/30)::bigint) code", (setup['secretHex'],)).fetchone()['code']
    enabled = call(api, w, "pulse.auth_account_action('staff','totp-enable',%s,%s)", (Jsonb({'code': otp, 'current': 'Synthetic-account-2026!'}), bootstrap), w.editor)
    challenge, session = hashof('rf1-challenge' + str(w.org)), hashof('rf1-verified' + str(w.org))
    assert call(api, w, "pulse.auth_login('staff','rf1.ca','Synthetic-account-2026!',%s,%s,false,'Fixture')", (challenge, hashof('unused' + str(w.org))))['twoStep']
    assert call(api, w, "pulse.auth_challenge_finish('staff',%s,%s,%s)", (challenge, enabled['recoveryCodes'][0], session))
    return w, bootstrap, session


def test_accountant_requires_verified_session_not_just_enrollment(api, finance_world):
    w, bootstrap, verified = finance_world
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(api, w, 'pulse.finance_desk_state(true)', viewer=w.editor, session=bootstrap)
    assert call(api, w, 'pulse.finance_desk_state(true)', viewer=w.editor, session=verified)['records'] == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(api, w, 'pulse.finance_desk_authorize(true)', viewer=w.editor, session=verified)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(api, w, "pulse.finance_desk_send_claim('close:2026-09',true)", viewer=w.editor, session=verified)
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute('update pulse.login_session set second_factor_verified=true where person_id=%s', (w.editor,))


def test_expiry_revocation_and_separate_ca_cs_principals(api, owner, finance_world):
    w, _, verified = finance_world
    assert call(api, w, 'pulse.is_accountant(%s)', (w.editor2,), w.editor, verified)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(api, w, 'pulse.finance_desk_state()', viewer=w.editor2, session=verified)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse_priv.accountant_access set expires_on=current_date-1 where person_id=%s", (w.editor,))
    assert call(api, w, 'pulse.is_accountant(%s)', (w.editor,), w.editor, verified)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(api, w, 'pulse.finance_desk_state()', viewer=w.editor, session=verified)
    call(api, w, "pulse.accountant_grant(%s,'2099-12-31',true)", (w.editor,), w.manager)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(api, w, 'pulse.finance_desk_state()', viewer=w.editor, session=verified)


def test_fixture_and_live_evidence_are_separate_and_each_read_is_audited(api, worker, owner, finance_world):
    w, _, verified = finance_world
    with worker.transaction():
        set_tenant(worker, w.org)
        for synthetic, label in [(True, 'Synthetic'), (False, 'Live')]:
            worker.execute('insert into pulse_priv.finance_desk_record(org_id,kind,key,body,synthetic) values(%s,%s,%s,%s,%s)', (w.org, 'purchase', 'same-key', Jsonb({'vendor': label}), synthetic))
            worker.execute('insert into pulse_priv.finance_desk_file(org_id,key,name,mime,bytes,synthetic) values(%s,%s,%s,%s,%s,%s)', (w.org, 'same-key', label + '.pdf', 'application/pdf', label.encode(), synthetic))
        worker.execute("insert into pulse_priv.finance_desk_record(org_id,kind,key,body) values(%s,'brief','founder-only','{}')", (w.org,))
    fixture = call(api, w, 'pulse.finance_desk_state(true)', viewer=w.editor, session=verified)
    live = call(api, w, 'pulse.finance_desk_state(false)', viewer=w.editor, session=verified)
    assert fixture['records'][0]['body']['vendor'] == 'Synthetic'
    assert live['records'][0]['body']['vendor'] == 'Live'
    assert all(r['kind'] != 'brief' for r in fixture['records'])
    file = call(api, w, "pulse.finance_desk_file_get('same-key',true)", viewer=w.editor, session=verified)
    assert file['name'] == 'Synthetic.pdf'
    with owner.transaction():
        set_tenant(owner, w.org)
        # Audit detail is limited to domain and evidence keys, never credentials.
        assert owner.execute("select count(*) n from pulse.audit_event where org_id=%s and actor_id=%s and resource like 'finance.%%' and action='restricted_read'", (w.org,w.editor)).fetchone()['n'] >= 3


def test_draft_cannot_send_without_founder_and_duplicate_claim_is_rejected(api, worker, finance_world):
    w, _, _ = finance_world
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse_priv.finance_desk_record(org_id,kind,key,body) values(%s,'close','close:2026-09',%s)", (w.org, Jsonb({'to': 'ca@example.test', 'subject': 'Synthetic close', 'emailBody': 'Fixture'})))
    draft = call(api, w, "pulse.finance_desk_send_claim('close:2026-09',true)", viewer=w.manager)
    assert draft['synthetic']
    with pytest.raises(psycopg.errors.UniqueViolation):
        call(api, w, "pulse.finance_desk_send_claim('close:2026-09',true)", viewer=w.manager)
    call(api, w, "pulse.finance_desk_send_finish('close:2026-09','sink',true)", viewer=w.manager)
    state = call(api, w, 'pulse.finance_desk_state(true)', viewer=w.manager)
    assert state['sends'] == [{'key': 'close:2026-09', 'status': 'sink'}]


def test_worker_replay_register_is_idempotent_and_api_has_no_direct_evidence_write(api, worker, finance_world):
    w, _, verified = finance_world
    with worker.transaction():
        set_tenant(worker, w.org)
        for _ in range(2):
            worker.execute("insert into pulse_priv.finance_desk_record(org_id,kind,key,body) values(%s,'purchase','invoice-1','{}') on conflict do nothing", (w.org,))
    assert len(call(api, w, 'pulse.finance_desk_state(true)', viewer=w.editor, session=verified)['records']) == 1
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("insert into pulse_priv.finance_desk_record(org_id,kind,key,body) values(%s,'purchase','forged','{}')", (w.org,))


def test_founder_brief_is_once_per_day_in_app_no_external_mail_and_rechecks_founder_access(worker, owner, api, finance_world):
    from datetime import datetime, timezone
    from pulse_workers.finance_tick import tick

    w, _, _ = finance_world
    at = datetime(2026,10,9,15,30,tzinfo=timezone.utc)
    with worker.transaction():
        set_tenant(worker,w.org)
        tick(worker,w.org,at)
        tick(worker,w.org,at)
    with owner.transaction():
        set_tenant(owner,w.org)
        rows = owner.execute("select id,title from pulse.notification where org_id=%s and person_id=%s and event_key='rf1:brief:2026-10-09'", (w.org,w.manager)).fetchall()
        assert len(rows) == 1
        assert 'Money in: unknown' in rows[0]['title']
        assert owner.execute("select count(*) n from pulse.hr_mail_outbox where org_id=%s and notification_id=%s", (w.org,rows[0]['id'])).fetchone()['n'] == 0
        owner.execute("update pulse.hr_cofounder set active=false where person_id=%s", (w.manager,))
    with worker.transaction():
        set_tenant(worker,w.org)
        assert not worker.execute("select pulse.notification_authorized(%s,%s) allowed", (rows[0]['id'],w.manager)).fetchone()['allowed']


def test_accountant_payroll_has_only_financial_fields(api,worker,finance_world):
    from pulse_workers.finance_tick import refresh_payroll
    w,_,session = finance_world
    with worker.transaction():
        set_tenant(worker,w.org)
        worker.execute("insert into pulse_priv.hr_compensation(org_id,person_id,effective_month,kind,amount,currency,source_file_id,source_name,source_sheet,basis) values(%s,%s,'2026-09-01','monthly',1000,'INR','fixture-source','Private source','Salary','Private evidence detail')", (w.org,w.lead))
        refresh_payroll(worker,w.org)
    data = call(api,w,'pulse.finance_desk_state(false)',viewer=w.editor,session=session)
    payroll = next(r['body'] for r in data['records'] if r['kind']=='payroll')
    assert set(payroll) == {'month','name','kind','amount','currency','components','basis'}
    # FIN-LIVE: individual salaries stay in the HR salary area; the desk shows one monthly total.
    assert payroll['amount']==1000 and payroll['name']=='All staff (monthly total)' and payroll['components']=='1 people'
    assert 'Project Lead' not in str(data['records'])
    assert 'Private evidence detail' not in payroll['basis']
