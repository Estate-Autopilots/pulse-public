"""GROWTH-LOOP slice 1 (1894): the investor numbers. Only the platform owner's admin seat in Vitals HQ (the
organisation whose modules document switches pulse_hq on) or in the install's own organisation reads them; they are
counted from the real tables of every active company and come back as totals and weekly series only (no company's
id, name or own number). Counts are checked as differences before and after synthetic activity, because the scratch
database holds other tests' companies too. Synthetic tenants, people and figures only."""
import json
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant

from helpers import build_world
from test_billing_flow import _issued_quote
from test_erp_invoice import _seed_erp_world, erp  # noqa: F401  (erp is a fixture)


def as_(api, org, who, sql, args=()):
    with api.transaction():
        set_tenant(api, org, who)
        return api.execute(sql, args).fetchall()


def metrics(api, org, who, weeks=12):
    return as_(api, org, who, "select pulse.investor_metrics(%s) m", (weeks,))[0]["m"]


def admin(worker, org, person):
    with worker.transaction():
        set_tenant(worker, org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (org, person))


def new_account(owner, handle):
    acct = uuid.uuid4()
    with owner.transaction():
        owner.execute("insert into pulse_priv.pulse_account(id,handle,display_name) values(%s,%s,%s)", (acct, handle, f"Synthetic {handle}"))
    return acct


def member(owner, acct, org, person, kind="staff", joined="now()"):
    with owner.transaction():
        owner.execute(f"insert into pulse_priv.account_member(account_id,member_org,person_id,kind,joined_at) values(%s,%s,%s,%s,{joined})", (acct, org, person, kind))


def person(worker, org, name, side="staff"):
    pid = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,%s)", (pid, org, name, side))
    return pid


@pytest.fixture
def hq(worker, owner, api):
    """Vitals HQ (pulse_hq on) with the owner's seat; the owner's seat in the install's own organisation is the platform admin."""
    build_world(worker, owner, api)  # the install's own organisation, on a fresh database, is never HQ here
    w = build_world(worker, owner, api)
    tag = uuid.uuid4().hex[:8]
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active)
                          values(%s,'tenant','modules',1,%s,true)""", (w.org, Jsonb({"off": [], "on": ["pulse_hq"]})))
    admin(worker, w.org, w.manager)
    admin(worker, w.org, w.lead)
    install = owner.execute("select pulse.install_org() o").fetchone()["o"]
    assert install is not None and install != w.org
    founder_install = person(worker, install, f"Synthetic Platform Owner {tag}")
    admin(worker, install, founder_install)
    acct = new_account(owner, f"owner{tag}")
    member(owner, acct, install, founder_install)
    member(owner, acct, w.org, w.manager)
    with owner.transaction():
        owner.execute("insert into pulse_priv.platform_admin(person_id,granted_by) values(%s,'test:synthetic')", (founder_install,))
    # Another admin of HQ with their own account (not a platform admin).
    other = new_account(owner, f"other{tag}")
    member(owner, other, w.org, w.lead)
    return w, install, founder_install


def test_only_the_platform_owner_reads_the_investor_numbers(hq, worker, owner, api):
    w, install, founder_install = hq
    m = metrics(api, w.org, w.manager)
    assert set(m) == {"asOf", "weeks", "series", "totals"}
    assert len(m["weeks"]) == 12 and all(len(v) == 12 for v in m["series"].values())
    # The platform admin's own seat in the install's organisation reads them too.
    assert metrics(api, install, founder_install, 4)["weeks"][-1] == m["weeks"][-1]
    # Another admin of HQ, a member of HQ, the owner's account in an ordinary company: refused.
    for org, who in ((w.org, w.lead), (w.org, w.editor)):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            metrics(api, org, who)
    plain = build_world(worker, owner, api)
    admin(worker, plain.org, plain.manager)
    acct = owner.execute("select account_id from pulse_priv.account_member where person_id=%s", (w.manager,)).fetchone()["account_id"]
    member(owner, acct, plain.org, plain.manager)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        metrics(api, plain.org, plain.manager)
    # Signed out (no viewer) and a platform-admin "view as" session are refused too.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        metrics(api, w.org, None)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with api.transaction():
            set_tenant(api, w.org, w.manager)
            api.execute("select set_config('pulse.platform_return','x|y|z',true)")
            api.execute("select pulse.investor_metrics(12)")
    # Every look is on the platform audit log; the API role cannot read the tables behind it.
    with owner.transaction():
        n = owner.execute("select count(*) n from pulse_priv.platform_audit where action='investor.view' and actor_person=%s", (w.manager,)).fetchone()["n"]
    assert n >= 1
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w.org, w.manager, "select count(*) from pulse_priv.platform_admin")


def test_counts_come_from_the_real_tables(hq, erp, worker, owner, api):  # noqa: F811
    w = hq[0]
    _seed_erp_world(worker, erp)
    before = metrics(api, w.org, w.manager)
    t = erp
    # Two quotations issued and one draft invoice (a draft is not counted).
    _issued_quote(api, t, t.finance, {"name": "Lotus Interiors (synthetic)", "stateCode": "27", "address": ["Office 1"]})
    _issued_quote(api, t, t.finance, {"name": "Harbor Builders (synthetic)", "stateCode": "27", "address": ["Office 2"]})
    # A company-to-company contract both sides accepted, and one still waiting.
    b = build_world(worker, owner, api)
    admin(worker, t.org, t.manager)
    admin(worker, b.org, b.manager)
    def contract(title):
        cid = as_(api, t.org, t.manager, "select pulse.contract_save(null,%s) id", (Jsonb({"kind": "retainer", "title": title, "scope": "Ten reels a month",
            "rates": [{"label": "Retainer", "amountMinor": 15000000, "unit": "month"}], "startsOn": "2026-12-01",
            "parties": [{"kind": "company", "role": "provider", "orgId": str(t.org)}, {"kind": "company", "role": "client", "orgId": str(b.org)}]}),))[0]["id"]
        as_(api, t.org, t.manager, "select pulse.contract_send(%s)", (cid,))
        return cid
    signed = contract("Signed retainer (synthetic)")
    contract("Waiting retainer (synthetic)")
    key = as_(api, t.org, t.manager, "select contract_key k from pulse.contract where id=%s", (signed,))[0]["k"]
    theirs = as_(api, b.org, b.manager, "select id from pulse.contract where contract_key=%s", (key,))[0]["id"]
    as_(api, b.org, b.manager, "select pulse.contract_accept(%s,null,null)", (theirs,))
    assert as_(api, t.org, t.manager, "select pulse.contract_accept(%s,null,null) s", (signed,))[0]["s"] == "active"
    # Chat: a staff person and a client-side person send messages; an AI employee's message is left out.
    client_person = person(worker, t.org, "Synthetic Client Contact", "client")
    ai = person(worker, t.org, "Synthetic AI Helper")
    with owner.transaction():
        set_tenant(owner, t.org)
        ch = owner.execute("insert into pulse.chat_channel(org_id,key,name,kind) values(%s,%s,'Synthetic client chat','group') returning id", (t.org, f"gl-{uuid.uuid4().hex[:8]}")).fetchone()["id"]
        owner.execute("""insert into pulse.agent_member(org_id,person_id,owner_person_id,employee_no,employee_id)
                         values(%s,%s,%s,(select coalesce(max(employee_no),0)+1 from pulse.agent_member where org_id=%s),%s)""",
                      (t.org, ai, t.manager, t.org, f"{t.code}-AI-{uuid.uuid4().hex[:4]}"))
        for author in (t.manager, client_person, client_person, ai):
            owner.execute("insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id) values(%s,%s,%s,'Synthetic hello',%s)", (t.org, ch, author, uuid.uuid4()))
        owner.execute("insert into pulse.login_session(org_id,token_hash,person_id,expires_at) values(%s,%s,%s,now()+interval '1 day')", (t.org, uuid.uuid4().hex * 2, t.editor))
    after = metrics(api, w.org, w.manager)
    d = {k: after["totals"][k] - before["totals"][k] for k in after["totals"]}
    assert d["quotes"] == 2 and d["bills"] == 0, d
    assert d["contractsSigned"] == 1, d
    assert d["chatUsers"] == 2 and d["chatUsersClient"] == 1, d
    assert d["aiAgents"] == 1, d
    # b is a new company with its four staff; the AI employee is not an employee.
    assert d["companies"] == 1 and d["employees"] == 4, d
    assert d["activeUsers"] >= 3, d  # the editor's session and the two chat people (and anyone else of the scratch database this week)
    wk = -1
    assert after["series"]["contractsSigned"][wk] - before["series"]["contractsSigned"][wk] == 1
    assert after["series"]["quotes"][wk] - before["series"]["quotes"][wk] == 2
    assert after["series"]["chatUsersClient"][wk] - before["series"]["chatUsersClient"][wk] == 1


def test_no_company_is_named_or_singled_out(hq, api):
    w = hq[0]
    m = metrics(api, w.org, w.manager, 52)
    text = json.dumps(m)
    assert str(w.org) not in text and w.code not in text and "Synthetic" not in text
    for v in m["series"].values():
        assert all(isinstance(n, int) for n in v)
    assert all(isinstance(n, int) for n in m["totals"].values())
    # Week bounds are clamped (4 to 52) and every week starts on a Monday.
    assert len(metrics(api, w.org, w.manager, 1)["weeks"]) == 4
    assert len(metrics(api, w.org, w.manager, 999)["weeks"]) == 52
    import datetime
    assert all(datetime.date.fromisoformat(d).weekday() == 0 for d in m["weeks"])


def test_a_company_that_joined_through_a_deal(hq, worker, owner, api):
    w = hq[0]
    seller = build_world(worker, owner, api)
    before = metrics(api, w.org, w.manager)["totals"]["companiesViaDeal"]
    # A client of the seller (on Vitals as their client) later opens their own company.
    contact = person(worker, seller.org, "Synthetic Buyer Contact", "client")
    acct = new_account(owner, f"buyer{uuid.uuid4().hex[:8]}")
    member(owner, acct, seller.org, contact, "client", "now() - interval '3 days'")
    theirs = build_world(worker, owner, api)
    member(owner, acct, theirs.org, theirs.manager, "staff")
    # A company opened by someone who was never anyone's client is not counted.
    build_world(worker, owner, api)
    assert metrics(api, w.org, w.manager)["totals"]["companiesViaDeal"] - before == 1


def test_the_funnel_table_is_the_bringing_companys_alone(worker, owner, api, hq):
    w = hq[0]
    row = worker.execute("""select c.relrowsecurity r, c.relforcerowsecurity f, exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') t,
        has_table_privilege('pulse_api', c.oid, 'select') sel, has_table_privilege('pulse_api', c.oid, 'insert') ins
        from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pulse' and c.relname='growth_event'""").fetchone()
    assert (row["r"], row["f"], row["t"], row["sel"], row["ins"]) == (True, True, True, False, False)
    seller = build_world(worker, owner, api)
    before = metrics(api, w.org, w.manager)["totals"]
    newco = build_world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, seller.org)
        for ev, vis in (("viewed", "a"), ("viewed", "b"), ("clicked", "a"), ("dismissed", "b")):
            owner.execute("insert into pulse.growth_event(org_id,event,source,visitor) values(%s,%s,'chat',%s)", (seller.org, ev, vis * 64))
        owner.execute("insert into pulse.growth_event(org_id,event,source,visitor,new_org) values(%s,'org_created','chat',%s,%s)", (seller.org, "a" * 64, newco.org))
        with pytest.raises(psycopg.errors.UniqueViolation):
            with owner.transaction():
                owner.execute("insert into pulse.growth_event(org_id,event,source,visitor) values(%s,'viewed','chat',%s)", (seller.org, "a" * 64))
    after = metrics(api, w.org, w.manager)["totals"]
    assert after["funnelViewed"] - before["funnelViewed"] == 2
    assert after["funnelClicked"] - before["funnelClicked"] == 1
    assert after["funnelOrgCreated"] - before["funnelOrgCreated"] == 1
    assert after["companiesViaDeal"] - before["companiesViaDeal"] == 1
