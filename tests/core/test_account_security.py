"""Real-role account security tests on disposable tenants. No outbound mail or retained capabilities."""
import hashlib
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict
from conftest import dsn
from helpers import build_world
from pulse_sdk.db import set_tenant


def hashof(value):
    return hashlib.sha256(value.encode()).hexdigest()


@pytest.fixture
def auth_world(worker, owner, api):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, w.manager))
        for person, username, email in [(w.manager, 'auth.admin', 'admin@example.test'), (w.editor, 'auth.person', 'personal@gmail.example'), (w.editor2, 'auth.noemail', None)]:
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,email,evidence) values(%s,%s,'Editor',%s,%s,'{}')", (w.org, person, username, email))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        for person in [w.manager, w.editor, w.editor2]:
            api.execute("select pulse.login_issue(%s,'Synthetic-account-2026!')", (person,))
    command(api, w, "pulse.auth_login('staff','auth.person','Synthetic-account-2026!',%s,%s,false,'Browser')", (hashof('fixture-challenge' + str(w.org)), hashof('fixture-session' + str(w.org))))
    return w


def command(api, w, sql, args=(), viewer=None):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        return api.execute('select ' + sql + ' d', args).fetchone()['d']


def admin_link(api, w, name='link', action='reset', actor=None):
    return command(api, w, "pulse.auth_admin('staff',%s,%s,%s)", (actor or w.editor, action, json.dumps({'hash': hashof(name), 'confirmed': True})), w.manager)


def redeem(api, w, name='link', code='', session='session'):
    return command(api, w, "pulse.auth_redeem('staff',%s,'Fresh violet cedar river!',%s,%s,'Test browser')", (hashof(name), code, hashof(session + str(w.org))))


def sensitive(api, w, op, body, viewer=None):
    return command(api, w, "pulse.auth_account_action('staff',%s,%s,coalesce((select token_hash from pulse.login_session where person_id=pulse.current_viewer() and revoked_at is null and expires_at>now() order by created_at desc limit 1),%s))", (op, json.dumps({'current': 'Synthetic-account-2026!', **body}), hashof('session' + str(w.org))), viewer or w.editor)


def test_reset_replaces_old_links_single_use_and_ends_sessions(api, owner, auth_world):
    w = auth_world
    admin_link(api, w, 'old')
    admin_link(api, w, 'new')
    assert redeem(api, w, 'old') is None
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.login_session(org_id,person_id,token_hash,expires_at) values(%s,%s,%s,now()+interval '1 day')", (w.org, w.editor, hashof('previous')))
    assert redeem(api, w, 'new')['maxAge'] == 43200
    assert redeem(api, w, 'new') is None
    state = sensitive(api, w, 'state', {})
    assert len(state['sessions']) == 1
    assert state['sessions'][0]['thisDevice']
    with owner.transaction():
        set_tenant(owner, w.org)
        rows = owner.execute('select token_hash,used_at from pulse_priv.auth_link where actor=%s', (w.editor,)).fetchall()
        assert all(r['used_at'] for r in rows)
        assert all(len(r['token_hash']) == 64 for r in rows)


def test_expiry_disable_and_tenant_scope(api, owner, worker, auth_world):
    w = auth_world
    admin_link(api, w)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse_priv.auth_link set expires_at=now()-interval '1 second' where actor=%s", (w.editor,))
    assert redeem(api, w) is None
    admin_link(api, w, 'fresh')
    command(api, w, "pulse.auth_admin('staff',%s,'disable','{}')", (w.editor,), w.manager)
    assert redeem(api, w, 'fresh') is None
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        admin_link(api, w, 'disabled')
    command(api, w, "pulse.auth_admin('staff',%s,'enable','{}')", (w.editor,), w.manager)
    admin_link(api, w, 'enabled')
    other = build_world(worker, owner, api)
    assert command(api, other, "pulse.auth_redeem('staff',%s,'Fresh violet cedar river!','',%s,'Browser')", (hashof('enabled'), hashof('foreign'))) is None
    assert redeem(api, w, 'enabled')


def test_sign_in_takes_the_work_email_on_file(api, worker, auth_world):
    # SIGNIN-OFFICE (28 Oct 2026): the delivery address names the account like the username does; nothing else does.
    w = auth_world
    name = lambda typed: command(api, w, "pulse.auth_login_name('staff',%s)", (typed,))
    assert name('auth.person') == 'auth.person'
    assert name('  Personal@Gmail.Example ') == 'auth.person'
    assert name('nobody@example.test') == 'nobody@example.test'
    assert name('auth.noemail') == 'auth.noemail'
    signed = command(api, w, "pulse.auth_login('staff',pulse.auth_login_name('staff','PERSONAL@gmail.example'),'Synthetic-account-2026!',%s,%s,false,'Browser')",
                     (hashof('email-challenge' + str(w.org)), hashof('email-session' + str(w.org))))
    assert signed and not signed.get('failed')
    with worker.transaction():  # an address two people share signs in neither
        set_tenant(worker, w.org)
        worker.execute("update pulse.people_profile set email='personal@gmail.example' where person_id=%s", (w.editor2,))
    assert name('personal@gmail.example') == 'personal@gmail.example'


def test_recovery_username_email_and_missing_delivery_queue(api, auth_world):
    w = auth_world
    r = command(api, w, "pulse.auth_recover('staff','personal@gmail.example','username',%s)", (hashof('u'),))
    assert r['username'] == 'auth.person'
    assert command(api, w, "pulse.auth_recover('staff','nobody','reset',%s)", (hashof('n'),)) is None
    assert command(api, w, "pulse.auth_recover('staff','auth.noemail','reset',%s)", (hashof('none'),)) is None
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        assert api.execute("select count(*) n from pulse.password_reset_request where person_id=%s and status='pending'", (w.editor2,)).fetchone()['n'] == 1
    for n in range(3):
        command(api, w, "pulse.auth_recover('staff','auth.person','reset',%s)", (hashof('req' + str(n)),))
    assert command(api, w, "pulse.auth_recover('staff','auth.person','reset',%s)", (hashof('limited'),)) is None


def legacy_invite(owner, w, name='invite'):
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse_priv.staff_invitation(org_id,person_id,batch_id,username,status,token_hash,expires_at) values(%s,%s,gen_random_uuid(),'auth.person','prepared',%s,now()+interval '7 days')", (w.org, w.editor, hashof(name)))


@pytest.mark.parametrize('action', ['reset', 'copy'])
def test_admin_replacement_revokes_modern_legacy_and_recovery_links(api, owner, auth_world, action):
    w = auth_world
    modern, legacy, reset, fresh = [name + str(w.org) for name in ['modern-', 'legacy-', 'reset-', 'fresh-']]
    admin_link(api, w, modern, action='invite')
    legacy_invite(owner, w, legacy)
    assert command(api, w, "pulse.auth_recover('staff','auth.person','reset',%s)", (hashof(reset),))
    admin_link(api, w, fresh, action=action)
    for old in [modern, legacy, reset]:
        assert redeem(api, w, old) is None
        assert command(api, w, "pulse.invitation_redeem(%s,'Fresh violet cedar river!')", (hashof(old),)) is None
    assert redeem(api, w, fresh)


def test_admin_reinvite_revokes_outstanding_self_service_reset(api, auth_world):
    w = auth_world
    reset, invite = 'reset-' + str(w.org), 'invite-' + str(w.org)
    assert command(api, w, "pulse.auth_recover('staff','auth.person','reset',%s)", (hashof(reset),))
    admin_link(api, w, invite, action='invite')
    assert redeem(api, w, reset) is None
    assert redeem(api, w, invite)


@pytest.mark.parametrize('kind,use', [('modern', 'invite'), ('modern', 'reset'), ('legacy', 'invite'), ('legacy', 'reset'), ('legacy', 'legacy')])
def test_recovery_preserves_invites_until_atomic_password_setting(api, owner, worker, auth_world, kind, use):
    w = auth_world
    invite, reset_old, reset_new = ('invite-' + str(w.org), 'reset-old-' + str(w.org), 'reset-new-' + str(w.org))
    if kind == 'modern':
        admin_link(api, w, invite, action='invite')
    else:
        legacy_invite(owner, w, invite)
    for name in [reset_old, reset_new]:
        assert command(api, w, "pulse.auth_recover('staff','auth.person','reset',%s)", (hashof(name),))
    assert redeem(api, w, reset_old) is None
    assert command(api, w, "pulse.auth_redeem('client',%s,'Fresh violet cedar river!','',%s,'Browser')", (hashof(invite), hashof('foreign-realm'))) is None
    other = build_world(worker, owner, api)
    assert redeem(api, other, invite) is None
    if use == 'legacy':
        assert command(api, w, "pulse.invitation_redeem(%s,'Fresh violet cedar river!')", (hashof(invite),)) == w.editor
    else:
        assert redeem(api, w, invite if use == 'invite' else reset_new)
    assert redeem(api, w, invite) is None
    assert redeem(api, w, reset_new) is None
    assert command(api, w, "pulse.invitation_redeem(%s,'Fresh violet cedar river!')", (hashof(invite),)) is None


@pytest.mark.parametrize('kind', ['modern', 'legacy'])
def test_preserved_invite_expiry_is_not_extended_by_recovery(api, owner, auth_world, kind):
    w = auth_world
    expired, valid = 'expired-' + str(w.org), 'valid-' + str(w.org)
    if kind == 'modern':
        admin_link(api, w, expired, action='invite')
    else:
        legacy_invite(owner, w, expired)
    with owner.transaction():
        set_tenant(owner, w.org)
        table = 'auth_link' if kind == 'modern' else 'staff_invitation'
        owner.execute('update pulse_priv.' + table + " set expires_at=now()-interval '1 second' where token_hash=%s", (hashof(expired),))
    assert command(api, w, "pulse.auth_recover('staff','auth.person','reset',%s)", (hashof(valid),))
    assert redeem(api, w, expired) is None
    assert redeem(api, w, valid)


def test_legacy_invite_cannot_bypass_two_step_with_coexisting_reset(api, owner, auth_world):
    w = auth_world
    invite, reset = 'invite-' + str(w.org), 'reset-' + str(w.org)
    setup = sensitive(api, w, 'totp-start', {})
    with owner.transaction():
        set_tenant(owner, w.org)
        code = owner.execute("select pulse.auth_totp(decode(%s,'hex'),floor(extract(epoch from now())/30)::bigint) code", (setup['secretHex'],)).fetchone()['code']
    codes = sensitive(api, w, 'totp-enable', {'code': code})['recoveryCodes']
    legacy_invite(owner, w, invite)
    assert command(api, w, "pulse.auth_recover('staff','auth.person','reset',%s)", (hashof(reset),))
    assert command(api, w, "pulse.invitation_redeem(%s,'Fresh violet cedar river!')", (hashof(invite),)) is None
    assert redeem(api, w, invite)['twoStep']
    assert redeem(api, w, invite, code=codes[0])
    assert redeem(api, w, reset) is None


def test_concurrent_legacy_invite_and_reset_have_one_password_setting_winner(api, owner, auth_world):
    w = auth_world
    invite, reset = 'invite-' + str(w.org), 'reset-' + str(w.org)
    legacy_invite(owner, w, invite)
    assert command(api, w, "pulse.auth_recover('staff','auth.person','reset',%s)", (hashof(reset),))
    barrier = Barrier(2)

    def attempt(legacy):
        with psycopg.connect(dsn('api'), autocommit=True, row_factory=psycopg.rows.dict_row) as connection:
            barrier.wait(timeout=10)
            if legacy:
                return command(connection, w, "pulse.invitation_redeem(%s,'Fresh violet cedar river!')", (hashof(invite),))
            return redeem(connection, w, reset)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(attempt, [True, False]))
    assert sum(result is not None for result in results) == 1
    assert redeem(api, w, invite) is None
    assert redeem(api, w, reset) is None


def test_privilege_checks_owner_and_hr_boundaries(api, worker, auth_world):
    w = auth_world
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        command(api, w, "pulse.auth_admin('staff',%s,'unlock','{}')", (w.editor2,), w.editor)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'hr','2020-01-01')", (w.org, w.editor))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        admin_args = (w.manager, 'reset', json.dumps({'hash': hashof('hr-owner')}))
        command(api, w, "pulse.auth_admin('staff',%s,%s,%s)", admin_args, w.editor)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        command(api, w, "pulse.auth_admin('staff',%s,'disable','{}')", (w.manager,), w.manager)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        command(api, w, "pulse.auth_admin('staff',%s,'two-step-reset','{}')", (w.editor,), w.manager)


@pytest.mark.parametrize('role', ['admin', 'leadership', 'video_editor'])
def test_recovery_before_first_activation(api, owner, worker, role):
    w = build_world(worker, owner, api)
    first_name, second_name = 'first-' + str(w.org), 'second-' + str(w.org)
    with worker.transaction():
        set_tenant(worker, w.org)
        if role != 'video_editor':
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, w.editor, role))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,email,evidence) values(%s,%s,'Editor','unactivated.person','confirmed@example.test','{}')", (w.org, w.editor))
    # No password has ever existed, matching an unactivated owner account.
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute('select count(*) n from pulse.login_credential where person_id=%s', (w.editor,)).fetchone()['n'] == 0
    assert command(api, w, "pulse.auth_recover('staff','confirmed@example.test','username',%s)", (hashof('find'),))['username'] == 'unactivated.person'
    first = command(api, w, "pulse.auth_recover('staff','unactivated.person','reset',%s)", (hashof(first_name),))
    assert first['delivery'] == 'confirmed@example.test'
    assert command(api, w, "pulse.auth_recover('staff','confirmed@example.test','reset',%s)", (hashof(second_name),))['actor'] == str(w.editor)
    assert redeem(api, w, first_name) is None
    assert redeem(api, w, second_name)['maxAge'] == 43200
    assert redeem(api, w, second_name) is None
    assert command(api, w, "pulse.auth_login('staff','unactivated.person','Fresh violet cedar river!',%s,%s,false,'Browser')", (hashof('login-challenge' + str(w.org)), hashof('login-session' + str(w.org))))['maxAge'] == 43200


def test_recovery_still_excludes_disabled_inactive_and_ambiguous_accounts(api, owner, worker, auth_world):
    w = auth_world
    command(api, w, "pulse.auth_admin('staff',%s,'disable','{}')", (w.editor,), w.manager)
    assert command(api, w, "pulse.auth_recover('staff','auth.person','reset',%s)", (hashof('disabled'),)) is None
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.person set status='inactive' where id=%s", (w.manager,))
    assert command(api, w, "pulse.auth_recover('staff','auth.admin','reset',%s)", (hashof('inactive'),)) is None
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,email,evidence) values(%s,%s,'Editor','unactivated.other','shared@example.test','{}')", (w.org, w.lead))
        worker.execute("update pulse.people_profile set email='shared@example.test' where person_id=%s", (w.editor2,))
    assert command(api, w, "pulse.auth_recover('staff','shared@example.test','reset',%s)", (hashof('ambiguous'),)) is None
    assert command(api, w, "pulse.auth_recover('staff','unactivated.other','reset',%s)", (hashof('unique'),))['actor'] == str(w.lead)


def test_copy_requires_confirmation_and_audits_no_secret(api, owner, auth_world):
    w = auth_world
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        command(api, w, "pulse.auth_admin('staff',%s,'copy',%s)", (w.editor2, json.dumps({'hash': hashof('private')})), w.manager)
    admin_link(api, w, 'private', action='copy', actor=w.editor2)
    assert redeem_other(api, w, 'private', w.editor2)
    with owner.transaction():
        set_tenant(owner, w.org)
        events = owner.execute('select action,device from pulse_priv.auth_event where actor=%s', (w.editor2,)).fetchall()
        assert any(r['action'] == 'private_link_copied' for r in events)
        assert all('private' not in str(r['device']) for r in events)


def redeem_other(api, w, token, actor):
    return command(api, w, "pulse.auth_redeem('staff',%s,'Fresh violet cedar river!','',%s,'Browser')", (hashof(token), hashof(str(actor))))


def test_email_confirmation_single_use_old_and_new_notice_data(api, auth_world):
    w = auth_world
    result = sensitive(api, w, 'email-start', {'email': 'new@gmail.example', 'hash': hashof('email')})
    assert result['delivery'] == 'new@gmail.example'
    assert sensitive(api, w, 'state', {})['delivery'] == 'personal@gmail.example'
    result = command(api, w, "pulse.auth_email_confirm('staff',%s)", (hashof('email'),))
    assert result['oldDelivery'] == 'personal@gmail.example'
    assert result['delivery'] == 'new@gmail.example'
    assert command(api, w, "pulse.auth_email_confirm('staff',%s)", (hashof('email'),)) is None
    assert sensitive(api, w, 'state', {})['delivery'] == 'new@gmail.example'


def test_current_password_required_and_other_session_sign_out(api, auth_world):
    w = auth_world
    for n in range(2):
        result = command(api, w, "pulse.auth_login('staff','auth.person','Synthetic-account-2026!',%s,%s,true,'Browser')", (hashof('ch'+str(n)), hashof('device'+str(n))))
        assert result['maxAge'] == 2592000
    assert sensitive(api, w, 'change-password', {'current': 'wrong', 'next': 'Changed violet cedar river!'})['error']
    sensitive(api, w, 'sign-out-others', {})
    assert len(sensitive(api, w, 'state', {})['sessions']) == 1
    assert sensitive(api, w, 'change-password', {'next': 'Changed violet cedar river!'})['ok']


def test_totp_rfc_vector_setup_challenge_replay_recovery_and_admin_reset(api, owner, auth_world):
    w = auth_world
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select pulse.auth_totp(convert_to('12345678901234567890','UTF8'),1) code").fetchone()['code'] == '287082'
    setup = sensitive(api, w, 'totp-start', {})
    assert len(setup['secretHex']) == 40
    with owner.transaction():
        set_tenant(owner, w.org)
        code = owner.execute("select pulse.auth_totp(decode(%s,'hex'),floor(extract(epoch from now())/30)::bigint) code", (setup['secretHex'],)).fetchone()['code']
    assert sensitive(api, w, 'totp-enable', {'code': 'invalid'})['error']
    codes = sensitive(api, w, 'totp-enable', {'code': code})['recoveryCodes']
    assert len(codes) == 10
    result = command(api, w, "pulse.auth_login('staff','auth.person','Synthetic-account-2026!',%s,%s,false,'Phone')", (hashof('challenge'), hashof('no-session')))
    assert result == {'twoStep': True}
    assert len(sensitive(api, w, 'state', {})['sessions']) == 1
    assert command(api, w, "pulse.auth_challenge_finish('staff',%s,%s,%s)", (hashof('challenge'), code, hashof('replay'))) is None
    assert command(api, w, "pulse.auth_challenge_finish('staff',%s,%s,%s)", (hashof('challenge'), codes[0], hashof('otp-session')))
    assert command(api, w, "pulse.auth_challenge_finish('staff',%s,%s,%s)", (hashof('challenge'), codes[1], hashof('reused-challenge'))) is None
    assert sensitive(api, w, 'state', {})['recoveryRemaining'] == 9
    admin_link(api, w)
    assert redeem(api, w)['twoStep']
    assert redeem(api, w, code=codes[0])['twoStep']
    assert redeem(api, w, code=codes[1])
    with owner.transaction():
        set_tenant(owner, w.org)
        row = owner.execute("select totp,recovery from pulse_priv.auth_account where actor=%s", (w.editor,)).fetchone()
        assert bytes(row['totp']) != bytes.fromhex(setup['secretHex'])
        assert all(len(c) == 64 for c in row['recovery'])
    command(api, w, "pulse.auth_admin('staff',%s,'two-step-reset',%s)", (w.editor, json.dumps({'confirmed': True, 'reason': 'Checked identity in person'})), w.manager)
    assert not sensitive(api, w, 'state', {})['twoStep']
    assert not sensitive(api, w, 'state', {})['sessions']


def test_lockout_uniform_failed_results_unlock_and_disabled(api, auth_world):
    w = auth_world
    for n in range(5):
        result = command(api, w, "pulse.auth_login('staff','auth.person','wrong',%s,%s,false,'Browser')", (hashof('bad'+str(n)), hashof('b'+str(n))))
        assert result['failed']
    assert result['delivery'] == 'personal@gmail.example'
    locked = command(api, w, "pulse.auth_login('staff','auth.person','Synthetic-account-2026!',%s,%s,false,'Browser')", (hashof('locked'), hashof('lockedsession')))
    assert locked['failed']
    command(api, w, "pulse.auth_admin('staff',%s,'unlock','{}')", (w.editor,), w.manager)
    assert command(api, w, "pulse.auth_login('staff','auth.person','Synthetic-account-2026!',%s,%s,false,'Browser')", (hashof('unlocked'), hashof('unlockedsession')))['maxAge'] == 43200


def test_owner_policy_grace_and_exemption(api, owner, worker, auth_world):
    w = auth_world
    assert not command(api, w, 'pulse.auth_policy_save()', viewer=w.manager)['required']
    result = command(api, w, 'pulse.auth_policy_save(%s)', (json.dumps({'required': True}),), w.manager)
    assert result['graceUntil']
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'hr','2020-01-01')", (w.org, w.editor))
    assert not command(api, w, 'pulse.auth_enforcement(%s)', (w.editor,))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse_priv.auth_policy set grace_until=now()-interval '1 second' where org_id=%s", (w.org,))
    assert command(api, w, 'pulse.auth_enforcement(%s)', (w.editor,))
    assert not command(api, w, 'pulse.auth_enforcement(%s)', (w.manager,))



def test_guided_two_step_asks_required_roles_once_the_grace_ends(api, owner, worker, auth_world):
    """TWO-STEP-GUIDE: auth_two_step_due asks admin, HR and leadership once the organisation's grace period has ended
    (never inside it), and stops asking once an authenticator is set up."""
    w = auth_world
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'hr','2020-01-01')", (w.org, w.editor))
    assert not command(api, w, 'pulse.auth_two_step_due(%s)', (w.editor,))
    command(api, w, 'pulse.auth_policy_save(%s)', (json.dumps({'required': True}),), w.manager)
    assert not command(api, w, 'pulse.auth_two_step_due(%s)', (w.editor,))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse_priv.auth_policy set grace_until=now()-interval '1 second' where org_id=%s", (w.org,))
    assert command(api, w, 'pulse.auth_two_step_due(%s)', (w.editor,))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse_priv.auth_key values(%s,gen_random_bytes(32)) on conflict do nothing", (w.org,))
        owner.execute("insert into pulse_priv.auth_account(org_id,realm,actor,totp) select %s,'staff',%s,pgp_sym_encrypt_bytea(gen_random_bytes(20),encode(key,'hex')) "
                      "from pulse_priv.auth_key where org_id=%s on conflict(org_id,realm,actor) do update set totp=excluded.totp", (w.org, w.editor, w.org))
    assert not command(api, w, 'pulse.auth_two_step_due(%s)', (w.editor,))



def test_setup_again_keeps_the_waiting_key_for_a_day_and_a_code_may_drift_one_step(api, owner, auth_world):
    """TWO-STEP-GUIDE: starting setup a second time returns the key already waiting, so the phone entry from the first
    try still works (two tries failed on 30 Oct when the second start replaced it). "Start over" (fresh) and a key older
    than 24 hours (or from before the change, with no time) make a new key. A code from the previous 30 seconds counts;
    one from 90 seconds ago does not."""
    w = auth_world
    first = sensitive(api, w, 'totp-start', {})['secretHex']
    assert sensitive(api, w, 'totp-start', {})['secretHex'] == first
    fresh = sensitive(api, w, 'totp-start', {'fresh': True})['secretHex']
    assert fresh != first and sensitive(api, w, 'totp-start', {})['secretHex'] == fresh

    def age(when):
        with owner.transaction():
            set_tenant(owner, w.org)
            owner.execute(f"update pulse_priv.auth_account set pending_totp_at={when} where org_id=%s and pending_totp is not null", (w.org,))
    age("now()-interval '25 hours'")
    day_old = sensitive(api, w, 'totp-start', {})['secretHex']
    assert day_old != fresh
    age('null')
    key = sensitive(api, w, 'totp-start', {})['secretHex']
    assert key != day_old

    def code(offset):
        with owner.transaction():
            set_tenant(owner, w.org)
            return owner.execute("select pulse.auth_totp(decode(%s,'hex'),floor(extract(epoch from now())/30)::bigint+%s) code",
                                 (key, offset)).fetchone()['code']
    assert sensitive(api, w, 'totp-enable', {'code': code(-3)})['error'] == 'Enter a fresh authenticator code'
    assert len(sensitive(api, w, 'totp-enable', {'code': code(-1)})['recoveryCodes']) == 10


def test_client_namespace_separate_link_and_sessions(api, auth_world):
    w = auth_world
    result = command(api, w, "pulse.auth_client_create('auth.person','Client person','client@gmail.example',%s)", (hashof('client-invite'),), w.manager)
    assert result['actor'] != str(w.editor)
    assert redeem(api, w, 'client-invite') is None
    result = command(api, w, "pulse.auth_redeem('client',%s,'Client violet cedar river!','',%s,'Phone')", (hashof('client-invite'), hashof('client-session')))
    assert result['maxAge'] == 43200
    with api.transaction():
        set_tenant(api, w.org)
        me = api.execute('select pulse.portal_auth(%s) d', (hashof('client-session'),)).fetchone()['d']
        assert me['role'] == 'client'
        state = api.execute("select pulse.auth_account_action('client','state','{}',%s) d", (hashof('client-session'),)).fetchone()['d']
        assert state['sessions'][0]['thisDevice']
        assert state['delivery'] == 'client@gmail.example'


def test_private_tables_unreadable_and_internal_helpers_not_executable(api, auth_world):
    w = auth_world
    for table in ['auth_key', 'auth_account', 'auth_link', 'auth_challenge', 'auth_event']:
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            set_tenant(api, w.org)
            api.execute('select * from pulse_priv.' + table)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        command(api, w, "pulse.auth_session('staff',%s,%s,false,'forged')", (w.editor, hashof('forged')))


def test_account_http_and_browser_flows(api, worker, owner, auth_world, tmp_path):
    w = auth_world
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, w.lead))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,email,evidence) values(%s,%s,'Editor','auth.unactivated.admin','unactivated@example.test','{}')", (w.org, w.lead))
    with owner.transaction():
        set_tenant(owner, w.org)
        original_org_name = owner.execute("select name from pulse.org where id=%s", (w.org,)).fetchone()["name"]
        owner.execute("update pulse.org set name=%s where id=%s", ('Northwind Studio', w.org))
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_ORG_ID': str(w.org), 'TEST_PERSON': str(w.editor), 'TEST_ADMIN': str(w.manager), 'TEST_OTHER':str(w.editor2), 'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '1', 'PULSE_AUTH_MAIL_MODE': 'sink', 'PULSE_AUTH_REPORT': str(tmp_path / 'auth.json')}
    root = Path(__file__).resolve().parents[2]
    try:
        proc = subprocess.run(['node', 'test/account-security-runner.mjs'], cwd=root / 'services/api', env=env, capture_output=True, text=True, timeout=360)
    finally:
        with owner.transaction():
            set_tenant(owner, w.org)
            owner.execute("update pulse.org set name=%s where id=%s", (original_org_name, w.org))
    assert proc.returncode == 0, proc.stderr[-8000:]
    result = json.loads((tmp_path / 'auth.json').read_text())
    assert result['apiChecks'] >= 30
    if env.get('PULSE_AUTH_BROWSER') == '1':
        assert result['browserChecks'] >= 50
    receipt = os.environ.get('PULSE_AUTH_RECEIPT')
    if not receipt and os.environ.get('PULSE_MATRIX_RECEIPT'):
        receipt = str(Path(os.environ['PULSE_MATRIX_RECEIPT']).with_name('auth-flows.json'))
    if receipt:
        Path(receipt).write_text(json.dumps(result, indent=2) + '\n')


def test_native_device_visible_and_revocable_from_account(api, owner, auth_world):
    w = auth_world
    admin_link(api, w, 'native-activation')
    assert redeem(api, w, 'native-activation')
    with owner.transaction():
        set_tenant(owner, w.org)
        device = owner.execute("insert into pulse.native_device(org_id,person_id,name,platform) values(%s,%s,'Synthetic phone','android') returning id", (w.org, w.editor)).fetchone()['id']
    command(api, w, 'pulse.auth_native_issue(%s,%s,%s,%s)', (device, hashof('native-access' + str(w.org)), hashof('native-refresh' + str(w.org)), hashof('session' + str(w.org))), w.editor)
    state = sensitive(api, w, 'state', {})
    assert any(s['id'] == str(device) and 'Native app' in s['device'] for s in state['sessions'])
    sensitive(api, w, 'session-end', {'id': str(device)})
    with api.transaction():
        set_tenant(api, w.org)
        assert api.execute('select * from pulse.native_token_resolve(%s)', (hashof('native-access' + str(w.org)),)).fetchone() is None
    sensitive(api, w, 'sign-out-others', {})
    command(api, w, "pulse.auth_logout('staff',%s)", (hashof('session' + str(w.org)),))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        command(api, w, 'pulse.auth_native_issue(%s,%s,%s,%s)', (device, hashof('revoked-access'), hashof('revoked-refresh'), hashof('session' + str(w.org))), w.editor)


def test_disable_before_invitation_blocks_all_links(api, owner, auth_world):
    w = auth_world
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute('delete from pulse.login_credential where person_id=%s', (w.editor2,))
    command(api, w, "pulse.auth_admin('staff',%s,'disable','{}')", (w.editor2,), w.manager)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        admin_link(api, w, 'offboarded', 'copy', w.editor2)
    command(api, w, "pulse.auth_admin('staff',%s,'enable','{}')", (w.editor2,), w.manager)
    assert admin_link(api, w, 'reenabled', 'copy', w.editor2)


def test_pending_two_step_session_cannot_survive_concurrent_sign_out(api, owner, auth_world):
    import threading
    import time

    w = auth_world
    setup = sensitive(api, w, 'totp-start', {})
    with owner.transaction():
        set_tenant(owner, w.org)
        code = owner.execute("select pulse.auth_totp(decode(%s,'hex'),floor(extract(epoch from now())/30)::bigint) code", (setup['secretHex'],)).fetchone()['code']
    codes = sensitive(api, w, 'totp-enable', {'code': code})['recoveryCodes']
    challenge = hashof('concurrent-challenge' + str(w.org))
    assert command(api, w, "pulse.auth_login('staff','auth.person','Synthetic-account-2026!',%s,%s,false,'Phone')", (challenge, hashof('unissued' + str(w.org))))['twoStep']
    ready = threading.Event()
    done = threading.Event()
    errors = []

    def revoke():
        try:
            with psycopg.connect(dsn('api'), autocommit=True) as second, second.transaction():
                set_tenant(second, w.org, w.manager)
                ready.set()
                second.execute("select pulse.auth_admin('staff',%s,'sign-out-all','{}')", (w.editor,))
        except Exception as error:
            errors.append(type(error).__name__)
        finally:
            done.set()

    with api.transaction():
        set_tenant(api, w.org)
        result = api.execute("select pulse.auth_challenge_finish('staff',%s,%s,%s) d", (challenge, codes[0], hashof('pending-session' + str(w.org)))).fetchone()['d']
        assert result
        thread = threading.Thread(target=revoke, daemon=True)
        thread.start()
        assert ready.wait(2)
        time.sleep(0.1)
        assert not done.is_set()
    thread.join(5)
    assert done.is_set() and not errors
    assert sensitive(api, w, 'state', {})['sessions'] == []


def test_sign_out_in_own_activity(api, auth_world):
    w = auth_world
    admin_link(api, w, 'logout')
    redeem(api, w, 'logout')
    command(api, w, "pulse.auth_logout('staff',%s)", (hashof('session' + str(w.org)),))
    result = command(api, w, "pulse.auth_admin('staff',%s,'history','{}')", (w.editor,), w.manager)
    assert any(event['action'] == 'sign_out' for event in result['activity'])


def test_revoked_browser_cannot_finish_sensitive_account_change(api, auth_world):
    w = auth_world
    old_session = hashof('fixture-session' + str(w.org))
    command(api, w, "pulse.auth_admin('staff',%s,'sign-out-all','{}')", (w.editor,), w.manager)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        command(api, w, "pulse.auth_account_action('staff','totp-start',%s,%s)", (json.dumps({'current': 'Synthetic-account-2026!'}), old_session), w.editor)


def email_action(api, w, op, body, actor=None, viewer=None):
    return command(api, w, "pulse.auth_admin_email(%s,%s,%s)",
                   (actor or w.editor2, op, json.dumps(body)), viewer or w.manager)


def test_inline_email_draft_does_not_invite_or_change_delivery_or_sessions(api, owner, auth_world):
    w = auth_world
    before = sensitive(api, w, 'state', {})
    email_action(api, w, 'email-delivery-save', {'email': '  DRAFT@example.test  '}, w.editor)
    after = sensitive(api, w, 'state', {})
    assert after['delivery'] == before['delivery']
    assert [s['id'] for s in after['sessions']] == [s['id'] for s in before['sessions']]
    state = email_action(api, w, 'email-state', {}, w.editor)
    assert state['draftDelivery'] == 'draft@example.test'
    assert state['emailPending'] is None
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select count(*) n from pulse_priv.auth_link where org_id=%s and actor=%s", (w.org, w.editor)).fetchone()['n'] == 0
    result = email_action(api, w, 'email-delivery-verify', {'hash': hashof('draft-confirm')}, w.editor)
    assert result['delivery'] == 'draft@example.test'
    assert sensitive(api, w, 'state', {})['delivery'] == before['delivery']
    assert command(api, w, "pulse.auth_email_confirm('staff',%s)", (hashof('draft-confirm'),))['delivery'] == 'draft@example.test'
    state = email_action(api, w, 'email-state', {}, w.editor)
    assert state['draftDelivery'] is None
    assert state['verifiedDelivery'] == 'draft@example.test'
    assert state['emailPending'] is None


def test_inline_email_validation_permissions_and_work_audit(api, owner, worker, auth_world):
    w = auth_world
    for value in ['', 'invalid', 'bad@localhost', 'x' * 250 + '@example.test', 'admin@example.test']:
        for op in ['email-work-save', 'email-delivery-save']:
            with pytest.raises(psycopg.errors.InvalidParameterValue):
                email_action(api, w, op, {'email': value})
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        email_action(api, w, 'email-delivery-save', {'email': 'own@example.test'}, w.editor, w.editor)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'hr','2020-01-01')", (w.org, w.editor))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        email_action(api, w, 'email-work-save', {'email': 'owner@example.test'}, w.manager, w.editor)
    email_action(api, w, 'email-work-save', {'email': ' WORK@example.test '})
    state = email_action(api, w, 'email-state', {})
    assert state['workEmail'] == 'work@example.test'
    with owner.transaction():
        set_tenant(owner, w.org)
        assert 'email' in owner.execute('select locked from pulse.people_profile where person_id=%s', (w.editor2,)).fetchone()['locked']
        assert owner.execute("select count(*) n from pulse.record_change where org_id=%s and entity_id=%s and field='email'", (w.org, str(w.editor2))).fetchone()['n'] == 1
    assert email_action(api, w, 'email-work-save', {'email': 'work@example.test'})['ok']
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select count(*) n from pulse.record_change where org_id=%s and entity_id=%s and field='email'", (w.org, str(w.editor2))).fetchone()['n'] == 1
    other = build_world(worker, owner, api)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        command(api, other, "pulse.auth_admin_email(%s,'email-state','{}')", (w.editor2,), other.manager)


def test_saved_delivery_replaces_pending_and_uniqueness_rechecked_at_confirmation(api, owner, auth_world):
    w = auth_world
    email_action(api, w, 'email-delivery-save', {'email': 'first@example.test'}, w.editor)
    email_action(api, w, 'email-delivery-verify', {'hash': hashof('first')}, w.editor)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        email_action(api, w, 'email-delivery-save', {'email': 'FIRST@example.test'})
    email_action(api, w, 'email-delivery-save', {'email': 'second@example.test'}, w.editor)
    assert command(api, w, "pulse.auth_email_confirm('staff',%s)", (hashof('first'),)) is None
    email_action(api, w, 'email-delivery-verify', {'hash': hashof('second')}, w.editor)
    # A legacy profile writer can still change a profile between issue and redemption.
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.people_profile set email='second@example.test' where person_id=%s", (w.editor2,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        command(api, w, "pulse.auth_email_confirm('staff',%s)", (hashof('second'),))
    assert sensitive(api, w, 'state', {})['delivery'] == 'personal@gmail.example'
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse_priv.auth_link set expires_at=now()-interval '1 second' where actor=%s and kind='email'", (w.editor,))
    assert command(api, w, "pulse.auth_email_confirm('staff',%s)", (hashof('second'),)) is None


def test_account_access_drawer_http_browser(api, auth_world, tmp_path):
    w = auth_world
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_ORG_ID': str(w.org),
           'TEST_PERSON': str(w.editor), 'TEST_ADMIN': str(w.manager), 'TEST_OTHER': str(w.editor2),
           'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '1', 'PULSE_AUTH_MAIL_MODE': 'sink',
           'PULSE_AUTH_REPORT': str(tmp_path / 'account-access.json')}
    root = Path(__file__).resolve().parents[2]
    proc = subprocess.run(['node', 'test/account-access-runner.mjs'], cwd=root / 'services/api', env=env,
                          capture_output=True, text=True, timeout=360)
    assert proc.returncode == 0, proc.stderr[-8000:]
    result = json.loads((tmp_path / 'account-access.json').read_text())
    assert result['apiChecks'] >= 20
    if env.get('PULSE_AUTH_BROWSER') == '1':
        assert result['browserChecks'] >= 40
    if os.environ.get('PULSE_MATRIX_RECEIPT'):
        Path(os.environ['PULSE_MATRIX_RECEIPT']).with_name('account-access.json').write_text(json.dumps(result, indent=2) + '\n')



def test_delivery_email_can_be_confirmed_before_first_invitation(api, owner, auth_world):
    import uuid

    w = auth_world
    person = uuid.uuid4()
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic new starter','staff')", (person, w.org))
        owner.execute("insert into pulse.people_profile(org_id,person_id,role,evidence) values(%s,%s,'Editor','{}')", (w.org, person))
    email_action(api, w, 'email-delivery-save', {'email': 'starter@example.test'}, person)
    email_action(api, w, 'email-delivery-verify', {'hash': hashof('starter-confirm')}, person)
    assert command(api, w, "pulse.auth_email_confirm('staff',%s)", (hashof('starter-confirm'),))['delivery'] == 'starter@example.test'
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute('select count(*) n from pulse.login_credential where person_id=%s', (person,)).fetchone()['n'] == 0
        assert owner.execute("select count(*) n from pulse_priv.auth_link where actor=%s and kind in('invite','reset')", (person,)).fetchone()['n'] == 0
    state = command(api, w, "pulse.auth_admin('staff',%s,'history','{}')", (person,), w.manager)
    assert state['authStatus'] == 'not invited'
