"""SELFSERVE-P1 (real-phone QA, 5 Nov 2026): companies started through self-serve sign-up on the shared address
(db/migrations/1540_selfserve_p1.sql). The API acceptance is services/api/test/selfserve-p1-runner.mjs: the founder opens
Finance and Billing, HR's Copy link works at the shared address, joining links the HR record by a verified e-mail, and
the pickers show the person who signs in. Here, on top: the founder's roles, one Ruvin, the link session is an account
session of the company only, and a link of one company never resolves anywhere but the shared address."""
from __future__ import annotations

import hashlib
import secrets
import uuid

from pulse_sdk.db import set_tenant
from helpers import build_world
from test_sop import demo_world, run_runner


def test_self_started_company_links_people_and_finance(worker, owner, api, tmp_path):
    w, p = demo_world(worker, owner, api)
    report = run_runner('selfserve-p1-runner', w, p, tmp_path, timeout=600)
    assert report['checks'] >= 30
    co = report['company']
    with owner.transaction():
        set_tenant(owner, co)
        roles = {r['role_key'] for r in owner.execute(
            "select role_key from pulse.role_assignment where org_id=%s and person_id=%s and current_date between valid_from and coalesce(valid_to,'infinity')",
            (co, report['founder'])).fetchall()}
        assert roles == {'admin', 'leadership'}
        assert owner.execute("select count(*) n from pulse.person where org_id=%s and display_name='Ruvin More'", (co,)).fetchone()['n'] == 1
        # Meera: the HR record and the joined person both stay (HR decides); only the joined one has an account seat.
        seats = {str(r['person_id']) for r in owner.execute("select person_id from pulse_priv.account_member where member_org=%s", (co,)).fetchall()}
        assert report['meera'] in seats and report['meeraRecord'] not in seats and report['porom'] in seats and report['ruvin'] in seats
        # The Copy-link session lives in the company only, as an account session (the one kind that travels).
        rows = owner.execute("select org_id, via from pulse.login_session where person_id=%s", (report['porom'],)).fetchall()
        assert rows and all(str(r['org_id']) == co and r['via'] == 'account' for r in rows)
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select count(*) n from pulse.login_session where person_id=%s", (report['porom'],)).fetchone()['n'] == 0


def test_a_link_resolves_its_company_only_at_the_shared_address(worker, owner, api):
    w = build_world(worker, owner, api)            # the install company (the shared address)
    a = build_world(worker, owner, api)            # two other companies
    b = build_world(worker, owner, api)
    token = secrets.token_urlsafe(32)
    h = hashlib.sha256(token.encode()).hexdigest()
    with owner.transaction():
        set_tenant(owner, a.org)
        owner.execute("insert into pulse_priv.auth_link(org_id,realm,actor,kind,token_hash,expires_at) values(%s,'staff',%s,'invite',%s,now()+interval '1 day')",
                      (a.org, a.editor, h))

    def redeem(org):
        with api.transaction():
            set_tenant(api, org)
            r = api.execute("select pulse.auth_redeem_link('staff',%s,'Fresh violet cedar river!','',%s,'Browser') d",
                            (h, hashlib.sha256(uuid.uuid4().bytes).hexdigest())).fetchone()['d']
            return r

    # Another company's own address never resolves it; nor does the client realm or a wrong token.
    assert redeem(b.org) is None
    with api.transaction():
        set_tenant(api, w.org)
        assert api.execute("select pulse.auth_redeem_link('client',%s,'Fresh violet cedar river!','',%s,'Browser') d",
                           (h, hashlib.sha256(b'x').hexdigest())).fetchone()['d'] is None
        assert api.execute("select pulse.auth_redeem_link('staff',%s,'Fresh violet cedar river!','',%s,'Browser') d",
                           (hashlib.sha256(b'nobody').hexdigest(), hashlib.sha256(b'y').hexdigest())).fetchone()['d'] is None
    # The internal lookup is not the API's to call.
    with api.transaction():
        set_tenant(api, w.org)
        assert api.execute("select has_function_privilege('pulse_api','pulse.auth_link_away(text,text)','execute') ok").fetchone()['ok'] is False
    # At the shared address it is redeemed inside its own company, once.
    r = redeem(w.org)
    assert r and r['org'] == str(a.org) and r['mustChange'] is False
    assert redeem(w.org) is None
