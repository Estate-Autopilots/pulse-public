"""CONNECTORS-CONTRACTS (1583): contracts between companies and people. One copy per company that is a party, kept in
step by the database; each party sees the contract and its own side; a person's contracts follow their account across
companies. Forced row security on every table. Synthetic tenants only."""
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from helpers import build_world

TABLES = ["contract", "contract_link", "contract_party", "contract_side", "contract_txn", "contract_version"]


def as_(api, w, who, sql, args=()):
    with api.transaction():
        set_tenant(api, w.org, who)
        return api.execute(sql, args).fetchall()


def one(api, w, who, sql, args=()):
    rows = as_(api, w, who, sql, args)
    return rows[0] if rows else None


def admin(worker, w, person):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (w.org, person))


def account(owner, w, person, handle):
    acct = uuid.uuid4()
    with owner.transaction():
        owner.execute("insert into pulse_priv.pulse_account(id,handle,display_name) values(%s,%s,%s)", (acct, handle, f"Synthetic {handle}"))
        owner.execute("insert into pulse_priv.account_member(account_id,member_org,person_id,kind) values(%s,%s,%s,'staff')", (acct, w.org, person))
    return acct


@pytest.fixture
def two(worker, owner, api):
    a = build_world(worker, owner, api)
    b = build_world(worker, owner, api)
    admin(worker, a, a.manager)
    admin(worker, b, b.manager)
    return a, b


def save(api, w, who, cid, body):
    return one(api, w, who, "select pulse.contract_save(%s,%s) id", (cid, Jsonb(body)))["id"]


def copy_of(api, w, who, key):
    return one(api, w, who, "select id,status,version,title,rates from pulse.contract where contract_key=%s", (key,))


def parties(api, w, who, cid):
    return {r["name"]: r for r in as_(api, w, who, "select * from pulse.contract_party where contract_id=%s order by position", (cid,))}


def test_tables_force_row_security_with_a_tenant_policy(worker):
    rows = worker.execute("""select c.relname,c.relrowsecurity,c.relforcerowsecurity,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') tenant
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pulse' and c.relname = any(%s) order by 1""", (TABLES,)).fetchall()
    assert [(r["relname"], r["relrowsecurity"], r["relforcerowsecurity"], r["tenant"]) for r in rows] == [(t, True, True, True) for t in TABLES]


def test_company_to_company_copies_acceptance_and_versions(api, two):
    a, b = two
    cid = save(api, a, a.manager, None, {"kind": "retainer", "title": "Monthly video retainer", "scope": "Ten reels a month",
        "rates": [{"label": "Retainer", "amountMinor": 15000000, "unit": "month"}], "startsOn": "2026-12-01", "noticeDays": 30, "notes": "Margin is thin",
        "parties": [{"kind": "company", "role": "provider", "orgId": str(a.org)}, {"kind": "company", "role": "client", "orgId": str(b.org)}]})
    key = one(api, a, a.manager, "select contract_key k from pulse.contract where id=%s", (cid,))["k"]
    # A draft is the drafter's alone; a member without a contract role sees nothing.
    assert copy_of(api, b, b.manager, key) is None
    assert copy_of(api, a, a.editor, key) is None
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        save(api, a, a.editor, None, {"title": "Not mine to make", "parties": []})
    assert one(api, a, a.manager, "select pulse.contract_send(%s) s", (cid,))["s"] == "proposed"
    theirs = copy_of(api, b, b.manager, key)
    assert theirs["status"] == "proposed" and theirs["title"] == "Monthly video retainer"
    assert copy_of(api, b, b.editor, key) is None
    # Each company keeps its own side: B's copy has no notes of A's.
    assert as_(api, b, b.manager, "select notes from pulse.contract_side where contract_id=%s", (theirs["id"],)) == []
    assert one(api, a, a.manager, "select notes from pulse.contract_side where contract_id=%s", (cid,))["notes"] == "Margin is thin"
    # B accepts for itself (not for A); A sees it; when A accepts, both copies are active.
    assert one(api, b, b.manager, "select pulse.contract_accept(%s,null,null) s", (theirs["id"],))["s"] == "proposed"
    mine = parties(api, a, a.manager, cid)
    assert mine[f"Synthetic {b.code}"]["accepted_version"] == 1 and mine[f"Synthetic {a.code}"]["accepted_at"] is None
    assert one(api, a, a.manager, "select pulse.contract_accept(%s,null,null) s", (cid,))["s"] == "active"
    assert copy_of(api, b, b.manager, key)["status"] == "active"
    # A change to the terms is a new version: the old terms are kept, every acceptance is cleared, in both copies.
    save(api, a, a.manager, cid, {"rates": [{"label": "Retainer", "amountMinor": 18000000, "unit": "month"}]})
    theirs = copy_of(api, b, b.manager, key)
    assert (theirs["status"], theirs["version"], theirs["rates"][0]["amountMinor"]) == ("proposed", 2, 18000000)
    assert one(api, b, b.manager, "select terms from pulse.contract_version where contract_id=%s and version=1", (theirs["id"],))["terms"]["rates"][0]["amountMinor"] == 15000000
    assert all(p["accepted_at"] is None for p in parties(api, b, b.manager, theirs["id"]).values())


def test_money_under_a_contract_is_seen_by_both_sides(api, two):
    a, b = two
    cid = save(api, a, a.manager, None, {"kind": "services", "title": "Launch film",
        "parties": [{"kind": "company", "role": "provider", "orgId": str(a.org)}, {"kind": "company", "role": "client", "orgId": str(b.org)}]})
    one(api, a, a.manager, "select pulse.contract_send(%s) s", (cid,))
    p = parties(api, a, a.manager, cid)
    payer, payee = p[f"Synthetic {b.code}"]["party_key"], p[f"Synthetic {a.code}"]["party_key"]
    one(api, a, a.manager, "select pulse.contract_txn_add(%s,%s) id", (cid, Jsonb({"kind": "invoice", "payerKey": str(payer), "payeeKey": str(payee),
        "label": "Launch film, half up front", "amountMinor": 5000000, "dueOn": "2026-12-10"})))
    key = one(api, a, a.manager, "select contract_key k from pulse.contract where id=%s", (cid,))["k"]
    theirs = copy_of(api, b, b.manager, key)["id"]
    txn = one(api, b, b.manager, "select id,status,amount_minor from pulse.contract_txn where contract_id=%s", (theirs,))
    assert (txn["status"], txn["amount_minor"]) == ("billed", 5000000)
    # B pays and says so; A sees it paid. Who pays must be one of the parties.
    as_(api, b, b.manager, "select pulse.contract_txn_set(%s,%s,%s)", (theirs, txn["id"], Jsonb({"status": "paid", "paidOn": "2026-12-09"})))
    assert one(api, a, a.manager, "select status,paid_on::text p from pulse.contract_txn where contract_id=%s", (cid,)) == {"status": "paid", "p": "2026-12-09"}
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, a, a.manager, "select pulse.contract_txn_add(%s,%s) id", (cid, Jsonb({"kind": "payout", "payerKey": str(uuid.uuid4()), "payeeKey": str(payee),
            "label": "Nobody", "amountMinor": 100})))
    # Links are this company's own side.
    as_(api, a, a.manager, "insert into pulse.contract_link(org_id,contract_id,project_id,added_by) values(pulse.current_org(),%s,%s,pulse.current_viewer()) returning id", (cid, a.project))
    assert as_(api, b, b.manager, "select id from pulse.contract_link") == []


def test_a_person_sees_their_contracts_across_companies(api, owner, two):
    a, b = two
    acct = account(owner, a, a.editor, f"partner{a.code.lower()}")
    # Company B names A's editor, by account, as its technology partner.
    found = one(api, b, b.manager, "select pulse.contract_find_account(%s) r", (f"partner{a.code.lower()}",))["r"]
    assert found["id"] == str(acct)
    cid = save(api, b, b.manager, None, {"kind": "revenue_share", "title": "Technology partner",
        "parties": [{"kind": "company", "role": "client", "orgId": str(b.org)}, {"kind": "person", "role": "partner", "accountId": str(acct)}]})
    assert one(api, a, a.editor, "select pulse.my_contracts() r", ())["r"] == []
    one(api, b, b.manager, "select pulse.contract_send(%s) s", (cid,))
    mine = one(api, a, a.editor, "select pulse.my_contracts() r", ())["r"]
    assert [(c["title"], c["heldBy"], c["here"], c["myRole"]) for c in mine] == [("Technology partner", f"Synthetic {b.code}", False, "partner")]
    assert "notes" not in mine[0] and mine[0]["id"] is None
    # Someone else in A sees nothing of it.
    assert one(api, a, a.editor2, "select pulse.my_contracts() r", ())["r"] == []
    assert one(api, a, a.editor, "select pulse.contract_accept_account(%s) s", (mine[0]["key"],))["s"] == "proposed"
    assert parties(api, b, b.manager, cid)[f"Synthetic partner{a.code.lower()}"]["accepted_version"] == 1
    assert one(api, b, b.manager, "select pulse.contract_accept(%s,null,null) s", (cid,))["s"] == "active"


def test_employment_inside_one_company(api, two):
    a, _ = two
    cid = save(api, a, a.manager, None, {"kind": "employment", "title": "Video editor", "notes": "Pay band B",
        "parties": [{"kind": "company", "role": "employer", "orgId": str(a.org)}, {"kind": "person", "role": "employee", "personId": str(a.editor2)}]})
    assert as_(api, a, a.editor2, "select id from pulse.contract where id=%s", (cid,)) == []
    one(api, a, a.manager, "select pulse.contract_send(%s) s", (cid,))
    # The employee sees the contract and accepts their own side, never the company's notes or links; others see nothing.
    assert one(api, a, a.editor2, "select title from pulse.contract where id=%s", (cid,))["title"] == "Video editor"
    assert as_(api, a, a.editor2, "select notes from pulse.contract_side where contract_id=%s", (cid,)) == []
    assert as_(api, a, a.editor, "select id from pulse.contract where id=%s", (cid,)) == []
    with pytest.raises(psycopg.errors.NoDataFound):
        one(api, a, a.editor, "select pulse.contract_accept(%s,null,null) s", (cid,))
    assert one(api, a, a.editor2, "select pulse.contract_accept(%s,null,null) s", (cid,))["s"] == "proposed"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, a, a.editor2, "select pulse.contract_save(%s,%s) id", (cid, Jsonb({"title": "Senior editor"})))
    assert one(api, a, a.manager, "select pulse.contract_accept(%s,null,null) s", (cid,))["s"] == "active"
    assert [c["title"] for c in one(api, a, a.editor2, "select pulse.my_contracts() r", ())["r"]] == ["Video editor"]
    assert one(api, a, a.manager, "select pulse.contract_end(%s,'2027-03-31','Moved on') s", (cid,))["s"] == "ended"
