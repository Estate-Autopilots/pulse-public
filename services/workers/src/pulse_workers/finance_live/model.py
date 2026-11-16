# ruff: noqa: E501
"""The finance model: the founders' brief and every Finance tab, computed from stored live records.

Every figure carries its basis and a confidence label. Nothing here is certified: a month becomes certified only when
the CA certifies it in the reconciliation workspace. Missing evidence is named with who supplies it, never shown as 0.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from datetime import date, timedelta

from .bank import CLIENT_RECEIPTS, INDIVIDUAL_CATEGORIES
from .common import HIGH, LOW, MEDIUM, add_months, fiscal_year, lowest, month_range, name_key, similar

FY_START = "2024-04"


def r2(value) -> float:
    return round(float(value or 0), 2)


def inr(value) -> str:
    """Founders read lakh and crore. ₹1,23,456 → '₹1.23 L'; ₹2,40,00,000 → '₹2.40 Cr'."""
    n = float(value or 0)
    sign = "-" if n < 0 else ""
    n = abs(n)
    if n >= 1e7:
        return f"{sign}₹{n / 1e7:.2f} Cr"
    if n >= 1e5:
        return f"{sign}₹{n / 1e5:.2f} L"
    if n >= 1e3:
        return f"{sign}₹{n / 1e3:.1f}k"
    return f"{sign}₹{n:.0f}"


def fmt(value, currency: str = "INR") -> str:
    if currency and currency != "INR":
        return f"{currency} {float(value or 0):,.2f}" if currency != "USD" else f"${float(value or 0):,.2f}"
    return inr(value)


def month_label(month: str) -> str:
    names = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
    return f"{names[int(month[5:7]) - 1]} {month[:4]}"


def months_between(first: date, second: date) -> int:
    return (second.year - first.year) * 12 + second.month - first.month


class Clients:
    """Clusters client names across Zoho invoices and bank narrations (bank fields truncate names)."""

    def __init__(self):
        self.names: list[str] = []

    def canonical(self, name: str | None, *, prefer: bool = False) -> str | None:
        if not name or not name_key(name):
            return None
        best, score = None, 0.0
        for known in self.names:
            s = similar(name, known)
            if s > score:
                best, score = known, s
        if best and score >= 0.8:
            if prefer and len(name) > len(best):
                self.names[self.names.index(best)] = name
                return name
            return best
        self.names.append(name)
        return name


def build(records: dict[str, list[dict]], today: date, sources: list[dict] | None = None) -> dict:
    bank = [r for r in records.get("bank_line", []) if r.get("selected")]
    for line in bank:
        line["amount"] = float(line["amount"])
    invoices = sorted(
        (r for r in records.get("invoice", []) if not r.get("test")),
        key=lambda r: (r.get("date") or "", r.get("number") or ""),
    )
    bills = records.get("bill", [])
    costs = sorted(records.get("cost_month", []), key=lambda r: r["month"])
    ads = sorted(records.get("ad_spend_month", []), key=lambda r: r["month"])
    filings = records.get("filing", [])
    suspense = records.get("suspense", [])
    plans = records.get("plan", [])
    packages = records.get("package_cost", [])
    subscriptions = records.get("subscription", [])
    balances = sorted(records.get("bank_balance", []), key=lambda r: r["to"])
    this_month = today.isoformat()[:7]
    last_full = (today.replace(day=1) - timedelta(days=1)).isoformat()[:7]
    months = month_range(FY_START, this_month)

    clients = Clients()
    for inv in invoices:
        inv["clientKey"] = clients.canonical(inv.get("client"), prefer=True)
    for line in bank:
        if line["direction"] == "in" and line.get("category") == CLIENT_RECEIPTS and line.get("kind") == "client":
            line["clientKey"] = clients.canonical(line.get("counterparty"))

    # ---- payments evidence and reconciliation suggestions ---------------------------------------------------------
    credits = [
        ln for ln in bank if ln["direction"] == "in" and ln.get("category") == CLIENT_RECEIPTS and ln["amount"] >= 100
    ]
    evidence_end = (
        max([ln["date"] for ln in bank if ln.get("date") and ln["direction"] == "in"] or [None]) if bank else None
    )
    suggestions, used = [], set()
    by_number = {inv["number"]: inv for inv in invoices if inv.get("number")}
    candidates = []
    for inv in invoices:
        if not inv.get("date") or not inv.get("total"):
            continue
        issued = date.fromisoformat(inv["date"])
        due = date.fromisoformat(inv["due"]) if inv.get("due") else issued + timedelta(days=15)
        total, taxable = float(inv["total"]), float(inv.get("taxable") or inv["total"])
        # A client may pay the full amount, deduct TDS (2% or 10% of the taxable value) or pay only the fee.
        variants = {
            "exact amount": total,
            "amount after 2% TDS": total - 0.02 * taxable,
            "amount after 10% TDS": total - 0.10 * taxable,
            "taxable value only": taxable,
        }
        window = [
            ln
            for ln in credits
            if ln.get("date")
            and issued - timedelta(days=30) <= date.fromisoformat(ln["date"]) <= due + timedelta(days=120)
        ]
        for line in window:
            amount, day = float(line["amount"]), date.fromisoformat(line["date"])
            name = similar(inv.get("client") or "", line.get("counterparty") or "")
            ref = inv["number"] in (line.get("invoices") or [])
            variant = next((label for label, v in variants.items() if abs(amount - v) <= max(2.0, v * 0.002)), None)
            if ref:
                score, basis = (
                    1.0,
                    "Bank narration cites " + inv["number"] + (f" ({variant})" if variant else " (part payment)"),
                )
            elif variant and name >= 0.8:
                score, basis = 0.95, "Same client and " + variant
            elif variant and name >= 0.5:
                score, basis = 0.7, "Similar client name and " + variant
            elif name >= 0.8 and amount < total:
                score, basis = 0.6, "Same client; part payment"
            elif variant and line.get("kind") == "unknown":
                score, basis = 0.55, variant.capitalize() + "; payer not named (cash or cheque)"
            elif variant:
                score, basis = 0.5, variant.capitalize() + "; payer name differs"
            else:
                continue
            candidates.append((score, abs((day - issued).days), inv, line, basis, [line]))
        # Two or three credits from the same client that add up to the invoice (instalments).
        same = sorted(
            [ln for ln in window if similar(inv.get("client") or "", ln.get("counterparty") or "") >= 0.8],
            key=lambda ln: ln["date"],
        )
        for i in range(len(same)):
            for j in range(i + 1, min(len(same), i + 4)):
                parts = same[i : j + 1]
                amount = sum(float(p["amount"]) for p in parts)
                variant = next((label for label, v in variants.items() if abs(amount - v) <= max(2.0, v * 0.002)), None)
                if variant and len(parts) > 1:
                    candidates.append(
                        (
                            0.9,
                            abs((date.fromisoformat(parts[0]["date"]) - issued).days),
                            inv,
                            parts[0],
                            f"{len(parts)} instalments from the same client = {variant}",
                            parts,
                        )
                    )
    # Greedy, best evidence first: each bank credit settles at most one invoice.
    candidates.sort(key=lambda p: (-p[0], p[1]))
    settled = set()
    counts = Counter((p[2]["number"], p[0]) for p in candidates)
    for score, _, inv, line, basis, parts in candidates:
        if inv["number"] in settled or any(p["key"] in used for p in parts):
            continue
        unique = counts[(inv["number"], score)] == 1 or len(parts) > 1
        confident = score >= 0.9 and unique
        if confident:
            settled.add(inv["number"])
            used.update(p["key"] for p in parts)
        elif any(s["invoice"] == inv["number"] for s in suggestions):
            continue
        suggestions.append(
            {
                "invoice": inv["number"],
                "client": inv.get("client"),
                "invoiceDate": inv["date"],
                "invoiceTotal": r2(inv["total"]),
                "bankKey": line["key"],
                "bankKeys": [p["key"] for p in parts],
                "bankDate": parts[-1]["date"],
                "bankAmount": r2(sum(float(p["amount"]) for p in parts)),
                "payer": line.get("counterparty"),
                "reference": line.get("reference"),
                "score": score,
                "unique": unique,
                "basis": basis + ("" if unique else "; another credit fits equally"),
                "confidence": HIGH if confident else MEDIUM if score >= 0.5 else LOW,
                "source": line.get("source"),
            }
        )
    matched = {s["invoice"]: s for s in suggestions if s["confidence"] == HIGH}
    for inv in invoices:
        hit = matched.get(inv.get("number"))
        due = inv.get("due") or inv.get("date")
        inv["paidAmount"] = (
            hit["bankAmount"]
            if hit
            else (r2(inv["total"]) - r2(inv.get("balanceDue") or inv["total"]) if inv.get("total") else 0)
        )
        if hit:
            inv["status"], inv["paidDate"], inv["paidBasis"] = "paid", hit["bankDate"], hit["basis"]
        elif inv.get("balanceDue") is not None and float(inv["balanceDue"]) <= 0:
            inv["status"], inv["paidBasis"] = "paid", inv.get("balanceBasis") or "Zoho invoice shows nil balance"
        elif evidence_end and inv.get("date") and inv["date"] <= evidence_end:
            inv["status"], inv["paidBasis"] = "unpaid", f"No matching credit in bank evidence up to {evidence_end}"
        else:
            inv["status"], inv["paidBasis"] = "unconfirmed", "No bank evidence after " + (evidence_end or "any date")
        inv["ageDays"] = (today - date.fromisoformat(inv["date"])).days if inv.get("date") else None
        inv["overdueDays"] = max(0, (today - date.fromisoformat(due)).days) if due and inv["status"] != "paid" else 0

    # ---- revenue by month and client -----------------------------------------------------------------------------
    rev = {
        m: {
            "month": m,
            "invoiced": 0.0,
            "invoicedGross": 0.0,
            "invoices": 0,
            "collected": None,
            "collectedLines": 0,
            "collectedBasis": None,
            "collectedConfidence": None,
        }
        for m in months
    }
    for inv in invoices:
        m = (inv.get("date") or "")[:7]
        if m in rev and inv.get("total"):
            rev[m]["invoiced"] += float(inv.get("taxable") or inv["total"])
            rev[m]["invoicedGross"] += float(inv["total"])
            rev[m]["invoices"] += 1
    families = {}
    for line in bank:
        if line["direction"] == "in":
            families[line["month"]] = line.get("family")
    for line in credits:
        m = line["month"]
        if m in rev:
            rev[m]["collected"] = (rev[m]["collected"] or 0.0) + float(line["amount"])
            rev[m]["collectedLines"] += 1
            rev[m]["collectedBasis"] = line.get("family")
            rev[m]["collectedConfidence"] = line.get("confidence")
    summaries = {(s["month"], s["direction"]): s for s in records.get("bank_summary", [])}
    for m, row in rev.items():
        if row["collected"] is None and (m, "in") in summaries:
            row["collected"], row["collectedBasis"], row["collectedConfidence"] = (
                float(summaries[(m, "in")]["amount"]),
                "summary",
                LOW,
            )
        row["revenue"] = row["invoiced"] if row["invoices"] else row["collected"]
        row["revenueBasis"] = (
            "invoiced (ex-GST, Zoho)"
            if row["invoices"]
            else ("collected (bank credits, incl. GST)" if row["collected"] is not None else None)
        )
        row["confidence"] = HIGH if row["invoices"] else row["collectedConfidence"]
        for k in ("invoiced", "invoicedGross"):
            row[k] = r2(row[k])
        if row["collected"] is not None:
            row["collected"] = r2(row["collected"])
    revenue_months = [rev[m] for m in months]
    fy = defaultdict(
        lambda: {"invoiced": 0.0, "collected": 0.0, "invoicedMonths": 0, "collectedMonths": 0, "revenue": 0.0}
    )
    for row in revenue_months:
        if row["month"] > this_month:
            continue
        f = fy[fiscal_year(row["month"] + "-01")]
        f["invoiced"] += row["invoiced"]
        f["invoicedMonths"] += 1 if row["invoices"] else 0
        if row["collected"] is not None:
            f["collected"] += row["collected"]
            f["collectedMonths"] += 1
        f["revenue"] += row["revenue"] or 0
    fiscal = [
        {"fy": k, **{x: r2(v) if isinstance(v, float) else v for x, v in val.items()}} for k, val in sorted(fy.items())
    ]
    # Best and worst months compare like with like: invoiced months with each other, collection months with each other.
    invoiced_months = [r for r in revenue_months if r["month"] <= last_full and r["invoices"]]
    collected_months = [
        r
        for r in revenue_months
        if r["month"] <= last_full and r["collected"] and r["collectedBasis"] in ("statement", "dated", "monthly")
    ]
    best = max(invoiced_months, key=lambda r: r["invoiced"], default=None)
    worst = min(invoiced_months, key=lambda r: r["invoiced"], default=None)
    best_collected = max(collected_months, key=lambda r: r["collected"], default=None)
    worst_collected = min(collected_months, key=lambda r: r["collected"], default=None)

    by_client = defaultdict(
        lambda: {
            "invoiced": 0.0,
            "collected": 0.0,
            "invoices": 0,
            "first": None,
            "last": None,
            "months": defaultdict(float),
            "outstanding": 0.0,
        }
    )
    for inv in invoices:
        key = inv.get("clientKey")
        if not key or not inv.get("total"):
            continue
        c = by_client[key]
        c["invoiced"] += float(inv.get("taxable") or inv["total"])
        c["invoices"] += 1
        c["first"] = min(filter(None, [c["first"], inv["date"]]))
        c["last"] = max(filter(None, [c["last"], inv["date"]]))
        c["months"][inv["date"][:7]] += float(inv.get("taxable") or inv["total"])
        if inv["status"] != "paid":
            c["outstanding"] += float(inv["total"]) - float(inv.get("paidAmount") or 0)
    for line in credits:
        key = line.get("clientKey")
        if not key:
            continue
        c = by_client[key]
        c["collected"] += float(line["amount"])
        c["first"] = min(filter(None, [c["first"], line.get("date") or line["month"] + "-01"]))
        c["last"] = max(filter(None, [c["last"], line.get("date") or line["month"] + "-28"]))
        if not c["invoices"]:
            c["months"][line["month"]] += float(line["amount"])
    total_invoiced = sum(c["invoiced"] for c in by_client.values()) or 1
    total_collected = sum(c["collected"] for c in by_client.values()) or 1
    client_rows = sorted(
        (
            {
                "client": k,
                "invoiced": r2(v["invoiced"]),
                "collected": r2(v["collected"]),
                "invoiceShare": round(v["invoiced"] / total_invoiced, 4),
                "collectedShare": round(v["collected"] / total_collected, 4),
                "invoices": v["invoices"],
                "first": v["first"],
                "last": v["last"],
                "outstanding": r2(v["outstanding"]),
                "months": {m: r2(a) for m, a in sorted(v["months"].items())},
            }
            for k, v in by_client.items()
        ),
        key=lambda c: (-(c["invoiced"] or 0), -(c["collected"] or 0)),
    )

    # ---- expenses, payroll and burn -------------------------------------------------------------------------------
    exp = defaultdict(
        lambda: {"month": None, "total": 0.0, "byCategory": defaultdict(float), "basis": None, "confidence": None}
    )
    for line in bank:
        if line["direction"] != "out":
            continue
        e = exp[line["month"]]
        e["month"] = line["month"]
        e["total"] += float(line["amount"])
        e["byCategory"][line["category"]] += float(line["amount"])
        e["basis"] = "bank debits (" + line.get("family", "sheet") + ")"
        e["confidence"] = line.get("confidence")
    for cost in costs:
        # EA's own monthly cost sheet is the more complete view of operating cost where it exists.
        e = exp[cost["month"]]
        e.update(
            month=cost["month"],
            total=float(cost["payroll"]) + sum(float(v) for v in cost["items"].values()),
            basis="monthly cost sheet (" + cost["source"]["file"] + ")",
            confidence=cost.get("confidence", MEDIUM),
        )
        e["byCategory"] = defaultdict(
            float,
            {"Payroll (monthly total)": float(cost["payroll"]), **{k: float(v) for k, v in cost["items"].items()}},
        )
    for s in records.get("bank_summary", []):
        if s["direction"] == "out" and s["month"] not in exp:
            exp[s["month"]].update(
                month=s["month"], total=float(s["amount"]), basis="sheet month summary", confidence=LOW
            )
    expense_months = [
        {
            "month": m,
            "total": r2(v["total"]),
            "byCategory": {k: r2(a) for k, a in sorted(v["byCategory"].items(), key=lambda x: -x[1])},
            "basis": v["basis"],
            "confidence": v["confidence"],
        }
        for m, v in sorted(exp.items())
        if v["month"]
    ]
    cat_totals = defaultdict(float)
    for row in expense_months:
        if row["month"] >= add_months(today.replace(day=1), -12).isoformat()[:7]:
            for k, v in row["byCategory"].items():
                cat_totals[k] += v
    payroll = []
    for cost in costs:
        payroll.append(
            {
                "month": cost["month"],
                "total": r2(cost["payroll"]),
                "people": cost["people"],
                "basis": "Monthly cost sheet: people rows totalled",
                "confidence": cost.get("confidence", MEDIUM),
                "source": cost["source"]["file"],
            }
        )
    covered = {p["month"] for p in payroll}
    people_bank = defaultdict(float)
    for line in bank:
        if line["direction"] == "out" and line["category"] in INDIVIDUAL_CATEGORIES:
            people_bank[line["month"]] += float(line["amount"])
    for m, v in sorted(people_bank.items()):
        if m not in covered:
            payroll.append(
                {
                    "month": m,
                    "total": r2(v),
                    "people": None,
                    "basis": "Bank transfers to individuals (staff, founders, freelancers)",
                    "confidence": LOW,
                    "source": "bank lines",
                }
            )
    payroll.sort(key=lambda p: p["month"])

    recent_costs = [e for e in expense_months if e["month"] <= last_full][-3:]
    avg_cost = sum(e["total"] for e in recent_costs) / len(recent_costs) if recent_costs else None
    recent_rev = [r for r in revenue_months if r["month"] <= last_full and r["invoices"]][-3:]
    avg_inv = sum(r["invoicedGross"] for r in recent_rev) / len(recent_rev) if recent_rev else None
    avg_inv_net = sum(r["invoiced"] for r in recent_rev) / len(recent_rev) if recent_rev else None
    latest_balance = balances[-1] if balances else None
    burn = {
        "avgMonthlyCost": r2(avg_cost) if avg_cost is not None else None,
        "costMonths": [e["month"] for e in recent_costs],
        "avgMonthlyInvoiced": r2(avg_inv_net) if avg_inv_net is not None else None,
        "invoicedMonths": [r["month"] for r in recent_rev],
        "net": r2((avg_inv_net or 0) - (avg_cost or 0)) if avg_cost is not None and avg_inv_net is not None else None,
        "balance": {
            "amount": r2(latest_balance["closing"]),
            "asOf": latest_balance["to"],
            "file": latest_balance["file"],
            "ageDays": (today - date.fromisoformat(latest_balance["to"])).days,
        }
        if latest_balance and latest_balance.get("closing") is not None
        else None,
        "runwayMonths": None,
        "basis": "Average of the last three complete months of the monthly cost sheet against Zoho invoicing (ex-GST).",
        "confidence": MEDIUM,
    }
    if (
        burn["balance"]
        and avg_cost
        and burn["net"] is not None
        and burn["net"] < 0
        and burn["balance"]["ageDays"] <= 45
    ):
        burn["runwayMonths"] = round(burn["balance"]["amount"] / -burn["net"], 1)
    burn["runwayNote"] = (
        f"Runway is not computed: the latest bank balance ({inr(burn['balance']['amount'])}) is from {burn['balance']['asOf']}, "
        f"{burn['balance']['ageDays']} days old."
        if burn["balance"] and burn["runwayMonths"] is None
        else "Runway is not computed: no bank balance is available."
        if not burn["balance"]
        else None
    )

    # ---- margins --------------------------------------------------------------------------------------------------
    overlap = [m for m in months if m <= last_full and rev[m]["invoices"] and m in exp and exp[m]["month"]]
    ov_rev = sum(rev[m]["invoiced"] for m in overlap)
    ov_cost = sum(float(exp[m]["total"]) for m in overlap)
    package_rows = [
        {
            "package": p["package"],
            "cost": r2(p["deliveryCost"]),
            "price": r2(p["price"]),
            "margin": round(1 - float(p["deliveryCost"]) / float(p["price"]), 4),
        }
        for p in packages
        if p.get("price")
    ]
    margins = {
        "operating": {
            "months": overlap,
            "revenue": r2(ov_rev),
            "cost": r2(ov_cost),
            "margin": round(1 - ov_cost / ov_rev, 4) if ov_rev else None,
            "basis": "Zoho invoicing (ex-GST) against the monthly cost sheet for the same months",
            "confidence": MEDIUM,
        },
        "packages": package_rows,
        "clients": [],
        "note": "Costs are not recorded per client, so margin per client is an estimate from the standard package cost model.",
    }
    if package_rows:
        ratio = sum(p["cost"] for p in package_rows) / sum(p["price"] for p in package_rows)
        for c in client_rows[:15]:
            if c["invoiced"]:
                margins["clients"].append(
                    {
                        "client": c["client"],
                        "revenue": c["invoiced"],
                        "estCost": r2(c["invoiced"] * ratio),
                        "estMargin": r2(c["invoiced"] * (1 - ratio)),
                        "basis": "Standard package cost ratio",
                        "confidence": LOW,
                    }
                )

    # ---- software, subscriptions and renewals --------------------------------------------------------------------
    vendors = defaultdict(
        lambda: {
            "vendor": None,
            "category": None,
            "total": 0.0,
            "count": 0,
            "last": None,
            "lastAmount": None,
            "currency": "INR",
            "cadence": None,
            "charges": [],
        }
    )
    pdf_vendors = {b["vendor"] for b in bills if b.get("basis") in ("pdf", "pdf-unreadable")}
    for b in sorted(bills, key=lambda b: b.get("date") or b.get("mailDate") or ""):
        v = vendors[b["vendor"]]
        v.update(vendor=b["vendor"], category=b["category"], cadence=b.get("cadence") or v["cadence"])
        if b.get("basis") == "mail-header" and b["vendor"] in pdf_vendors:
            continue  # a notice about a bill whose PDF is already counted
        v["count"] += 1
        currency = b.get("currency") or "INR"
        if b.get("total") is not None:
            if not v["charges"]:
                v["currency"] = currency
            if currency == v["currency"]:
                v["total"] += float(b["total"])
            v["charges"].append((b.get("date") or b.get("mailDate"), float(b["total"]), currency))
        when = b.get("date") or b.get("mailDate")
        if when and (not v["last"] or when >= v["last"]):
            v["last"] = when
            if b.get("total") is not None and currency == v["currency"]:
                v["lastAmount"] = r2(b["total"])
    for line in bank:
        if line["direction"] == "out" and line.get("counterparty") and line.get("kind") == "vendor":
            v = vendors[line["counterparty"]]
            v.update(vendor=line["counterparty"], category=v["category"] or line["category"])
            v["total"] += float(line["amount"])
            v["count"] += 1
            when = line.get("date") or line["month"] + "-01"
            if not v["last"] or when >= v["last"]:
                v["last"], v["lastAmount"] = when, r2(line["amount"])
    renewals = []
    vendor_rows = []
    for v in vendors.values():
        days = sorted({c[0] for c in v["charges"] if c[0]})
        gaps = sorted(
            (date.fromisoformat(b) - date.fromisoformat(a)).days for a, b in zip(days, days[1:], strict=False)
        )
        if len(gaps) >= 2:
            median = gaps[len(gaps) // 2]
            v["cadence"] = (
                "monthly"
                if 25 <= median <= 35
                else "quarterly"
                if 80 <= median <= 100
                else "annual"
                if 330 <= median <= 400
                else v["cadence"]
            )
        nxt, basis = None, None
        step = {"monthly": 1, "quarterly": 3, "annual": 12}.get(v["cadence"])
        if v["last"] and step:
            last = date.fromisoformat(v["last"])
            nxt = add_months(last, step)
            while nxt < today:
                nxt = add_months(nxt, step)
            basis = f"{v['cadence'].title()} cadence from the last bill on {v['last']}"
        amounts = [c[1] for c in sorted(v["charges"], key=lambda c: c[0] or "") if c[2] == v["currency"]]
        change = round(amounts[-1] - amounts[-2], 2) if len(amounts) >= 2 else None
        row = {
            "vendor": v["vendor"],
            "category": v["category"],
            "total": r2(v["total"]),
            "count": v["count"],
            "last": v["last"],
            "lastAmount": v["lastAmount"],
            "currency": v["currency"],
            "cadence": v["cadence"] or "unknown",
            "nextRenewal": nxt.isoformat() if nxt else None,
            "renewalBasis": basis,
            "priceChange": change,
            "confidence": MEDIUM if v["charges"] else LOW,
        }
        vendor_rows.append(row)
        if nxt and nxt <= today + timedelta(days=30):
            renewals.append(row)
    vendor_rows.sort(key=lambda v: -v["total"])
    renewals.sort(key=lambda v: v["nextRenewal"])
    tools = sorted(subscriptions, key=lambda s: -float(s.get("monthly") or 0))
    ai_words = re.compile(r"claude|chatgpt|openai|kling|eleven|anthropic|manus", re.I)
    software = {
        "ownerMonthly": r2(sum(float(t["monthly"]) for t in tools if t.get("category") == "Software & AI")),
        "aiMonthly": r2(sum(float(t["monthly"]) for t in tools if ai_words.search(t.get("name", "")))),
        "officeMonthly": r2(sum(float(t["monthly"]) for t in tools if t.get("category") != "Software & AI")),
        "tools": tools,
        "sheetTools": [
            {"month": c["month"], "amount": r2(c["items"].get("Software & AI", 0))}
            for c in costs
            if c["items"].get("Software & AI")
        ],
        "renewals30": renewals,
        "basis": "Owner's tool list (EA setup handoff, 2 Oct 2026); vendor bills in finance mail",
    }

    # ---- ad spend -------------------------------------------------------------------------------------------------
    ad_total = sum(float(a["amount"]) for a in ads if a.get("currency") == "INR")
    ad_recent = [a for a in ads if a["month"] <= last_full][-3:]
    ad = {
        "months": [{**a, "amount": r2(a["amount"])} for a in ads],
        "total": r2(ad_total),
        "receipts": sum(a.get("receipts", 0) for a in ads),
        "avg3": r2(sum(float(a["amount"]) for a in ad_recent) / len(ad_recent)) if ad_recent else None,
        "basis": "Distinct Meta payment receipts (Transaction ID) seen in any EA mailbox, from the index",
        "note": "Receipts show client ad accounts being funded; the receipt does not say who paid. Ad spend is billed to clients separately.",
        "confidence": MEDIUM,
    }

    # ---- filings and compliance ----------------------------------------------------------------------------------
    gst = [f for f in filings if f["type"] in ("GSTR-1", "GSTR-3B", "IFF")]
    registered = min([f["date"] for f in filings if f["type"] == "GST registration"] or ["2025-06-26"])
    quarters = []
    q_start = date(int(registered[:4]), ((int(registered[5:7]) - 1) // 3) * 3 + 1, 1)
    while q_start <= today:
        q_end = add_months(q_start, 3) - timedelta(days=1)
        period = q_end.isoformat()[:7]
        due1, due3 = add_months(q_start, 3).replace(day=13), add_months(q_start, 3).replace(day=22)
        filed1 = next((f for f in gst if f["type"] == "GSTR-1" and f.get("period") == period), None)
        filed3 = next((f for f in gst if f["type"] == "GSTR-3B" and f.get("period") == period), None)
        iff = sorted(
            {
                f["period"]
                for f in gst
                if f["type"] == "IFF" and f.get("period") and q_start.isoformat()[:7] <= f["period"] <= period
            }
        )
        quarters.append(
            {
                "quarter": f"{month_label(q_start.isoformat()[:7])}–{month_label(period)}",
                "period": period,
                "gstr1": {
                    "filed": bool(filed1),
                    "date": filed1["date"] if filed1 else None,
                    "arn": filed1.get("arn") if filed1 else None,
                    "due": due1.isoformat(),
                    "late": bool(filed1 and filed1["date"] > due1.isoformat()),
                },
                "gstr3b": {
                    "filed": bool(filed3),
                    "date": filed3["date"] if filed3 else None,
                    "arn": filed3.get("arn") if filed3 else None,
                    "due": due3.isoformat(),
                    "late": bool(filed3 and filed3["date"] > due3.isoformat()),
                },
                "iff": iff,
                "open": q_end >= today or due3 > today,
            }
        )
        q_start = add_months(q_start, 3)
    gaps = [q for q in quarters if not q["open"] and (not q["gstr1"]["filed"] or not q["gstr3b"]["filed"])]
    late = [q for q in quarters if q["gstr1"]["late"] or q["gstr3b"]["late"]]
    notices = sorted(
        [
            f
            for f in filings
            if f["status"] in ("default notice", "notice", "reminder")
            and f["type"] not in ("LLP Form 8", "LLP Form 11")
        ],
        key=lambda f: f["date"],
    )
    upcoming = []
    for q in quarters:
        for key, label in (("gstr1", "GSTR-1"), ("gstr3b", "GSTR-3B")):
            if not q[key]["filed"] and q[key]["due"] >= today.isoformat():
                upcoming.append({"what": f"{label} for {q['quarter']}", "due": q[key]["due"]})
    upcoming.sort(key=lambda u: u["due"])
    compliance = {
        "registered": registered,
        "scheme": "QRMP (quarterly returns; IFF for the first two months)"
        if any(f["type"] == "IFF" for f in gst)
        else "Quarterly",
        "quarters": quarters,
        "gaps": [q["quarter"] for q in gaps],
        "late": [q["quarter"] for q in late],
        "notices": notices,
        "upcoming": upcoming,
        "tds": sorted([f for f in filings if f["type"].startswith("TDS")], key=lambda f: f["date"]),
        "itr": sorted([f for f in filings if f["type"] in ("ITR", "Financial statements")], key=lambda f: f["date"]),
        "llp": sorted([f for f in filings if f["type"].startswith("LLP")], key=lambda f: f["date"])[-6:],
        "pt": sorted([f for f in filings if f["type"] == "Profession tax"], key=lambda f: f["date"]),
        "gstPayments": sorted([f for f in filings if f["type"] == "GST payment"], key=lambda f: f["date"]),
    }

    # ---- anomalies ------------------------------------------------------------------------------------------------
    anomalies = []
    numbers = sorted(
        {int(re.sub(r"\D", "", n)) for n in by_number if re.sub(r"\D", "", n) and int(re.sub(r"\D", "", n)) >= 1000}
    )
    if numbers:
        missing = [n for n in range(numbers[0], numbers[-1] + 1) if n not in set(numbers)]
        if missing:
            shown = ", ".join(f"INV-{n:08d}" for n in missing[:8]) + (
                f" and {len(missing) - 8} more" if len(missing) > 8 else ""
            )
            anomalies.append(
                {
                    "kind": "missing_invoices",
                    "title": f"{len(missing)} invoice numbers never reached finance mail",
                    "text": f"Zoho numbers {shown} are missing between INV-{numbers[0]:08d} and INV-{numbers[-1]:08d}. "
                    "They may be drafts, voids or invoices sent without copying marketing@.",
                    "count": len(missing),
                    "confidence": HIGH,
                    "who": "Kazuk (Zoho Invoice admin)",
                }
            )
    seen = defaultdict(list)
    for b in bills:
        if b.get("total") is not None and b.get("date"):
            seen[(b["vendor"], round(float(b["total"]), 2))].append(b)
    dupes = []
    for (vendor, amount), group in seen.items():
        group.sort(key=lambda b: b["date"])
        for a, b in zip(group, group[1:], strict=False):
            if (
                (date.fromisoformat(b["date"]) - date.fromisoformat(a["date"])).days <= 3
                and a.get("invoiceNo") != b.get("invoiceNo")
                and amount > 0
            ):
                dupes.append({"vendor": vendor, "amount": amount, "dates": [a["date"], b["date"]]})
    debit_seen = defaultdict(list)
    for line in bank:
        if line["direction"] == "out" and line.get("counterparty") and line.get("date"):
            debit_seen[(line["counterparty"], round(float(line["amount"]), 2))].append(line["date"])
    for (party, amount), days in debit_seen.items():
        days.sort()
        for a, b in zip(days, days[1:], strict=False):
            if (date.fromisoformat(b) - date.fromisoformat(a)).days <= 3 and amount >= 500:
                dupes.append({"vendor": party, "amount": amount, "dates": [a, b]})
    if dupes:
        anomalies.append(
            {
                "kind": "duplicate_charges",
                "title": f"{len(dupes)} possible duplicate charges",
                "text": "; ".join(
                    f"{d['vendor']} {inr(d['amount'])} on {d['dates'][0]} and {d['dates'][1]}" for d in dupes[:5]
                ),
                "items": dupes[:20],
                "count": len(dupes),
                "confidence": MEDIUM,
                "who": "Founders to confirm with the vendor",
            }
        )
    if gaps:
        anomalies.append(
            {
                "kind": "gst_gap",
                "title": "GST returns not seen for " + ", ".join(q["quarter"] for q in gaps),
                "text": "No GST portal ARN mail for a GSTR-1 or GSTR-3B that is past due.",
                "confidence": MEDIUM,
                "who": "CA Pukapafa",
            }
        )
    for n in notices:
        if n["type"] == "GSTR-3B" and n["status"] == "default notice":
            anomalies.append(
                {
                    "kind": "gst_notice",
                    "title": "GSTR-3B default notice (" + (n.get("noticePeriod") or n["date"]) + ")",
                    "text": f"The GST portal issued a GSTR-3A default notice on {n['date']}; the return was filed afterwards.",
                    "confidence": HIGH,
                    "who": "CA Pukapafa",
                }
            )
        if n["type"] == "Profession tax" and n["status"] == "notice":
            anomalies.append(
                {
                    "kind": "pt_notice",
                    "title": "Profession tax show-cause notice",
                    "text": f"The Maharashtra PT office issued a show-cause notice for non/short payment on {n['date']}. "
                    "Confirm the PTRC/PTEC payment receipts are on file.",
                    "confidence": HIGH,
                    "who": "CA Pukapafa",
                }
            )
    if suspense:
        open_amount = sum(float(s["amount"]) for s in suspense)
        anomalies.append(
            {
                "kind": "suspense",
                "title": f"{len(suspense)} bank entries sit in the CA's suspense ledger",
                "text": f"{inr(open_amount)} of bank entries had no explanation in Tally (latest {max(s['date'] for s in suspense)}).",
                "count": len(suspense),
                "amount": r2(open_amount),
                "confidence": HIGH,
                "who": "Founders explain each entry to the CA",
            }
        )
    no_gstin = [
        b
        for b in bills
        if b.get("category") not in ("Equipment & supplies",)
        and b.get("basis") == "pdf"
        and b.get("currency") == "INR"
        and b.get("vendorGstin")
        and not b.get("ourGstinPresent")
    ]
    if no_gstin:
        anomalies.append(
            {
                "kind": "missing_our_gstin",
                "title": f"{len(no_gstin)} Indian vendor bills do not show our GSTIN",
                "text": "Input tax credit needs the company GSTIN on the bill: "
                + ", ".join(sorted({b["vendor"] for b in no_gstin})[:6])
                + ".",
                "count": len(no_gstin),
                "confidence": MEDIUM,
                "who": "Each vendor (billing profile)",
            }
        )
    cited = {n for ln in credits for n in (ln.get("invoices") or [])}
    unknown_refs = sorted(n for n in cited if n not in by_number and numbers and int(n[4:]) >= numbers[0])
    if unknown_refs:
        anomalies.append(
            {
                "kind": "unknown_invoice_refs",
                "title": f"{len(unknown_refs)} bank credits cite invoices not in finance mail",
                "text": ", ".join(unknown_refs[:8]),
                "confidence": MEDIUM,
                "who": "Kazuk (Zoho Invoice export)",
            }
        )

    # ---- collections ----------------------------------------------------------------------------------------------
    open_invoices = [i for i in invoices if i["status"] != "paid" and i.get("total")]
    overdue = sorted([i for i in open_invoices if i["overdueDays"] > 0], key=lambda i: -i["overdueDays"])
    confirmed = [i for i in overdue if i["status"] == "unpaid"]
    unverified = [i for i in overdue if i["status"] == "unconfirmed"]
    buckets = defaultdict(lambda: {"count": 0, "amount": 0.0})
    for i in overdue:
        b = (
            "0–30 days"
            if i["overdueDays"] <= 30
            else "31–60 days"
            if i["overdueDays"] <= 60
            else "61–90 days"
            if i["overdueDays"] <= 90
            else "90+ days"
        )
        buckets[b]["count"] += 1
        buckets[b]["amount"] += float(i["total"]) - float(i.get("paidAmount") or 0)
    window = [
        i
        for i in invoices
        if evidence_end and i.get("date") and i["date"] <= evidence_end and i.get("due") and i["due"] <= evidence_end
    ]
    paid_in_window = [i for i in window if i["status"] == "paid"]

    def due_amount(rows):
        return r2(sum(float(i["total"]) - float(i.get("paidAmount") or 0) for i in rows))

    collections = {
        "invoices": [
            _invoice_row(i)
            for i in sorted(invoices, key=lambda i: (i.get("date") or "", i.get("number") or ""), reverse=True)
        ],
        "outstanding": {"count": len(open_invoices), "amount": due_amount(open_invoices)},
        "overdue": {
            "count": len(overdue),
            "amount": due_amount(overdue),
            "buckets": [
                {"bucket": k, "count": v["count"], "amount": r2(v["amount"])} for k, v in sorted(buckets.items())
            ],
            "top": [_invoice_row(i) for i in overdue[:12]],
            "confirmed": {
                "count": len(confirmed),
                "amount": due_amount(confirmed),
                "top": [_invoice_row(i) for i in confirmed[:12]],
            },
            "unverified": {
                "count": len(unverified),
                "amount": due_amount(unverified),
                "top": [_invoice_row(i) for i in unverified[:12]],
            },
        },
        "evidenceEnd": evidence_end,
        "paidRate": round(len(paid_in_window) / len(window), 3) if len(window) >= 10 else None,
        "paidRateBasis": f"{len(paid_in_window)} of {len(window)} invoices due before {evidence_end} have a matching bank credit"
        if window
        else None,
        "confidence": MEDIUM,
    }

    # ---- forecast (honest projection) -----------------------------------------------------------------------------
    forecast = _forecast(today, avg_cost, avg_inv, collections, compliance, renewals, burn)

    # ---- budget history -------------------------------------------------------------------------------------------
    budget = {"plans": sorted(plans, key=lambda p: (p.get("asOf") or "", p["item"])), "vsActual": []}
    plan_by_cat = defaultdict(dict)
    for p in plans:
        plan_by_cat[p.get("category") or "Other operating costs"][p.get("asOf") or ""] = plan_by_cat[
            p.get("category") or "Other operating costs"
        ].get(p.get("asOf") or "", 0) + float(p["monthly"])
    for row in expense_months[-12:]:
        for cat, actual in row["byCategory"].items():
            versions = plan_by_cat.get(cat)
            planned = None
            if versions:
                valid = [k for k in versions if k[:7] <= row["month"]] or sorted(versions)
                planned = versions[max(valid)]
            budget["vsActual"].append(
                {
                    "month": row["month"],
                    "category": cat,
                    "actual": actual,
                    "plan": r2(planned) if planned is not None else None,
                }
            )

    # ---- timeline -------------------------------------------------------------------------------------------------
    timeline = []
    for m in reversed(months):
        events = []
        r = rev[m]
        if r["invoices"]:
            events.append(
                {
                    "kind": "invoices",
                    "label": f"{r['invoices']} invoices issued",
                    "amount": r["invoiced"],
                    "confidence": HIGH,
                }
            )
        if r["collected"] is not None:
            events.append(
                {
                    "kind": "collections",
                    "label": f"Collections ({r['collectedLines']} bank credits)"
                    if r["collectedLines"]
                    else "Collections (sheet summary)",
                    "amount": r["collected"],
                    "confidence": r["collectedConfidence"],
                }
            )
        e = exp.get(m)
        if e and e["month"]:
            events.append(
                {
                    "kind": "costs",
                    "label": "Operating costs · " + (e["basis"] or ""),
                    "amount": r2(e["total"]),
                    "confidence": e["confidence"],
                }
            )
        p = next((p for p in payroll if p["month"] == m), None)
        if p:
            events.append(
                {
                    "kind": "payroll",
                    "label": "Payroll (monthly total)" + (f" · {p['people']} people" if p["people"] else ""),
                    "amount": p["total"],
                    "confidence": p["confidence"],
                }
            )
        a = next((a for a in ads if a["month"] == m), None)
        if a:
            events.append(
                {
                    "kind": "ads",
                    "label": f"Meta ad funding seen ({a['receipts']} receipts)",
                    "amount": r2(a["amount"]),
                    "confidence": MEDIUM,
                }
            )
        for f in filings:
            if f["date"][:7] == m and f["status"] in (
                "filed",
                "verified",
                "processed",
                "default notice",
                "notice",
                "CA documents",
            ):
                events.append(
                    {
                        "kind": "filing",
                        "label": f"{f['type']} {f['status']}"
                        + (f" ({month_label(f['period'])})" if f.get("period") else ""),
                        "date": f["date"],
                        "confidence": HIGH,
                    }
                )
        if events:
            timeline.append({"month": m, "label": month_label(m), "events": _dedupe_events(events)})

    # ---- missing evidence (who supplies it) ----------------------------------------------------------------------
    missing = []
    gap_months = [m for m in months if m <= last_full and not any(ln["month"] == m for ln in bank)]
    if evidence_end:
        missing.append(
            {
                "what": f"Bank statements after {evidence_end}",
                "impact": "Collections, overdue status, cash balance and runway after that date are unconfirmed.",
                "who": "Kazuk: Axis Bank current-account statement export (or CA Pukapafa: Tally bank ledger)",
                "months": len(gap_months),
            }
        )
    trashed = [x for x in (sources or []) if x.get("status") == "trashed"]
    if trashed:
        missing.append(
            {
                "what": f"{len(trashed)} finance files in the Drive trash",
                "impact": "Not read: "
                + ", ".join(x["label"] for x in trashed)
                + ". Restoring the statement exports extends the bank evidence.",
                "who": "marketing@ owner (restore from Drive trash)",
            }
        )
    missing.append(
        {
            "what": "Current bank balance",
            "impact": "Runway and the cash forecast start from an unknown balance.",
            "who": "Kazuk (Axis net banking)",
        }
    )
    if invoices:
        missing.append(
            {
                "what": f"Sales invoices before {invoices[0]['date']}",
                "impact": "Revenue before then is measured from bank credits, not invoices.",
                "who": "Kazuk: Zoho Invoice export of all invoices",
            }
        )
    missing.append(
        {
            "what": "Payment-received notices",
            "impact": "No Zoho payment receipts reach finance mail, so invoices are matched to bank lines only.",
            "who": "Kazuk: turn on Zoho Invoice payment receipts to billing@",
        }
    )
    missing.append(
        {
            "what": "Per-client delivery costs",
            "impact": "Margin per client is estimated from the package cost model.",
            "who": "Pod leads: tag shoots and freelancer payments with the client",
        }
    )
    if not any(f["type"] == "TDS return" and "2025-26" in (f.get("quarter") or "") for f in filings):
        missing.append(
            {
                "what": "TDS returns for FY2025-26",
                "impact": "No TDS CPC filing mail for FY2025-26 quarters.",
                "who": "CA Pukapafa",
            }
        )
    missing.append(
        {
            "what": "Month certification",
            "impact": "Every figure stays uncertified until the CA certifies the month.",
            "who": "CA Pukapafa (Accountant login)",
        }
    )

    brief = _brief(
        today,
        revenue_months,
        best,
        worst,
        client_rows,
        collections,
        burn,
        margins,
        software,
        ad,
        anomalies,
        compliance,
        last_full,
        fiscal,
        best_collected,
        worst_collected,
    )
    return {
        "asOf": today.isoformat(),
        "certified": False,
        "certification": "Uncertified: the CA has not certified any month. Figures carry their source and confidence.",
        "brief": brief,
        "activeClients": _active_clients(records.get("client_status", []), invoices, today),
        "revenue": {
            "months": revenue_months,
            "fiscal": fiscal,
            "best": best,
            "worst": worst,
            "bestCollected": best_collected,
            "worstCollected": worst_collected,
            "clients": client_rows[:60],
            "clientCount": len(client_rows),
            "basis": "Invoiced = Zoho sales invoices ex-GST; collected = bank credits from clients incl. GST",
        },
        "collections": collections,
        "expenses": {
            "months": expense_months,
            "categories": [{"category": k, "total": r2(v)} for k, v in sorted(cat_totals.items(), key=lambda x: -x[1])],
            "vendors": vendor_rows[:80],
        },
        "payroll": payroll,
        "burn": burn,
        "margins": margins,
        "software": software,
        "adSpend": ad,
        "compliance": compliance,
        "anomalies": anomalies,
        "reconcile": {
            "suggestions": sorted(suggestions, key=lambda s: (-s["score"], s["invoiceDate"]), reverse=False)[:200],
            "matched": len(matched),
            "evidenceEnd": evidence_end,
            "unmatchedInvoices": len([i for i in invoices if i["status"] != "paid"]),
            "unmatchedCredits": len([ln for ln in credits if ln["key"] not in used]),
        },
        "forecast": forecast,
        "budget": budget,
        "timeline": timeline,
        "suspense": sorted(suspense, key=lambda s: s["date"], reverse=True)[:120],
        "missing": missing,
        "sources": sources or [],
    }


def _active_clients(rows: list[dict], invoices: list[dict], today: date) -> dict:
    """Active clients on the pod trackers next to the clients invoiced in the last 60 days. Names differ between
    trackers (project names) and Zoho (legal names), so the two counts are shown side by side, not matched."""
    latest = {}
    for r in rows:
        latest[r["client"].lower()] = r
    active = sorted({r["client"] for r in latest.values() if r["status"] == "active"})
    since = (today - timedelta(days=60)).isoformat()
    invoiced = sorted(
        {
            i.get("clientKey") or i.get("client")
            for i in invoices
            if (i.get("date") or "") >= since and (i.get("clientKey") or i.get("client"))
        }
    )
    sheets = sorted(
        {
            f"{(r.get('source') or {}).get('file')} (edited {r.get('asOf') or '?'})"
            for r in rows
            if (r.get("source") or {}).get("file")
        }
    )
    return {
        "active": len(active),
        "names": active[:80],
        "invoiced60": len(invoiced),
        "sheets": sheets,
        "basis": "Active/Inactive status on the pod trackers; invoiced = Zoho invoices dated in the last 60 days",
        "confidence": MEDIUM,
    }


def _invoice_row(i: dict) -> dict:
    keep = (
        "number",
        "date",
        "due",
        "client",
        "clientGstin",
        "taxable",
        "total",
        "status",
        "paidAmount",
        "paidDate",
        "paidBasis",
        "ageDays",
        "overdueDays",
        "description",
        "drive",
        "confidence",
    )
    return {
        k: (r2(i[k]) if k in ("taxable", "total", "paidAmount") and i.get(k) is not None else i.get(k)) for k in keep
    }


def _dedupe_events(events):
    seen, out = set(), []
    for e in events:
        key = (e["kind"], e["label"])
        if key not in seen:
            seen.add(key)
            out.append(e)
    return out


def _forecast(today, avg_cost, avg_inv, collections, compliance, renewals, burn):
    """A six-month direct projection of net cash flow with every assumption written out. Not a balance claim."""
    assumptions = []
    if avg_inv is None or avg_cost is None:
        return {
            "months": [],
            "assumptions": ["Invoicing or cost history is missing; no projection is made."],
            "confidence": LOW,
        }
    rate = collections.get("paidRate")
    collect = rate if rate is not None and rate >= 0.5 else 0.85
    assumptions.append(
        f"New invoicing continues at {inr(avg_inv)} a month incl. GST (average of the last three complete months)."
    )
    assumptions.append(
        f"{round(collect * 100)}% of invoicing is collected the month after it is issued "
        + (
            f"({collections['paidRateBasis']})."
            if rate is not None and rate >= 0.5
            else "(assumed: the bank lines we have match too few invoices to measure a collection rate)."
        )
    )
    assumptions.append(
        f"Operating costs stay at {inr(avg_cost)} a month (last three months of the monthly cost sheet)."
    )
    gst_rate = 0.18 / 1.18
    assumptions.append("GST collected on invoices (18%) is paid quarterly after the quarter, before input credit.")
    recent_open = [
        i
        for i in collections["invoices"]
        if i["status"] != "paid" and i.get("ageDays") is not None and i["ageDays"] <= 60 and i.get("total")
    ]
    outstanding = sum(float(i["total"]) - float(i.get("paidAmount") or 0) for i in recent_open)
    assumptions.append(
        f"Invoices issued in the last 60 days ({len(recent_open)}, {inr(outstanding)}) are collected over the next three months in the base case; "
        "half of them in the downside case. Older invoices without bank evidence are not projected."
    )
    if burn.get("balance"):
        assumptions.append(
            f"The latest known bank balance is {inr(burn['balance']['amount'])} on {burn['balance']['asOf']}; it is too old to be an opening balance."
        )
    months = []
    cumulative = {"base": 0.0, "downside": 0.0, "upside": 0.0}
    for i in range(1, 7):
        m = add_months(today.replace(day=1), i).isoformat()[:7]
        gst_due = avg_inv * gst_rate * 3 if int(m[5:7]) in (1, 4, 7, 10) else 0.0
        row = {"month": m, "label": month_label(m)}
        for scenario, inv_factor, col_factor, open_factor in (
            ("base", 1.0, collect, 1.0),
            ("downside", 0.8, collect * 0.85, 0.5),
            ("upside", 1.1, min(1.0, collect + 0.1), 1.0),
        ):
            inflow = avg_inv * inv_factor * col_factor + (outstanding * open_factor / 3 if i <= 3 else 0)
            outflow = avg_cost * (1.05 if scenario == "downside" else 1.0) + gst_due
            cumulative[scenario] += inflow - outflow
            row[scenario] = {
                "inflow": r2(inflow),
                "outflow": r2(outflow),
                "net": r2(inflow - outflow),
                "cumulative": r2(cumulative[scenario]),
            }
        months.append(row)
    return {
        "months": months,
        "assumptions": assumptions,
        "confidence": LOW,
        "basis": "Direct projection of net cash flow from invoicing, collection rate and monthly costs; uncertified.",
    }


def _brief(
    today,
    revenue_months,
    best,
    worst,
    client_rows,
    collections,
    burn,
    margins,
    software,
    ad,
    anomalies,
    compliance,
    last_full,
    fiscal,
    best_collected=None,
    worst_collected=None,
):
    items = []
    invoiced = [r for r in revenue_months if r["month"] <= last_full and r["invoices"]]
    recent, prior = invoiced[-3:], invoiced[-6:-3]
    if recent:
        now = sum(r["invoiced"] for r in recent) / len(recent)
        before = sum(r["invoiced"] for r in prior) / len(prior) if prior else None
        change = (now / before - 1) if before else None
        text = f"Invoicing averaged {inr(now)} a month (ex-GST) over {month_label(recent[0]['month'])}–{month_label(recent[-1]['month'])}"
        if change is not None:
            text += f", {'up' if change >= 0 else 'down'} {abs(change) * 100:.0f}% on the three months before"
        text += "."
        if best and worst:
            text += f" Best month {month_label(best['month'])} ({inr(best['invoiced'])}); weakest {month_label(worst['month'])} ({inr(worst['invoiced'])})."
        years = [f for f in fiscal if f["invoiced"] or f["collected"]]
        parts = []
        for f in years:
            if f["invoiced"]:
                parts.append(f"{f['fy']} {inr(f['invoiced'])} invoiced ({f['invoicedMonths']} months)")
            elif f["collected"]:
                parts.append(f"{f['fy']} {inr(f['collected'])} collected ({f['collectedMonths']} months of bank lines)")
        if parts:
            text += " " + "; ".join(parts) + "."
        items.append(
            {
                "key": "revenue",
                "title": "Revenue and clients",
                "text": text,
                "tone": "good" if (change or 0) >= 0 else "warn",
                "confidence": HIGH,
                "href": "/finance?tab=overview",
                "basis": "Zoho sales invoices ex-GST; years before Zoho use bank credits from the finance sheets",
            }
        )
    ranked = [c for c in client_rows if c["invoiced"]][:3]
    if ranked:
        share = sum(c["invoiceShare"] for c in ranked)
        text = (
            "Top three clients by invoicing: "
            + "; ".join(f"{c['client']} {inr(c['invoiced'])} ({c['invoiceShare'] * 100:.0f}%)" for c in ranked)
            + (
                f". Together {share * 100:.0f}% of invoiced revenue"
                + (", so no single client dominates." if share < 0.25 else ".")
            )
        )
        target = next((i for i in items if i["key"] == "revenue"), None)
        if target:
            target["text"] += " " + text
        else:
            items.append(
                {
                    "key": "revenue",
                    "title": "Revenue and clients",
                    "text": text,
                    "tone": "info",
                    "confidence": HIGH,
                    "href": "/finance?tab=revenue",
                    "basis": "Zoho sales invoices since the first invoice in finance mail",
                }
            )
    od = collections["overdue"]
    if od["count"]:
        text = ""
        if od["confirmed"]["count"]:
            text += (
                f"{od['confirmed']['count']} invoices worth {inr(od['confirmed']['amount'])} were due before {collections['evidenceEnd']} and no matching payment "
                "appears in the bank lines: "
                + "; ".join(
                    f"{i['client']} {inr(float(i['total']) - float(i.get('paidAmount') or 0))} ({i['overdueDays']} days)"
                    for i in od["confirmed"]["top"][:3]
                )
                + ". "
            )
        if od["unverified"]["count"]:
            text += (
                f"Another {od['unverified']['count']} invoices worth {inr(od['unverified']['amount'])} are past due but cannot be checked: "
                f"there is no bank statement after {collections['evidenceEnd']}."
            )
        items.append(
            {
                "key": "overdue",
                "title": "Overdue collections",
                "text": text.strip(),
                "tone": "bad",
                "confidence": MEDIUM,
                "href": "/finance?tab=revenue",
                "basis": collections.get("paidRateBasis") or "Invoice due dates against bank credits",
            }
        )
    if burn.get("avgMonthlyCost") is not None:
        text = (
            f"Monthly costs average {inr(burn['avgMonthlyCost'])} ("
            + ", ".join(month_label(m) for m in burn["costMonths"])
            + ")"
        )
        if burn.get("avgMonthlyInvoiced") is not None:
            text += (
                f" against {inr(burn['avgMonthlyInvoiced'])} invoiced ex-GST in "
                + ", ".join(month_label(m) for m in burn["invoicedMonths"])
                + f": {'a surplus' if burn['net'] >= 0 else 'a shortfall'} of {inr(abs(burn['net']))} a month if every sale is invoiced in Zoho."
            )
        else:
            text += "."
        if burn.get("runwayMonths") is not None:
            text += f" Runway {burn['runwayMonths']} months."
        elif burn.get("runwayNote"):
            text += " " + burn["runwayNote"]
        items.append(
            {
                "key": "burn",
                "title": "Burn and runway",
                "text": text,
                "tone": "good" if (burn.get("net") or 0) >= 0 else "bad",
                "confidence": MEDIUM,
                "href": "/finance?tab=forecast",
                "basis": burn["basis"],
            }
        )
    op = margins["operating"]
    if op.get("margin") is not None:
        pk = margins["packages"]
        text = f"Operating margin {op['margin'] * 100:.0f}% over {len(op['months'])} months ({inr(op['revenue'])} invoiced ex-GST against {inr(op['cost'])} of costs)."
        if pk:
            text += (
                " The package cost model expects "
                + "; ".join(f"{p['margin'] * 100:.0f}% on the {p['package']} package" for p in pk)
                + "."
            )
        items.append(
            {
                "key": "margin",
                "title": "Margins",
                "text": text + " Costs are not tracked per client, so per-client margin is an estimate.",
                "tone": "bad" if op["margin"] < 0 else "info",
                "confidence": MEDIUM,
                "href": "/finance?tab=budget",
                "basis": op["basis"],
            }
        )
    if software["tools"] or software["renewals30"]:
        text = f"Software and AI tools cost {inr(software['ownerMonthly'])} a month, of which AI {inr(software['aiMonthly'])} (owner's tool list)."
        if software["renewals30"]:
            text += (
                " Renewing within 30 days: "
                + "; ".join(
                    f"{v['vendor']}{' ' + fmt(v['lastAmount'], v['currency']) if v.get('lastAmount') else ''} on {v['nextRenewal']}"
                    for v in software["renewals30"][:5]
                )
                + "."
            )
        items.append(
            {
                "key": "software",
                "title": "Software, AI and renewals",
                "text": text,
                "tone": "info",
                "confidence": MEDIUM,
                "href": "/finance?tab=subscriptions",
                "basis": software["basis"],
            }
        )
    if ad.get("total"):
        items.append(
            {
                "key": "ads",
                "title": "Client ad funding",
                "text": f"{inr(ad['total'])} of Meta ad funding seen across {ad['receipts']:,} receipts; "
                f"recent average {inr(ad['avg3'])} a month. {ad['note']}",
                "tone": "info",
                "confidence": MEDIUM,
                "href": "/finance?tab=ad-spend",
                "basis": ad["basis"],
            }
        )
    if anomalies:
        items.append(
            {
                "key": "anomalies",
                "title": "Anomalies to clear",
                "text": " · ".join(a["title"] for a in anomalies[:5]) + ".",
                "tone": "bad",
                "confidence": lowest(*(a["confidence"] for a in anomalies[:5])),
                "href": "/finance?tab=reconcile",
                "basis": "Invoice sequence, duplicate bills and bank lines, GST portal mail, CA suspense ledger",
            }
        )
    if compliance.get("upcoming"):
        nxt = compliance["upcoming"][0]
        items.append(
            {
                "key": "compliance",
                "title": "Next filing",
                "text": f"{nxt['what']} is due {nxt['due']}. "
                + (
                    "Every past quarterly GST return has an ARN mail."
                    if not compliance["gaps"]
                    else "Past gaps: " + ", ".join(compliance["gaps"]) + "."
                )
                + (
                    f" {len(compliance['late'])} of {len([q for q in compliance['quarters'] if not q['open']])} completed quarters were filed after "
                    "the due date (GSTR-1 on the 13th, GSTR-3B on the 22nd after the quarter), which attracts late fees."
                    if compliance["late"]
                    else ""
                ),
                "tone": "info" if not compliance["gaps"] and not compliance["late"] else "warn",
                "confidence": HIGH,
                "href": "/finance/desk",
                "basis": "GST portal ARN mails",
            }
        )
    order = ["revenue", "overdue", "burn", "margin", "compliance", "anomalies", "software", "ads"]
    items.sort(key=lambda i: order.index(i["key"]))
    return items[:7]
