"""KAZUK-FLOW (1670): Kazuk's sales flow. G1 a sales seat in Billing that runs only its own deals (quotation, invoice
from it, payments), the sales head seeing the team's; G2 approval as one company setting; G4 "Start clean" for the
catalogue and cost kept from the sales roles. DB checks here; the API's answers in services/api/test/kazuk-flow-api-runner.mjs;
the salesperson (390) and owner (1440) in the browser in services/api/test/kazuk-flow-browser-runner.mjs (T00-T21).
Synthetic companies, people, clients, GSTINs and figures only."""
import hashlib
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import (  # noqa: F401  (erp is a fixture)
    BUYER,
    SELLER,
    as_,
    build_world,
    draft,
    erp,
    issue,
    one,
    person,
    setup_company,
)


def from_quote(api, w, who, quote, taxable=10000000, day="2026-04-02"):
    """A tax invoice drafted from a quotation (as Create invoice does), its figures adding up."""
    tax = taxable * 18 // 100
    with api.transaction():
        set_tenant(api, w.org, who)
        did = api.execute("""insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,source_id,created_by)
            values(%s,'invoice',%s,%s,%s,'27','intra',%s,%s,%s,0,%s,%s,%s) returning id""",
                          (w.org, day, Jsonb(SELLER), Jsonb(BUYER), taxable, tax // 2, tax // 2, taxable + tax, quote, who)).fetchone()["id"]
        api.execute("""insert into pulse.erp_line(org_id,document_id,position,description,sac,qty,rate,gst_rate,taxable,cgst,sgst,igst,total)
            values(%s,%s,0,'Synthetic marketing package','998361',1,%s,18,%s,%s,%s,0,%s)""", (w.org, did, taxable, taxable, tax // 2, tax // 2, taxable + tax))
    return did


@pytest.fixture
def sales(api, worker, erp):  # noqa: F811
    w = erp
    w.s1 = person(worker, w, "Synthetic Seller One", "sales")
    w.s2 = person(worker, w, "Synthetic Seller Two", "sales")
    w.head = person(worker, w, "Synthetic Sales Head", "sales_head")
    # EA's preset: no approval, cost and margin for the owner only (both are the company's settings).
    as_(api, w, w.founder, "update pulse.erp_settings set quote_approval=false,cost_visibility='owner'")
    return w


def test_the_sales_seats_read_and_write_billing_and_only_the_owner_sees_cost(api, worker, sales):
    w = sales
    expect = {w.s1: (True, True, True, False), w.head: (True, True, False, False), w.finance: (True, True, False, False), w.founder: (True, True, False, True),
              w.member: (False, False, False, False)}
    for who, want in expect.items():
        got = one(api, w, who, "select pulse.erp_can(false) r,pulse.erp_can(true) w,pulse.erp_own_only() o,pulse.erp_sees_cost() c")
        assert (got["r"], got["w"], got["o"], got["c"]) == want, who
    # A salesperson who also holds Finance (or a sales head) sees every deal.
    both = person(worker, w, "Synthetic Seller With Finance", "sales")
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'finance','2026-01-01')", (w.org, both))
    assert one(api, w, both, "select pulse.erp_own_only() o")["o"] is False
    # The setting decides: Finance too, then everyone, and only leadership or an admin changes it.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.finance, "update pulse.erp_settings set cost_visibility='everyone'")
    as_(api, w, w.founder, "update pulse.erp_settings set cost_visibility='finance'")
    assert [one(api, w, who, "select pulse.erp_sees_cost() c")["c"] for who in (w.s1, w.head, w.finance, w.founder)] == [False, False, True, True]
    as_(api, w, w.founder, "update pulse.erp_settings set cost_visibility='everyone'")
    assert [one(api, w, who, "select pulse.erp_sees_cost() c")["c"] for who in (w.s1, w.head, w.member)] == [True, True, False]


def test_a_salesperson_runs_their_own_deal_end_to_end_and_never_anothers(api, sales):
    w = sales
    q1, q2, qf = draft(api, w, w.s1, "quotation"), draft(api, w, w.s2, "quotation"), draft(api, w, w.finance, "quotation")
    # A salesperson's document is named theirs; Finance's is nobody's.
    assert one(api, w, w.finance, "select salesperson_id s from pulse.erp_document where id=%s", (q1,))["s"] == w.s1
    assert one(api, w, w.finance, "select salesperson_id s from pulse.erp_document where id=%s", (qf,))["s"] is None
    # Each salesperson sees their own deal and its lines; the sales head and Finance see all three.
    assert {r["id"] for r in as_(api, w, w.s1, "select id from pulse.erp_document")} == {q1}
    assert {r["document_id"] for r in as_(api, w, w.s1, "select document_id from pulse.erp_line")} == {q1}
    assert {r["id"] for r in as_(api, w, w.s2, "select id from pulse.erp_document")} == {q2}
    for who in (w.head, w.finance, w.founder):
        assert {r["id"] for r in as_(api, w, who, "select id from pulse.erp_document")} == {q1, q2, qf}
    # Another's deal: nothing to change directly, and Billing's functions refuse it.
    assert as_(api, w, w.s1, "update pulse.erp_document set notes='x' where id=%s returning id", (q2,)) == []
    assert as_(api, w, w.s1, "delete from pulse.erp_line where document_id=%s returning id", (q2,)) == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="another salesperson"):
        one(api, w, w.s1, "select pulse.erp_document_issue(%s)", (q2,))
    # Their own: send (number it), mark sent, accepted, then the invoice from it, then payments.
    assert issue(api, w, w.s1, q1) == "QT/26-27/0001"
    assert one(api, w, w.s1, "select pulse.erp_document_mark(%s,'sent',null) s", (q1,))["s"] == "sent"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.s2, "select pulse.erp_document_mark(%s,'accepted',null) s", (q1,))
    assert one(api, w, w.s1, "select pulse.erp_document_mark(%s,'accepted',null) s", (q1,))["s"] == "accepted"
    # T15: no blank tax invoice, proforma or credit note for a salesperson; from their quotation it is fine.
    for kind in ("invoice", "proforma"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match="accepted quotation"):
            draft(api, w, w.s1, kind)
    inv = from_quote(api, w, w.s1, q1)
    assert one(api, w, w.s1, "select salesperson_id s from pulse.erp_document where id=%s", (inv,))["s"] == w.s1
    assert issue(api, w, w.s1, inv) == "INV/26-27/0001"
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="accepted quotation"):
        draft(api, w, w.s1, "credit_note", taxable=100000, against=inv)
    pay = {"amount": 5900000, "receivedOn": "2026-04-03", "method": "upi", "reference": "TESTUTR001"}
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="another salesperson"):
        one(api, w, w.s2, "select pulse.erp_payment_add(%s,%s) id", (inv, Jsonb(pay)))
    one(api, w, w.s1, "select pulse.erp_payment_add(%s,%s) id", (inv, Jsonb(pay)))
    assert one(api, w, w.s1, "select status from pulse.erp_document where id=%s", (inv,))["status"] == "part_paid"
    one(api, w, w.s1, "select pulse.erp_payment_add(%s,%s) id", (inv, Jsonb({**pay, "method": "bank", "reference": "TESTUTR002"})))
    assert one(api, w, w.s1, "select status from pulse.erp_document where id=%s", (inv,))["status"] == "paid"
    # The other salesperson sees none of it: payments, log, files.
    assert as_(api, w, w.s2, "select id from pulse.erp_payment") == []
    assert as_(api, w, w.s2, "select id from pulse.erp_event where subject_id in (%s,%s)", (q1, inv)) == []
    assert as_(api, w, w.s2, "select document_id from pulse.erp_document_file") == []
    assert len(as_(api, w, w.head, "select id from pulse.erp_payment")) == 2


def test_settings_templates_and_stock_stay_with_leadership_and_finance(api, sales):
    w = sales
    assert as_(api, w, w.s1, "update pulse.erp_settings set due_days=20 returning org_id") == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.s1, "insert into pulse.erp_template(org_id,name) values(%s,'Synthetic template')", (w.org,))
    assert as_(api, w, w.head, "update pulse.erp_settings set due_days=20 returning org_id") != []
    # Only leadership or an admin turns approval on (1561's guard), never a salesperson.
    assert as_(api, w, w.s1, "update pulse.erp_settings set quote_approval=true returning org_id") == []


def test_the_catalogue_a_salesperson_adds_to_and_changes_only_their_own(api, sales):
    w = sales
    mine = one(api, w, w.s1, "insert into pulse.erp_item(org_id,kind,name,price,status,created_by) values(%s,'service','Synthetic Brand Film',5000000,'active',%s) returning id", (w.org, w.s1))["id"]
    owners = one(api, w, w.founder, "insert into pulse.erp_item(org_id,kind,name,price,cost,status,created_by) values(%s,'service','Synthetic Meta Ads',2500000,800000,'active',%s) returning id",
                 (w.org, w.founder))["id"]
    assert as_(api, w, w.s1, "update pulse.erp_item set price=4500000 where id=%s returning id", (mine,)) != []
    assert as_(api, w, w.s2, "update pulse.erp_item set price=1 where id=%s returning id", (mine,)) == []
    assert as_(api, w, w.s1, "update pulse.erp_item set price=1 where id=%s returning id", (owners,)) == []
    assert as_(api, w, w.founder, "update pulse.erp_item set price=2400000 where id=%s returning id", (owners,)) != []


def test_start_clean_archives_what_was_drafted_and_keeps_it(api, worker, sales):
    w = sales
    with worker.transaction():
        set_tenant(worker, w.org)
        for n in range(3):
            worker.execute("insert into pulse.erp_item(org_id,kind,name,price,status,source) values(%s,'service',%s,100000,'draft',%s)",
                           (w.org, f"Synthetic drafted {n}", Jsonb({"file": "Synthetic cost sheet", "row": n, "note": "Draft from the synthetic cost sheet"})))
        worker.execute("insert into pulse.erp_item(org_id,kind,name,price,status,source) values(%s,'service','Synthetic typed by hand',100000,'draft','{\"type\":\"manual\"}')", (w.org,))
    for who in (w.s1, w.head, w.finance):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            one(api, w, who, "select pulse.erp_catalog_start_clean() n")
    assert one(api, w, w.founder, "select pulse.erp_catalog_start_clean() n")["n"] == 3
    rows = {r["name"]: r["status"] for r in as_(api, w, w.founder, "select name,status from pulse.erp_item")}
    assert [rows[f"Synthetic drafted {n}"] for n in range(3)] == ["archived"] * 3 and rows["Synthetic typed by hand"] == "draft"
    assert one(api, w, w.founder, "select detail from pulse.erp_event where kind='start_clean'")["detail"] == {"archived": 3}
    assert one(api, w, w.founder, "select pulse.erp_catalog_start_clean() n")["n"] == 0


def test_an_admin_grants_the_sales_roles_and_companies_stay_apart(api, worker, owner, sales):
    w = sales
    fresh, admin = person(worker, w, "Synthetic New Seller"), person(worker, w, "Synthetic Admin", "admin")
    as_(api, w, admin, "insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'sales',current_date)", (w.org, fresh))
    assert one(api, w, fresh, "select pulse.erp_own_only() o")["o"] is True
    q = draft(api, w, w.s1, "quotation")
    b = build_world(worker, owner, api)
    b.seller = person(worker, b, "Synthetic Other Seller", "sales")
    b.head = person(worker, b, "Synthetic Other Head", "sales_head")
    for who in (b.seller, b.head):
        assert one(api, b, who, "select count(*) n from pulse.erp_document")["n"] == 0
        assert one(api, b, who, "select count(*) n from pulse.erp_document where id=%s", (q,))["n"] == 0
    with pytest.raises(psycopg.Error):  # another company's document is not there to issue
        one(api, b, b.seller, "select pulse.erp_document_issue(%s)", (q,))
    assert one(api, w, w.s1, "select status from pulse.erp_document where id=%s", (q,))["status"] == "draft"


def test_the_api_answers_for_the_sales_seat(api, worker, sales):
    """services/api/test/kazuk-flow-api-runner.mjs: cost left out for the sales roles, Billing's own parts refused,
    no blank invoice, approval mode none, Start clean, a salesperson's item usable at once."""
    w = sales
    with worker.transaction():
        set_tenant(worker, w.org)
        for who, handle in ((w.founder, "founder"), (w.s1, "seller"), (w.s2, "seller2"), (w.head, "head")):
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"{handle}@{w.domain}", who))
        worker.execute("insert into pulse.erp_item(org_id,kind,name,price,status,source) values(%s,'service','Synthetic drafted',100000,'draft','{\"file\":\"Synthetic\"}')", (w.org,))
    pkg = one(api, w, w.founder, "insert into pulse.erp_item(org_id,kind,name,price,cost,status,source,created_by) values(%s,'package','Synthetic Starter',7500000,2300000,'active','{\"type\":\"manual\"}',%s) returning id",
              (w.org, w.founder))["id"]
    as_(api, w, w.founder, "insert into pulse.erp_package_part(org_id,package_id,position,label,price,cost) values(%s,%s,0,'Synthetic Meta Ads',2500000,800000)", (w.org, pkg))
    other = draft(api, w, w.s2, "quotation")
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(config),
           "TEST_IDS": json.dumps({"org": str(w.org), "domain": w.domain, "package": str(pkg), "other": str(other)})}
    p = subprocess.run(["node", "test/kazuk-flow-api-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=300, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    made = json.loads(next(line.removeprefix("KF ") for line in p.stdout.splitlines() if line.startswith("KF ")))
    # The salesperson's item is in use at once and carries no cost; the drafted one was archived by Start clean.
    item = one(api, w, w.founder, "select status,cost from pulse.erp_item where id=%s", (made["item"],))
    assert item == {"status": "active", "cost": None}
    assert one(api, w, w.founder, "select status from pulse.erp_item where name='Synthetic drafted'")["status"] == "archived"
    assert one(api, w, w.founder, "select salesperson_id s from pulse.erp_document where id=%s", (made["quote"],))["s"] == w.s1


def test_the_sales_flow_is_configuration_ea_and_willow_lane_are_presets(api, sales):
    """1671: one engine, two presets. Willow Lane's preset reproduces BILLING-WL (a manager or the owner approves; the
    owner approves a changed price); EA's has neither; a step changed by the company says why and who unlocks it."""
    w = sales
    # No preset chosen: Pulse as before (the price step is on; approval follows the existing switch, off here).
    assert one(api, w, w.finance, "select pulse.erp_flow_step('price')->>'on' p")["p"] == "true"
    for who in (w.finance, w.s1, w.head):
        with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Leadership or an admin"):
            one(api, w, who, "select pulse.erp_flow_save(%s)", (Jsonb({"preset": "ea"}),))
    # Willow Lane: Finance cannot approve a quotation it was not sent; leadership can.
    one(api, w, w.founder, "select pulse.erp_flow_save(%s)", (Jsonb({"preset": "wl"}),))
    assert one(api, w, w.founder, "select quote_approval,cost_visibility from pulse.erp_settings") == {"quote_approval": True, "cost_visibility": "everyone"}
    q = draft(api, w, w.finance, "quotation")
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="approves this quotation"):
        one(api, w, w.finance, "select pulse.erp_document_issue(%s)", (q,))
    assert one(api, w, w.finance, "select pulse.erp_flow_block('approve')->>'why' w")["w"].startswith("A manager or the owner approves")
    assert issue(api, w, w.founder, q) == "QT/26-27/0001"
    # EA: no approval and no price gate; the salesperson's blank invoice stays locked, and says who unlocks it.
    one(api, w, w.founder, "select pulse.erp_flow_save(%s)", (Jsonb({"preset": "ea"}),))
    assert one(api, w, w.founder, "select quote_approval,cost_visibility from pulse.erp_settings") == {"quote_approval": False, "cost_visibility": "owner"}
    assert one(api, w, w.finance, "select pulse.erp_flow_step('price')->>'on' p")["p"] == "false"
    assert issue(api, w, w.s1, draft(api, w, w.s1, "quotation")) == "QT/26-27/0002"
    blocked = one(api, w, w.s1, "select pulse.erp_flow_block('invoice') b")["b"]
    assert blocked["why"].endswith("accepted quotation") and "Synthetic Finance" in blocked["unlockBy"] and "Synthetic Founder" in blocked["unlockBy"]
    assert one(api, w, w.head, "select pulse.erp_flow_block('invoice') b")["b"] is None
    # A company's own step: payments by Finance only. The salesperson is told why and who; the step can be switched off.
    one(api, w, w.founder, "select pulse.erp_flow_save(%s)", (Jsonb({"steps": {"payment": {"roles": ["finance"], "why": "Finance records payments here", "unlock": ["finance"]}}}),))
    assert one(api, w, w.founder, "select preset from pulse.erp_flow")["preset"] == "custom"
    b = one(api, w, w.s1, "select pulse.erp_flow_block('payment') b")["b"]
    assert b["why"] == "Finance records payments here" and b["unlockBy"] == ["Synthetic Finance"]
    assert one(api, w, w.finance, "select pulse.erp_flow_block('payment') b")["b"] is None
    one(api, w, w.founder, "select pulse.erp_flow_save(%s)", (Jsonb({"steps": {"payment": {"on": False}}}),))
    assert one(api, w, w.s1, "select pulse.erp_flow_block('payment') b")["b"] is None
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="no step called"):
        one(api, w, w.founder, "select pulse.erp_flow_save(%s)", (Jsonb({"steps": {"teleport": {"on": True}}}),))
    assert one(api, w, w.founder, "select count(*) n from pulse.erp_event where kind='flow_saved'")["n"] == 4


def test_versions_carry_their_reason_and_the_deal_has_one_status(api, sales):
    """1672: V1, V2 … each with why (price, scope, timeline, other) and when it was sent; one status per deal from Draft
    to Paid; Lost with its reason; the invoice records the version it came from."""
    w = sales

    def deal(d):
        return one(api, w, w.s1, "select pulse.erp_deal_status(%s) s", (d,))["s"]
    q = draft(api, w, w.s1, "quotation")
    assert deal(q) == "draft"
    assert issue(api, w, w.s1, q) == "QT/26-27/0001" and deal(q) == "to_send"
    one(api, w, w.s1, "select pulse.erp_document_mark(%s,'sent',null)", (q,))
    assert deal(q) == "sent"
    assert one(api, w, w.s1, "select pulse.erp_quote_negotiating(%s,'Client wants a lower price') s", (q,))["s"] == "negotiating"
    assert deal(q) == "negotiating"
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Say why"):
        one(api, w, w.s1, "select pulse.erp_quote_new_version(%s,'whim',null)", (q,))
    r = one(api, w, w.s1, "select pulse.erp_quote_new_version(%s,'price','Client asked 10%% off') r", (q,))["r"]
    assert r["revision"] == 1 and r["reason"] == "price"
    v1 = one(api, w, w.s1, "select reason_kind,reason,snapshot->>'sent_at' sent from pulse.erp_document_revision where document_id=%s and revision=0", (q,))
    assert v1["reason_kind"] == "price" and v1["reason"] == "Price: Client asked 10% off" and v1["sent"]
    assert deal(q) == "negotiating"
    assert issue(api, w, w.s1, q) == "QT/26-27/0001"  # V2 keeps the number
    one(api, w, w.s1, "select pulse.erp_document_mark(%s,'sent',null)", (q,))
    one(api, w, w.s1, "select pulse.erp_document_mark(%s,'accepted',null)", (q,))
    assert deal(q) == "accepted"
    inv = from_quote(api, w, w.s1, q)
    assert one(api, w, w.s1, "select source_revision v from pulse.erp_document where id=%s", (inv,))["v"] == 1
    issue(api, w, w.s1, inv)
    assert deal(q) == "invoiced"
    pay = {"amount": 5900000, "receivedOn": "2026-04-03", "method": "upi", "reference": "TESTUTR001"}
    one(api, w, w.s1, "select pulse.erp_payment_add(%s,%s)", (inv, Jsonb(pay)))
    assert deal(q) == "part_paid"
    one(api, w, w.s1, "select pulse.erp_payment_add(%s,%s)", (inv, Jsonb({**pay, "reference": "TESTUTR002"})))
    assert deal(q) == "paid"
    # A second deal, lost to a competitor: reportable by its reason.
    q2 = draft(api, w, w.s1, "quotation")
    issue(api, w, w.s1, q2)
    one(api, w, w.s1, "select pulse.erp_document_mark(%s,'sent',null)", (q2,))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Say why the deal was lost"):
        one(api, w, w.s1, "select pulse.erp_quote_lost(%s,'bad luck',null)", (q2,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.s2, "select pulse.erp_quote_lost(%s,'competitor',null)", (q2,))
    assert one(api, w, w.s1, "select pulse.erp_quote_lost(%s,'competitor','Went with another agency') s", (q2,))["s"] == "declined"
    assert deal(q2) == "lost"
    assert one(api, w, w.head, "select lost_reason r,count(*) n from pulse.erp_document where lost_reason is not null group by 1") == {"r": "competitor", "n": 1}


def test_an_invoice_from_the_accepted_quotation_keeps_its_lines_where_the_flow_says(api, sales):
    """1672 (G9): EA's preset locks an invoice's lines to its quotation for the sales role; Finance and other companies'
    flows (no preset) keep them editable."""
    w = sales
    q = draft(api, w, w.s1, "quotation")
    issue(api, w, w.s1, q)
    one(api, w, w.s1, "select pulse.erp_document_mark(%s,'accepted',null)", (q,))
    inv = from_quote(api, w, w.s1, q)
    assert one(api, w, w.s1, "select pulse.erp_lines_locked(%s) l", (inv,))["l"] is False  # no preset: as before
    one(api, w, w.founder, "select pulse.erp_flow_save(%s)", (Jsonb({"preset": "ea"}),))
    assert one(api, w, w.s1, "select pulse.erp_lines_locked(%s) l", (inv,))["l"] is True
    assert one(api, w, w.finance, "select pulse.erp_lines_locked(%s) l", (inv,))["l"] is False
    assert one(api, w, w.s1, "select pulse.erp_lines_locked(%s) l", (q,))["l"] is False


def test_a_payment_proof_belongs_to_its_payment_and_its_deal(api, sales):
    """1673 (G10): a proof is kept beside its own payment, read only where the payment is."""
    w = sales
    q = draft(api, w, w.s1, "quotation")
    issue(api, w, w.s1, q)
    inv = from_quote(api, w, w.s1, q)
    issue(api, w, w.s1, inv)
    pid = one(api, w, w.s1, "select pulse.erp_payment_add(%s,%s) id", (inv, Jsonb({"amount": 100000, "receivedOn": "2026-04-03", "method": "upi", "reference": "TESTUTR001"})))["id"]
    png = bytes.fromhex("89504e470d0a1a0a") + b"synthetic"
    as_(api, w, w.s1, "insert into pulse.erp_payment_file(org_id,payment_id,document_id,mime,bytes,sha256,created_by) values(%s,%s,%s,'image/png',%s,%s,%s)",
        (w.org, pid, inv, png, hashlib.sha256(png).hexdigest(), w.s1))
    assert one(api, w, w.head, "select mime from pulse.erp_payment_file where payment_id=%s", (pid,))["mime"] == "image/png"
    assert as_(api, w, w.s2, "select payment_id from pulse.erp_payment_file") == []
    other = draft(api, w, w.s1, "quotation")
    with pytest.raises(psycopg.Error):  # a proof names its own payment's invoice
        as_(api, w, w.s1, "insert into pulse.erp_payment_file(org_id,payment_id,document_id,mime,bytes,sha256) values(%s,%s,%s,'image/png',%s,%s)",
            (w.org, uuid.uuid4(), other, png, hashlib.sha256(png).hexdigest()))


def test_the_handover_suggests_the_pgs_adds_on_to_the_live_project_and_names_the_gaps(api, worker, owner, sales):
    """1688 (G11): the client's earlier PGS is suggested first, else the least loaded under the cap; a paid add-on joins
    the live project as scope (never a second project) and its PGS is told; missing commitments become the salesperson's
    tasks; a confirmed PGS heads the project and owns the handover."""
    w = sales
    one(api, w, w.founder, "select pulse.erp_flow_save(%s)", (Jsonb({"preset": "ea"}),))
    busy, free = person(worker, w, "Synthetic Busy PGS", "pgs"), person(worker, w, "Synthetic Free PGS", "pgs")
    with worker.transaction():
        set_tenant(worker, w.org)
        for n in range(8):  # at the cap: never suggested
            worker.execute("insert into pulse.project(org_id,registry_no,name,kind,status,lead_person_id) values(%s,%s,%s,'client_work','active',%s)", (w.org, 9000 + n, f"Synthetic busy {n}", busy))

    def paid_deal(note=""):
        q = draft(api, w, w.s1, "quotation", client=w.client)
        if note:
            as_(api, w, w.s1, "update pulse.erp_document set notes=%s where id=%s", (note, q))
        issue(api, w, w.s1, q)
        inv = from_quote(api, w, w.s1, q)
        as_(api, w, w.s1, "update pulse.erp_document set client_id=%s where id=%s", (w.client, inv))
        issue(api, w, w.s1, inv)
        one(api, w, w.s1, "select pulse.erp_payment_add(%s,%s)", (inv, Jsonb({"amount": 11800000, "receivedOn": "2026-04-03", "method": "upi", "reference": "TESTUTR001"})))
        return q, inv
    q, inv = paid_deal("Two extra reels promised")
    pid = one(api, w, w.founder, "select project_id from pulse.project_quote where document_id=%s", (inv,))["project_id"]
    s = one(api, w, w.founder, "select pulse.project_pgs_suggest(%s) s", (pid,))["s"]
    names = [x["name"] for x in s]
    assert "Synthetic Free PGS" in names and "Synthetic Busy PGS" not in names, s  # least loaded first, never above the cap
    assert all(x["load"] <= s[-1]["load"] for x in s[:1]), s
    gaps = [r["title"] for r in as_(api, w, w.founder, "select title from pulse.task where project_id=%s and source='gap' order by title", (pid,))]
    assert len(gaps) == 4 and any(t.startswith("Confirm the promise noted on the deal") for t in gaps), gaps
    one(api, w, w.founder, "select pulse.project_assign_pgs(%s,%s,'normal')", (pid, free))
    assert one(api, w, w.founder, "select lead_person_id from pulse.project where id=%s", (pid,))["lead_person_id"] == free
    # An add-on, paid: its lines join the same project; no second project; the PGS is told "scope added".
    q2, inv2 = paid_deal()
    assert one(api, w, w.founder, "select count(*) n from pulse.project where client_id=%s", (w.client,))["n"] == 1
    assert one(api, w, w.founder, "select project_id from pulse.project_quote where document_id=%s", (inv2,))["project_id"] == pid
    assert one(api, w, w.founder, "select count(*) n from pulse.task where project_id=%s and source_key like %s", (pid, "addon:%"))["n"] == 1
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select count(*) n from pulse.notification where person_id=%s and title like %s", (free, "Scope added%")).fetchone()["n"] == 1
    # A later project for the same client suggests the PGS who ran this one first.
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.project set status='done' where id=%s", (pid,))
    q3, inv3 = paid_deal()
    pid3 = one(api, w, w.founder, "select project_id from pulse.project_quote where document_id=%s", (inv3,))["project_id"]
    assert pid3 != pid
    assert one(api, w, w.founder, "select pulse.project_pgs_suggest(%s)->0->>'name' n", (pid3,))["n"] == "Synthetic Free PGS"


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_kazuk_flow_in_the_browser(api, worker, sales):
    """services/api/test/kazuk-flow-browser-runner.mjs: Kazuk's test script T00-T21 as far as the landed slices go, the
    salesperson at 390 and the owner at 1440 (PULSE_KR_SCREENSHOTS=<dir> keeps the shots)."""
    w = sales
    client = uuid.uuid4()
    company = {**SELLER, "legalName": "Synthetic Seller LLP", "website": "seller.example.test", "address": ["1 Synthetic Road, Pune 411001"]}
    as_(api, w, w.founder, "update pulse.erp_settings set company=%s,quote_approval=false", (Jsonb(company),))
    w.pgs = person(worker, w, "Synthetic PGS", "pgs")
    with worker.transaction():
        set_tenant(worker, w.org)
        for who, handle in ((w.founder, "owner"), (w.s1, "seller")):
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"{handle}@{w.domain}", who))
        worker.execute("insert into pulse.client(id,org_id,display_name,company_name,phone,email) values(%s,%s,'Test Realty Pvt Ltd','Test Realty Pvt Ltd','+91 90000 00111','buyer@example.test')",
                       (client, w.org))
        worker.execute("insert into pulse.erp_item(org_id,kind,name,price,status,source) values(%s,'service','Synthetic drafted extra',100000,'draft','{\"file\":\"Synthetic cost sheet\"}')", (w.org,))
    pkg = one(api, w, w.founder, "insert into pulse.erp_item(org_id,kind,name,price,cost,sac,status,source,created_by) values(%s,'package','Synthetic Starter',7500000,2300000,'998361','active','{\"type\":\"manual\"}',%s) returning id",
              (w.org, w.founder))["id"]
    as_(api, w, w.founder, "insert into pulse.erp_package_part(org_id,package_id,position,label,price,cost) values(%s,%s,0,'Synthetic part',7500000,2300000)", (w.org, pkg))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "TEST_IDS": json.dumps({"org": str(w.org), "client": str(client), "package": str(pkg)}),
           "TEST_EMAILS": json.dumps({"owner": f"owner@{w.domain}", "seller": f"seller@{w.domain}"})}
    p = subprocess.run(["node", "test/kazuk-flow-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=2400, check=False)
    print(p.stdout[-6000:])
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    # T05/T06: the quotation went out at the salesperson's own price, numbered, theirs, with no approval asked.
    q = one(api, w, w.founder, "select id,number,status,revision,salesperson_id,approval_to from pulse.erp_document where doc_type='quotation' and number like %s", ("%/0001",))
    assert (q["status"], q["revision"], q["salesperson_id"], q["approval_to"]) == ("converted", 2, w.s1, None), q
    # T14-T19: the invoice from V3, paid in two payments, each with its UTR and proof.
    inv = one(api, w, w.founder, "select id,status,source_revision,salesperson_id from pulse.erp_document where source_id=%s and doc_type='invoice'", (q["id"],))
    assert (inv["status"], inv["source_revision"], inv["salesperson_id"]) == ("paid", 2, w.s1)
    assert [(r["reference"], r["mime"]) for r in as_(api, w, w.founder, """select p.reference,f.mime from pulse.erp_payment p join pulse.erp_payment_file f on f.payment_id=p.id
        where p.document_id=%s order by p.created_at""", (inv["id"],))] == [("TESTUTR001", "image/png"), ("TESTUTR002", "image/png")]
    kinds = [r["kind"] for r in as_(api, w, w.founder, "select kind from pulse.erp_event where subject_id=%s", (q["id"],))]
    assert "emailed" in kinds and "whatsapp_sent" in kinds
    # T20/T21 (G11): one project; the heads told once; the handover carries V3, the invoice, both proofs and the scope;
    # the gap tasks are the salesperson's; the confirmed PGS heads it and owns the handover.
    made = json.loads(next(line.removeprefix("KFP ") for line in p.stdout.splitlines() if line.startswith("KFP ")))
    projects = as_(api, w, w.founder, "select p.id,p.lead_person_id,p.client_category,wp.project_type from pulse.project p join pulse.work_project wp on wp.project_id=p.id where p.client_id=%s", (client,))
    assert len(projects) == 1 and str(projects[0]["id"]) == made["project"]
    assert (projects[0]["lead_person_id"], projects[0]["client_category"], projects[0]["project_type"]) == (w.pgs, "competitive", "client_delivery")
    with worker.transaction():
        set_tenant(worker, w.org)
        told = worker.execute("select person_id,title from pulse.notification where title like %s", ("New client to assign%",)).fetchall()
        owned = worker.execute("select count(*) n from pulse.notification where person_id=%s and title like %s", (w.pgs, "You own a new client project%")).fetchone()["n"]
    assert len(told) == 1 and told[0]["person_id"] == w.manager and owned == 1, told
    hand = one(api, w, w.founder, "select notes,assignee_person_id from pulse.task where project_id=%s and source='handover'", (made["project"],))
    assert hand["assignee_person_id"] == w.pgs
    for bit in ("Test Realty Pvt Ltd", "V3", "INV/26-27/0001", "TESTUTR001", "TESTUTR002", "/proof", "Meta Ads Management", "Sold by: Synthetic Seller One"):
        assert bit in hand["notes"], (bit, hand["notes"])
    gaps = as_(api, w, w.founder, "select title,assignee_person_id from pulse.task where project_id=%s and source='gap' order by title", (made["project"],))
    assert len(gaps) == 3 and all(g["assignee_person_id"] == w.s1 for g in gaps), gaps
    # T10/T11: V1 and V2 kept with their reasons; T13: the second deal lost to a competitor.
    assert [r["reason_kind"] for r in as_(api, w, w.founder, "select reason_kind from pulse.erp_document_revision where document_id=%s order by revision", (q["id"],))] == ["price", "scope"]
    assert one(api, w, w.founder, "select lost_reason from pulse.erp_document where number like %s", ("%/0002",))["lost_reason"] == "competitor"
    lines = as_(api, w, w.founder, "select description,qty,rate,discount,discount_percent from pulse.erp_line where document_id=%s order by position", (q["id"],))
    assert [r["rate"] for r in lines if r["description"] == "Meta Ads Management"] == [2000000], lines
