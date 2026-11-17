"""BILLING-WL (owner, 4 Nov 2026; Akabod Soniba of Willow Lane: "start fresh from today's real stock; a backend import from
our sheet is fine"). Loads a company's opening stock from a CSV export of its stock sheet into Billing: each row is matched
to a catalogue item by its code (else its name, ignoring case, spaces and punctuation) and that item's stock is set to the
sheet's count (one adjustment, kept in the item's moves). Serial numbers, when the sheet has them, become the units in
stock of a serial-numbered item. Nothing is created in the catalogue; rows that match no item are listed.

Columns (the header row; names are forgiving): code (or sku, model), name (or item, product), qty (or quantity, stock),
serials (or serial, serial numbers: separated by commas, semicolons, spaces or new lines). A sheet with one serial per row
is fine: rows of the same item are added up.

    PULSE_DATABASE_URL_WORKER=... uv run python tools/billing/stock-import.py --org <org uuid> --file stock.csv          # dry run
    PULSE_DATABASE_URL_WORKER=... uv run python tools/billing/stock-import.py --org <org uuid> --file stock.csv --apply  # writes

It connects as the worker role (pulse.erp_stock_import_operator), one transaction for the whole sheet, and prints what it
did (or would do). It reads no secrets itself and prints no customer data, only item names, counts and row numbers.
"""

import argparse
import csv
import json
import re
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages/sdk-py/src"))
from pulse_sdk.db import connect, tenant_tx  # noqa: E402

COLUMNS = {
    "code": {"code", "sku", "model", "modelno", "modelnumber", "itemcode", "productcode"},
    "name": {"name", "item", "itemname", "product", "productname", "description"},
    "qty": {"qty", "quantity", "stock", "onhand", "count", "closingstock", "currentstock"},
    "serials": {"serial", "serials", "serialno", "serialnumber", "serialnumbers", "sn", "srno"},
}


def squash(text):
    return re.sub(r"[^0-9a-z]+", "", str(text or "").lower())


def read_rows(path):
    """The sheet's rows as the database takes them: [{code, name, qty, serials}], rows of one item added up."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        table = list(csv.reader(f))
    if not table:
        return []
    header = [squash(h) for h in table[0]]
    at = {key: next((i for i, h in enumerate(header) if h in names), None) for key, names in COLUMNS.items()}
    if at["code"] is None and at["name"] is None:
        raise SystemExit("The sheet needs a code or a name column")
    if at["qty"] is None and at["serials"] is None:
        raise SystemExit("The sheet needs a quantity or a serial numbers column")
    items = {}
    for n, row in enumerate(table[1:], start=2):
        cell = lambda key: (row[at[key]].strip() if at[key] is not None and at[key] < len(row) else "")  # noqa: E731
        code, name = cell("code"), cell("name")
        if not code and not name:
            continue
        serials = [s for s in re.split(r"[\s,;|]+", cell("serials")) if s]
        qty_text = cell("qty").replace(",", "")
        try:
            qty = float(qty_text) if qty_text else None
        except ValueError:
            raise SystemExit(f"Row {n}: the quantity {qty_text!r} is not a number")
        key = squash(code) or squash(name)
        it = items.setdefault(key, {"code": code or None, "name": name or None, "qty": 0, "serials": [], "rows": []})
        it["rows"].append(n)
        it["serials"] += serials
        if qty is not None and not serials:
            it["qty"] += qty
        elif serials and qty is None:
            it["qty"] += len(serials)
        elif serials:
            it["qty"] += len(serials)
    return [{"code": i["code"], "name": i["name"], "qty": i["qty"], "serials": i["serials"]} for i in items.values()]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--org", required=True, help="the company's organisation id")
    ap.add_argument("--file", required=True, help="the CSV export of the stock sheet")
    ap.add_argument("--apply", action="store_true", help="write the stock (without it: a dry run)")
    ap.add_argument("--db", default="worker", help="a connection string, or the role whose PULSE_DATABASE_URL_<ROLE> to use")
    args = ap.parse_args(argv)
    org = uuid.UUID(args.org)
    rows = read_rows(args.file)
    with connect(args.db) as conn, tenant_tx(conn, org):
        r = conn.execute("select pulse.erp_stock_import_operator(%s::jsonb, %s) r", (json.dumps(rows), args.apply)).fetchone()["r"]
    print(f"{'Applied' if r['applied'] else 'Dry run'}: {r['rows']} items in the sheet, {len(r['matched'])} matched, {len(r['missing'])} not in the catalogue")
    for m in r["matched"]:
        print(f"  {m['item']}: {m['was']:g} -> {m['qty']:g}{' (' + str(m['serials']) + ' serial numbers)' if m['serials'] else ''}")
    for m in r["missing"]:
        print(f"  not found: {m.get('code') or ''} {m.get('name') or ''}".rstrip())
    return r


if __name__ == "__main__":
    main()
