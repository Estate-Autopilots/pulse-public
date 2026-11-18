"""CONNECTIONS part A (2199): test and demo companies are listed apart and never counted; the registered (legal) name is
set in Settings and printed on contracts.

* pulse.org.purpose ('work', 'test', 'demo'); rehearsal companies start as test. Only a platform admin changes it,
  through pulse.platform_org_purpose, with a reason in both audit logs.
* pulse.account_me() and pulse.account_seat_purposes() carry each organisation's purpose (and personal or company).
* pulse.org_legal_name_save: an admin only; it makes Billing's company profile with Billing's own defaults when Billing
  was never opened, sets the directory card's legal name, and writes an audit note. pulse.org_legal_name reads it.
* A contract party that is the company itself, given no name of its own, prints the registered name.
Synthetic organisations and people only."""
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from helpers import build_world
from test_investor_metrics import admin, as_, member, new_account, person


@pytest.fixture
def two(worker, owner, api):
    """One account in two companies (an admin in a, a member in b) and its own personal space."""
    a, b = build_world(worker, owner, api), build_world(worker, owner, api)
    admin(worker, a.org, a.manager)
    acct = new_account(owner, f"conn{uuid.uuid4().hex[:8]}")
    member(owner, acct, a.org, a.manager)
    member(owner, acct, b.org, b.editor)
    return a, b, acct


def test_purpose_column_defaults_to_work_and_rehearsal_is_test(worker, owner, api):
    w = build_world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select purpose from pulse.org where id=%s", (w.org,)).fetchone()["purpose"] == "work"
    with pytest.raises(psycopg.errors.CheckViolation):
        with owner.transaction():
            set_tenant(owner, w.org)
            owner.execute("update pulse.org set purpose='toy' where id=%s", (w.org,))


def test_account_me_and_seat_purposes_list_each_company(two, api, owner):
    a, b, acct = two
    me = as_(api, a.org, a.manager, "select pulse.account_me() m")[0]["m"]
    assert {o["id"]: o["purpose"] for o in me["orgs"]} == {str(a.org): "work", str(b.org): "work"}
    with owner.transaction():
        set_tenant(owner, b.org)
        owner.execute("update pulse.org set purpose='demo' where id=%s", (b.org,))
    seen = as_(api, a.org, a.manager, "select pulse.account_seat_purposes() p")[0]["p"]
    assert seen == {str(a.org): {"purpose": "work", "kind": "company"}, str(b.org): {"purpose": "demo", "kind": "company"}}
    me = as_(api, a.org, a.manager, "select pulse.account_me() m")[0]["m"]
    assert {o["id"]: o["purpose"] for o in me["orgs"]}[str(b.org)] == "demo"
    # Someone with no account sees only their own organisation; nobody signed in sees nothing.
    assert as_(api, a.org, a.editor, "select pulse.account_seat_purposes() p")[0]["p"] == {}


def test_only_a_platform_admin_marks_a_company_test_or_demo_with_a_reason(worker, owner, api):
    build_world(worker, owner, api)
    w = build_world(worker, owner, api)
    admin(worker, w.org, w.manager)
    install = owner.execute("select pulse.install_org() o").fetchone()["o"]
    seat = person(worker, install, "Synthetic Platform Owner")
    admin(worker, install, seat)
    # A company's own admin is not a platform admin.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w.org, w.manager, "select pulse.platform_org_purpose(%s,'demo','synthetic reason')", (w.org,))
    with owner.transaction():
        owner.execute("insert into pulse_priv.platform_admin(person_id,granted_by) values(%s,'test:synthetic')", (seat,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, install, seat, "select pulse.platform_org_purpose(%s,'demo','')", (w.org,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, install, seat, "select pulse.platform_org_purpose(%s,'toy','synthetic reason')", (w.org,))
    r = as_(api, install, seat, "select pulse.platform_org_purpose(%s,'demo','synthetic: a demo company') r", (w.org,))[0]["r"]
    assert r == {"purpose": ["work", "demo"], "changed": True}
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select purpose from pulse.org where id=%s", (w.org,)).fetchone()["purpose"] == "demo"
        note = owner.execute("select action, changes from pulse.audit_event where org_id=%s and action='platform.org.purpose'", (w.org,)).fetchone()
    assert note["changes"]["reason"] == "synthetic: a demo company"
    with owner.transaction():
        logged = owner.execute("select reason, detail from pulse_priv.platform_audit where action='org.purpose' and target_org=%s", (w.org,)).fetchone()
    assert logged["detail"]["purpose"] == ["work", "demo"]
    # The install's own company stays a real one.
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, install, seat, "select pulse.platform_org_purpose(%s,'test','synthetic reason')", (install,))


def test_registered_name_is_set_by_an_admin_with_a_note_and_printed(two, api, owner):
    a, _, _ = two
    assert as_(api, a.org, a.manager, "select pulse.org_legal_name() n")[0]["n"] == f"Synthetic {a.code}"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, a.org, a.editor, "select pulse.org_legal_name_save('Synthetic Legal Private Limited', null)")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, a.org, a.manager, "select pulse.org_legal_name_save(' x ', null)")
    r = as_(api, a.org, a.manager, "select pulse.org_legal_name_save('  Synthetic   Legal Private Limited ', 'synthetic: approved by the registrar') r")[0]["r"]
    assert r["legalName"] == "Synthetic Legal Private Limited" and r["changed"] is True and r["before"] == f"Synthetic {a.code}"
    assert as_(api, a.org, a.manager, "select pulse.org_legal_name() n")[0]["n"] == "Synthetic Legal Private Limited"
    with owner.transaction():
        set_tenant(owner, a.org)
        s = owner.execute("select company, (select count(*) from pulse.erp_template where org_id=%s) t from pulse.erp_settings where org_id=%s", (a.org, a.org)).fetchone()
        card = owner.execute("select legal_name, show_legal_name from pulse.org_public_card where org_id=%s", (a.org,)).fetchone()
        note = owner.execute("select actor_id, changes from pulse.audit_event where org_id=%s and action='org.legal_name'", (a.org,)).fetchone()
        name = owner.execute("select name from pulse.org where id=%s", (a.org,)).fetchone()["name"]
    # Billing's own first-run defaults, with the registered name; a starter template; the display name is unchanged.
    assert s["company"]["legalName"] == "Synthetic Legal Private Limited" and s["company"]["stateCode"] == "27" and s["t"] == 1
    assert card["legal_name"] == "Synthetic Legal Private Limited" and card["show_legal_name"] is False
    assert note["actor_id"] == a.manager and note["changes"]["note"] == "synthetic: approved by the registrar" and note["changes"]["billingMade"] is True
    assert name == f"Synthetic {a.code}"
    # Saving it again changes nothing in Billing (no second template).
    r = as_(api, a.org, a.manager, "select pulse.org_legal_name_save('Synthetic Legal Private Limited', null) r")[0]["r"]
    assert r["changed"] is False
    with owner.transaction():
        set_tenant(owner, a.org)
        assert owner.execute("select count(*) n from pulse.erp_template where org_id=%s", (a.org,)).fetchone()["n"] == 1


def test_another_company_reads_only_a_shown_legal_name(two, api, owner):
    a, b, _ = two
    as_(api, a.org, a.manager, "select pulse.org_legal_name_save('Synthetic Legal Private Limited', null)")
    # From b, a's registered name is not shown on its card: b prints a's display name.
    assert as_(api, b.org, b.editor, "select pulse.org_legal_name(%s) n", (a.org,))[0]["n"] == f"Synthetic {a.code}"
    with owner.transaction():
        set_tenant(owner, a.org)
        owner.execute("update pulse.org_public_card set show_legal_name=true where org_id=%s", (a.org,))
    assert as_(api, b.org, b.editor, "select pulse.org_legal_name(%s) n, pulse.current_org() o", (a.org,))[0] == {"n": "Synthetic Legal Private Limited", "o": b.org}


def test_contract_party_for_the_company_prints_its_registered_name(two, api, owner):
    a, _, _ = two
    as_(api, a.org, a.manager, "select pulse.org_legal_name_save('Synthetic Legal Private Limited', null)")
    cid = as_(api, a.org, a.manager, "select pulse.contract_save(null, %s) id", (Jsonb({"title": "Synthetic service agreement", "parties": [
        {"kind": "company", "role": "provider", "orgId": str(a.org)}, {"kind": "company", "role": "client", "name": "Synthetic Client LLP"}]}),))[0]["id"]
    with owner.transaction():
        set_tenant(owner, a.org)
        names = [r["name"] for r in owner.execute("select name from pulse.contract_party where contract_id=%s order by position", (cid,))]
    assert names == ["Synthetic Legal Private Limited", "Synthetic Client LLP"]
    # A name given on purpose is kept.
    cid = as_(api, a.org, a.manager, "select pulse.contract_save(null, %s) id", (Jsonb({"title": "Synthetic NDA", "parties": [
        {"kind": "company", "role": "provider", "orgId": str(a.org), "name": "Synthetic Trading Name"}, {"kind": "company", "role": "client", "name": "Synthetic Client LLP"}]}),))[0]["id"]
    with owner.transaction():
        set_tenant(owner, a.org)
        assert owner.execute("select name from pulse.contract_party where contract_id=%s and position=1", (cid,)).fetchone()["name"] == "Synthetic Trading Name"
