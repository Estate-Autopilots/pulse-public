"""AUTH-UNIFY: one sign-in identity per human across organisations (synthetic people only)."""
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_account_security import command, hashof

PW_A = 'Synthetic-org-a-2026!'
PW_B = 'Synthetic-org-b-2026!'


def _staff_login(worker, owner, api, w, person, username, password, email=None):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01') on conflict do nothing", (w.org, w.manager))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,email,evidence) values(%s,%s,'Editor',%s,%s,'{}')", (w.org, person, username, email))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.login_issue(%s,%s)", (person, password))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.login_credential set must_change=false where person_id=%s", (person,))


def _login(api, w, username, password, tag):
    return command(api, w, "pulse.auth_login('staff',%s,%s,%s,%s,false,'Browser')",
                   (username, password, hashof('challenge' + tag + str(w.org)), hashof('session' + tag + str(w.org))))


@pytest.fixture
def two_orgs(worker, owner, api):
    a = build_world(worker, owner, api)
    b = build_world(worker, owner, api)
    _staff_login(worker, owner, api, a, a.editor, 'same.name', PW_A)
    _staff_login(worker, owner, api, b, b.editor, 'same.name', PW_B)
    return a, b


def test_same_username_in_two_orgs_checks_only_this_orgs_credential(api, two_orgs):
    a, b = two_orgs
    ok = _login(api, a, 'same.name', PW_A, 'a1')
    assert not ok.get('failed') and ok['actor'] == str(a.editor)
    # B's password at A's address never opens a session (and never one for B's person).
    assert _login(api, a, 'same.name', PW_B, 'a2').get('failed') is True
    ok = _login(api, b, 'same.name', PW_B, 'b1')
    assert not ok.get('failed') and ok['actor'] == str(b.editor)
    with api.transaction():
        set_tenant(api, a.org)
        assert api.execute("select count(*) n from pulse.login_session where person_id=%s", (b.editor,)).fetchone()['n'] == 0
