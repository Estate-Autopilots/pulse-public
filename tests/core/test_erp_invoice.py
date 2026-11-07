"""ERP-INVOICE (0190) in the database: who may read and write invoicing, numbering per financial year (gapless, in date
order, one series per kind of document), issued documents kept as issued, payments and credit notes settling an invoice,
the "generate invoice" task rule, the client's acceptance link, stock and price history. Synthetic tenants, people,
clients, GSTINs and figures only; the GST arithmetic itself is tested in packages/invoice-doc."""
import hashlib
import uuid

import psycopg
import pytest
from helpers import build_world
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_finance_desk import finance_world  # noqa: F401  (fixture)

SELLER = {"legalName": "Synthetic Studio LLP", "gstin": "27AAXFV2138F1ZR", "stateCode": "27", "address": ["1 Test Road, Pune"]}
BUYER = {"name": "Northstar Homes LLP", "gstin": "27AABCS5678K1ZS", "stateCode": "27"}


def as_(api, w, who, sql, args=(), session=None):
    with api.transaction():
        set_tenant(api, w.org, who)
        if session:
            api.execute("select set_config('pulse.session_hash',%s,true)", (session,))
        cur = api.execute(sql, args)
        return cur.fetchall() if cur.description else []


def one(api, w, who, sql, args=(), session=None):
    rows = as_(api, w, who, sql, args, session)
    return rows[0] if rows else None


def person(worker, w, name, role=None):
    pid = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, name))
        if role:
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2026-01-01')", (w.org, pid, role))
    return pid


def setup_company(api, w, who):
    with api.transaction():
        set_tenant(api, w.org, who)
        api.execute("select pulse.erp_bootstrap()")
        api.execute("update pulse.erp_settings set company=%s,inventory_enabled=false", (Jsonb(SELLER),))


def draft(api, w, who, doc_type="invoice", taxable=10000000, day="2026-04-02", pos="27", against=None, client=None, rate=18):
    """A draft with one line; whole-rupee figures so CGST/SGST/IGST are exact (the arithmetic is @pulse/invoice-doc's)."""
    tax = taxable * rate // 100
    intra = pos == "27"
    cgst = sgst = tax // 2 if intra else 0
    igst = 0 if intra else tax
    with api.transaction():
        set_tenant(api, w.org, who)
        did = api.execute("""insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,against_id,client_id,created_by)
            values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id""",
                          (w.org, doc_type, day, Jsonb(SELLER), Jsonb(BUYER), pos, "intra" if intra else "inter", taxable, cgst, sgst, igst, taxable + tax, against, client, who)).fetchone()["id"]
        api.execute("""insert into pulse.erp_line(org_id,document_id,position,description,sac,qty,rate,gst_rate,taxable,cgst,sgst,igst,total)
            values(%s,%s,0,'Synthetic marketing package','998361',1,%s,%s,%s,%s,%s,%s,%s)""", (w.org, did, taxable, rate, taxable, cgst, sgst, igst, taxable + tax))
    return did


def issue(api, w, who, did):
    return one(api, w, who, "select pulse.erp_document_issue(%s) r", (did,))["r"]["number"]


@pytest.fixture
def erp(worker, owner, api):
    w = build_world(worker, owner, api)
    w.founder = person(worker, w, "Synthetic Founder", "leadership")
    w.finance = person(worker, w, "Synthetic Finance", "finance")
    w.member = person(worker, w, "Synthetic Member")
    w.client = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'Northstar Homes')", (w.client, w.org))
    setup_company(api, w, w.founder)
    return w


def test_leadership_and_finance_write_the_accountant_reads_others_see_nothing(api, worker, owner, finance_world):  # noqa: F811
    w, bootstrap, verified = finance_world
    founder, fin, member = person(worker, w, "Synthetic Founder", "leadership"), person(worker, w, "Synthetic Finance", "finance"), person(worker, w, "Synthetic Member")
    setup_company(api, w, founder)
    did = draft(api, w, fin)
    for who, session, read, write in ((founder, None, True, True), (fin, None, True, True), (w.manager, None, True, True),  # admin with the money grants
                                      (w.editor, verified, True, False),                                                    # Accountant, two-step session
                                      (w.editor, bootstrap, False, False), (w.editor2, None, False, False),                 # no verified session
                                      (member, None, False, False), (w.lead, None, False, False)):                         # a member; a PGS
        got = one(api, w, who, "select pulse.erp_can(false) r,pulse.erp_can(true) w", session=session)
        assert (got["r"], got["w"]) == (read, write), (who, session)
        seen = one(api, w, who, "select count(*) n from pulse.erp_document", session=session)["n"]
        assert seen == (1 if read else 0)
    # Read-only: an update finds nothing to change, an insert is refused.
    assert as_(api, w, w.editor, "update pulse.erp_document set notes='x' where id=%s returning id", (did,), verified) == []
    assert one(api, w, fin, "select notes from pulse.erp_document where id=%s", (did,))["notes"] == ""
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "insert into pulse.erp_item(org_id,kind,name) values(%s,'service','Nope')", (w.org,), verified)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.erp_document_issue(%s)", (did,), verified)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, member, "select pulse.erp_require(false)")
    # An operational admin without the money grants has no invoicing.
    plain_admin = person(worker, w, "Synthetic Admin", "admin")
    assert one(api, w, plain_admin, "select pulse.erp_can(false) r")["r"] is False
    # The FIN-LIVE hints are for writers only.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.erp_party_hints(%s)", (uuid.uuid4(),), verified)


def test_numbers_run_per_financial_year_without_gaps_and_in_date_order(api, erp):
    w = erp
    numbers = [issue(api, w, w.finance, draft(api, w, w.finance, day=d)) for d in ("2026-04-01", "2026-04-02", "2026-04-02")]
    assert numbers == ["INV/26-27/0001", "INV/26-27/0002", "INV/26-27/0003"]
    assert issue(api, w, w.finance, draft(api, w, w.finance, day="2026-03-31")) == "INV/25-26/0001"     # the year before
    # A date before the series' last one is refused, and the refusal costs no number.
    early = draft(api, w, w.finance, day="2026-04-01")
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="dated 02 Apr 2026"):
        issue(api, w, w.finance, early)
    as_(api, w, w.finance, "update pulse.erp_document set issue_date='2026-04-03' where id=%s", (early,))
    assert issue(api, w, w.finance, early) == "INV/26-27/0004"
    # Each kind of document has its own series; a quotation and a credit note start at 1.
    assert issue(api, w, w.finance, draft(api, w, w.finance, "quotation", day="2026-04-03")) == "QT/26-27/0001"
    inv = draft(api, w, w.founder, day="2026-04-04")
    issue(api, w, w.founder, inv)
    assert issue(api, w, w.founder, draft(api, w, w.founder, "credit_note", taxable=100000, day="2026-04-05", against=inv)) == "CN/26-27/0001"
    # A future date, a draft with nothing to bill, and figures that do not add up are refused.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="future"):
        issue(api, w, w.finance, draft(api, w, w.finance, day="2099-01-01"))
    bad = draft(api, w, w.finance, day="2026-04-05")
    as_(api, w, w.finance, "update pulse.erp_document set total=total+100 where id=%s", (bad,))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="do not add up"):
        issue(api, w, w.finance, bad)
    split = draft(api, w, w.finance, day="2026-04-05", pos="29")
    as_(api, w, w.finance, "update pulse.erp_document set place_of_supply='27' where id=%s", (split,))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="place of supply"):
        issue(api, w, w.finance, split)
    series = {r["doc_type"] + r["fy"]: r["next_no"] for r in as_(api, w, w.finance, "select doc_type,fy,next_no from pulse.erp_series")}
    assert series == {"invoice2026-27": 6, "invoice2025-26": 2, "quotation2026-27": 2, "credit_note2026-27": 2}


def test_an_issued_invoice_is_kept_and_settled_by_payments_and_credit_notes(api, erp):
    w = erp
    inv = draft(api, w, w.finance, client=w.client)
    issue(api, w, w.finance, inv)
    for sql in ("update pulse.erp_document set buyer='{}' where id=%s", "update pulse.erp_line set rate=1 where document_id=%s", "delete from pulse.erp_document where id=%s"):
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            as_(api, w, w.finance, sql, (inv,))
    sha = one(api, w, w.finance, "select pulse.erp_document_file_put(%s,%s) s", (inv, b"%PDF-synthetic"))["s"]
    assert sha == hashlib.sha256(b"%PDF-synthetic").hexdigest()
    assert one(api, w, w.finance, "select pulse.erp_document_file_put(%s,%s) s", (inv, b"%PDF-other"))["s"] == sha     # written once
    assert one(api, w, w.finance, "select pulse.erp_document_mark(%s,'sent') s", (inv,))["s"] == "sent"
    pay = lambda amount, tds=0, key=None: one(api, w, w.finance, "select pulse.erp_payment_add(%s,%s) id", (inv, Jsonb({"amount": amount, "tds": tds, "receivedOn": "2026-04-10", "bankLineKey": key})))["id"]
    pay(5000000)
    status = lambda: one(api, w, w.finance, "select status,paid,credited from pulse.erp_document where id=%s", (inv,))
    assert status() == {"status": "part_paid", "paid": 5000000, "credited": 0}
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="balance due"):
        pay(7000000)
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="credit note, not cancelled"):
        one(api, w, w.finance, "select pulse.erp_document_mark(%s,'cancel','wrong client')", (inv,))
    # A credit note for ₹11,800 against it; credit notes may not exceed the invoice.
    cn = draft(api, w, w.finance, "credit_note", taxable=1000000, against=inv, client=w.client, day="2026-04-03")
    issue(api, w, w.finance, cn)
    assert status() == {"status": "part_paid", "paid": 5000000, "credited": 1180000}
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="exceed the invoice"):
        issue(api, w, w.finance, draft(api, w, w.finance, "credit_note", taxable=10000000, against=inv, client=w.client, day="2026-04-04"))
    other = draft(api, w, w.finance, "credit_note", taxable=100000, against=inv, day="2026-04-04")      # no client: not the invoice's client
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="own client"):
        issue(api, w, w.finance, other)
    # The rest, with 2% TDS deducted by the client: paid. Removing a payment reopens it.
    last = pay(5620000 - 200000, 200000, "bank:synthetic-1")
    assert status()["status"] == "paid"
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Say why"):
        one(api, w, w.finance, "select pulse.erp_payment_void(%s,'')", (last,))
    one(api, w, w.finance, "select pulse.erp_payment_void(%s,'Bounced cheque')", (last,))
    assert status()["status"] == "part_paid"
    log = [r["kind"] for r in as_(api, w, w.finance, "select kind from pulse.erp_event where subject_id=%s order by at", (inv,))]
    assert log[:2] == ["issued", "sent"] and log.count("payment") == 2 and "payment_voided" in log


def test_the_invoice_task_is_done_only_when_its_invoice_is_issued(api, erp):
    w = erp
    did = draft(api, w, w.founder)
    task = one(api, w, w.founder, "select pulse.task_save(null,%s) id", (Jsonb({"title": "Generate invoice for Riverside milestone 2", "assigneeId": str(w.manager)}),))["id"]
    as_(api, w, w.founder, "update pulse.erp_document set task_id=%s where id=%s", (task, did))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Issue the invoice first"):
        one(api, w, w.manager, "select pulse.task_move(%s,'done')", (task,))
    issue(api, w, w.founder, did)
    assert one(api, w, w.manager, "select pulse.task_move(%s,'done') r", (task,))["r"]["status"] == "done"
    # A task with nothing attached is unaffected.
    plain = one(api, w, w.manager, "select pulse.task_save(null,%s) id", (Jsonb({"title": "Synthetic chore"}),))["id"]
    assert one(api, w, w.manager, "select pulse.task_move(%s,'done') r", (plain,))["r"]["status"] == "done"


def test_a_client_accepts_a_quotation_through_a_link_once(api, owner, erp):
    w = erp
    q = draft(api, w, w.finance, "quotation")
    token = hashlib.sha256(b"synthetic-token").hexdigest()
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Issue the quotation"):
        one(api, w, w.finance, "select pulse.erp_accept_link_create(%s,%s,30)", (q, token))
    issue(api, w, w.finance, q)
    one(api, w, w.finance, "select pulse.erp_accept_link_create(%s,%s,30)", (q, token))
    seen = one(api, w, None, "select pulse.erp_accept_open(%s) r", (token,))["r"]        # signed out
    assert seen["canDecide"] and seen["number"] == "QT/26-27/0001" and seen["buyer"] == "Northstar Homes LLP"
    assert one(api, w, None, "select pulse.erp_accept_open(%s) r", ("0" * 64,))["r"] is None
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="full name"):
        one(api, w, None, "select pulse.erp_accept_decide(%s,'accepted','',null,%s,'test')", (token, "a" * 64))
    one(api, w, None, "select pulse.erp_accept_decide(%s,'accepted','Asha Kireteso','Go ahead',%s,'test')", (token, "a" * 64))
    doc = one(api, w, w.finance, "select status,decision from pulse.erp_document where id=%s", (q,))
    assert doc["status"] == "accepted" and doc["decision"]["name"] == "Asha Kireteso" and doc["decision"]["via"] == "link"
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="already answered"):
        one(api, w, None, "select pulse.erp_accept_decide(%s,'declined','Asha Kireteso',null,%s,'test')", (token, "a" * 64))
    # An expired link shows nothing.
    q2 = draft(api, w, w.finance, "quotation", day="2026-04-03")
    issue(api, w, w.finance, q2)
    t2 = hashlib.sha256(b"synthetic-token-2").hexdigest()
    one(api, w, w.finance, "select pulse.erp_accept_link_create(%s,%s,1)", (q2, t2))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.erp_accept_link set expires_at=now()-interval '1 minute' where token_hash=%s", (t2,))
    assert one(api, w, None, "select pulse.erp_accept_open(%s) r", (t2,))["r"] is None
    assert [r["kind"] for r in as_(api, w, w.finance, "select kind from pulse.erp_event where subject_id=%s order by at", (q,))][-2:] == ["link_opened", "client_accepted"]


def test_stock_moves_follow_the_inventory_switch_and_items_keep_their_price_history(api, erp):
    w = erp
    item = one(api, w, w.finance, """insert into pulse.erp_item(org_id,kind,name,unit,price,track_stock,reorder_level,status)
        values(%s,'consumable','Synthetic brochure','nos',5000,true,5,'active') returning id""", (w.org,))["id"]
    move = lambda kind, qty: as_(api, w, w.finance, "insert into pulse.erp_stock_move(org_id,item_id,kind,qty) values(%s,%s,%s,%s) returning id", (w.org, item, kind, qty))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Inventory is off"):
        move("in", 10)
    as_(api, w, w.finance, "update pulse.erp_settings set inventory_enabled=true")
    move("in", 10)
    move("out", 3)
    assert one(api, w, w.finance, "select pulse.erp_on_hand(%s) n", (item,))["n"] == 7
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Not enough stock"):
        move("out", 8)
    move("adjust", -2)
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="kept as recorded"):
        as_(api, w, w.finance, "update pulse.erp_stock_move set qty=1 where item_id=%s", (item,))
    # A price change is a new version; a package's parts are saved with its version.
    as_(api, w, w.finance, "update pulse.erp_item set price=5500 where id=%s", (item,))
    pkg = one(api, w, w.finance, "insert into pulse.erp_item(org_id,kind,name,price) values(%s,'package','Synthetic 4 Month',10000000) returning id", (w.org,))["id"]
    one(api, w, w.finance, "select pulse.erp_parts_set(%s,%s)", (pkg, Jsonb([{"label": "Model-led film", "quantity": 3, "deliverables": ["3 videos"], "derives": "Ad creatives"},
                                                                          {"label": "Brochures", "itemId": str(item), "quantity": 100}])))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="from the catalog"):
        one(api, w, w.finance, "select pulse.erp_parts_set(%s,%s)", (pkg, Jsonb([{"label": "Itself", "itemId": str(pkg)}])))
    history = as_(api, w, w.finance, "select version,(snapshot->>'price')::bigint price,jsonb_array_length(snapshot->'parts') parts from pulse.erp_item_version where item_id=any(%s) order by item_id=%s,version",
                  ([item, pkg], pkg))
    assert [(r["version"], r["price"], r["parts"]) for r in history] == [(1, 5000, 0), (2, 5500, 0), (1, 10000000, 0), (2, 10000000, 2)]


def _seed_erp_world(worker, w):
    """Synthetic people, two clients with contacts, two projects, one past Zoho invoice and one bank credit in FIN-LIVE."""
    ids = {k: uuid.uuid4() for k in ("north", "lake", "asha", "ravi", "riverside", "towers")}
    with worker.transaction():
        set_tenant(worker, w.org)
        for pid, name, email in ((w.founder, "Neha Founder", "founder"), (w.finance, "Kedab Accounts", "finance"), (w.member, "Dev Member", "member")):
            worker.execute("update pulse.person set display_name=%s where id=%s", (name, pid))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"{email}@{w.domain}", pid))
        worker.execute("insert into pulse.client(id,org_id,display_name,company_name,city) values(%s,%s,'Northstar Homes','Northstar Homes LLP','Pune'),(%s,%s,'Lakeview Developers','Lakeview Developers Pvt Ltd','Bengaluru')",
                       (ids["north"], w.org, ids["lake"], w.org))
        for pid, name, client, email, phone in ((ids["asha"], "Asha Kireteso", ids["north"], "accounts@northstar.example", "+91 90000 00001"),
                                                (ids["ravi"], "Ravi Menon", ids["lake"], "finance@lakeview.example", "+91 90000 00002")):
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'client')", (pid, w.org, name))
            worker.execute("insert into pulse.contact_profile(org_id,person_id,contact_type,designation,email,phone) values(%s,%s,'developer','Accounts head',%s,%s)", (w.org, pid, email, phone))
            worker.execute("insert into pulse.client_contact(org_id,client_id,person_id,is_primary) values(%s,%s,%s,true)", (w.org, client, pid))
        no = worker.execute("select coalesce(max(registry_no),0)+1 n from pulse.project").fetchone()["n"]
        for i, (key, client, title) in enumerate((("riverside", "north", "Riverside Residences launch"), ("towers", "lake", "Lakeview Towers phase 2"))):
            worker.execute("insert into pulse.project(id,org_id,registry_no,name,title,client_id,kind,start_month,location) values(%s,%s,%s,%s,%s,%s,'client_work','2026-08-01','Baner')",
                           (ids[key], w.org, no + i, f"#{no + i} - {title}", title, ids[client]))
        worker.execute("insert into pulse_priv.finance_live_record(org_id,kind,key,scope,body,source,hash,confidence) values(%s,'invoice','INV-00009001','mail:sales',%s,%s,%s,'high')",
                       (w.org, Jsonb({"number": "INV-00009001", "client": "Lakeview Developers Pvt Ltd", "clientGstin": "29AAACN1234F1ZT", "date": "2026-06-10", "taxable": 50000, "total": 59000}),
                        Jsonb({"type": "mail"}), "b" * 64))
    return ids


@pytest.mark.skipif(__import__("os").environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_erp_screens_in_the_browser(worker, owner, api, erp, tmp_path):
    """ERP end to end through the real API and the built web app on a synthetic tenant (services/api/test/erp-runner.mjs);
    PULSE_ERP_SCREENSHOTS=<dir> also writes the screens at 1440 and 390 px, light and dark."""
    import json
    import os
    import subprocess
    from pathlib import Path

    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = erp
    ids = _seed_erp_world(worker, w)
    with api.transaction():   # the company profile comes from the runner, through the API
        set_tenant(api, w.org, w.founder)
        api.execute("update pulse.erp_settings set company='{}'")

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "TEST_WORKER_CONFIG": config(dsn("worker")), "TEST_ORG": str(w.org),
           "TEST_EMAILS": json.dumps({k: f"{k}@{w.domain}" for k in ("founder", "finance", "member")}),
           "TEST_IDS": json.dumps({k: str(v) for k, v in {**ids, "finance": w.finance, "founder": w.founder}.items()}), "PULSE_ERP_REPORT": str(tmp_path / "erp.json")}
    p = subprocess.run(["node", "test/erp-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-8000:]
    report = json.loads((tmp_path / "erp.json").read_text())
    assert report["browserChecks"] >= 25 and report["apiChecks"] >= 30
