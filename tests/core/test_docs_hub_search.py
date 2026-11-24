"""DOCS-HUB (owner, 21 Nov 2026: "I can't find specific documents"): one search over every billing document and what is
inside it, from plain words, for Billing → Documents (GET /api/v0/erp/documents/search) and the AI employees'
find_documents (GET /api/v1/billing/documents), on real PostgreSQL and tenant row security: the owner's own ask
("last month's invoices for Willow Lane over 1 lakh"), a number, an item, a phone, a GSTIN, a state, an amount, a typo
(the closest names, said as such), a member without Billing refused and a sales seat finding only its own deals. The
routes run through services/api/test/docs-hub-runner.mjs. Synthetic companies, people, items and amounts only."""
import json
import os
import subprocess
import uuid
from datetime import date, timedelta
from pathlib import Path

from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import SELLER, _seed_erp_world, erp, person  # noqa: F401  (erp is a fixture)

WISE = {"name": "Willow Lane Synthetic Pvt Ltd", "gstin": "27AABCS5678K1ZS", "stateCode": "27", "phone": "+91 90000 11111"}
MAJESTIC = {"name": "Majestic Infra (sample)", "stateCode": "27"}
DORUGOHUM = {"name": "Dorugohum Residency (sample)", "stateCode": "27", "phone": "+91 98765 43210"}


def _doc(db, w, kind, buyer, issued, total, status, number=None, sent=False, due=None, paid=0, item="Synthetic service", salesperson=None):
    """A draft with its one line (lines are written while it is a draft), then moved to its state with its figures fixed."""
    did = uuid.uuid4()
    taxable = round(total / 1.18)
    tax = total - taxable
    db.execute("""insert into pulse.erp_document(id,org_id,doc_type,status,issue_date,due_date,seller,buyer,place_of_supply,tax_mode,
            taxable,cgst,sgst,igst,total,paid,created_by,salesperson_id)
        values(%s,%s,%s,'draft',%s,%s,%s,%s,'27','intra',%s,%s,%s,0,%s,%s,%s,%s)""",
               (did, w.org, kind, issued, due, Jsonb(SELLER), Jsonb(buyer), taxable, tax // 2, tax - tax // 2, total, paid, w.finance, salesperson))
    db.execute("""insert into pulse.erp_line(org_id,document_id,position,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total)
        values(%s,%s,0,%s,1,%s,18,%s,%s,%s,0,%s)""", (w.org, did, item, taxable, taxable, tax // 2, tax - tax // 2, total))
    if status != "draft":
        db.execute("update pulse.erp_document set status=%s,number=%s,fy='2026-27',issued_at=%s,sent_at=%s where id=%s",
                   (status, number, f"{issued} 09:00+05:30", f"{issued} 10:00+05:30" if sent else None, did))
    return did


def test_one_search_finds_every_document_from_plain_words(worker, owner, api, erp):  # noqa: F811
    w = erp
    _seed_erp_world(worker, w)   # Workspace accounts founder@, finance@ and member@ the domain
    seller = person(worker, w, "Synthetic Seller", "sales")
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                       (w.org, f"seller@{w.domain}", seller))
        today = worker.execute("select (now() at time zone pulse.org_time_zone())::date d").fetchone()["d"]
    last = (today.replace(day=1) - timedelta(days=1)).replace(day=5)   # the 5th of last month
    with api.transaction():   # written as the founder (row security, the documents' own checks and the approval gate apply)
        set_tenant(api, w.org, w.founder)
        ids = {
            # Last month: Willow Lane over 1 lakh, sent and overdue; Willow Lane under 1 lakh, paid; Majestic over 1 lakh, part-paid.
            "a": _doc(api, w, "invoice", WISE, last, 15000000, "sent", "SYN/INV/0001", sent=True, due=last + timedelta(days=15)),
            "b": _doc(api, w, "invoice", WISE, last, 5000000, "paid", "SYN/INV/0002", sent=True, due=last + timedelta(days=15), paid=5000000),
            "d": _doc(api, w, "invoice", MAJESTIC, last, 30000000, "part_paid", "SYN/INV/0003", sent=True, due=today + timedelta(days=30), paid=10000000),
            # Today: Willow Lane over 1 lakh, approved but not sent; a proforma of ₹1,18,000.
            "c": _doc(api, w, "invoice", WISE, today, 20000000, "issued", "SYN/INV/0004", due=today + timedelta(days=15)),
            "g": _doc(api, w, "proforma", WISE, today, 11800000, "sent", "SYN/PI/0001", sent=True),
            # A quotation approved and not sent (an item to find), a draft with a phone, and the salesperson's own quotation.
            "e": _doc(api, w, "quotation", MAJESTIC, today, 47200000, "issued", "SYN/QT/0007", item="Synthetic PurePower 5.0 kW solar system"),
            "f": _doc(api, w, "quotation", DORUGOHUM, today, 2360000, "draft", item="Synthetic hybrid inverter 5 kVA"),
            "h": _doc(api, w, "quotation", WISE, today, 3540000, "issued", "SYN/QT/0008", item="Synthetic battery bank", salesperson=seller),
        }
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(config),
           "TEST_W": json.dumps({"org": str(w.org), "domain": w.domain, "client": WISE["name"], "today": str(today), "last": str(last), "ids": {k: str(v) for k, v in ids.items()}})}
    result = subprocess.run(["node", "test/docs-hub-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                            env=env, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    assert isinstance(today, date)
