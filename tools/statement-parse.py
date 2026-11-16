"""Parse statement exports in memory; emit only normalised transaction fields, never raw cells."""
import base64
import csv
import hashlib
import io
import itertools
import json
import re
import sys
import zipfile
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation

import xlrd
from openpyxl import load_workbook
from pypdf import PdfReader
from pypdf.errors import PdfReadError

ALIASES = {
    "date": ["date", "transaction date", "txn date", "value date", "posting date", "created at"],
    "vendor": ["vendor", "description", "narration", "particulars", "merchant", "name", "customer name"],
    "amount": ["amount", "transaction amount", "gross amount", "total"],
    "debit": ["debit", "withdrawal", "withdrawals", "debit amount", "withdrawal amt.", "withdrawal (dr.)", "paid out"],
    "credit": ["credit", "deposit", "deposits", "credit amount", "deposit amt.", "deposit (cr.)", "paid in"],
    "direction": ["direction", "type", "transaction type", "dr/cr", "credit/debit"],
    "reference": ["reference", "transaction id", "txn id", "utr", "reference number", "payment id", "order id"],
    "account": ["account", "account number", "account no", "card", "card number"],
    "currency": ["currency", "currency code"],
}
CATEGORIES = {
    "Subscriptions": r"adobe|google workspace|notion|figma|canva|slack|github|openai|subscription",
    "Travel": r"uber|ola|rail|travel|flight|petrol|fuel|hotel",
    "Payroll": r"salary|payroll",
    "Office": r"rent|electric|internet|broadband|office",
    "Marketing": r"meta|facebook|google ads|advertis",
}


def number(v):
    raw = str(v or "").strip().replace(",", "").replace("₹", "").replace("INR", "")
    if not raw:
        return None
    if raw.startswith("(") and raw.endswith(")"):
        raw = "-" + raw[1:-1]
    try:
        n = Decimal(raw)
        return n if n.is_finite() and abs(n) < Decimal("1e14") else None
    except InvalidOperation:
        return None


def date(v):
    if isinstance(v, datetime):
        return v.date().isoformat()
    raw = str(v).strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}[ T]", raw):
        raw = raw[:10]
    for fmt in ["%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d %b %Y", "%d-%b-%Y", "%d %b %y", "%d-%b-%y", "%d/%m/%y"]:
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=UTC).date().isoformat()
        except ValueError:
            pass
    return None


def redact(v):
    s = re.sub(r"\b(?:password|passwd|pin|otp|secret|token)\s*[:=]\s*\S+", "[redacted]", str(v), flags=re.IGNORECASE)
    s = re.sub(r"(?<!\w)\d(?:[ -]?\d){4,}(?!\w)", "[redacted]", s)
    return s[:160]


def parse(a):
    raw = base64.b64decode(a["content"], validate=True)
    if len(raw) > 5 * 1024 * 1024:
        raise ValueError("file too large")
    ext = a["format"].lower()
    warnings = []
    file_digest = hashlib.sha256(raw).hexdigest()
    if ext == "csv":
        text = raw.decode("utf-8-sig")
        try:
            dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        table = list(itertools.islice(csv.reader(io.StringIO(text), dialect), 2101))
        if len(table) > 2100:
            raise ValueError("too many rows")
    elif ext == "xlsx":
        wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        table = list(itertools.islice(wb.active.values, 2101))
        if len(table) > 2100:
            raise ValueError("too many rows")
        wb.close()
    elif ext == "xls":
        wb = xlrd.open_workbook(file_contents=raw)
        sheet = wb.sheet_by_index(0)
        if sheet.nrows > 2100:
            raise ValueError("too many rows")
        table = [[xlrd.xldate_as_datetime(cell.value, wb.datemode) if cell.ctype == xlrd.XL_CELL_DATE else cell.value for cell in sheet.row(i)] for i in range(sheet.nrows)]
        wb.release_resources()
    elif ext == "pdf":
        pdf = PdfReader(io.BytesIO(raw))
        if len(pdf.pages) > 100:
            raise ValueError("too many pages")
        lines = "\n".join(p.extract_text(extraction_mode="layout") or "" for p in pdf.pages).splitlines()
        table = [re.split(r"\s{2,}|\t", line.strip()) for line in lines if line.strip()]
        warnings.append("PDF tables need review. Scanned or password-protected PDFs need a CSV or Excel export.")
    else:
        raise ValueError("unsupported")
    mapping = a.get("mapping") or {}
    header_at = next((i for i, row in enumerate(table[:100]) if any(str(c).strip().lower().replace("_", " ") in ([mapping["date"].lower()] if mapping.get("date") else ALIASES["date"]) for c in row)), None)
    if header_at is None:
        return {"rows": [], "skipped": 0, "warnings": ["No date column found. Export a table with Date, Description, Debit/Credit or Amount and Direction."], "columns": []}
    headers = [str(c or "").strip().lower().replace("_", " ") for c in table[header_at]]
    indices = {key: next((headers.index(h) for h in ([mapping[key].lower()] if mapping.get(key) else names) if h in headers), None) for key, names in ALIASES.items()}
    rows = []
    skipped = 0
    for ordinal, row in enumerate(table[header_at + 1:]):
        def cell(key, row=row):
            i = indices[key]
            return row[i] if i is not None and i < len(row) else None
        day = date(cell("date"))
        debit, credit, amt = number(cell("debit")), number(cell("credit")), number(cell("amount"))
        direction = str(cell("direction") or "").strip().lower()
        if debit and credit:
            skipped += 1
            continue
        if debit:
            amt, direction = abs(debit), "outflow"
        elif credit:
            amt, direction = abs(credit), "inflow"
        elif direction in ["dr", "debit", "debited", "outflow", "withdrawal"]:
            direction = "outflow"
        elif direction in ["cr", "credit", "credited", "inflow", "deposit"]:
            direction = "inflow"
        elif amt is not None and amt < 0:
            direction = "outflow"
        else:
            direction = "unknown"
        if direction == "unknown" and a.get("defaultDirection") in ["inflow", "outflow"]:
            direction = a["defaultDirection"]
        if not day or amt is None or direction == "unknown":
            skipped += 1
            continue
        currency = str(cell("currency") or a.get("currency", "INR")).upper()
        if not re.fullmatch(r"[A-Z]{3}", currency):
            skipped += 1
            continue
        vendor = redact(cell("vendor") or "Unknown merchant")
        category = next((k for k, pattern in CATEGORIES.items() if re.search(pattern, vendor, re.IGNORECASE)), "Uncategorised")
        account = re.sub(r"\D", "", str(cell("account") or a.get("accountLast4", "")))
        ref = str(cell("reference") or f"row:{ordinal}|{day}|{vendor}|{amt}|{direction}|{account[-4:]}")
        scales = {"INR": 2, "USD": 2, "EUR": 2, "GBP": 2, "JPY": 0, "KWD": 3}
        scale = scales.get(currency, a.get("minorUnitScale"))
        issues = []
        if scale is None or not isinstance(scale, int) or not 0 <= scale <= 4:
            issues.append("Currency minor-unit scale unknown; review before certification")
            scale = 2  # observation only; the unresolved issue blocks certification
        if debit is not None and debit < 0 or credit is not None and credit < 0:
            issues.append("Reversed debit/credit sign needs source confirmation")
        raw_date = str(cell("date"))
        if re.search(r"[T ]\d\d:\d\d", raw_date):
            issues.append("Timezone boundary date requires explicit posting-date confirmation")
        if ext == "pdf":
            issues.append("PDF parser fields require human confirmation")
        converted = abs(amt) / (Decimal(10) ** scale if a.get("amountUnit") == "minor" else 1)
        if converted * (Decimal(10) ** scale) != (converted * (Decimal(10) ** scale)).to_integral_value():
            issues.append("Amount exceeds currency minor-unit scale")
        date_header = headers[indices["date"]] if indices["date"] is not None else "unknown date basis"
        ref_header = headers[indices["reference"]] if indices["reference"] is not None else ""
        account_basis = account if len(account) > 4 else str(a.get("accountAlias") or "")
        account_digest = hashlib.sha256(f"{a.get('sourceScope', '')}|{a.get('sourceType', 'bank')}|{account_basis}".encode()).hexdigest() if account_basis else None
        reference_kind = "provider_transaction" if ref_header in ["transaction id", "txn id", "utr", "payment id"] else "source_row"
        rows.append({"date": day, "vendor": vendor, "amount": str(converted), "direction": direction, "currency": currency, "category": category,
                     "account_last4": account[-4:] if len(account) >= 4 else None, "reference_hash": hashlib.sha256(ref.encode()).hexdigest(),
                     "source_file_digest": file_digest, "file_replay_key": hashlib.sha256(f"{file_digest}|{ordinal}".encode()).hexdigest(),
                     "date_basis": date_header, "minor_unit_scale": scale, "original_amount_unit": a.get("amountUnit", "major"),
                     "reference_kind": reference_kind, "account_digest": account_digest, "parser_issues": issues})
        if len(rows) > 2000:
            raise ValueError("too many transactions")
    if any(row["parser_issues"] for row in rows):
        warnings.append("Some rows have explicit parser issues; imported observations need confirmation before Finance certification.")
    return {"rows": rows, "skipped": skipped, "warnings": warnings, "columns": [redact(h) for h in headers]}


if __name__ == "__main__":
    try:
        print(json.dumps(parse(json.load(sys.stdin))))
    except (ValueError, TypeError, KeyError, OSError, PdfReadError, zipfile.BadZipFile, xlrd.XLRDError):
        print(json.dumps({"error": "Could not parse this file. Use an unencrypted CSV, .xlsx, or text-based PDF export with transaction columns."}))
