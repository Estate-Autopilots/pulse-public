"""TWO-STEP-FACTORS (owner, 30 Oct 2026): a passkey or e-mailed codes as the second step, beside the authenticator app
(synthetic people only). The WebAuthn signature checks are in services/api/test/two-step-factors.test.mjs; here the
database side: who may add, which sign-in a passkey answers, single use, counters, rationed e-mail codes, backup codes."""
import base64
import json

from pulse_sdk.db import set_tenant
from test_account_security import auth_world, command, hashof, sensitive  # noqa: F401 (auth_world is a fixture)

PW = 'Synthetic-account-2026!'


def sign_in(api, w, name):
    return command(api, w, "pulse.auth_login('staff','auth.person',%s,%s,%s,false,'Browser')", (PW, hashof(name), hashof(name + '-session')))


def test_passkey_is_a_second_step_from_adding_to_signing_in(api, owner, worker, auth_world):
    w = auth_world
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'hr','2020-01-01')", (w.org, w.editor))
    command(api, w, 'pulse.auth_policy_save(%s)', (json.dumps({'required': True}),), w.manager)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse_priv.auth_policy set grace_until=now()-interval '1 second' where org_id=%s", (w.org,))
    assert command(api, w, 'pulse.auth_two_step_due(%s)', (w.editor,))
    assert not command(api, w, "pulse.auth_second_factor('staff',%s)", (w.editor,))
    reg, cred_id = 'reg-' + str(w.org), 'cred-' + str(w.org)
    begin = command(api, w, "pulse.auth_passkey_begin('staff','register',null,%s)", (reg,), w.editor)
    assert begin['actor'] == str(w.editor) and begin['credentials'] == []
    assert command(api, w, "pulse.auth_passkey_begin('staff','register',null,%s)", ('reg-nobody',)) is None
    cred = {'id': cred_id, 'publicKey': base64.b64encode(b'synthetic-cose-key').decode(), 'counter': 0, 'transports': ['internal'], 'name': 'Windows computer'}
    assert command(api, w, "pulse.auth_passkey_add('staff',%s,%s)", (reg, json.dumps(cred)), w.manager)['error']
    added = command(api, w, "pulse.auth_passkey_add('staff',%s,%s)", (reg, json.dumps(cred)), w.editor)
    assert len(added['recoveryCodes']) == 10
    assert command(api, w, "pulse.auth_passkey_add('staff',%s,%s)", (reg, json.dumps(cred)), w.editor)['error']
    assert command(api, w, "pulse.auth_second_factor('staff',%s)", (w.editor,))
    assert not command(api, w, 'pulse.auth_two_step_due(%s)', (w.editor,))

    assert sign_in(api, w, 'pk-login')['twoStep']
    h, ch = hashof('pk-login'), 'auth-' + str(w.org)
    assert command(api, w, "pulse.auth_challenge_methods('staff',%s)", (h,)) == {'authenticator': False, 'passkey': True, 'email': False}
    assert command(api, w, "pulse.auth_passkey_begin('staff','two-step',%s,%s)", (h, ch))['credentials'][0]['id'] == cred_id
    assert command(api, w, "pulse.auth_passkey_for('staff',%s,%s,%s)", (ch, h, cred_id))['publicKey'] == cred['publicKey']
    assert command(api, w, "pulse.auth_passkey_for('staff',%s,%s,%s)", (ch, hashof('another-sign-in'), cred_id)) is None
    assert command(api, w, "pulse.auth_passkey_for('staff',%s,%s,%s)", (ch, h, 'someone-elses-passkey')) is None
    done = command(api, w, "pulse.auth_challenge_finish_passkey('staff',%s,%s,%s,5,%s)", (h, ch, cred_id, hashof('pk-session')))
    assert done and done['actor'] == str(w.editor)
    assert command(api, w, "pulse.auth_challenge_finish_passkey('staff',%s,%s,%s,6,%s)", (h, ch, cred_id, hashof('pk-session-2'))) is None
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select second_factor_verified s from pulse.login_session where token_hash=%s", (hashof('pk-session'),)).fetchone()['s']
        assert owner.execute("select sign_count n from pulse_priv.auth_passkey where credential_id=%s", (cred_id,)).fetchone()['n'] == 5

    # Without an authenticator, a backup code still finishes a sign-in, once.
    assert sign_in(api, w, 'pk-login-2')['twoStep']
    assert command(api, w, "pulse.auth_challenge_finish('staff',%s,%s,%s)", (hashof('pk-login-2'), added['recoveryCodes'][0], hashof('pk-session-3')))
    assert sign_in(api, w, 'pk-login-3')['twoStep']
    assert command(api, w, "pulse.auth_challenge_finish('staff',%s,%s,%s)", (hashof('pk-login-3'), added['recoveryCodes'][0], hashof('pk-session-4'))) is None


def test_email_codes_need_a_delivery_address_are_rationed_and_only_the_newest_works(api, owner, auth_world):
    w = auth_world
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse_priv.auth_account(org_id,realm,actor,delivery) values(%s,'staff',%s,'auth.person@example.test') "
                      "on conflict(org_id,realm,actor) do update set delivery=excluded.delivery", (w.org, w.editor))
    on = sensitive(api, w, 'email-factor-on', {})
    assert on['ok'] and len(on['recoveryCodes']) == 10
    assert sign_in(api, w, 'em-login')['twoStep']
    h = hashof('em-login')
    assert command(api, w, "pulse.auth_challenge_methods('staff',%s)", (h,))['email']
    first = command(api, w, "pulse.auth_email_code('staff',%s)", (h,))
    assert len(first['code']) == 6 and first['delivery'] == 'auth.person@example.test'
    wrong = '000000' if first['code'] != '000000' else '111111'
    assert command(api, w, "pulse.auth_challenge_finish_email('staff',%s,%s,%s)", (h, wrong, hashof('em-s1'))) is None
    command(api, w, "pulse.auth_email_code('staff',%s)", (h,))
    newest = command(api, w, "pulse.auth_email_code('staff',%s)", (h,))
    assert 'error' in command(api, w, "pulse.auth_email_code('staff',%s)", (h,))
    if first['code'] != newest['code']:
        assert command(api, w, "pulse.auth_challenge_finish_email('staff',%s,%s,%s)", (h, first['code'], hashof('em-s2'))) is None
    done = command(api, w, "pulse.auth_challenge_finish_email('staff',%s,%s,%s)", (h, newest['code'][:3] + ' ' + newest['code'][3:], hashof('em-s3')))
    assert done and done['actor'] == str(w.editor)
    assert command(api, w, "pulse.auth_challenge_finish_email('staff',%s,%s,%s)", (h, newest['code'], hashof('em-s4'))) is None
    assert sensitive(api, w, 'email-factor-off', {})['ok']
    assert not command(api, w, "pulse.auth_second_factor('staff',%s)", (w.editor,))
