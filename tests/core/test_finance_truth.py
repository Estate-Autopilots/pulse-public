"""FINANCE-TRUTH (1480, owner 4 Nov 2026; Kazuk: GST is paid into a separate account): Finance → Numbers and a
salesperson's own numbers. A payment into the GST account pays an invoice's GST first, any other its base first, so a
GST receipt still to come is GST outstanding and never missing revenue; collections are bank lines for the months they
cover, else the Cash book; expenses are net of input GST with taxes apart. Synthetic tenants, people and figures only."""
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import (  # noqa: F401  (erp is a fixture)
    as_,
    draft,
    erp,
    issue,
    one,
    person,
)

GST = "GST account"
ACCOUNTS = ["HDFC current", GST, "Cash"]


def pay(api, w, inv, amount, on, account=None, tds=0):
    pid = one(api, w, w.finance, "select pulse.erp_payment_add(%s,%s) id", (inv, Jsonb({"amount": amount, "tds": tds, "receivedOn": on})))["id"]
    if account:
        as_(api, w, w.finance, "select pulse.erp_payment_account(%s,%s)", (pid, account))
    return pid


def due(api, w, inv):
    return one(api, w, w.finance, "select pulse.erp_invoice_due(%s) d", (inv,))["d"]


@pytest.fixture
def books(worker, owner, api, erp):  # noqa: F811
    w = erp
    w.sales = person(worker, w, "Synthetic Sales")
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.fin_entry_settings(org_id,accounts) values(%s,%s)", (w.org, ACCOUNTS))
    return w


def test_a_gst_receipt_into_the_gst_account_is_gst_and_a_missing_one_is_outstanding(api, books):
    w = books
    # Only leadership names the GST account, and only one of the Cash book's accounts.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.finance, "select pulse.finance_gst_account_set(%s)", (GST,))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Cash book accounts"):
        as_(api, w, w.founder, "select pulse.finance_gst_account_set('Nowhere')")
    assert one(api, w, w.founder, "select pulse.finance_gst_account_set(%s) a", (f"  {GST} ",))["a"] == GST
    assert one(api, w, w.finance, "select pulse.finance_accounts() a")["a"] == {"accounts": ACCOUNTS, "gstAccount": GST}

    # ₹1,00,000 + 18% GST. The base arrives in April in the main account: all revenue, the GST still to come.
    inv = draft(api, w, w.finance, client=w.client)
    issue(api, w, w.finance, inv)
    pay(api, w, inv, 10000000, "2026-04-10", "HDFC current")
    assert due(api, w, inv) == {"baseDue": 0, "gstDue": 1800000}
    # The GST arrives in May in the GST account: GST, not revenue; the invoice is paid.
    pay(api, w, inv, 1800000, "2026-05-05", GST)
    assert due(api, w, inv) == {"baseDue": 0, "gstDue": 0}
    assert one(api, w, w.finance, "select status from pulse.erp_document where id=%s", (inv,))["status"] == "paid"

    # A second invoice paid in full into the main account in one go: base and GST both received there.
    inv2 = draft(api, w, w.finance, taxable=5000000, day="2026-04-15", client=w.client)
    issue(api, w, w.finance, inv2)
    pay(api, w, inv2, 5900000, "2026-04-20")
    # A third: ₹20,000 into the GST account is its ₹3,600 GST and ₹16,400 of base; the rest is still due.
    inv3 = draft(api, w, w.finance, taxable=2000000, day="2026-05-02", client=w.client)
    issue(api, w, w.finance, inv3)
    pid = pay(api, w, inv3, 2000000, "2026-05-10", GST)
    assert due(api, w, inv3) == {"baseDue": 360000, "gstDue": 0}
    # Moving that payment to the main account makes it base first: ₹3,600 of GST is then due, logged on the invoice.
    as_(api, w, w.finance, "select pulse.erp_payment_account(%s,'HDFC current')", (pid,))
    assert due(api, w, inv3) == {"baseDue": 0, "gstDue": 360000}
    assert "payment_account" in [r["kind"] for r in as_(api, w, w.finance, "select kind from pulse.erp_event where subject_id=%s", (inv3,))]
    as_(api, w, w.finance, "select pulse.erp_payment_account(%s,%s)", (pid, GST))

    # A credit note of ₹2,000 + GST against the third lowers both parts: its GST is ₹3,240, paid; ₹1,240 of base is due.
    cn = draft(api, w, w.finance, "credit_note", taxable=200000, against=inv3, client=w.client, day="2026-05-12")
    issue(api, w, w.finance, cn)
    assert due(api, w, inv3) == {"baseDue": 124000, "gstDue": 0}
    n = one(api, w, w.finance, "select pulse.finance_numbers('2026-04-01','2026-05-01') n")["n"]
    april, may = n["months"]
    assert [april["month"], may["month"]] == ["2026-04", "2026-05"]
    assert april["receipts"] == {"count": 2, "base": 15000000, "gstInGstAccount": 0, "gstInMain": 900000, "tds": 0, "cash": 15900000, "over": 0}
    assert may["receipts"]["base"] == 1676000 and may["receipts"]["gstInGstAccount"] == 1800000 + 324000
    assert april["paidInvoices"] == 1 and may["paidInvoices"] == 1        # the second invoice in April, the first in May
    assert april["invoiced"]["taxable"] == 15000000 and may["invoiced"]["taxable"] == 2000000
    assert may["credited"] == {"count": 1, "taxable": 200000, "gst": 36000, "total": 236000}
    assert n["outstanding"]["gst"] == 0 and n["outstanding"]["base"] == 124000 and n["outstanding"]["invoices"] == 1
    # The Finance role has no bank lines (leadership with the amount grants only).
    assert n["bank"] is False and april["bankLines"] is None
    assert n["gstAccount"] == GST and n["canSetAccount"] is False


def test_collections_come_from_bank_lines_where_they_exist_and_expenses_leave_gst_and_taxes_out(api, worker, books):
    w = books
    with worker.transaction():
        set_tenant(worker, w.org)
        for key, body in (("b1", {"date": "2026-04-11", "month": "2026-04", "direction": "in", "amount": 100000.0, "category": "Client receipts", "selected": True}),
                          ("b2", {"date": "2026-04-12", "month": "2026-04", "direction": "in", "amount": 250.5, "category": "Interest", "selected": True}),
                          ("b3", {"date": "2026-04-11", "month": "2026-04", "direction": "in", "amount": 100000.0, "category": "Client receipts", "selected": False}),
                          ("b4", {"date": "2026-04-13", "month": "2026-04", "direction": "out", "amount": 5000.0, "category": "Rent", "selected": True})):
            worker.execute("insert into pulse_priv.finance_live_record(org_id,kind,key,scope,body,source,hash,confidence) values(%s,'bank_line',%s,'sheet:x',%s,%s,%s,'high')",
                           (w.org, key, Jsonb(body), Jsonb({"type": "sheet"}), key.ljust(64, "0")))
    entries = (("income", "in", "2026-04-20", 999900, 0, "Client payment", None), ("income", "in", "2026-05-03", 50000000, 0, "Client payment", None),
               ("income", "in", "2026-05-04", 900000, 0, "Client payment", GST),
               ("expense", "out", "2026-04-05", 1180000, 180000, "Software & tools", None), ("expense", "out", "2026-04-28", 30000000, 0, "Salaries", None),
               ("expense", "out", "2026-04-29", 2500000, 0, "Taxes & GST", None), ("bill", "out", "2026-04-30", 400000, 0, "Rent & office", None))
    with api.transaction():
        set_tenant(api, w.org, w.founder)
        for kind, direction, day, amount, gst, category, to in entries:
            api.execute("""insert into pulse.fin_entry(org_id,kind,direction,entry_date,amount_minor,gst_minor,category,account_to,bill_status,created_by)
                values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", (w.org, kind, direction, day, amount, gst, category, to, "unpaid" if kind == "bill" else None, w.founder))
        api.execute("select pulse.finance_gst_account_set(%s)", (GST,))
    n = one(api, w, w.founder, "select pulse.finance_numbers('2026-04-01','2026-05-01') n")["n"]
    april, may = n["months"]
    assert n["bank"] is True and n["bankEnd"] == "2026-04-12"
    # April: the bank's one selected client credit (the copy not selected and the debit are left out); interest apart.
    assert april["bankLines"] == {"lines": 2, "client": 10000000, "other": 25050}
    assert april["book"]["total"] == 999900
    # May has no bank lines: the Cash book's money in, the GST account's share named.
    assert may["bankLines"] is None and may["book"] == {"lines": 2, "total": 50900000, "intoGst": 900000}
    # Spending net of input GST; salaries named; taxes paid to the government kept out; an unpaid bill not counted.
    assert april["spend"]["net"] == 1000000 + 30000000 and april["spend"]["gst"] == 180000
    assert april["spend"]["salaries"] == 30000000 and april["spend"]["taxes"] == 2500000
    assert n["unpaidBills"] == {"count": 1, "total": 400000}
    # A member sees none of it; another company's numbers stay its own.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.member, "select pulse.finance_numbers('2026-04-01','2026-05-01')")


def test_a_salesperson_sees_their_own_quotations_invoices_and_collections(api, worker, books):
    w = books
    q = draft(api, w, w.finance, "quotation", taxable=4000000, day="2026-04-03", client=w.client)
    as_(api, w, w.finance, "update pulse.erp_document set salesperson_id=%s where id=%s", (w.sales, q))
    issue(api, w, w.finance, q)
    inv = draft(api, w, w.finance, taxable=4000000, day="2026-04-08", client=w.client)
    as_(api, w, w.finance, "update pulse.erp_document set source_id=%s where id=%s", (q, inv))
    issue(api, w, w.finance, inv)
    pay(api, w, inv, 4000000, "2026-04-18")
    other = draft(api, w, w.finance, "quotation", taxable=100000, day="2026-04-04", client=w.client)   # Finance's own
    issue(api, w, w.finance, other)
    s = one(api, w, w.sales, "select pulse.sales_numbers(null,'2026-04-01','2026-04-01') s")["s"]
    assert s["person"]["id"] == str(w.sales) and s["person"]["self"] is True and s["canOpenErp"] is False and s["team"] is None
    assert [x["id"] for x in s["quotes"]["items"]] == [str(q)] and s["quotes"]["value"] == 4000000
    # The invoice made from their quotation is theirs; the client paid the base, the GST is still due.
    assert [x["id"] for x in s["invoices"]["items"]] == [str(inv)]
    assert s["invoices"]["items"][0]["gstDue"] == 720000 and s["invoices"]["items"][0]["baseDue"] == 0
    assert s["collections"]["base"] == 4000000 and s["collections"]["cash"] == 4000000
    assert (s["open"]["count"], s["open"]["base"], s["open"]["gst"]) == (1, 0, 720000)
    # Someone else's numbers are for leadership and Finance only.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.sales, "select pulse.sales_numbers(%s,'2026-04-01','2026-04-01')", (w.finance,))
    f = one(api, w, w.founder, "select pulse.sales_numbers(%s,'2026-04-01','2026-04-01') s", (w.sales,))["s"]
    assert f["person"]["self"] is False and f["collections"]["base"] == 4000000
    assert "Synthetic Sales" in {t["name"] for t in f["team"]}
    n = one(api, w, w.founder, "select pulse.finance_numbers('2026-04-01','2026-04-01') n")["n"]
    sales = next(x for x in n["salespeople"] if x["id"] == str(w.sales))
    assert (sales["quotes"], sales["quoted"], sales["invoiced"], sales["revenue"]) == (1, 4000000, 4000000, 4000000)


def test_the_salesperson_is_who_made_or_sent_the_quotation_never_who_issued_the_invoice(api, books):
    w = books
    # A quotation with no salesperson named, made in Billing by Finance but sent by the salesperson.
    q = draft(api, w, w.finance, "quotation", taxable=2000000, day="2026-06-03", client=w.client)
    issue(api, w, w.finance, q)
    as_(api, w, w.finance, "update pulse.erp_document set sent_by=%s where id=%s", (w.sales, q))
    inv = draft(api, w, w.finance, taxable=2000000, day="2026-06-09", client=w.client)
    as_(api, w, w.finance, "update pulse.erp_document set source_id=%s where id=%s", (q, inv))
    issue(api, w, w.finance, inv)
    pay(api, w, inv, 2000000, "2026-06-20")
    # An invoice Finance made with no quotation behind it and no salesperson: nobody's sale.
    alone = draft(api, w, w.finance, taxable=500000, day="2026-06-10", client=w.client)
    issue(api, w, w.finance, alone)
    pay(api, w, alone, 590000, "2026-06-21")
    n = one(api, w, w.founder, "select pulse.finance_numbers('2026-06-01','2026-06-01') n")["n"]
    by = {x["id"]: x for x in n["salespeople"]}
    assert str(w.finance) not in by
    assert (by[str(w.sales)]["quotes"], by[str(w.sales)]["invoiced"], by[str(w.sales)]["revenue"]) == (1, 2000000, 2000000)
    assert (by[None]["name"], by[None]["invoiced"], by[None]["revenue"]) == ("No salesperson", 500000, 500000)
    assert n["salespeople"][-1]["id"] is None
    s = one(api, w, w.sales, "select pulse.sales_numbers(null,'2026-06-01','2026-06-01') s")["s"]
    assert [x["id"] for x in s["invoices"]["items"]] == [str(inv)]
    # Theirs because they sent it, not because they are named on it: Quotes would refuse them, so My sales gives no link.
    assert [(x["id"], x["named"]) for x in s["quotes"]["items"]] == [(str(q), False)]


def test_a_credit_note_after_full_payment_leaves_the_excess_as_overpaid_and_refunds_come_off_revenue(api, books):
    w = books
    as_(api, w, w.founder, "select pulse.finance_gst_account_set(%s)", (GST,))
    # ₹1,000 + ₹180 GST paid in full into the main account, then a ₹100 + ₹18 credit note.
    inv = draft(api, w, w.finance, taxable=100000, day="2026-07-02", client=w.client)
    issue(api, w, w.finance, inv)
    pay(api, w, inv, 118000, "2026-07-05")
    cn = draft(api, w, w.finance, "credit_note", taxable=10000, against=inv, client=w.client, day="2026-07-08")
    issue(api, w, w.finance, cn)
    assert due(api, w, inv) == {"baseDue": 0, "gstDue": 0}
    # A payment recorded with no account, on an invoice with GST due, is listed for Billing to say which account.
    inv2 = draft(api, w, w.finance, taxable=100000, day="2026-07-10", client=w.client)
    issue(api, w, w.finance, inv2)
    p2 = pay(api, w, inv2, 18000, "2026-07-12")
    with api.transaction():
        set_tenant(api, w.org, w.founder)
        api.execute("""insert into pulse.fin_entry(org_id,kind,direction,entry_date,amount_minor,gst_minor,category,created_by)
            values(%s,'refund','out','2026-07-15',59000,9000,'Client refund',%s)""", (w.org, w.founder))
    n = one(api, w, w.founder, "select pulse.finance_numbers('2026-07-01','2026-07-01') n")["n"]
    july = n["months"][0]
    # ₹900 base and ₹162 GST fill the invoice after its credit note; the ₹118 beyond is overpaid, neither revenue nor GST
    # (the second invoice's ₹180, with no account said, is base for now).
    assert (july["receipts"]["base"], july["receipts"]["gstInMain"], july["receipts"]["over"]) == (90000 + 18000, 16200, 11800)
    assert july["refunds"] == {"lines": 1, "net": 50000} and july["spend"]["net"] == 0
    assert n["unsaidPayments"]["count"] == 1 and n["unsaidPayments"]["items"][0]["id"] == str(p2)
    as_(api, w, w.finance, "select pulse.erp_payment_account(%s,%s)", (p2, GST))
    assert due(api, w, inv2) == {"baseDue": 100000, "gstDue": 0}
    assert one(api, w, w.founder, "select pulse.finance_numbers('2026-07-01','2026-07-01') n")["n"]["unsaidPayments"]["count"] == 0


def test_numbers_and_sales_numbers_through_the_api(worker, owner, api, books, tmp_path):
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = books
    inv = draft(api, w, w.finance, taxable=1000000, day="2026-10-02", client=w.client)
    issue(api, w, w.finance, inv)
    with worker.transaction():
        set_tenant(worker, w.org)
        for who, handle in ((w.founder, "founder"), (w.finance, "fin"), (w.sales, "sales"), (w.member, "member")):
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (w.org, f"{handle}@{w.domain}", who))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(config),
           "TEST_IDS": json.dumps({"invoice": str(inv), "sales": str(w.sales), "founder": str(w.founder), "domain": w.domain, "gst": GST}), "TEST_REPORT": str(tmp_path / "ft.json")}
    result = subprocess.run(["node", "test/finance-truth-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                            env=env, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, (result.stdout + result.stderr)[-6000:]
    assert json.loads((tmp_path / "ft.json").read_text())["checks"] >= 12


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_finance_numbers_in_the_browser(worker, owner, api, books, tmp_path):
    """Finance → Numbers, the payment drawer's GST choice and My sales at 1440 and 390 px (services/api/test/finance-truth-browser.mjs);
    PULSE_FT_SCREENSHOTS=<dir> also writes the screens."""
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = books
    as_(api, w, w.founder, "select pulse.finance_gst_account_set(%s)", (GST,))
    # A salesperson's ₹3,00,000 quotation, invoiced and its base paid in September; its ₹54,000 GST still to come.
    q = draft(api, w, w.finance, "quotation", taxable=30000000, day="2026-09-03", client=w.client)
    as_(api, w, w.finance, "update pulse.erp_document set salesperson_id=%s where id=%s", (w.sales, q))
    quote_number = issue(api, w, w.finance, q)
    inv = draft(api, w, w.finance, taxable=30000000, day="2026-09-10", client=w.client)
    as_(api, w, w.finance, "update pulse.erp_document set source_id=%s where id=%s", (q, inv))
    issue(api, w, w.finance, inv)
    pay(api, w, inv, 30000000, "2026-09-20", "HDFC current")
    # Finance's own ₹50,000 invoice, sent and unpaid: the browser records its GST into the GST account.
    inv2 = draft(api, w, w.finance, taxable=5000000, day="2026-10-05", client=w.client)
    issue(api, w, w.finance, inv2)
    one(api, w, w.finance, "select pulse.erp_document_mark(%s,'sent') s", (inv2,))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse_priv.finance_live_record(org_id,kind,key,scope,body,source,hash,confidence) values(%s,'bank_line','s1','sheet:x',%s,%s,%s,'high')",
                       (w.org, Jsonb({"date": "2026-09-20", "month": "2026-09", "direction": "in", "amount": 300000.0, "category": "Client receipts", "selected": True}), Jsonb({"type": "sheet"}), "c" * 64))
        for who, handle in ((w.founder, "founder"), (w.finance, "finance"), (w.sales, "sales"), (w.member, "member")):
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (w.org, f"{handle}@{w.domain}", who))
    with api.transaction():
        set_tenant(api, w.org, w.founder)
        for kind, day, amount, gst, category in (("expense", "2026-10-28", 12000000, 0, "Salaries"), ("expense", "2026-10-06", 1180000, 180000, "Software & tools")):
            api.execute("""insert into pulse.fin_entry(org_id,kind,direction,entry_date,amount_minor,gst_minor,category,created_by) values(%s,%s,'out',%s,%s,%s,%s,%s)""",
                        (w.org, kind, day, amount, gst, category, w.founder))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(config), "TEST_REPORT": str(tmp_path / "ftb.json"),
           "TEST_EMAILS": json.dumps({k: f"{k}@{w.domain}" for k in ("founder", "finance", "sales", "member")}),
           "TEST_IDS": json.dumps({"invoice": str(inv), "invoice2": str(inv2), "quoteNumber": quote_number, "founder": str(w.founder), "gst": GST})}
    result = subprocess.run(["node", "test/finance-truth-browser.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                            env=env, capture_output=True, text=True, timeout=1800)
    assert result.returncode == 0, (result.stdout + result.stderr)[-8000:]
    assert json.loads((tmp_path / "ftb.json").read_text())["checks"] >= 25
