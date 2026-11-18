"""ERP-INVOICE: invoices issued in Pulse (pulse.erp_document) join FIN-LIVE's registers at each sync.

They are read as invoice records beside the Zoho invoices from mail, so the model's collections, the reconcile matching
against bank credits and the CA desk's sales register take them like any other sales invoice. They are not stored as
finance_live_record rows: the ERP document is the record. What Pulse knows was paid (payments and credit notes recorded
in ERP) is the invoice's balance due, the way Zoho's PDFs carry one.
"""

from __future__ import annotations

from decimal import Decimal

SOURCE = "pulse-erp"


def _rupees(paise) -> float:
    return float(Decimal(int(paise or 0)) / 100)


def erp_invoices(conn) -> list[dict]:
    """Issued, not cancelled, ERP invoices as FIN-LIVE invoice records (amounts in rupees, like the mail parser's)."""
    rows = conn.execute(
        """select d.id,d.number,to_char(d.issue_date,'YYYY-MM-DD') date,to_char(d.due_date,'YYYY-MM-DD') due,
                  d.buyer,d.seller,d.taxable,d.cgst,d.sgst,d.igst,d.total,d.paid,d.credited,d.status,
                  (select string_agg(l.description,'; ' order by l.position)
                     from pulse.erp_line l where l.document_id=d.id) description
             from pulse.erp_document d
            where d.doc_type='invoice' and d.status in ('issued','sent','part_paid','paid')
              and d.number is not null
            order by d.issue_date,d.number"""
    ).fetchall()
    out = []
    for r in rows:
        buyer, seller = r["buyer"] or {}, r["seller"] or {}
        balance = int(r["total"]) - int(r["paid"] or 0) - int(r["credited"] or 0)
        out.append(
            {
                "key": r["number"],
                "number": r["number"],
                "rawNumber": r["number"],
                "date": r["date"],
                "due": r["due"] or r["date"],
                "client": (buyer.get("name") or "").strip() or None,
                "clientGstin": buyer.get("gstin"),
                "description": (r["description"] or "")[:200],
                "taxable": _rupees(r["taxable"]),
                "cgst": _rupees(r["cgst"]),
                "sgst": _rupees(r["sgst"]),
                "igst": _rupees(r["igst"]),
                "total": _rupees(r["total"]),
                "balanceDue": _rupees(max(0, balance)),
                "balanceBasis": "Payments and credit notes recorded in Pulse ERP",
                "ourGstinPresent": bool(seller.get("gstin")),
                "paidAtIssue": False,
                "test": False,
                "issues": [],
                "messages": [],
                "versions": [],
                "confidence": "high",
                "source": {"type": SOURCE, "documentId": str(r["id"]), "status": r["status"]},
            }
        )
    return out


def merge_into(records: dict[str, list[dict]], invoices: list[dict]) -> int:
    """Adds ERP invoices to the flat records; one replaces a mail copy of the same number (Zoho as a mirror)."""
    numbers = {i["number"] for i in invoices}
    kept = [r for r in records.get("invoice", []) if r.get("number") not in numbers]
    records["invoice"] = kept + invoices
    return len(invoices)
