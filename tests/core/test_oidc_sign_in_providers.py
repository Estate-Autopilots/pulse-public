"""LOGIN-VITALS (owner, 13 Nov 2026: "prepare Microsoft and Apple sign-in the same way"): pulse.oidc_sign_in_any signs in the
one active staff person whose e-mail on record is the provider-verified e-mail, as Continue with Google does without a
link; sessions and 2-step challenges say which provider; an attempt is taken only by its own provider's callback
(migration 2033). Synthetic people only. The HTTP side: services/api/test/sign-in-providers.test.mjs."""
import json
import uuid

from pulse_sdk.db import set_tenant
from test_account_security import auth_world, command, hashof  # noqa: F401 (fixture)

MICROSOFT = 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0'


def sign_in(api, w, provider, email, tag, iss=None, verified=True):
    proof = {'iss': iss or (MICROSOFT if provider == 'microsoft' else 'https://appleid.apple.com'), 'sub': 'sub-' + tag, 'email': email, 'email_verified': verified}
    return command(api, w, "pulse.oidc_sign_in_any(%s,%s,%s,%s,'Browser')", (provider, json.dumps(proof), hashof(tag + '-challenge' + str(w.org)), hashof(tag + '-session' + str(w.org))))


def ready(owner, w):
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute('update pulse.login_credential set must_change=false where org_id=%s', (w.org,))


def test_verified_email_on_record_signs_in_and_the_session_names_the_provider(api, owner, auth_world):
    w = auth_world
    ready(owner, w)
    for provider in ('microsoft', 'apple'):
        done = sign_in(api, w, provider, 'Personal@Gmail.Example', provider)
        assert done['actor'] == str(w.editor), done
        with owner.transaction():
            set_tenant(owner, w.org)
            assert owner.execute('select via from pulse.login_session where token_hash=%s', (hashof(provider + '-session' + str(w.org)),)).fetchone()['via'] == provider
            assert owner.execute('select 1 from pulse.audit_event where org_id=%s and action=%s and resource_id=%s', (w.org, provider + '_email_sign_in', str(w.editor))).fetchone()


def test_refuses_unverified_other_issuers_unknown_providers_and_strangers(api, owner, auth_world):
    w = auth_world
    ready(owner, w)
    assert sign_in(api, w, 'microsoft', 'personal@gmail.example', 'unverified', verified=False) == {'error': 'provider_error'}
    assert sign_in(api, w, 'apple', 'personal@gmail.example', 'wrong-iss', iss='https://accounts.google.com') == {'error': 'provider_error'}
    assert sign_in(api, w, 'microsoft', 'personal@gmail.example', 'apple-iss', iss='https://appleid.apple.com') == {'error': 'provider_error'}
    assert sign_in(api, w, 'google', 'personal@gmail.example', 'google', iss='https://accounts.google.com') == {'error': 'provider_error'}
    assert sign_in(api, w, 'microsoft', 'stranger@example.test', 'stranger') == {'error': 'not_linked'}
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select 1 from pulse.audit_event where org_id=%s and action='microsoft_sign_in_unmatched'", (w.org,)).fetchone()
        assert owner.execute('select count(*) n from pulse.person where org_id=%s', (w.org,)).fetchone()['n'] == 4  # nobody made


def test_two_step_still_applies_and_its_challenge_names_the_provider(api, owner, auth_world):
    w = auth_world
    ready(owner, w)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse_priv.auth_passkey(org_id,realm,actor,credential_id,public_key) values(%s,'staff',%s,%s,'\\x00')", (w.org, w.editor, 'a-' + str(w.org)))
    assert sign_in(api, w, 'apple', 'personal@gmail.example', 'pk') == {'twoStep': True}
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute('select via from pulse_priv.auth_challenge where hash=%s', (hashof('pk-challenge' + str(w.org)),)).fetchone()['via'] == 'apple'


def test_an_attempt_is_taken_only_by_its_own_provider(api, auth_world):
    w = auth_world
    def attempt(op, b):
        return command(api, w, 'pulse.google_auth_attempt(%s,%s)', (op, json.dumps(b)))
    state, cookie = hashof(str(uuid.uuid4())), hashof('cookie')
    begin = {'provider': 'microsoft', 'stateHash': state, 'cookieHash': cookie, 'nonce': 'n', 'verifier': 'v', 'mode': 'signin', 'next': '/tasks'}
    assert attempt('begin', begin) == {'ok': True}
    assert attempt('take', {'stateHash': state, 'cookieHash': cookie}) == {'error': 'state_invalid'}  # Google's callback (no provider)
    assert attempt('take', {'provider': 'apple', 'stateHash': state, 'cookieHash': cookie}) == {'error': 'state_invalid'}
    assert attempt('take', {'provider': 'microsoft', 'stateHash': state, 'cookieHash': cookie}) == {'nonce': 'n', 'verifier': 'v', 'mode': 'signin', 'next': '/tasks'}
    assert attempt('take', {'provider': 'microsoft', 'stateHash': state, 'cookieHash': cookie}) == {'error': 'state_invalid'}  # used once
    # Google's own attempts are as before (no provider named).
    g = {'stateHash': hashof(str(uuid.uuid4())), 'cookieHash': cookie, 'nonce': 'n', 'verifier': 'v', 'mode': 'signin', 'next': '/'}
    assert attempt('begin', g) == {'ok': True}
    assert attempt('take', {'stateHash': g['stateHash'], 'cookieHash': cookie})['next'] == '/'
