"""ERP-INVOICE: invoices issued in Pulse join FIN-LIVE's collections, reconcile and the CA desk's sales register.
Synthetic clients and figures only."""

from datetime import date

from pulse_workers.finance_live import erp, model, sync


class Rows:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows


class Conn:
    def __init__(self, rows):
        self.rows, self.sql = rows, []

    def execute(self, sql, params=None):
        self.sql.append(sql)
        return Rows(self.rows)


def issued(number, total, paid=0, credited=0, status="issued", day="2026-10-05"):
    return {
        "id": "00000000-0000-4000-8000-00000000000" + number[-1],
        "number": number,
        "date": day,
        "due": "2026-10-20",
        "buyer": {"name": "Northstar Homes LLP", "gstin": "27AABCS5678K1ZS"},
        "seller": {"gstin": "27AAXFV2138F1ZR"},
        "taxable": total * 100 // 118,
        "cgst": total * 9 // 118,
        "sgst": total * 9 // 118,
        "igst": 0,
        "total": total,
        "paid": paid,
        "credited": credited,
        "status": status,
        "description": "Synthetic package: month 2",
    }


def test_erp_invoices_read_as_invoice_records_with_their_balance():
    conn = Conn(
        [
            issued("INV/26-27/0001", 11800000, paid=5000000),
            issued("INV/26-27/0002", 5900000, paid=5900000, status="paid"),
        ]
    )
    rows = erp.erp_invoices(conn)
    assert "status in ('issued','sent','part_paid','paid')" in conn.sql[0]
    first = rows[0]
    assert first["number"] == "INV/26-27/0001" and first["total"] == 118000.0 and first["balanceDue"] == 68000.0
    assert first["client"] == "Northstar Homes LLP" and first["clientGstin"] == "27AABCS5678K1ZS"
    assert first["source"] == {
        "type": "pulse-erp",
        "documentId": "00000000-0000-4000-8000-000000000001",
        "status": "issued",
    }
    records = {
        "invoice": [
            {"number": "INV/26-27/0002", "total": 1.0, "source": {"mailbox": "m", "message": "x"}},
            {"number": "INV-00003001"},
        ]
    }
    assert erp.merge_into(records, rows) == 2
    numbers = [r["number"] for r in records["invoice"]]
    assert numbers.count("INV/26-27/0002") == 1 and "INV-00003001" in numbers  # the ERP copy replaces a mail copy


def test_the_model_counts_erp_invoices_and_takes_their_paid_basis_from_pulse():
    records = {
        "invoice": erp.erp_invoices(
            Conn([issued("INV/26-27/0001", 11800000), issued("INV/26-27/0002", 5900000, paid=5900000, status="paid")])
        )
    }
    m = model.build(records, date(2026, 10, 11))
    by = {i["number"]: i for i in m["collections"]["invoices"]}
    assert (
        by["INV/26-27/0002"]["status"] == "paid"
        and by["INV/26-27/0002"]["paidBasis"] == "Payments and credit notes recorded in Pulse ERP"
    )
    assert by["INV/26-27/0001"]["status"] != "paid"
    rows = sync.desk_rows(records, m)
    sale = rows["sales"]["INV/26-27/0001"]
    assert sale["origin"] == "finance-live" and sale["source"] == {
        "system": "pulse-erp",
        "documentId": "00000000-0000-4000-8000-000000000001",
    }
    assert sale["total"] == 118000.0 and sale["clientGSTIN"] == "27AABCS5678K1ZS"
