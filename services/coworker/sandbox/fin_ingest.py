"""FIN-AGENT: the Finance AI employee's statement analysis, run inside the sandbox (services/coworker/sandbox.mjs).

No network, no Pulse key: the runtime puts the job's files in /in and reads /out. Order of work, cheapest first:
  1. a published parser skill whose header signature matches the file (learned earlier, no guessing);
  2. Pulse's standard importer (tools/statement-parse.py, the same code as Finance → Reconcile → Import);
  3. the fallback reader: any sheet, header found by scoring, Indian bank layouts (HDFC, ICICI, SBI, Axis, Kotak, …),
     narrations that run over several lines, "1,23,456.00 Dr" amounts, a running balance that settles which column
     is money out, day/month order settled by the whole file, text PDFs line by line.
Then every line is normalised, de-duplicated (overlapping statements), categorised (published categoriser skills, then
built-in rules), matched to open invoices (one invoice, an invoice less TDS, or two or three invoices together), and
flagged for a person: suspicious, unclear category, missing document, possible duplicate. What it learned comes back
as plain heuristics and proposed skills (a parser for this layout, with a test). Output streams in chunks, so a
million-line statement fits in memory and time limits.

  python -I fin_ingest.py /in /out        (stdout: one JSON line per progress step)
"""

from __future__ import annotations

import base64
import csv
import gzip
import hashlib
import importlib.util
import itertools
import json
import math
import os
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path

CHUNK = 5000
STANDARD_MAX_BYTES = 5 * 1024 * 1024
FLAGS = ("suspicious", "unclear_category", "missing_document", "possible_duplicate")


def say(p: int, line: str, **extra) -> None:
    print(
        json.dumps(
            {
                "t": "progress",
                "p": max(0, min(100, int(p))),
                "line": line[:280],
                **extra,
            }
        ),
        flush=True,
    )


# ---------------------------------------------------------------- amounts, dates, words
AMOUNT = re.compile(
    r"^\(?-?\s*(?:₹|rs\.?|inr)?\s*-?[\d,]*\.?\d+\s*\)?\s*(?:cr|dr|c|d)?\.?$",
    re.IGNORECASE,
)


def amount_minor(value) -> tuple[int | None, str | None]:
    """'1,23,456.50' → (12345650, None); '1,234.00 Dr' → (123400, 'out'); '(500)' → (-50000, None); '' → (None, None)."""
    if value is None:
        return None, None
    if isinstance(value, (int, float)):
        if isinstance(value, float) and math.isnan(value):
            return None, None
        return int((Decimal(str(value)) * 100).to_integral_value()), None
    raw = str(value).strip().replace(" ", " ")
    if not raw or raw in ("-", "--", "—", "0.00 ", "nil", "NIL"):
        return None, None
    side = None
    m = re.search(r"\s*\b(cr|dr)\.?$", raw, re.IGNORECASE) or re.search(
        r"(?<=\d)\s*(c|d)$", raw, re.IGNORECASE
    )
    if m:
        side = "in" if m.group(1).lower().startswith("c") else "out"
        raw = raw[: m.start()].strip()
    neg = raw.startswith("(") and raw.endswith(")")
    raw = re.sub(r"[₹,\s()]|rs\.?|inr", "", raw, flags=re.IGNORECASE)
    if raw.startswith("-"):
        neg, raw = True, raw[1:]
    if not re.fullmatch(r"\d*\.?\d+", raw):
        return None, None
    try:
        n = int((Decimal(raw) * 100).to_integral_value())
    except InvalidOperation:
        return None, None
    if n >= 10**15:
        return None, None
    return (-n if neg else n), side


MONTHS = {
    m: i + 1
    for i, ms in enumerate(
        [
            "jan",
            "feb",
            "mar",
            "apr",
            "may",
            "jun",
            "jul",
            "aug",
            "sep",
            "oct",
            "nov",
            "dec",
        ]
    )
    for m in [ms]
}
MONTHS.update({"sept": 9, "june": 6, "july": 7, "march": 3, "april": 4})
DATE_RX = re.compile(
    r"^(\d{1,4})[/\-. ](\d{1,2}|[A-Za-z]{3,9})[/\-. ,]+(\d{2,4})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)?$"
)


def date_parts(value):
    """Raw (a, b, c) of a date cell, or a date for real date cells; None when it is not a date."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, (int, float)) and 20000 < value < 80000:  # an Excel serial day
        return date(1899, 12, 30) + timedelta(days=int(value))
    raw = str(value or "").strip()
    if not raw or len(raw) > 24:
        return None
    m = DATE_RX.match(raw)
    if not m:
        return None
    a, b, c = m.groups()
    if b.isalpha():
        mon = (
            MONTHS.get(b[:3].lower())
            if b.lower()[:3] in MONTHS
            else MONTHS.get(b.lower())
        )
        if not mon:
            return None
        b = str(mon)
    return (int(a), int(b), int(c), len(a) == 4)


def make_date(parts, order: str):
    if parts is None:
        return None
    if isinstance(parts, date):
        return parts
    a, b, c, year_first = parts
    if year_first:
        y, mth, d = a, b, c
    elif order == "mdy":
        mth, d, y = a, b, c
    else:
        d, mth, y = a, b, c
    if y < 100:
        y += 2000
    try:
        out = date(y, mth, d)
    except ValueError:
        return None
    return out if date(2000, 1, 1) <= out <= date(2100, 1, 1) else None


def norm(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()


def key(s) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()


def redact(s: str) -> str:
    """Narrations keep words, never account, card or phone numbers (5+ digits in a row)."""
    s = re.sub(r"(?<!\w)\d(?:[ -]?\d){4,}(?!\w)", "•••", norm(s))
    s = re.sub(
        r"\b[\w.\-]{2,}@[\w]{2,}\b",
        lambda m: m.group(0).split("@")[0][:3] + "…@" + m.group(0).split("@")[1],
        s,
    )
    return s[:200]


def sha(*parts) -> str:
    return hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()


# ---------------------------------------------------------------- reading tables
def read_table(path: Path, name: str):
    """Yield (sheet, rows) for every sheet of a CSV, XLSX, XLS or text PDF. Rows are lists of cells."""
    low = name.lower()
    head = path.open("rb").read(8)
    if low.endswith(".pdf") or head.startswith(b"%PDF"):
        yield "pdf", pdf_rows(path)
        return
    if low.endswith(".xlsx") or head.startswith(b"PK"):
        from openpyxl import load_workbook

        wb = load_workbook(path, read_only=True, data_only=True)
        for ws in wb.worksheets:
            yield ws.title, ws.iter_rows(values_only=True)
        return
    if low.endswith(".xls") or head.startswith(b"\xd0\xcf\x11\xe0"):
        import xlrd

        wb = xlrd.open_workbook(str(path))
        for sh in wb.sheets():
            yield (
                sh.name,
                (
                    [
                        xlrd.xldate_as_datetime(c.value, wb.datemode)
                        if c.ctype == xlrd.XL_CELL_DATE
                        else c.value
                        for c in sh.row(i)
                    ]
                    for i in range(sh.nrows)
                ),
            )
        return
    raw = path.open("rb").read(65536)
    enc = "utf-8-sig"
    try:
        raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        enc = "latin-1"
    sample = raw.decode(enc, errors="replace")
    try:
        dialect = csv.Sniffer().sniff(sample[:8192], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    f = path.open("r", encoding=enc, errors="replace", newline="")
    yield "csv", csv.reader(f, dialect)


PDF_LINE = re.compile(
    r"^(?P<date>\d{1,2}[/\-. ](?:\d{1,2}|[A-Za-z]{3})[/\-. ]\d{2,4})\s+(?P<rest>.+)$"
)
PDF_AMT = re.compile(r"(?:\(?-?[\d,]+\.\d{2}\)?(?:\s*(?:Cr|Dr|CR|DR))?)")


def pdf_rows(path: Path):
    """A text PDF as rows: pdfplumber's tables when it is installed, else each line split into date, words, amounts."""
    try:
        import pdfplumber  # type: ignore

        with pdfplumber.open(str(path)) as pdf:
            found = False
            for page in pdf.pages:
                for table in page.extract_tables() or []:
                    for row in table:
                        found = True
                        yield [c if c is not None else "" for c in row]
            if found:
                return
    except Exception as e:  # noqa: BLE001 — pdfplumber missing or a page it cannot read: fall back to the text
        print(
            json.dumps(
                {
                    "t": "note",
                    "line": f"PDF tables not read ({type(e).__name__}); reading its text",
                }
            ),
            flush=True,
        )
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    # Text extraction drops the empty column, so a line is date, words, its amount and the balance after it; the running
    # balance then settles whether it was money in or out.
    yield ["Date", "Narration", "Amount", "Balance"]
    for page in reader.pages:
        for line in (page.extract_text() or "").splitlines():
            line = norm(line)
            m = PDF_LINE.match(line)
            if not m:
                if line and not PDF_AMT.search(line):
                    yield ["", line, "", ""]
                continue
            rest = m.group("rest")
            amts = PDF_AMT.findall(rest)
            words = PDF_AMT.sub(" ", rest)
            words = re.sub(
                r"\s\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b", " ", words
            )  # a value date inside the line
            if not amts:
                continue
            yield [
                m.group("date"),
                norm(words),
                amts[-2] if len(amts) >= 2 else amts[-1],
                amts[-1] if len(amts) >= 2 else "",
            ]


# ---------------------------------------------------------------- the standard importer, first
def standard(path: Path, name: str):
    """tools/statement-parse.py (Finance → Import) on the file; its rows, or None with why it could not."""
    lib = os.environ.get("PULSE_STANDARD_PARSER", "/job/standard/statement-parse.py")
    if not Path(lib).exists():
        return None, "the standard importer is not here"
    if path.stat().st_size > STANDARD_MAX_BYTES:
        return None, "the file is over the standard importer's 5 MB"
    ext = name.lower().rsplit(".", 1)[-1]
    if ext not in ("csv", "xlsx", "xls", "pdf"):
        return None, "not a CSV, Excel or PDF"
    try:
        spec = importlib.util.spec_from_file_location("statement_parse", lib)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        out = mod.parse(
            {
                "content": base64.b64encode(path.read_bytes()).decode(),
                "format": ext,
                "sourceScope": "sandbox",
            }
        )
    except Exception as e:  # noqa: BLE001 — every refusal of the standard importer sends the file to the fallback
        return (
            None,
            f"the standard importer stopped: {str(e)[:120] or type(e).__name__}",
        )
    rows = out.get("rows") or []
    if not rows:
        return None, (out.get("warnings") or ["it found no transactions"])[0][:160]
    if ext == "pdf" or out.get("skipped", 0) > max(3, len(rows) // 10):
        return (
            None,
            f"it was unsure ({out.get('skipped', 0)} lines skipped of {len(rows) + out.get('skipped', 0)})",
        )
    lines = []
    for r in rows:
        mnr, _ = amount_minor(r["amount"])
        lines.append(
            {
                "date": r["date"],
                "amount": abs(mnr or 0),
                "dir": "in" if r["direction"] == "inflow" else "out",
                "narration": r.get("vendor") or "",
                # the standard importer keeps only a hash of the bank reference; it still tells two lines apart
                "ref": "H" + str(r.get("reference_hash") or "")[:15]
                if r.get("reference_hash")
                else None,
                "balance": None,
            }
        )
    return lines, None


# ---------------------------------------------------------------- header scoring and the fallback reader
ALIASES = {
    "date": [
        "date",
        "txn date",
        "tran date",
        "transaction date",
        "trans date",
        "posting date",
        "value date",
        "value dt",
        "txn dt",
        "date of transaction",
    ],
    "narration": [
        "narration",
        "description",
        "particulars",
        "transaction remarks",
        "remarks",
        "details",
        "transaction details",
        "transaction particulars",
        "narrative",
    ],
    "debit": [
        "withdrawal amt",
        "withdrawal amount",
        "withdrawal",
        "withdrawals",
        "debit",
        "debit amount",
        "dr",
        "debits",
        "withdrawal amount inr",
        "paid out",
        "amount debited",
    ],
    "credit": [
        "deposit amt",
        "deposit amount",
        "deposit",
        "deposits",
        "credit",
        "credit amount",
        "cr",
        "credits",
        "deposit amount inr",
        "paid in",
        "amount credited",
    ],
    "amount": ["amount", "transaction amount", "txn amount", "amount inr", "amount rs"],
    "drcr": ["dr cr", "cr dr", "type", "debit credit", "transaction type", "d c"],
    "balance": [
        "closing balance",
        "balance",
        "running balance",
        "bal",
        "balance inr",
        "available balance",
    ],
    "ref": [
        "chq ref no",
        "chq no",
        "cheque no",
        "ref no",
        "reference no",
        "chq ref number",
        "utr",
        "ref no cheque no",
        "chqno",
        "cheque number",
        "transaction id",
        "reference",
        "ref no chq no",
    ],
}
BANKS = [
    ("HDFC", re.compile(r"withdrawal amt|deposit amt|\bhdfc\b", re.IGNORECASE)),
    (
        "ICICI",
        re.compile(r"transaction remarks|withdrawal amount inr|icici", re.IGNORECASE),
    ),
    (
        "SBI",
        re.compile(r"txn date.*ref no cheque no|state bank|\bsbi\b", re.IGNORECASE),
    ),
    ("Axis", re.compile(r"\bchqno\b.*\bsol\b|\baxis\b", re.IGNORECASE)),
    ("Kotak", re.compile(r"kotak|sl no transaction date", re.IGNORECASE)),
    ("Yes Bank", re.compile(r"yes bank", re.IGNORECASE)),
    ("IDFC First", re.compile(r"idfc", re.IGNORECASE)),
]


def cell_key(c) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z]+", " ", str(c or "").lower())).strip()


def header_score(row) -> tuple[int, dict]:
    cols: dict[str, int] = {}
    for i, c in enumerate(row):
        k = cell_key(c)
        if not k or len(k) > 40:
            continue
        for field, names in ALIASES.items():
            if field in cols:
                continue
            if k in names or any(k.startswith(n) and len(n) > 3 for n in names):
                # 'value date' is a second date column: keep the transaction date when both exist
                if (
                    field == "date"
                    and "value" in k
                    and any(
                        cell_key(x)
                        in ("date", "txn date", "tran date", "transaction date")
                        for x in row
                    )
                ):
                    continue
                cols[field] = i
                break
    score = (
        len(cols)
        + (2 if "date" in cols else 0)
        + (2 if ("debit" in cols and "credit" in cols) or "amount" in cols else 0)
    )
    return score, cols


def signature(row) -> list[str]:
    return [cell_key(c) for c in row if cell_key(c)][:12]


def fallback(rows_iter, skill_cols=None, notes=None):
    """Lines from any table: find the header (or use a parser skill's columns), merge run-over narrations, settle
    direction and day/month order. Returns (lines, info)."""
    notes = notes if notes is not None else []
    buf = []
    head_at, cols, sig = None, None, None
    it = iter(rows_iter)
    if skill_cols is not None:
        cols = dict(skill_cols["columns"])
        skip = int(skill_cols.get("skip", 0))
        for _ in range(skip + 1):
            row = next(it, None)
            if row is None:
                break
            buf.append(list(row))
            sig = signature(row)
        head_at = skip
    else:
        best = (0, None, None, None)
        for i, row in enumerate(itertools.islice(it, 80)):
            row = list(row or [])
            buf.append(row)
            s, c = header_score(row)
            if s > best[0]:
                best = (s, i, c, row)
        if best[0] < 5 or "date" not in (best[2] or {}):
            return [], {"error": "no transaction table with a date column was found"}
        _, head_at, cols, hrow = best
        sig = signature(hrow)
    body = itertools.chain(buf[head_at + 1 :] if skill_cols is None else [], it)
    raw = []
    sample = (
        [
            [
                str(c) if c is not None else ""
                for c in (buf[head_at] if skill_cols is None else [])
            ]
        ]
        if skill_cols is None
        else []
    )
    for row in body:
        row = list(row or [])
        if (
            len(sample)
            and len(sample) < 4
            and date_parts(row[cols["date"]] if cols["date"] < len(row) else None)
            is not None
        ):
            n_at = cols.get("narration")
            sample.append(
                [
                    "x"
                    if i == n_at
                    else (
                        c.isoformat()
                        if isinstance(c, (date, datetime))
                        else str(c)
                        if c is not None
                        else ""
                    )
                    for i, c in enumerate(row)
                ]
            )

        def at(f, row=row):
            i = cols.get(f)
            return row[i] if i is not None and i < len(row) else None

        parts = date_parts(at("date"))
        text = norm(at("narration"))
        if parts is None:
            # A narration that runs over onto the next line(s): no date, words only, no amounts.
            # (a header repeated after a page break, a "Total" or "Page 2 of 3" line is not part of a narration)
            junk = cell_key(text) in {
                n for names in ALIASES.values() for n in names
            } or re.match(
                r"^(total|page \d|opening balance|closing balance|statement summary)",
                text,
                re.IGNORECASE,
            )
            if (
                raw
                and text
                and not junk
                and not any(
                    amount_minor(at(f))[0] for f in ("debit", "credit", "amount")
                )
            ):
                raw[-1].setdefault("pieces", [raw[-1]["narration"]]).append(text)
                raw[-1]["narration"] = norm(raw[-1]["narration"] + " " + text)[:400]
                raw[-1]["merged"] = raw[-1].get("merged", 0) + 1
            continue
        d, dside = amount_minor(at("debit"))
        c, cside = amount_minor(at("credit"))
        a, aside = amount_minor(at("amount"))
        b, bside = amount_minor(at("balance"))
        drcr = key(at("drcr"))
        if b is not None and bside == "out":
            b = -abs(b)  # an overdrawn balance written "1,000.00 Dr"
        raw.append(
            {
                "parts": parts,
                "narration": text,
                "d": d,
                "c": c,
                "a": a,
                "aside": aside or dside or cside,
                "drcr": drcr,
                "balance": b,
                "ref": ref_of(at("ref")),
            }
        )
    if not raw:
        return [], {"error": "the table has a header but no dated lines"}
    # Banks wrap a long narration at a fixed width, often inside a word: where the first piece is exactly that width
    # the pieces join with no space ("MYSTERY TRADE" + "RS/…" is "MYSTERY TRADERS/…").
    widths = Counter(len(r["pieces"][0]) for r in raw if r.get("pieces"))
    if widths:
        wrap, n = widths.most_common(1)[0]
        if n >= 3:
            for r in raw:
                if r.get("pieces") and len(r["pieces"][0]) == wrap:
                    r["narration"] = norm("".join(r["pieces"]))[:400]
    # Day/month order: the one under which every date is valid and the file runs in order.
    orders = {}
    for order in ("dmy", "mdy"):
        ds = [make_date(r["parts"], order) for r in raw]
        valid = sum(1 for x in ds if x)
        mono = sum(
            1 for x, y in itertools.pairwise(ds) if x and y and abs((y - x).days) <= 31
        )
        orders[order] = (valid, mono)
    order = "mdy" if orders["mdy"] > orders["dmy"] else "dmy"
    if order == "mdy":
        notes.append("Dates in this file are month first (MM/DD).")
    lines = []
    two_cols = "debit" in cols and "credit" in cols
    for r in raw:
        day = make_date(r["parts"], order)
        if not day:
            continue
        amt, side = None, None
        if two_cols and (r["d"] or r["c"]):
            if r["d"] and r["c"]:
                continue
            amt, side = (abs(r["d"]), "out") if r["d"] else (abs(r["c"]), "in")
        elif r["a"] is not None:
            amt = abs(r["a"])
            if r["aside"]:
                side = r["aside"]
            elif r["drcr"]:
                side = (
                    "out"
                    if r["drcr"].startswith(("d", "w"))
                    else "in"
                    if r["drcr"].startswith(("c", "dep"))
                    else None
                )
            elif r["a"] < 0:
                side = "out"
        if not amt:
            continue
        lines.append(
            {
                "date": day.isoformat(),
                "amount": amt,
                "dir": side,
                "narration": r["narration"],
                "ref": r["ref"],
                "balance": r["balance"],
                "merged": r.get("merged", 0),
            }
        )
    # A running balance settles money in and out: where the direction is unknown, and to catch swapped columns.
    with_bal = [x for x in lines if x["balance"] is not None]
    if len(with_bal) >= 3:
        agree = disagree = 0
        prev = None
        for x in lines:
            if x["balance"] is None:
                prev = None
                continue
            if prev is not None:
                delta = x["balance"] - prev
                if x["dir"] is None and abs(delta) == x["amount"]:
                    x["dir"] = "in" if delta > 0 else "out"
                elif x["dir"] is not None and abs(delta) == x["amount"]:
                    agree += (delta > 0) == (x["dir"] == "in")
                    disagree += (delta > 0) != (x["dir"] == "in")
            prev = x["balance"]
        if disagree > agree and disagree >= 3:
            for x in lines:
                if x["dir"]:
                    x["dir"] = "in" if x["dir"] == "out" else "out"
            notes.append(
                "This bank's debit and credit columns are the other way round from their names; the running balance settled it."
            )
    unknown = sum(1 for x in lines if x["dir"] is None)
    lines = [x for x in lines if x["dir"]]
    merged = sum(x.get("merged", 0) for x in lines)
    if merged:
        notes.append(
            f"{merged} narrations ran over onto the next line; they were joined to their transaction."
        )
    above = buf[:head_at] if skill_cols is None else buf[:-1]
    return lines, {
        "account_last4": account_in(above),
        "columns": cols,
        "signature": sig,
        "header_row": head_at,
        "order": order,
        "unknown_direction": unknown,
        "sample": sample,
    }


ACCOUNT_RX = re.compile(
    r"(?:\ba/?c\b|account)(?:\s*(?:no|number|num))?\.?\s*[:#-]?\s*([A-Z]{0,6}[\dX*]{4,})",
    re.IGNORECASE,
)


def account_in(rows) -> str | None:
    """The account's last 4 digits from the lines above a statement's table ("Account No : …0001234")."""
    for row in rows[:40]:
        m = ACCOUNT_RX.search(" ".join(str(c) for c in row if c not in (None, "")))
        if m:
            digits = re.sub(r"\D", "", m.group(1))
            if len(digits) >= 4:
                return digits[-4:]
    return None


def name_last4(name: str) -> str | None:
    """Otherwise the last group of 4+ digits in the file name that is not a year ("hdfc-1234-2026.csv" → 1234)."""
    groups = [
        g for g in re.findall(r"\d{4,}", name) if not re.fullmatch(r"(19|20)\d{2}", g)
    ]
    return groups[-1][-4:] if groups else None


def ref_of(v):
    """A bank reference worth keeping: digits in it ("-", "NA" or a blank cheque column tell nothing apart)."""
    r = norm(v)[:60]
    return r if sum(ch.isdigit() for ch in r) >= 4 else None


def balance_check(lines):
    """Opening, closing and whether the running balance adds up (a gap means missing lines or pages)."""
    bal = [x for x in lines if x.get("balance") is not None]
    if len(bal) < 2:
        return None
    first = bal[0]
    opening = first["balance"] - (
        first["amount"] if first["dir"] == "in" else -first["amount"]
    )
    running, gaps = opening, []
    for x in lines:
        running += x["amount"] if x["dir"] == "in" else -x["amount"]
        if x.get("balance") is not None and running != x["balance"]:
            gaps.append(x["date"])
            running = x["balance"]
    return {
        "opening": opening,
        "closing": bal[-1]["balance"],
        "ok": not gaps,
        "gaps": gaps[:10],
        "gap_count": len(gaps),
    }


# ---------------------------------------------------------------- narrations: channel, reference, counterparty
NARR = [
    (
        "UPI",
        re.compile(
            r"^UPI[/\-](?:(?:P2[AM]|DR|CR)[/\-])?(?P<ref>\d{9,14})?[/\-]?(?P<who>[^/\-@]{2,60})",
            re.IGNORECASE,
        ),
    ),
    (
        "UPI",
        re.compile(
            r"^UPI[/\-](?P<who>[A-Za-z][^/\-@]{1,60})[/\-](?:[\w.]+@\w+)?[/\-]?(?:\w+[/\-])?(?P<ref>\d{9,14})?",
            re.IGNORECASE,
        ),
    ),
    (
        "NEFT",
        re.compile(
            r"^(?:INB/)?NEFT[/\- ]+(?:(?:CR|DR)[/\-])?(?:[A-Z]{4}0[A-Z0-9]{6}[/\-])?(?P<ref>[A-Z0-9]{8,22})?[/\-]?(?P<who>[^/\-]{2,60})",
            re.IGNORECASE,
        ),
    ),
    (
        "RTGS",
        re.compile(
            r"^(?:INB/)?RTGS[/\- ]+(?:(?:CR|DR)[/\-])?(?:[A-Z]{4}0[A-Z0-9]{6}[/\-])?(?P<ref>[A-Z0-9]{8,22})?[/\-]?(?P<who>[^/\-]{2,60})",
            re.IGNORECASE,
        ),
    ),
    (
        "IMPS",
        re.compile(
            r"^(?:MMT/)?IMPS[/\- ]+(?:P2A[/\-])?(?P<ref>\d{9,14})?[/\-]?(?P<who>[^/\-]{2,60})",
            re.IGNORECASE,
        ),
    ),
    (
        "NACH",
        re.compile(
            r"^(?:ACH|NACH|ECS)[/\- ]+(?:D[/\- ]+|DR[/\- ]+)?(?P<who>[^/\-]{2,60})",
            re.IGNORECASE,
        ),
    ),
    (
        "CARD",
        re.compile(
            r"^(?:POS|ECOM|VPS|IPS|PCD|ME DR)[/\- ]+(?:\d{4,}[/\- ]+)?(?P<who>[^/\-]{2,60})",
            re.IGNORECASE,
        ),
    ),
    ("ATM", re.compile(r"^(?:ATM|NWD|ATW|CASH WDL|CASH WITHDRAWAL)", re.IGNORECASE)),
    ("CASH", re.compile(r"^(?:CASH DEP|BY CASH|CASH DEPOSIT|SAK)", re.IGNORECASE)),
    (
        "CHEQUE",
        re.compile(r"^(?:CLG|CHQ|CHEQUE|TO CLG|BY CLG|INWARD CLG)", re.IGNORECASE),
    ),
    (
        "CHARGES",
        re.compile(
            r"CHARGES|CHGS|SMS ALERT|GST ON|CONSOLIDATED|MIN BAL|DEBIT CARD FEE|ANNUAL FEE",
            re.IGNORECASE,
        ),
    ),
    (
        "INTEREST",
        re.compile(r"^(?:INT\.?PD|INTEREST|CREDIT INTEREST|INT PAID)", re.IGNORECASE),
    ),
    ("TAX", re.compile(r"^(?:GST|CBDT|TAX|TDS|ITNS|GSTN)", re.IGNORECASE)),
]
CHANNEL_WORDS = re.compile(
    r"^(?:UPI|NEFT|RTGS|IMPS|MMT|INB|ACH|NACH|ECS|POS|ECOM|VPS|IPS|PCD|ATM|NWD|CLG|CHQ|TRF|BIL|ONL|MOB|P2A|P2M|DR|CR|D|C|IN|OUT|TO|BY|FROM|PAYMENT|TRANSFER|SELF|NA|REF|ME|IFT)$",
    re.IGNORECASE,
)
IFSC = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$", re.IGNORECASE)


UPPER = re.compile(r"\b(Llp|Gst|Hdfc|Icici|Sbi|Lic|Neft|Rtgs|Imps|Upi|Emi|Tds)\b")


def caps(name: str) -> str:
    """Title case, with the short forms people write in capitals ("Orbit Realty LLP", not "Llp")."""
    return UPPER.sub(lambda m: m.group(1).upper(), name)


def narration(text: str) -> dict:
    """Channel, reference and the other party, read the same way for every bank: the narration is split on / and -,
    the channel word, IFSC codes, references, UPI handles and placeholders are set aside, and the first piece with
    real words left is the party."""
    t = norm(text).replace("[redacted]", "#").replace("•••", "#")
    channel = next((ch for ch, rx in NARR if rx.search(t)), "OTHER")
    ref = None
    who = None
    for i, seg in enumerate(re.split(r"\s*[/\-:]\s*", t)):
        seg = seg.strip()
        if not seg:
            continue
        compact = seg.replace(" ", "")
        if IFSC.match(compact):
            continue
        if (
            ref is None
            and re.fullmatch(r"[A-Z0-9]{9,22}", compact, re.IGNORECASE)
            and sum(ch.isdigit() for ch in compact) >= 6
        ):
            ref = compact[:40]
            continue
        if (
            "@" in seg
            or IFSC.match(compact)
            or compact == "#"
            or CHANNEL_WORDS.match(compact)
            or re.fullmatch(r"P2[AM]", compact, re.IGNORECASE)
        ):
            continue
        words = [
            w
            for w in re.split(r"\s+", re.sub(r"[^A-Za-z& .]+", " ", seg))
            if w and not CHANNEL_WORDS.match(w.strip("."))
        ]
        words = [w for w in words if not re.fullmatch(r"X+", w, re.IGNORECASE)]
        if (
            who is None
            and words
            and len(key(" ".join(words))) >= 3
            and not (
                i == 0 and channel != "OTHER" and len(words) <= 1 and len(seg) <= 6
            )
        ):
            who = caps(" ".join(words).title())[:80]
    if channel in ("CHARGES", "INTEREST", "ATM", "CASH"):
        who = None
    return {"channel": channel, "ref": ref, "who": who}


# ---------------------------------------------------------------- categories
RULES = [
    (
        r"FACEBK|FACEBOOK|META ?PLATFORMS|\bFB ?ADS?\b|INSTAGRAM ADS",
        "Ad spend",
        "expense",
    ),
    (r"GOOGLE ?ADS|ADWORDS|GOOGLEADS", "Ad spend", "expense"),
    (
        r"GOOGLE ?(?:WORKSPACE|CLOUD|GSUITE)|MICROSOFT|ZOHO|CANVA|ADOBE|OPENAI|ANTHROPIC|NOTION|SLACK|FIGMA|GITHUB|HOSTINGER|GODADDY|AWS|AMAZON WEB",
        "Software & tools",
        "expense",
    ),
    (r"\bRENT\b|LANDLORD|LEASE|MAINTENANCE|SOCIETY", "Rent & office", "expense"),
    (
        r"ELECTRIC|MSEDCL|MAHAVITARAN|BESCOM|TATA POWER|ADANI ELEC|AIRTEL|JIO|VODAFONE|BSNL|BROADBAND|HATHWAY|ACT FIBERNET",
        "Utilities",
        "expense",
    ),
    (r"SALARY|SAL FOR|PAYROLL|STIPEND", "Salaries", "expense"),
    (
        r"UBER|OLA|RAPIDO|IRCTC|INDIGO|MAKEMYTRIP|AIR INDIA|PETROL|FUEL|HPCL|BPCL|IOCL",
        "Travel",
        "expense",
    ),
    (
        r"SWIGGY|ZOMATO|CAFE|RESTAURANT|BLINKIT|ZEPTO|BIGBASKET",
        "Food & office supplies",
        "expense",
    ),
    (
        r"\bGST\b|GSTN|CBDT|\bTDS\b|INCOME ?TAX|ADVANCE TAX|ITNS|PROF(?:ESSION)? ?TAX|CHALLAN",
        "Taxes & GST",
        "expense",
    ),
    (
        r"\bCA\b|CHARTERED|ADVOCATE|LEGAL|AUDIT|CONSULTANCY FEE",
        "Professional fees",
        "expense",
    ),
    (
        r"CHARGES|CHGS|SMS ALERT|GST ON CHG|MIN BAL|DEBIT CARD FEE|ANNUAL FEE",
        "Bank charges",
        "expense",
    ),
    (
        r"AMAZON|FLIPKART|CROMA|RELIANCE DARUHIS|LAPTOP|STATIONERY",
        "Equipment",
        "expense",
    ),
    (r"INTEREST|INT\.?PD|CREDIT INT", "Other income", "income"),
    (r"REFUND|REVERSAL|CASHBACK", "Refund", "refund"),
]
RULES_RX = [(re.compile(p, re.IGNORECASE), c, k) for p, c, k in RULES]


class Categoriser:
    def __init__(self, skills):
        self.learned = []  # (compiled, category, kind, skill name@version)
        for s in skills:
            if s.get("kind") != "categoriser":
                continue
            for r in (s.get("body") or {}).get("rules", [])[:2000]:
                try:
                    rx = (
                        re.compile(r["match"], re.IGNORECASE)
                        if r.get("regex")
                        else re.compile(
                            r"\b" + re.escape(r["match"]) + r"\b", re.IGNORECASE
                        )
                    )
                except re.error:
                    continue
                self.learned.append(
                    (
                        rx,
                        r["category"][:60],
                        r.get("kind") or None,
                        r.get("direction"),
                        f"{s['name']}@{s.get('version', 1)}",
                    )
                )
        self.used = Counter()

    def __call__(self, text: str, who: str | None, direction: str):
        hay = f"{text} {who or ''}"
        for rx, cat, kind, dirn, src in self.learned:
            if (not dirn or dirn == direction) and rx.search(hay):
                self.used[src] += 1
                return (
                    cat,
                    kind or ("income" if direction == "in" else "expense"),
                    0.95,
                    src,
                )
        for rx, cat, kind in RULES_RX:
            if rx.search(hay):
                if kind == "income" and direction == "out":
                    continue
                if kind == "refund" or direction == "in" and kind == "expense":
                    return (
                        ("Refund", "refund", 0.7, "rules")
                        if direction == "in"
                        else (cat, kind, 0.8, "rules")
                    )
                return cat, kind, 0.85, "rules"
        if direction == "in":
            # Money in from a company is almost always a client paying; from a person it may be a loan or a founder.
            return (
                ("Client payment", "income", 0.7, "rules")
                if COMPANY.search(hay)
                else ("Client payment", "income", 0.5, "guess")
            )
        return None, "expense", 0.0, None


COMPANY = re.compile(
    r"\b(?:LLP|PVT|PRIVATE|LTD|LIMITED|DEVELOPERS?|REALTY|BUILDERS?|HOMES|PROPERTIES|INFRA|ESTATES?|GROUP|ENTERPRISES?|VENTURES|SOLUTIONS|TECHNOLOGIES|CORPORATION|INDUSTRIES|ASSOCIATES)\b",
    re.IGNORECASE,
)


# ---------------------------------------------------------------- matching invoices ("every possibility")
def match_invoices(amount: int, day: str, invoices: list[dict], text: str):
    """One invoice (its number in the narration, or the same amount), an invoice less TDS (10 %, 2 %, 1 %), or two or
    three open invoices of one client that add up to the credit. Returns (match, reason) or (None, None)."""
    d = date.fromisoformat(day)
    near = [
        i
        for i in invoices
        if not i.get("taken") and -15 <= (d - date.fromisoformat(i["date"])).days <= 240
    ]
    for i in near:
        if i.get("no") and re.search(
            r"\b" + re.escape(i["no"]).replace("\\-", "[-/ ]?") + r"\b",
            text,
            re.IGNORECASE,
        ):
            return i, f"invoice {i['no']} is named in the narration"
    for i in near:
        if i["amount"] == amount:
            return i, f"same amount as invoice {i['no']}"
    for i in near:
        base = i["amount"] - i.get("gst", 0)
        for rate in (10, 2, 1):
            if abs(i["amount"] - base * rate // 100 - amount) <= 100:
                return i, f"invoice {i['no']} less {rate}% TDS"
    by_client = defaultdict(list)
    for i in near:
        by_client[i.get("client") or ""].append(i)
    for client, group in by_client.items():
        group = sorted(group, key=lambda x: x["date"])[:12]
        for n in (2, 3):
            for combo in itertools.combinations(group, n):
                if sum(x["amount"] for x in combo) == amount:
                    return (
                        list(combo),
                        f"{n} invoices of {client or 'one client'} together ({', '.join(x['no'] for x in combo)})",
                    )
    return None, None


# ---------------------------------------------------------------- the job
def main(inp: Path, out: Path) -> int:
    t0 = time.time()
    job = json.loads((inp / "job.json").read_text())
    files = job.get("files") or []
    skills = [
        s
        for s in job.get("skills") or []
        if s.get("status") in ("published", None) or job.get("tryDrafts")
    ]
    parsers = [s for s in skills if s.get("kind") == "parser"]
    cat = Categoriser(skills)
    invoices = [dict(i) for i in (job.get("invoices") or [])]
    known_who = {key(w): c for w, c in (job.get("known") or {}).items()}
    big = int(job.get("largeMinor") or 10_000_000)  # ₹1 lakh
    say(2, f"Opening {len(files)} file{'s' if len(files) != 1 else ''}…")
    seen: dict[str, int] = {}
    recent: dict[tuple, list] = defaultdict(list)
    who_seen: Counter = Counter()
    report_files, heuristics, proposed = [], [], []
    totals = Counter()
    flags_n = Counter()
    by_cat: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    unclear: dict[str, list] = {}
    months = set()
    chunk, chunk_no = [], 0
    used_parser = Counter()

    def flush(final=False):
        nonlocal chunk, chunk_no
        if chunk and (final or len(chunk) >= CHUNK):
            with gzip.open(
                out / f"items-{chunk_no:05d}.jsonl.gz", "wt", compresslevel=5
            ) as f:
                for x in chunk:
                    f.write(json.dumps(x, separators=(",", ":")) + "\n")
            chunk_no += 1
            chunk = []

    for fi, f in enumerate(files):
        path = inp / f["path"]
        name = f.get("name") or f["path"]
        base_p = 5 + int(80 * fi / max(1, len(files)))
        notes: list[str] = []
        info: dict = {}
        how, why_not = None, None
        lines = None
        bank = None
        say(base_p, f"Reading {name}…")
        # 1. a learned parser for this layout
        for sheet, rows in read_table(path, name):
            rows = iter(rows)
            peek = list(itertools.islice(rows, 80))
            for s in parsers:
                sig = (s.get("body") or {}).get("signature") or []
                hit = next(
                    (
                        i
                        for i, r in enumerate(peek)
                        if sig and signature(list(r or []))[: len(sig)] == sig
                    ),
                    None,
                )
                if hit is not None:
                    body = dict(s["body"])
                    body["skip"] = hit
                    lines, info = fallback(itertools.chain(peek, rows), body, notes)
                    if lines:
                        how = f"skill:{s['name']}@{s.get('version', 1)}"
                        bank = body.get("bank")
                        used_parser[how] += len(lines)
                    break
            if lines:
                break
            if why_not is None and lines is None:
                # 2. the standard importer (only once per file)
                std, why_not = standard(path, name)
                if std:
                    lines, how = std, "standard"
                    break
            # 3. the fallback reader on this sheet
            lines, info = fallback(itertools.chain(peek, rows), None, notes)
            if lines:
                how = "fallback"
                hdr = " ".join(info.get("signature") or [])
                bank = next((b for b, rx in BANKS if rx.search(hdr + " " + name)), None)
                break
        if not lines:
            report_files.append(
                {
                    "name": name,
                    "ok": False,
                    "parser": None,
                    "why": (info or {}).get("error")
                    or why_not
                    or "no transactions found",
                    "rows": 0,
                }
            )
            heuristics.append(
                f"{name}: I could not read it ({(info or {}).get('error') or why_not}). Ask for a CSV or Excel download from the bank's website."
            )
            continue
        if how == "fallback":
            heuristics.append(
                f"{name}: the standard import could not take it ({why_not}); I read it myself"
                + (f" as a {bank} statement" if bank else "")
                + f": header on row {info['header_row'] + 1}, columns {', '.join(sorted(info['columns']))}."
            )
            heuristics.extend(notes)
            pname = f"parser-{key(bank or 'bank').replace(' ', '-')}-{hashlib.sha1(json.dumps(info['signature']).encode()).hexdigest()[:6]}"
            if not any(p["name"] == pname for p in proposed):
                # The skill's own test: the header and the first lines (narrations replaced, dates and amounts kept)
                # must read back to the same dates, amounts and sides.
                rows = info.get("sample") or []
                expect = [
                    {"date": s["date"], "amount": s["amount"], "dir": s["dir"]}
                    for s in lines[: max(0, len(rows) - 1)]
                ]
                proposed.append(
                    {
                        "kind": "parser",
                        "name": pname,
                        "title": f"Read {bank or 'this bank'}'s statement layout",
                        "body": {
                            "bank": bank,
                            "signature": info["signature"],
                            "columns": info["columns"],
                            "order": info["order"],
                        },
                        "tests": [{"rows": rows, "expect": expect}]
                        if rows and expect
                        else [],
                        "why": f"Next time a file with this header skips the guessing: {len(lines)} lines read this way.",
                    }
                )
        bc = balance_check(lines) if how != "standard" else None
        if bc and not bc["ok"]:
            heuristics.append(
                f"{name}: the running balance breaks {bc['gap_count']} time(s) (first on {bc['gaps'][0]}): lines or pages may be missing there."
            )
        # The account: its number in the statement itself, else the file name (never a year), so two downloads of one
        # account match and two accounts never do.
        last4 = (info or {}).get("account_last4") or name_last4(name)
        acct = f.get("account") or (
            f"{bank or 'Bank'} ··{last4}" if last4 else bank or name[:40]
        )
        fdates = [x["date"] for x in lines]
        rep = {
            "name": name,
            "ok": True,
            "parser": how,
            "bank": bank,
            "account": acct,
            "rows": len(lines),
            "from": min(fdates),
            "to": max(fdates),
            "balance": bc,
            "why": why_not if how != "standard" else None,
        }
        report_files.append(rep)
        n_lines = len(lines)
        for li, x in enumerate(lines):
            if li % 20000 == 0 and li:
                say(
                    base_p + int(80 / max(1, len(files)) * li / n_lines),
                    f"{name}: {li:,} of {n_lines:,} lines checked",
                )
            nar = narration(x["narration"])
            ref = x.get("ref") or nar["ref"]
            # The same line in two overlapping downloads: same account, day, amount, side, and its reference (or its
            # words and the balance after it, which tells two equal charges on one day apart).
            lk = sha(
                acct,
                x["date"],
                x["amount"],
                x["dir"],
                (ref or "").upper() or key(x["narration"])[:80],
                "" if ref else x.get("balance"),
            )
            if lk in seen:
                totals["duplicates"] += 1
                continue
            seen[lk] = 1
            months.add(x["date"][:7])
            who = nar["who"]
            category, kind, conf, src = cat(x["narration"], who, x["dir"])
            if not category and who and key(who) in known_who:
                category, kind, conf, src = (
                    known_who[key(who)],
                    "expense",
                    0.8,
                    "history",
                )
            flags, reasons = [], []
            match = None
            if (
                x["dir"] == "in"
                and invoices
                and nar["channel"] not in ("INTEREST", "CHARGES")
            ):
                m, why = match_invoices(
                    x["amount"], x["date"], invoices, x["narration"]
                )
                if m:
                    for inv in m if isinstance(m, list) else [m]:
                        inv["taken"] = True
                    match = {
                        "invoices": [
                            i["no"] for i in (m if isinstance(m, list) else [m])
                        ],
                        "why": why,
                    }
                    category, kind, conf = "Client payment", "income", max(conf, 0.9)
                elif x["amount"] >= 500000:
                    flags.append("missing_document")
                    reasons.append("Money came in but no open invoice matches it.")
            if not category or conf < 0.6:
                flags.append("unclear_category")
                reasons.append(
                    "I could not tell what this is for."
                    if not category
                    else f"My guess is {category}; please check."
                )
                k2 = key(who or x["narration"])[:60] or "(no words)"
                u = unclear.setdefault(
                    k2, [0, 0, redact(x["narration"])[:120], x["dir"]]
                )
                u[0] += 1
                u[1] += x["amount"]
            if (
                x["dir"] == "out"
                and x["amount"] >= big
                and category not in ("Taxes & GST", "Salaries", "Bank charges")
            ):
                flags.append("missing_document")
                reasons.append(
                    f"A payment of ₹{x['amount'] / 100:,.0f} needs its bill or invoice."
                )
            if nar["channel"] == "ATM" and x["amount"] >= 5_000_000:
                flags.append("suspicious")
                reasons.append("A large cash withdrawal.")
            if (
                x["dir"] == "out"
                and x["amount"] >= big
                and x["amount"] % 10_000_000 == 0
                and who
                and not who_seen[key(who)]
            ):
                flags.append("suspicious")
                reasons.append("A round amount to someone not paid before.")
            rk = (x["amount"], x["dir"], key(who or x["narration"])[:40])
            dd = date.fromisoformat(x["date"])
            earlier = [p for p in recent[rk] if 0 <= (dd - p).days <= 3]
            if earlier and x["amount"] >= 100000:
                flags.append("possible_duplicate")
                reasons.append("The same amount to the same party within 3 days.")
            recent[rk] = (earlier + [dd])[-4:]
            if who:
                who_seen[key(who)] += 1
            flags = sorted(set(flags))
            for fl in flags:
                flags_n[fl] += 1
            totals["rows"] += 1
            totals["in" if x["dir"] == "in" else "out"] += x["amount"]
            bc_ = by_cat[category or "Not sure yet"]
            bc_[0] += 1
            bc_[1] += x["amount"]
            chunk.append(
                {
                    "lineKey": lk,
                    "file": name[:120],
                    "bank": bank,
                    "account": acct[:60],
                    "date": x["date"],
                    "amountMinor": x["amount"],
                    "direction": x["dir"],
                    "narration": redact(x["narration"]),
                    "channel": nar["channel"],
                    "reference": (ref or None) and str(ref)[:60],
                    "counterparty": who,
                    "category": category,
                    "kind": kind,
                    "confidence": round(conf, 2),
                    "flags": flags,
                    "reasons": reasons[:4],
                    "match": match,
                    "source": src or how,
                }
            )
            flush()
    flush(final=True)
    # Gaps: months with nothing between the first and the last month seen.
    missing = []
    if months:
        ms = sorted(months)
        y, m = map(int, ms[0].split("-"))
        while f"{y:04d}-{m:02d}" <= ms[-1]:
            if f"{y:04d}-{m:02d}" not in months:
                missing.append(f"{y:04d}-{m:02d}")
            m += 1
            if m == 13:
                y, m = y + 1, 1
    if not invoices and totals["in"]:
        heuristics.append(
            "There are no open invoices in Pulse to match the money that came in: send the invoice register (number, date, client, amount)."
        )
    if missing:
        heuristics.append(
            f"No lines at all in {', '.join(missing[:6])}: ask for those months' statements."
        )
    learned_hits = sum(v for k, v in cat.used.items())
    if learned_hits:
        heuristics.append(
            f"Learned rules sorted {learned_hits:,} lines without asking the AI."
        )
    top_unclear = sorted(unclear.items(), key=lambda kv: -kv[1][1])[:40]
    result = {
        "files": report_files,
        "totals": {
            "rows": totals["rows"],
            "inMinor": totals["in"],
            "outMinor": totals["out"],
            "duplicates": totals["duplicates"],
            "flags": dict(flags_n),
        },
        "categories": sorted(
            ({"category": k, "lines": v[0], "minor": v[1]} for k, v in by_cat.items()),
            key=lambda r: -r["minor"],
        )[:40],
        "months": sorted(months),
        "missingMonths": missing,
        "unclear": [
            {"key": k, "lines": v[0], "minor": v[1], "sample": v[2], "direction": v[3]}
            for k, v in top_unclear
        ],
        "heuristics": heuristics[:40],
        "proposedSkills": proposed[:10],
        "skillsUsed": {**{k: v for k, v in cat.used.items()}, **dict(used_parser)},
        "chunks": chunk_no,
        "seconds": round(time.time() - t0, 2),
    }
    (out / "result.json").write_text(json.dumps(result))
    say(
        100,
        f"Done: {totals['rows']:,} lines, {sum(flags_n.values()):,} flags, {totals['duplicates']:,} duplicates dropped.",
    )
    return 0


def test_skill(skill: dict) -> dict:
    """A parser skill's tests: its header and sample lines must read back to the expected dates, amounts and sides."""
    body = skill.get("body") or {}
    tests = skill.get("tests") or []
    if skill.get("kind") == "parser" and (
        not body.get("signature")
        or not isinstance(body.get("columns"), dict)
        or "date" not in body["columns"]
    ):
        return {
            "passed": 0,
            "failed": 1,
            "why": "a parser needs a header signature and a date column",
        }
    passed = failed = 0
    why = None
    for t in tests[:20]:
        if skill.get("kind") == "parser":
            got, _ = fallback(iter(t.get("rows") or []), {**body, "skip": 0})
            got = [
                {"date": x["date"], "amount": x["amount"], "dir": x["dir"]} for x in got
            ]
            ok = got == t.get("expect")
        else:
            cat = Categoriser([{**skill, "status": "published"}])
            c = cat(t.get("text", ""), t.get("who"), t.get("direction", "out"))
            ok = c[0] == t.get("expect")
        passed += ok
        failed += not ok
        if not ok and why is None:
            why = f"test {passed + failed} gave something else"
    if not tests:
        return {"passed": 0, "failed": 0, "why": "no tests"}
    return {"passed": passed, "failed": failed, "why": why}


if __name__ == "__main__":
    sys.setrecursionlimit(5000)
    if len(sys.argv) > 1 and sys.argv[1] == "--test-skill":
        print(json.dumps(test_skill(json.loads(Path(sys.argv[2]).read_text()))))
        sys.exit(0)
    try:
        sys.exit(main(Path(sys.argv[1]), Path(sys.argv[2])))
    except MemoryError:
        print(
            json.dumps(
                {
                    "t": "error",
                    "error": "The file needs more memory than this job may use.",
                }
            ),
            flush=True,
        )
        sys.exit(3)
