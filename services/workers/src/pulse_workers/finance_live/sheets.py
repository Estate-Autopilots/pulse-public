# ruff: noqa: E501
"""Readers for EA's own finance workbooks (Drive exports opened read-only with openpyxl).

Each reader yields plain observations with provenance (file, sheet, row). Salary workbooks are reduced to monthly
totals inside this module: no name, per-person amount or row text is returned for them.
"""

from __future__ import annotations

import re
from collections import defaultdict
from decimal import Decimal

from .common import HIGH, LOW, MEDIUM, as_date, money, tab_month


def rows_of(ws):
    for index, row in enumerate(ws.iter_rows(values_only=True), start=1):
        if any(c not in (None, "") for c in row):
            yield index, list(row)


def cell(row, i):
    return row[i] if i is not None and i < len(row) else None


def provenance(meta, ws, row_no):
    return {"type": "sheet", "fileId": meta["id"], "file": meta["name"], "sheet": ws.title.strip(), "row": row_no}


def statement(wb, meta):
    """Axis 'Statement Enquiry' export: dated debit/credit lines, opening and closing balances."""
    lines, balances = [], []
    for ws in wb.worksheets:
        opening = closing = None
        for row_no, row in rows_of(ws):
            label = str(cell(row, 3) or "").strip().upper()
            if label == "OPENING BALANCE":
                opening = money(cell(row, 6))
                continue
            if label == "CLOSING BALANCE":
                closing = money(cell(row, 6))
                continue
            day = as_date(cell(row, 1))
            amount = money(cell(row, 4))
            marker = str(cell(row, 5) or "").strip().upper()
            if not day or amount is None or marker not in ("CR", "DR"):
                continue
            lines.append(
                {
                    "date": day.isoformat(),
                    "month": day.isoformat()[:7],
                    "direction": "in" if marker == "CR" else "out",
                    "amount": amount,
                    "text": str(cell(row, 3) or ""),
                    "balance": money(cell(row, 6)),
                    "family": "statement",
                    "confidence": HIGH,
                    "source": provenance(meta, ws, row_no),
                }
            )
        if lines:
            days = sorted(line["date"] for line in lines)
            balances.append(
                {
                    "from": days[0],
                    "to": days[-1],
                    "opening": opening,
                    "closing": closing,
                    "file": meta["name"],
                    "fileId": meta["id"],
                }
            )
    return lines, balances


def _header(rows, *words):
    for row_no, row in rows[:6]:
        texts = [str(c or "").strip().lower() for c in row]
        if all(any(w in t for t in texts) for w in words):
            return row_no, texts
    return None, None


def dated_debits(wb, meta, year_hint):
    """'expenses 2024/2025': Transaction Date | Particulars | Amount(INR) [| founder salary] [| client ads spend]."""
    out, totals = [], []
    for ws in wb.worksheets:
        rows = list(rows_of(ws))
        header_row, texts = _header(rows, "date", "particulars")
        if not header_row:
            # 'Sheet13': month | gross expnses | net expnses
            head, labels = _header(rows, "month", "gross")
            if head:
                for row_no, row in rows:
                    month = tab_month(str(cell(row, 0) or ""), year_hint)
                    gross = money(cell(row, 1))
                    if row_no > head and month and gross:
                        totals.append(
                            {
                                "month": month,
                                "direction": "out",
                                "amount": gross,
                                "family": "summary",
                                "source": provenance(meta, ws, row_no),
                            }
                        )
            continue
        amount_col = next(i for i, t in enumerate(texts) if "amount" in t)
        founder_col = next((i for i, t in enumerate(texts) if "founder" in t), None)
        ads_col = next((i for i, t in enumerate(texts) if "ads spend" in t), None)
        for row_no, row in rows:
            if row_no <= header_row:
                continue
            day = as_date(cell(row, 0))
            text = str(cell(row, 1) or "")
            if not day:
                continue
            amount = money(cell(row, amount_col)) or Decimal(0)
            founder = money(cell(row, founder_col)) if founder_col is not None else None
            ads = money(cell(row, ads_col)) if ads_col is not None else None
            base = {
                "date": day.isoformat(),
                "month": day.isoformat()[:7],
                "direction": "out",
                "text": text,
                "family": "dated",
                "confidence": MEDIUM,
                "source": provenance(meta, ws, row_no),
            }
            if amount > 0:
                out.append({**base, "amount": amount})
            if founder and founder > 0:
                out.append({**base, "amount": founder, "hint": "founder payment", "subkey": "founder"})
            if ads and ads > 0:
                out.append({**base, "amount": ads, "hint": "client ads spend", "subkey": "ads"})
    return out, totals


def dated_credits(wb, meta, year_hint, tabs=None):
    """Revenue sheets and dated tabs: date | narration | amount (credits)."""
    out = []
    for ws in wb.worksheets:
        if tabs is not None and ws.title.strip().lower() not in tabs:
            continue
        month = tab_month(ws.title, year_hint)
        for row_no, row in rows_of(ws):
            day = as_date(cell(row, 0))
            amount = money(cell(row, 2))
            text = str(cell(row, 1) or "")
            if not day or amount is None or amount <= 0 or not re.search(r"[A-Za-z]", text):
                continue
            if month and day.isoformat()[:7] != month:
                # A row typed into the wrong month tab keeps its own date.
                pass
            out.append(
                {
                    "date": day.isoformat(),
                    "month": day.isoformat()[:7],
                    "direction": "in",
                    "amount": amount,
                    "text": text,
                    "family": "dated",
                    "confidence": MEDIUM,
                    "source": provenance(meta, ws, row_no),
                }
            )
    return out


def monthly_tabs(wb, meta, year_hint, skip=()):
    """Agency Finance Sheet month tabs: Date | Expense | Where? | Revenue | How? (Client Name). The first column is a
    running counter, not a transaction date, so lines carry the tab month only."""
    out, summaries = [], []
    for ws in wb.worksheets:
        title = ws.title.strip()
        month = tab_month(title, year_hint)
        rows = list(rows_of(ws))
        if title.lower().startswith("q -"):
            head, texts = _header(rows, "month", "revenue")
            if head:
                year = int(re.search(r"(\d{4})", title).group(1))
                rev = next(i for i, t in enumerate(texts) if "revenue" in t)
                exp = next(i for i, t in enumerate(texts) if "expence" in t or "expense" in t)
                for row_no, row in rows:
                    m = tab_month(str(cell(row, 0) or "").strip(), year)
                    if row_no <= head or not m:
                        continue
                    for direction, col in (("in", rev), ("out", exp)):
                        amount = money(cell(row, col))
                        if amount:
                            summaries.append(
                                {
                                    "month": m,
                                    "direction": direction,
                                    "amount": amount,
                                    "family": "summary",
                                    "source": provenance(meta, ws, row_no),
                                }
                            )
            continue
        if not month or title.lower() in skip:
            continue
        header_row, texts = _header(rows, "expense", "revenue")
        if not header_row:
            continue
        expense = next(i for i, t in enumerate(texts) if t.startswith("expense"))
        where = next((i for i, t in enumerate(texts) if t.startswith("where")), None)
        revenue = next(i for i, t in enumerate(texts) if t.startswith("revenue"))
        how = next((i for i, t in enumerate(texts) if t.startswith("how")), None)
        package = next((i for i, t in enumerate(texts) if t.startswith("package")), None)
        for row_no, row in rows:
            if row_no <= header_row:
                continue
            first = cell(row, 0)
            if isinstance(first, str) and not as_date(first) and re.search(r"[A-Za-z]", first):
                continue  # 'Total Cash', 'Datup Payment' ... summary rows
            base = {
                "date": None,
                "month": month,
                "family": "monthly",
                "confidence": LOW,
                "source": provenance(meta, ws, row_no),
            }
            out_amount, in_amount = money(cell(row, expense)), money(cell(row, revenue))
            label_out = cell(row, where)
            if out_amount is None and isinstance(cell(row, expense), str) and money(label_out):
                # Some tabs paste the bank narration into 'Expense' and the amount into 'Where?'.
                out_amount, label_out = money(label_out), cell(row, expense)
            if out_amount and out_amount > 0:
                label = str(label_out or "")
                looks_bank = "/" in label
                out.append(
                    {
                        **base,
                        "direction": "out",
                        "amount": out_amount,
                        "text": label if looks_bank else "",
                        "hint": "" if looks_bank else label,
                    }
                )
            if in_amount and in_amount > 0:
                label = str(cell(row, how) or "")
                looks_bank = "/" in label
                item = {
                    **base,
                    "direction": "in",
                    "amount": in_amount,
                    "text": label if looks_bank else "",
                    "hint": "" if looks_bank else label,
                }
                if package is not None and cell(row, package):
                    item["package"] = str(cell(row, package)).strip()[:40]
                out.append(item)
    return out, summaries


COST_ITEMS = [
    (re.compile(r"^model", re.I), "Production & shoots"),
    (re.compile(r"^rent\b", re.I), "Office & rent"),
    (re.compile(r"^cleaning", re.I), "Office & rent"),
    (re.compile(r"^food", re.I), "Food & office supplies"),
    (re.compile(r"marketing( ads)? spend", re.I), "Marketing spend"),
    (re.compile(r"^tools?\b", re.I), "Software & AI"),
    (re.compile(r"^ca fee", re.I), "Accounting & compliance"),
    (re.compile(r"^electric", re.I), "Office & rent"),
    (re.compile(r"^other", re.I), "Other operating costs"),
]
TOTAL_LABEL = re.compile(
    r"(^|\b)(sub[- ]?total|total|f\.t\. total|s\.t\. total|other total|fullfilment total|fulfilment total)\b", re.I
)
SECTION_LABEL = re.compile(
    r"^(hoo|hr|hr & sales|production (head|coordinator)|creative strategist|videographer|video editor|graphic design|"
    r"performance marketer|access coordinator|social media optimi[sz]ation|founder team|sales team|other expences|"
    r"other expenses|name)$",
    re.I,
)


def monthly_costs(wb, meta, year_hint):
    """EA's monthly cost workbooks ('Salary & Expenses Details', 'Salary & Per Task 2026'): people rows reduce to one
    payroll total and head count; rent, tools, food, models and marketing lines keep their labels and amounts."""
    result = {}
    for ws in wb.worksheets:
        month = tab_month(ws.title, year_hint)
        if not month:
            continue
        rows = list(rows_of(ws))
        total_col = header_row = None
        for row_no, row in rows[:6]:
            texts = [str(c or "").strip().lower() for c in row]
            candidates = [i for i, t in enumerate(texts) if t in ("total", "salary total")]
            if candidates:
                total_col, header_row = candidates[-1], row_no
                break
        if total_col is None:
            continue
        people, payroll, stated = 0, Decimal(0), None
        items = defaultdict(lambda: Decimal(0))
        for row_no, row in rows:
            if row_no <= header_row:
                continue
            value = money(cell(row, total_col))
            texts = [
                str(c).strip() for c in row[:total_col] if isinstance(c, str) and re.search(r"[A-Za-z]{2}", str(c))
            ]
            label = texts[0] if texts else ""
            if not label and any(isinstance(c, str) and TOTAL_LABEL.search(c) for c in row[total_col:]):
                label = "Sub-Total"
            category = next((cat for pattern, cat in COST_ITEMS if pattern.search(label)), None)
            if category and value is None:
                # Older tabs type the other-expense amounts in the salary column, not the total column.
                value = next((money(c) for c in reversed(row) if isinstance(c, (int, float)) and money(c)), None)
            if value is None or value <= 0:
                continue
            if TOTAL_LABEL.search(label):
                if re.search(r"sub", label, re.I):
                    stated = value
            elif category:
                items[category] += value
            elif label and not SECTION_LABEL.match(label):
                people += 1
                payroll += value
        if people:
            source = {
                "type": "sheet",
                "fileId": meta["id"],
                "file": meta["name"],
                "sheet": ws.title.strip(),
                "rows": people,
            }
            result[month] = {
                "month": month,
                "payroll": payroll,
                "people": people,
                "items": {k: v for k, v in items.items() if v > 0},
                "sheetTotal": stated,
                "source": source,
            }
    return list(result.values())


def month_totals(wb, meta, year_hint, *, label, amount_header, date_col=0):
    """Monthly totals of an amount column (petty cash, model payments). Names in the rows are not returned."""
    totals = defaultdict(lambda: {"amount": Decimal(0), "rows": 0, "sheets": set()})
    for ws in wb.worksheets:
        month = tab_month(ws.title, year_hint)
        if not month:
            continue
        rows = list(rows_of(ws))
        col = header_row = None
        for row_no, row in rows[:8]:
            texts = [str(c or "").strip().lower() for c in row]
            if any(amount_header in t for t in texts):
                col, header_row = next(i for i, t in enumerate(texts) if amount_header in t), row_no
                break
        if col is None:
            continue
        for row_no, row in rows:
            if row_no <= header_row:
                continue
            day = as_date(cell(row, date_col))
            value = money(cell(row, col))
            if day and 2020 <= day.year <= 2035 and value and value > 0:
                bucket = totals[day.isoformat()[:7]]
                bucket["amount"] += value
                bucket["rows"] += 1
                bucket["sheets"].add(ws.title.strip())
    return [
        {
            "month": m,
            "category": label,
            "amount": v["amount"],
            "rows": v["rows"],
            "source": {
                "type": "sheet",
                "fileId": meta["id"],
                "file": meta["name"],
                "sheet": ", ".join(sorted(v["sheets"])),
                "rows": v["rows"],
            },
        }
        for m, v in sorted(totals.items())
    ]


def petty_cash(wb, meta, year_hint):
    """Daily Expense Tracker: each month tab states 'Total Spent Till Now'."""
    out = []
    for ws in wb.worksheets:
        month = tab_month(ws.title, year_hint)
        if not month:
            continue
        for row_no, row in rows_of(ws):
            label = str(cell(row, 0) or "").lower()
            if "total spent" in label:
                amount = money(cell(row, 1))
                if amount and amount > 0:
                    out.append(
                        {
                            "month": month,
                            "category": "Shoot petty cash",
                            "amount": amount,
                            "rows": 1,
                            "source": provenance(meta, ws, row_no),
                        }
                    )
                break
    return out


def suspense(wb, meta):
    """Tally suspense ledger exports: entries the CA could not explain from the bank statement."""
    out = []
    for ws in wb.worksheets:
        rows = list(rows_of(ws))
        header_row, texts = None, None
        for row_no, row in rows[:14]:
            t = [str(c or "").strip().lower() for c in row]
            if "date" in t and "debit" in t and "credit" in t:
                header_row, texts = row_no, t
                break
        if not header_row:
            continue
        debit, credit = texts.index("debit"), texts.index("credit")
        nature = next((i for i, t in enumerate(texts) if t.startswith("nature")), None)
        voucher = next((i for i, t in enumerate(texts) if "vch type" in t), None)
        previous = None
        for row_no, row in rows:
            if row_no <= header_row:
                continue
            day = as_date(cell(row, 0))
            if not day:
                # Narration continuation line under the entry.
                if previous is not None and not previous.get("narrationSeen"):
                    previous["reference"] = re.sub(r"\s+", " ", " ".join(str(c) for c in row if c))[:40]
                    previous["narrationSeen"] = True
                continue
            d, c = money(cell(row, debit)), money(cell(row, credit))
            amount = d or c
            if not amount:
                continue
            note = cell(row, nature) if nature is not None else None
            if not note:
                note = next((x for x in row[credit + 1 :] if isinstance(x, str) and x.strip()), None)
            previous = {
                "date": day.isoformat(),
                "direction": "out" if d else "in",
                "amount": amount,
                "voucher": str(cell(row, voucher) or "") if voucher is not None else "",
                "nature": str(note or "").strip()[:80] or None,
                "source": provenance(meta, ws, row_no),
            }
            out.append(previous)
    for item in out:
        item.pop("narrationSeen", None)
    return out


TOOL_WORDS = re.compile(
    r"^(make|chat ?gpt( pro)?|claude|canva|google workspace|workspace|kling( ai)?|eleven ?labs|netlify|sim recharges?|adobe|"
    r"loom|wi-?fi|zoho invoice|electricity|office rent|rent|maintenance|cleaning|food|tools|traveling|travel)$",
    re.I,
)


def plan_rows(wb, meta, as_of):
    """Planned monthly costs typed into the finance workbook (tools, rent, food, travel). People rows are skipped."""
    out = []
    for ws in wb.worksheets:
        title = ws.title.strip().lower()
        if title not in ("exp. monthly investment", "trib & investment"):
            continue
        for row_no, row in rows_of(ws):
            for i, value in enumerate(row):
                label = str(value or "").strip()
                if not TOOL_WORDS.match(label):
                    continue
                amount = next((money(x) for x in row[i + 1 : i + 2] if money(x)), None)
                if amount and amount > 0:
                    out.append(
                        {
                            "item": label.title(),
                            "monthly": amount,
                            "asOf": as_of,
                            "basis": "Planned monthly cost typed in the finance workbook",
                            "confidence": LOW,
                            "source": provenance(meta, ws, row_no),
                        }
                    )
    return out


def package_costs(wb, meta):
    """'Per client expenses': the standard delivery cost of a package against its desired price (a cost model)."""
    out = []
    for ws in wb.worksheets:
        if ws.title.strip() != "Sheet1":
            continue
        rows = list(rows_of(ws))
        if not rows:
            continue
        header = [str(c or "").strip() for c in rows[0][1]]
        for col, name in enumerate(header):
            if not re.match(r"\d+ Month", name):
                continue
            cost = Decimal(0)
            for row_no, row in rows[1:]:
                label = str(cell(row, 0) or "")
                if label.lower().startswith("total"):
                    price = next(
                        (money(x) for x in (cell(row, col - 2), cell(row, col - 3), cell(row, 1)) if money(x)), None
                    )
                    if cost and price:
                        out.append(
                            {
                                "package": name,
                                "deliveryCost": cost,
                                "price": price,
                                "source": provenance(meta, ws, row_no),
                            }
                        )
                    break
                value = money(cell(row, col))
                if value and value > 0:
                    cost += value
    return out


def client_status(wb, meta):
    """Pod and active-client trackers: one row per client with its Active/Inactive status. No money is read."""
    out = []
    for ws in wb.worksheets:
        if re.search(r"\bold\b", ws.title, re.I):
            continue  # superseded tracker copies
        rows = list(rows_of(ws))
        head = None
        for row_no, row in rows[:4]:
            texts = [str(c or "").strip().lower() for c in row]
            name = next((i for i, t in enumerate(texts) if t.startswith("client name")), None)
            status = next(
                (i for i, t in enumerate(texts) if t in ("status", "client status", "active or inactive")), None
            )
            if name is not None:
                head = (row_no, name, status)
                break
        if not head:
            continue
        row_no0, name_col, status_col = head
        for row_no, row in rows:
            if row_no <= row_no0:
                continue
            client = str(cell(row, name_col) or "").split("|")[0].strip()
            if not client or len(client) < 3:
                continue
            raw = str(cell(row, status_col) or "") if status_col is not None else ""
            if not raw:
                raw = next(
                    (str(c) for c in row if isinstance(c, str) and c.strip().lower() in ("active", "inactive")), ""
                )
            state = (
                "active"
                if raw.strip().lower().startswith("active")
                else "inactive"
                if raw.strip().lower().startswith("inactive")
                else "unknown"
            )
            if ws.title.strip().lower() == "inactive":
                state = "inactive"
            out.append(
                {
                    "client": client[:80],
                    "status": state,
                    "tab": ws.title.strip(),
                    "asOf": (meta.get("modified") or "")[:10],
                    "source": provenance(meta, ws, row_no),
                }
            )
    return out
