"""BILLING-WL (owner, 4 Nov 2026; Akabod Soniba of Willow Lane's meeting, "Billing" 1-8), migration 1500: a forgiving search
over clients, contacts and leads; an approved quotation books its customer (a Prospect) on their story, and a renamed
customer stays one client; serial-numbered stock (stock in, set the current stock, sold on a tax invoice, back on cancel,
an opening-stock import); an approval a salesperson asks for and a manager or the owner gives, both told; client types
that follow the company's industry. Synthetic tenants, people, products, serials and figures only."""
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_billing_flow import _issued_quote, _invoice_from
from test_erp_invoice import SELLER, _seed_erp_world, as_, erp, one  # noqa: F401  (fixture)

ROOT = Path(__file__).resolve().parents[2]


def test_the_search_forgives_case_spaces_punctuation_and_word_order(owner):
    """"purepower 5", "Pure Power 5.0" and "pure power5.0" all find Pure Power 5.0 (Akabod's bug), and "Mifos Asohiv" finds
    Asohiv Mifos; digits find a phone or a code; nonsense finds nothing."""
    score = lambda q, *f: owner.execute("select pulse.search_score(%s,%s) s", (q, list(f))).fetchone()["s"]  # noqa: E731
    assert owner.execute("select pulse.search_norm(' Pure-Power 5.0 ') n").fetchone()["n"] == "purepower50"
    for q in ("purepower 5", "Pure Power 5.0", "pure power5.0", "PUREPOWER5"):
        assert score(q, "Pure Power 5.0", "PP-5") >= 85, q
    assert score("pp-5", "Pure Power 5.0", "PP-5") == 100, "a code"
    assert score("Asohiv Mifos", "Asohiv Mifos") == 100
    assert score("mifos asohiv", "Asohiv Mifos", None) == 50, "the words in another order"
    assert score("98765 43210", "Asohiv Mifos", "+91 98765-43210") == 70, "a phone however it is written"
    assert score("Ajay", "Ruvin Soniba", "Majestic Infra") == 0
    assert score("", "anything") == 0


def _inventory(api, w):
    as_(api, w, w.finance, "update pulse.erp_settings set inventory_enabled=true")


def _item(api, w, name, code, serialised=True, price=4500000):
    return one(api, w, w.finance, """insert into pulse.erp_item(org_id,kind,code,name,sac,unit,price,gst_rate,track_stock,serialised,status,warranty_months,warranty_options)
        values(%s,'product',%s,%s,'850440','nos',%s,18,true,%s,'active',60,%s) returning id""",
               (w.org, code, name, price, serialised, Jsonb([{"months": 24, "price": 900000}])))["id"]


def test_an_approved_quotation_books_a_prospect_on_its_story_and_the_invoice_makes_it_active(api, worker, erp):  # noqa: F811
    w = erp
    qid = _issued_quote(api, w, w.finance, {"name": "Synthetic Shantanu", "stateCode": "27", "phone": "+91 90000 12345"})
    r = one(api, w, w.finance, "select pulse.erp_book_client(%s) r", (qid,))["r"]
    assert r["newClient"] and r["newContact"], "a person billed by their own name is their own point of contact"
    c = one(api, w, w.finance, "select status,display_name from pulse.client where id=%s", (r["clientId"],))
    assert c == {"status": "prospect", "display_name": "Synthetic Shantanu"}, "a quotation books a Prospect"
    number = one(api, w, w.finance, "select number from pulse.erp_document where id=%s", (qid,))["number"]
    story = as_(api, w, w.finance, "select entity_type,new_value from pulse.record_change where field='billing' and entity_id = any(%s) order by 1",
                ([uuid.UUID(r["clientId"]), uuid.UUID(r["contactId"])],))
    assert [s["entity_type"] for s in story] == ["client", "contact"] and story[0]["new_value"].startswith(f"Quotation {number} approved · ₹1,18,000"), story
    one(api, w, w.finance, "select pulse.erp_book_client(%s) r", (qid,))
    assert len(as_(api, w, w.finance, "select 1 from pulse.record_change where field='billing' and entity_id=%s", (uuid.UUID(r["clientId"]),))) == 1, "once per document"
    # Renamed on the next quotation ("Mr. Synthetic Shantanu Nayak"), the same phone: the same client, no duplicate.
    again = _issued_quote(api, w, w.finance, {"name": "Mr. Synthetic Shantanu Nayak", "stateCode": "27", "phone": "9000012345"})
    r2 = one(api, w, w.finance, "select pulse.erp_book_client(%s) r", (again,))["r"]
    assert (r2["clientId"], r2["newClient"], r2["contactId"]) == (r["clientId"], False, r["contactId"])
    ev = one(api, w, w.finance, "select detail from pulse.erp_event where subject_id=%s and kind='booked'", (again,))["detail"]
    assert ev["clientRule"] == "phone"
    # The invoice from it makes the client Active.
    inv = _invoice_from(api, w, w.finance, qid=qid)
    one(api, w, w.finance, "select pulse.erp_book_client(%s) r", (inv,))
    assert one(api, w, w.finance, "select status from pulse.client where id=%s", (r["clientId"],))["status"] == "active"


def test_a_shared_phone_never_decides_between_two_clients(api, worker, erp):  # noqa: F811
    """The phone alone books a client only when exactly one client has it (an office line two companies share does not)."""
    w = erp
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.client(org_id,display_name,phone) values(%s,'Synthetic Alpha','+91 90000 22222'),(%s,'Synthetic Beta','9000022222')", (w.org, w.org))
    qid = _issued_quote(api, w, w.finance, {"name": "Synthetic Gamma", "stateCode": "27", "phone": "90000 22222"})
    r = one(api, w, w.finance, "select pulse.erp_book_client(%s) r", (qid,))["r"]
    assert r["newClient"], "two clients with the phone: a new one, not a guess"
    twins = one(api, w, w.finance, "select pulse.erp_party_twins(null,'+91 90000 22222') t")["t"]
    assert sorted(c["name"] for c in twins["clients"]) == ["Synthetic Alpha", "Synthetic Beta", "Synthetic Gamma"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.member, "select pulse.erp_party_twins(null,'9000022222') t")


def test_serial_numbered_stock_in_set_sold_on_an_invoice_and_back_on_cancel(api, worker, erp):  # noqa: F811
    w = erp
    _inventory(api, w)
    pp5 = _item(api, w, "Pure Power 5.0", "PP-5")
    r = one(api, w, w.finance, "select pulse.erp_stock_receive(%s,null,%s,'Synthetic supplier',null,null) r", (pp5, ["pp5-001", " PP5-002 ", "PP5-003"]))["r"]
    assert r["qty"] == 3 and r["onHand"] == 3
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="PP5-002 is already in Pulse"):
        one(api, w, w.finance, "select pulse.erp_stock_receive(%s,null,%s,'again',null,null) r", (pp5, ["PP5-002"]))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.member, "select pulse.erp_stock_receive(%s,null,%s,'x',null,null) r", (pp5, ["PP5-009"]))
    # The shelf today: 001, 002 and a new 010 (003 is gone): one adjustment, 003 counted out.
    r = one(api, w, w.finance, "select pulse.erp_stock_set(%s,null,%s,'Synthetic count') r", (pp5, ["PP5-001", "PP5-002", "PP5-010"]))["r"]
    assert (r["onHand"], r["change"], r["serialsIn"], r["serialsOut"]) == (3, 0, 1, 1)
    status = {x["serial"]: x["status"] for x in as_(api, w, w.finance, "select serial,status from pulse.erp_stock_serial where item_id=%s", (pp5,))}
    assert status == {"PP5-001": "in_stock", "PP5-002": "in_stock", "PP5-003": "removed", "PP5-010": "in_stock"}

    def invoice(serials, qty=2):
        with api.transaction():
            set_tenant(api, w.org, w.finance)
            did = api.execute("""insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,created_by)
                values(%s,'invoice',(now() at time zone 'Asia/Kolkata')::date,%s,%s,'27','intra',%s,%s,%s,0,%s,%s) returning id""",
                              (w.org, Jsonb(SELLER), Jsonb({"name": "Synthetic Solar Buyer", "stateCode": "27"}), 4500000 * qty, 405000 * qty, 405000 * qty, 5310000 * qty, w.finance)).fetchone()["id"]
            api.execute("""insert into pulse.erp_line(org_id,document_id,position,item_id,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total,serials)
                values(%s,%s,0,%s,'Pure Power 5.0',%s,4500000,18,%s,%s,%s,0,%s,%s)""", (w.org, did, pp5, qty, 4500000 * qty, 405000 * qty, 405000 * qty, 5310000 * qty, serials))
        return did
    short = invoice(["PP5-001"])
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Pick 2 serial numbers for Pure Power 5.0: 1 picked"):
        one(api, w, w.finance, "select pulse.erp_document_issue(%s)", (short,))
    gone = invoice(["PP5-001", "PP5-003"])
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="PP5-003 is not in stock"):
        one(api, w, w.finance, "select pulse.erp_document_issue(%s)", (gone,))
    good = invoice(["PP5-001", "PP5-010"])
    one(api, w, w.finance, "select pulse.erp_document_issue(%s)", (good,))
    sold = as_(api, w, w.finance, "select serial from pulse.erp_stock_serial where document_id=%s and status='sold' order by 1", (good,))
    assert [x["serial"] for x in sold] == ["PP5-001", "PP5-010"]
    assert one(api, w, w.finance, "select pulse.erp_on_hand(%s)::int n", (pp5,))["n"] == 1, "the invoice took them out of stock"
    # The same serial cannot be sold twice.
    twice = invoice(["PP5-001", "PP5-002"])
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="PP5-001 is not in stock"):
        one(api, w, w.finance, "select pulse.erp_document_issue(%s)", (twice,))
    one(api, w, w.finance, "select pulse.erp_document_mark(%s,'cancel','Synthetic: wrong customer')", (good,))
    assert one(api, w, w.finance, "select count(*)::int n from pulse.erp_stock_serial where item_id=%s and status='in_stock'", (pp5,))["n"] == 3
    assert one(api, w, w.finance, "select pulse.erp_on_hand(%s)::int n", (pp5,))["n"] == 3, "cancelling puts them back"
    # A number for an item without serials; a sold serial cannot be counted back in.
    plain = _item(api, w, "Synthetic cable kit", "CK-1", serialised=False)
    assert one(api, w, w.finance, "select pulse.erp_stock_set(%s,12,null,null) r", (plain,))["r"]["onHand"] == 12
    one(api, w, w.finance, "select pulse.erp_document_issue(%s)", (twice,))  # 001 and 002 are back in stock now
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="already sold"):
        one(api, w, w.finance, "select pulse.erp_stock_set(%s,null,%s,null) r", (pp5, ["PP5-001"]))


def test_opening_stock_from_the_sheet_dry_run_then_applied_by_the_operator(api, worker, erp, tmp_path):  # noqa: F811
    from conftest import dsn
    w = erp
    _inventory(api, w)
    pp5 = _item(api, w, "Pure Power 5.0", "PP-5")
    pp20 = _item(api, w, "Pure Power 20.0", "PP-20")
    kit = _item(api, w, "Synthetic cable kit", "CK-1", serialised=False)
    sheet = tmp_path / "stock.csv"
    sheet.write_text("Item Code,Product Name,Qty,Serial Numbers\n"
                     "pp 5,,,\"SYN-5-01, SYN-5-02\"\n"
                     ",pure power 20.0,,SYN-20-01\n"
                     ",PURE  POWER 20.0,,SYN-20-02\n"
                     "CK-1,Synthetic cable kit,14,\n"
                     "ZZ-9,Synthetic unknown,3,\n", encoding="utf-8")
    run = lambda *a: subprocess.run([sys.executable, str(ROOT / "tools/billing/stock-import.py"), "--org", str(w.org), "--file", str(sheet), "--db", dsn("worker"), *a],  # noqa: E731
                                    capture_output=True, text=True, timeout=120, check=False, env={**os.environ})
    dry = run()
    assert dry.returncode == 0, dry.stderr[-3000:]
    assert "Dry run: 4 items in the sheet, 3 matched, 1 not in the catalogue" in dry.stdout, dry.stdout
    assert one(api, w, w.finance, "select pulse.erp_on_hand(%s)::int n", (kit,))["n"] == 0, "a dry run writes nothing"
    done = run("--apply")
    assert done.returncode == 0, done.stderr[-3000:]
    assert "Applied" in done.stdout and "not found: ZZ-9 Synthetic unknown" in done.stdout
    hand = lambda i: one(api, w, w.finance, "select pulse.erp_on_hand(%s)::int n", (i,))["n"]  # noqa: E731
    assert (hand(pp5), hand(pp20), hand(kit)) == (2, 2, 14)
    assert [x["serial"] for x in as_(api, w, w.finance, "select serial from pulse.erp_stock_serial where item_id=%s order by 1", (pp20,))] == ["SYN-20-01", "SYN-20-02"]
    # Applied again: nothing changes. The API's role cannot run the operator's import, nor a person their own without the grant.
    assert run("--apply").returncode == 0 and hand(kit) == 14
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.finance, "select pulse.erp_stock_import_operator('[]'::jsonb,false) r")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.member, "select pulse.erp_stock_import('[]'::jsonb,false) r")
    # A serialised item listed with a count and no serials is refused, not emptied.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="list the serial numbers"):
        one(api, w, w.finance, "select pulse.erp_stock_import(%s::jsonb,true) r", (json.dumps([{"code": "PP-5", "qty": 4}]),))


def test_a_salesperson_asks_a_manager_who_approves_and_both_are_told(api, worker, owner, erp):  # noqa: F811
    w = erp
    _seed_erp_world(worker, w)
    as_(api, w, w.founder, "update pulse.erp_settings set quote_approval=true")
    with api.transaction():
        set_tenant(api, w.org, w.finance)
        did = api.execute("""insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,created_by)
            values(%s,'quotation',(now() at time zone 'Asia/Kolkata')::date,%s,%s,'27','intra',10000000,900000,900000,0,11800000,%s) returning id""",
                          (w.org, Jsonb(SELLER), Jsonb({"name": "Synthetic Majestic Infra", "stateCode": "27"}), w.finance)).fetchone()["id"]
        api.execute("""insert into pulse.erp_line(org_id,document_id,position,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total)
            values(%s,%s,0,'Pure Power 20.0',1,10000000,18,10000000,900000,900000,0,11800000)""", (w.org, did))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="send it for approval"):
        one(api, w, w.finance, "select pulse.erp_document_issue(%s)", (did,))
    approvers = [x["name"] for x in as_(api, w, w.finance, "select name from pulse.erp_approvers()")]
    assert "Neha Founder" in approvers and "Dev Member" not in approvers
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="manager or the owner"):
        one(api, w, w.finance, "select pulse.erp_approval_ask(%s,%s,null)", (did, w.member))
    one(api, w, w.finance, "select pulse.erp_approval_ask(%s,%s,'Synthetic: customer wants it today')", (did, w.founder))
    one(api, w, w.finance, "select pulse.erp_approval_ask(%s,%s,null)", (did, w.founder))  # a reminder
    with owner.transaction():
        set_tenant(owner, w.org)
        asked = owner.execute("select person_id,title,href from pulse.notification where event_type='billing.approval' order by created_at", ()).fetchall()
    assert [a["person_id"] for a in asked] == [w.founder, w.founder], "the approver is told, and reminded"
    assert asked[0]["title"].startswith("Approve the quotation for Synthetic Majestic Infra: ₹1,18,000") and asked[0]["href"] == f"/erp/documents/{did}"
    one(api, w, w.founder, "select pulse.erp_document_issue(%s)", (did,))
    with owner.transaction():
        set_tenant(owner, w.org)
        told = owner.execute("select person_id,title from pulse.notification where event_type='billing.approved'").fetchall()
        kinds = [e["kind"] for e in owner.execute("select kind from pulse.erp_event where subject_id=%s order by at", (did,)).fetchall()]
    assert [t["person_id"] for t in told] == [w.finance] and told[0]["title"].startswith("Approved: quotation ") and "Send it now" in told[0]["title"]
    assert "approval_asked" in kinds and "approval_given" in kinds, "the history keeps who asked and who approved"
    # Off again, Finance approves its own quotation as before.
    as_(api, w, w.founder, "update pulse.erp_settings set quote_approval=false")
    today = one(api, w, w.finance, "select (now() at time zone 'Asia/Kolkata')::date::text d")["d"]
    other = _issued_quote(api, w, w.finance, {"name": "Synthetic Free Approval", "stateCode": "27"}, day=today)
    assert one(api, w, w.finance, "select status from pulse.erp_document where id=%s", (other,))["status"] == "issued"


def test_a_revision_starts_its_own_approval(api, worker, owner, erp):  # noqa: F811
    """Review (5 Nov 2026): revising an approved quotation clears the earlier request, so the approver is not shown it as
    theirs and the salesperson sends R2 afresh; R2's first request is a request, not a reminder."""
    w = erp
    _seed_erp_world(worker, w)
    as_(api, w, w.founder, "update pulse.erp_settings set quote_approval=true")
    with api.transaction():
        set_tenant(api, w.org, w.finance)
        did = api.execute("""insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,created_by)
            values(%s,'quotation',(now() at time zone 'Asia/Kolkata')::date,%s,%s,'27','intra',10000000,900000,900000,0,11800000,%s) returning id""",
                          (w.org, Jsonb(SELLER), Jsonb({"name": "Synthetic Revised Co", "stateCode": "27"}), w.finance)).fetchone()["id"]
        api.execute("""insert into pulse.erp_line(org_id,document_id,position,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total)
            values(%s,%s,0,'Pure Power 5.0',1,10000000,18,10000000,900000,900000,0,11800000)""", (w.org, did))
    one(api, w, w.finance, "select pulse.erp_approval_ask(%s,%s,'Synthetic: R1')", (did, w.founder))
    one(api, w, w.founder, "select pulse.erp_document_issue(%s)", (did,))
    one(api, w, w.finance, "select pulse.erp_quote_revise(%s,'Synthetic: the customer negotiated')", (did,))
    d = one(api, w, w.finance, "select status,revision,approval_to,approval_asked_by,approval_asked_at,approval_note from pulse.erp_document where id=%s", (did,))
    assert d == {"status": "draft", "revision": 1, "approval_to": None, "approval_asked_by": None, "approval_asked_at": None, "approval_note": None}
    assert not as_(api, w, w.founder, "select 1 from pulse.erp_document where status='draft' and approval_to=%s", (w.founder,)), "not on the approver's list"
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="send it for approval"):
        one(api, w, w.finance, "select pulse.erp_document_issue(%s)", (did,))
    r = one(api, w, w.finance, "select pulse.erp_approval_ask(%s,%s,null) r", (did, w.founder))["r"]
    assert r["reminder"] is False, "R2's first request is not a reminder"
    with owner.transaction():
        set_tenant(owner, w.org)
        asked = owner.execute("select count(*) n from pulse.notification where event_type='billing.approval' and href=%s", (f"/erp/documents/{did}",)).fetchone()["n"]
    assert asked == 2, "the approver is told about R2 too"


def test_only_leadership_switches_approval_and_it_covers_documents_made_from_scratch(api, worker, erp):  # noqa: F811
    """Review (5 Nov 2026): a salesperson who must send for approval cannot switch it off; with it on, a proforma or tax
    invoice made from scratch waits for approval too, while one made from an approved quotation does not."""
    w = erp
    _seed_erp_world(worker, w)
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Only leadership or an admin"):
        as_(api, w, w.finance, "update pulse.erp_settings set quote_approval=true")
    as_(api, w, w.founder, "update pulse.erp_settings set quote_approval=true")
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Only leadership or an admin"):
        as_(api, w, w.finance, "update pulse.erp_settings set quote_approval=false")
    as_(api, w, w.finance, "update pulse.erp_settings set due_days=20")  # the rest of the settings stay theirs
    with api.transaction():
        set_tenant(api, w.org, w.finance)
        pid = api.execute("""insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,created_by)
            values(%s,'proforma',(now() at time zone 'Asia/Kolkata')::date,%s,%s,'27','intra',10000000,900000,900000,0,11800000,%s) returning id""",
                          (w.org, Jsonb(SELLER), Jsonb({"name": "Synthetic Scratch Proforma", "stateCode": "27"}), w.finance)).fetchone()["id"]
        api.execute("""insert into pulse.erp_line(org_id,document_id,position,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total)
            values(%s,%s,0,'Pure Power 5.0',1,10000000,18,10000000,900000,900000,0,11800000)""", (w.org, pid))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="approves this proforma"):
        one(api, w, w.finance, "select pulse.erp_document_issue(%s)", (pid,))
    one(api, w, w.finance, "select pulse.erp_approval_ask(%s,%s,null)", (pid, w.founder))
    one(api, w, w.founder, "select pulse.erp_document_issue(%s)", (pid,))
    assert one(api, w, w.finance, "select status from pulse.erp_document where id=%s", (pid,))["status"] == "issued"


def test_a_dealers_phone_typed_for_another_customer_books_a_new_client(api, worker, erp):  # noqa: F811
    """Review (5 Nov 2026): one client has the phone, but the name typed is someone else's (a dealer's or installer's
    number typed for an end customer): a new client, not the dealer."""
    w = erp
    with worker.transaction():
        set_tenant(worker, w.org)
        dealer = worker.execute("insert into pulse.client(org_id,display_name,phone) values(%s,'Synthetic Majestic Infra','+91 90000 33333') returning id",
                                (w.org,)).fetchone()["id"]
    qid = _issued_quote(api, w, w.finance, {"name": "Synthetic Ruvin Shah", "stateCode": "27", "phone": "9000033333"})
    r = one(api, w, w.finance, "select pulse.erp_book_client(%s) r", (qid,))["r"]
    assert r["newClient"] and r["clientId"] != str(dealer), "Ruvin Shah is his own client"
    assert one(api, w, w.finance, "select display_name from pulse.client where id=%s", (r["clientId"],))["display_name"] == "Synthetic Ruvin Shah"
    # The dealer's own next quotation, renamed, still finds the dealer.
    again = _issued_quote(api, w, w.finance, {"name": "Majestic Infra", "stateCode": "27", "phone": "9000033333"})
    assert one(api, w, w.finance, "select pulse.erp_book_client(%s) r", (again,))["r"]["clientId"] == str(dealer)
    assert one(api, w, w.finance, "select pulse.erp_name_close('Shantanu','Mr. Shantanu Nayak') a")["a"] is True
    assert one(api, w, w.finance, "select pulse.erp_name_close('Ruvin Shah','Majestic Infra') a")["a"] is False
    assert one(api, w, w.finance, "select pulse.erp_name_close('Nayak Shantanu','Mr. Shantanu Nayak') a")["a"] is True
    assert one(api, w, w.finance, "select pulse.erp_name_close('Synthetic Ruvin Shah','Synthetic Majestic Infra') a")["a"] is False


def test_client_types_follow_the_industry(api, owner, erp):  # noqa: F811
    """A solar dealer is offered Business, Individual and Dealer, never Developer, Channel partner or Agent; a real-estate
    company keeps them; a type already on a record, or one the company edited, stays offered; a neutral industry with a
    trader's Billing pack changes nothing; switching back to real estate brings the archived types back."""
    w = erp
    live = lambda: {(r["entity"], r["key"]) for r in as_(api, w, w.founder, "select entity,key from pulse.record_type where archived_at is null")}  # noqa: E731
    as_(api, w, w.founder, "select pulse.record_types_defaults()")
    before = live()
    assert ("client", "developer") in before, "no industry chosen: today's types stay"
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.org_pack(org_id,pack_key) values(%s,'neutral') on conflict(org_id) do update set pack_key='neutral'", (w.org,))
        owner.execute("update pulse.erp_settings set pack='trader' where org_id=%s", (w.org,))
        owner.execute("select pulse.record_types_align()")
    assert live() == before, "a neutral industry keeps every type whatever the Billing pack"
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.client set client_type='channel_partner' where id=%s", (w.client,))
        owner.execute("update pulse.record_type set hint='Synthetic: ours', updated_by=%s where org_id=%s and entity='client' and key='agent'", (w.founder, w.org))
        owner.execute("update pulse.org_pack set pack_key='solar' where org_id=%s", (w.org,))
    now = live()
    assert {("client", "business"), ("client", "individual"), ("client", "dealer"), ("contact", "customer"), ("contact", "installer")} <= now
    assert ("client", "developer") not in now, "never offered to a solar dealer"
    assert ("client", "channel_partner") in now, "in use on a record: kept"
    assert ("client", "agent") in now, "edited by the company: kept"
    assert one(api, w, w.founder, "select client_type from pulse.client where id=%s", (w.client,))["client_type"] == "channel_partner", "kept on the record"
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.org_pack set pack_key='real_estate_marketing' where org_id=%s", (w.org,))
    back = live()
    assert ("client", "developer") in back and before <= back, "switching back to real estate brings the archived types back"
    assert ("client", "dealer") in back, "and keeps what was added (records may use it)"


@pytest.mark.skipif(os.environ.get("PULSE_BILLING_WL_SKIP_RUNNER") == "1", reason="runner skipped on request")
def test_willow_lane_billing_through_the_api_and_the_browser(worker, owner, api, erp, tmp_path):  # noqa: F811
    """The whole of it through the real API (services/api/test/billing-wl-runner.mjs); with PULSE_AUTH_BROWSER=1 also through
    the built web app at 390 and 1440 px (PULSE_BILLING_SCREENSHOTS=<dir> writes the screens)."""
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = erp
    ids = _seed_erp_world(worker, w)
    lead, asohiv = uuid.uuid4(), uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Asohiv Mifos','client')", (asohiv, w.org))
        worker.execute("insert into pulse.contact_profile(org_id,person_id,email,phone,city) values(%s,%s,'asohiv@synthetic.example','+91 98765 43210','Nagpur')", (w.org, asohiv))
    with owner.transaction():   # the salesperson's own lead, synced from Sales X-Ray (Meta ads), not yet a client or a contact
        set_tenant(owner, w.org)
        owner.execute("""insert into pulse.sales_xray_lead(org_id,sx_lead_id,name,company,city,phone,email,stage,stage_label,source_label,owner_name)
            values(%s,%s,'Ajay Kireteso','Synthetic Majestic Infra','Wardha','+91 90000 00111','ajay@majestic.example','new','New','Meta ads','Kedab Accounts')""", (w.org, lead))
    as_(api, w, w.founder, "update pulse.erp_settings set inventory_enabled=true,quote_approval=true")

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "TEST_ORG": str(w.org),
           "TEST_EMAILS": json.dumps({k: f"{k}@{w.domain}" for k in ("founder", "finance", "member")}),
           "TEST_IDS": json.dumps({k: str(v) for k, v in {**ids, "finance": w.finance, "founder": w.founder, "lead": lead, "asohiv": asohiv}.items()}),
           "PULSE_BILLING_REPORT": str(tmp_path / "billing.json")}
    p = subprocess.run(["node", "test/billing-wl-runner.mjs"], cwd=ROOT / "services/api", env=env, capture_output=True, text=True, timeout=2400, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-8000:]
    report = json.loads((tmp_path / "billing.json").read_text())
    assert report["apiChecks"] >= 40
    if os.environ.get("PULSE_AUTH_BROWSER") == "1":
        assert report["browserChecks"] >= 20
