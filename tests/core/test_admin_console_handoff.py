"""SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.4; migration 2042): a platform admin signed in to Pulse opens the admin console
already signed in, from whichever company they are in, with no second sign-in and no refusal. Pulse makes a one-time
hand-off for the account's seat in the install's own company; the admin site (a public call at the install's own
address) trades it for its own session of that seat. Once, within two minutes, only at the install's own company, only
while the seat is still a platform admin. A company admin who is not a platform admin gets no hand-off. Synthetic
tenants and people only."""
import hashlib
import uuid

import psycopg
import pytest
from pulse_sdk.db import set_tenant

from helpers import build_world
from test_investor_metrics import admin, as_, member, new_account, person


def h(text):
    return hashlib.sha256(text.encode()).hexdigest()


def create(api, org, who, token):
    return as_(api, org, who, "select pulse.admin_handoff_create(%s) r", (token,))[0]["r"]


def redeem(api, org, token, session):
    return as_(api, org, None, "select pulse.admin_handoff_redeem(%s,%s,'Admin console · synthetic test') r", (token, session))[0]["r"]


@pytest.fixture
def platform(worker, owner, api):
    """An ordinary company (the owner is its admin) and the owner's platform-admin seat in the install's own company,
    one account across both; another admin of the company with their own account is not a platform admin."""
    build_world(worker, owner, api)
    w = build_world(worker, owner, api)
    tag = uuid.uuid4().hex[:8]
    admin(worker, w.org, w.manager)
    admin(worker, w.org, w.lead)
    install = owner.execute("select pulse.install_org() o").fetchone()["o"]
    assert install is not None and install != w.org
    seat = person(worker, install, f"Synthetic Platform Owner {tag}")
    admin(worker, install, seat)
    acct = new_account(owner, f"handoff{tag}")
    member(owner, acct, install, seat)
    member(owner, acct, w.org, w.manager)
    with owner.transaction():
        owner.execute("insert into pulse_priv.platform_admin(person_id,granted_by) values(%s,'test:synthetic')", (seat,))
    member(owner, new_account(owner, f"other{tag}"), w.org, w.lead)
    return w, install, seat, tag


def test_a_platform_admin_lands_in_the_console_signed_in_from_any_company(platform, api, owner):
    w, install, seat, tag = platform
    # In another company the menu still has Admin console: the account's seat in the install's company is found.
    assert as_(api, w.org, w.manager, "select pulse.account_platform_seat() s")[0]["s"] == seat
    assert as_(api, install, seat, "select pulse.account_platform_seat() s")[0]["s"] == seat

    token, session = h("handoff-" + tag), h("session-" + tag)
    assert create(api, w.org, w.manager, token) == {"ok": True}
    assert redeem(api, install, token, session) == {"ok": True}
    with owner.transaction():
        set_tenant(owner, install)
        row = owner.execute("""select org_id, person_id, via, remembered, expires_at < now() + interval '13 hours' short
                                 from pulse.login_session where token_hash=%s""", (session,)).fetchone()
        events = {r["action"] for r in owner.execute("select action from pulse_priv.auth_event where actor=%s", (seat,)).fetchall()}
    assert (row["org_id"], row["person_id"], row["via"], row["remembered"], row["short"]) == (install, seat, "account", False, True)
    assert {"admin_console_handoff", "admin_console_signed_in"} <= events
    # That session is a platform admin in the console (its /me says so), with no password or two-step asked again.
    assert as_(api, install, seat, "select pulse.platform_admin() p")[0]["p"] is True

    # Once only.
    assert redeem(api, install, token, h("again-" + tag)) is None
    # Only at the install's own company (the admin site's address), never at another company's.
    other = h("other-company-" + tag)
    assert create(api, w.org, w.manager, other) == {"ok": True}
    assert redeem(api, w.org, other, h("s2-" + tag)) is None
    # Not after two minutes.
    late = h("late-" + tag)
    assert create(api, w.org, w.manager, late) == {"ok": True}
    with owner.transaction():
        set_tenant(owner, install)
        owner.execute("update pulse_priv.admin_handoff set expires_at = now() - interval '1 second' where token_hash=%s", (late,))
    assert redeem(api, install, late, h("s3-" + tag)) is None
    # Not with a malformed token or session.
    assert redeem(api, install, "x" * 64, h("s4-" + tag)) is None
    assert redeem(api, install, h("handoff-" + tag), "nope") is None


def test_nobody_else_gets_a_handoff(platform, api, owner):
    w, install, seat, tag = platform
    # A company admin who is not a platform admin, a member, and nobody signed in: no seat, no hand-off.
    for who in (w.lead, w.editor, None):
        assert as_(api, w.org, who, "select pulse.account_platform_seat() s")[0]["s"] is None
        assert create(api, w.org, who, h(f"no-{who}-{tag}")) is None
    # A seat that stops being a platform admin before the admin site redeems the hand-off is refused there.
    token = h("revoked-" + tag)
    assert create(api, w.org, w.manager, token) == {"ok": True}
    with owner.transaction():
        owner.execute("delete from pulse_priv.platform_admin where person_id=%s", (seat,))
    assert redeem(api, install, token, h("s-revoked-" + tag)) is None
    assert as_(api, w.org, w.manager, "select pulse.account_platform_seat() s")[0]["s"] is None
    # The hand-off table is closed to the API role.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, install, seat, "select count(*) from pulse_priv.admin_handoff")
