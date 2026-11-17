"""GOOGLE-ONE-CLICK (owner, 2 Nov 2026): Continue with Google signs in whoever's Google-verified e-mail is on record here
(work, personal, delivery, or the Pulse account holding their seat), gmail.com included, without linking first; it never
creates anyone (synthetic people only). The HTTP side: services/api/test/google-sign-in-flow-runner.mjs."""
import json
import uuid

from pulse_sdk.db import set_tenant
from test_account_security import auth_world, command, hashof  # noqa: F401 (fixture)
from test_google_sign_in import google_world  # noqa: F401 (fixture)


def google(api, w, email, tag, verified=True, hd=None, sub=None):
    proof = {'iss': 'https://accounts.google.com', 'sub': sub or 'sub-' + tag, 'email': email, 'email_verified': verified, **({'hd': hd} if hd else {})}
    return command(api, w, "pulse.google_sign_in_any(%s,%s,%s,'Browser')", (json.dumps(proof), hashof(tag + '-challenge' + str(w.org)), hashof(tag + '-session' + str(w.org))))


def test_verified_email_on_record_signs_in_without_a_link(api, owner, google_world):
    w = google_world
    done = google(api, w, 'Personal@Gmail.Example', 'personal')  # auth.person's personal (profile) address, no hd
    assert done['actor'] == str(w.editor) and done['maxAge'] == 43200
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select via from pulse.login_session where token_hash=%s", (hashof('personal-session' + str(w.org)),)).fetchone()['via'] == 'google'
        assert not owner.execute("select 1 from pulse_priv.google_identity where person_id=%s", (w.editor,)).fetchone()  # nothing linked or made
        assert owner.execute("select 1 from pulse.audit_event where org_id=%s and action='google_email_sign_in' and resource_id=%s", (w.org, str(w.editor))).fetchone()


def test_delivery_email_and_account_email_match(api, owner, worker, google_world):
    w = google_world
    with owner.transaction():
        set_tenant(owner, w.org)
        # The delivery address on record (Account / Security); HR's private contact card is not readable signed out.
        owner.execute("insert into pulse_priv.auth_account(org_id,realm,actor,delivery) values(%s,'staff',%s,'noemail.home@gmail.example') "
                      "on conflict(org_id,realm,actor) do update set delivery=excluded.delivery", (w.org, w.editor2))
    assert google(api, w, 'noemail.home@gmail.example', 'hr')['actor'] == str(w.editor2)
    account = uuid.uuid4()
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse_priv.pulse_account(id,handle,display_name,email) values(%s,%s,'Admin Account',%s)",
                      (account, 'acct' + account.hex[:8], f'admin.{account.hex[:8]}@gmail.example'))
        owner.execute("insert into pulse_priv.account_member(account_id,member_org,person_id,kind) values(%s,%s,%s,'staff')", (account, w.org, w.manager))
    assert google(api, w, f'admin.{account.hex[:8]}@gmail.example', 'acct')['actor'] == str(w.manager)


def test_never_creates_anyone_and_refuses_unverified_unknown_and_offboarded(api, owner, google_world):
    w = google_world
    assert google(api, w, 'personal@gmail.example', 'unverified', verified=False) == {'error': 'provider_error'}
    assert google(api, w, 'stranger@gmail.example', 'stranger') == {'error': 'not_linked'}
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.person set status='offboarded' where id=%s", (w.editor,))
    assert google(api, w, 'personal@gmail.example', 'offboarded') == {'error': 'not_linked'}
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.person set status='active' where id=%s", (w.editor,))
        owner.execute("update pulse.login_credential set status='disabled' where person_id=%s", (w.editor,))
    assert google(api, w, 'personal@gmail.example', 'disabled') == {'error': 'not_linked'}
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.login_credential set status='active' where person_id=%s", (w.editor,))
        # Two people with the same address: neither.
        owner.execute("update pulse.people_profile set email='personal@gmail.example' where person_id=%s", (w.editor2,))
    assert google(api, w, 'personal@gmail.example', 'twice') == {'error': 'not_linked'}
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select count(*) n from pulse.person where org_id=%s", (w.org,)).fetchone()['n'] == 4
        assert owner.execute("select 1 from pulse.audit_event where org_id=%s and action='google_sign_in_unmatched'", (w.org,)).fetchone()
    # Google switched off here: nothing.
    command(api, w, 'pulse.google_settings(%s)', (json.dumps({'enabled': False, 'allowedDomains': ['example.test'], 'trustGoogle2Step': False, 'passwordSignIn': 'on'}),), w.manager)
    assert google(api, w, 'admin@example.test', 'off') == {'error': 'provider_error'}


def test_two_step_still_applies(api, owner, google_world):
    w = google_world
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse_priv.auth_passkey(org_id,realm,actor,credential_id,public_key) values(%s,'staff',%s,%s,'\\x00')", (w.org, w.editor, 'g-' + str(w.org)))
    assert google(api, w, 'personal@gmail.example', 'pk') == {'twoStep': True}
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select via from pulse_priv.auth_challenge where hash=%s", (hashof('pk-challenge' + str(w.org)),)).fetchone()['via'] == 'google'
