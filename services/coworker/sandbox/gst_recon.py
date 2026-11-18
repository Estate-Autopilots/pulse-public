"""FIN-AGENT-2 (18 Nov 2026): GST reconciliation, run inside the sandbox (no network, read-only inputs).

Reads the GST portal's own downloads (GSTR-1, GSTR-3B and GSTR-2B as JSON, or the B2B sheet of their Excel/CSV
downloads) and checks them against what Pulse holds:
  * GSTR-1 against the company's invoices in Pulse: invoices missing from either side, and amounts that differ;
  * GSTR-3B against GSTR-1, month by month: output tax declared below what GSTR-1 reports (what a DRC-01B notice
    asks about);
  * GSTR-3B's input tax credit against GSTR-2B: credit claimed above what suppliers filed (what a DRC-01C notice asks
    about);
  * GSTR-2B's supplier bills against the bank payments Pulse already has: a bill whose payment is not found (credit on
    a bill left unpaid for 180 days must be reversed).
Money is kept in paise (integers). Nothing is guessed: a figure the returns do not give stays out, and each finding
says which return and month it comes from.

  python gst_recon.py /in /out      (/in/job.json: files, invoices, payments, gstin)
Writes /out/result.json and one JSON progress line per step on stdout.
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
import time
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

TOL = 100  # ₹1, in paise: rounding on the portal

MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()


def say(p: int, line: str) -> None:
    print(json.dumps({"t": "progress", "p": p, "line": line[:200]}), flush=True)


def paise(v) -> int:
    if v is None or v == "":
        return 0
    if isinstance(v, (int, float)):
        return int(round(float(v) * 100))
    s = re.sub(r"[^\d.\-]", "", str(v))
    try:
        return int(round(float(s) * 100)) if s not in ("", "-", ".") else 0
    except ValueError:
        return 0


def period_of(fp: str | None) -> str | None:
    """The portal's period "MMYYYY" (fp, ret_period, rtnprd) as "YYYY-MM"."""
    m = re.fullmatch(r"(\d{2})(\d{4})", str(fp or "").strip())
    if not m or not 1 <= int(m.group(1)) <= 12:
        return None
    return f"{m.group(2)}-{m.group(1)}"


def day_of(v) -> str | None:
    if isinstance(v, (datetime, date)):
        return (v.date() if isinstance(v, datetime) else v).isoformat()
    s = str(v or "").strip()
    for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d", "%d-%b-%Y", "%d-%b-%y", "%d/%m/%y"):
        try:
            return datetime.strptime(s[:11], fmt).date().isoformat()
        except ValueError:
            continue
    return None


def month_words(m: str) -> str:
    y, mm = m.split("-")
    return f"{MONTHS[int(mm) - 1]} {y}"


def inv_key(s) -> str:
    """Invoice numbers compared without case, spaces, slashes or leading zeros in their numbers."""
    return "".join(t if t.isalpha() else str(int(t)) for t in re.findall(r"[A-Z]+|[0-9]+", str(s or "").upper()))


STOP = {"PVT", "PRIVATE", "LTD", "LIMITED", "LLP", "INDIA", "THE", "AND", "CO", "COMPANY", "SERVICES", "SOLUTIONS",
        "ENTERPRISES", "TECHNOLOGIES", "TECHNOLOGY", "INDUSTRIES", "TRADERS", "OPC", "INC", "M/S", "MS"}


def name_tokens(s) -> set[str]:
    return {t for t in re.findall(r"[A-Z0-9]{4,}", str(s or "").upper()) if t not in STOP}


# ----------------------------------------------------------------------------------------------- reading the returns
def from_json(d: dict, name: str):
    """One portal JSON: GSTR-1 (b2b, b2cs, cdnr …), GSTR-3B (sup_details, itc_elg) or GSTR-2B (docdata)."""
    if isinstance(d.get("data"), dict) and ("docdata" in d["data"] or "rtnprd" in d["data"]):
        d = d["data"]
    if "docdata" in d or "rtnprd" in d:
        out = {"return": "GSTR-2B", "period": period_of(d.get("rtnprd")), "gstin": d.get("gstin"), "bills": []}
        for sup in (d.get("docdata") or {}).get("b2b") or []:
            for inv in sup.get("inv") or []:
                items = inv.get("items") or inv.get("itms") or []
                tax = sum(paise(i.get("igst")) + paise(i.get("cgst")) + paise(i.get("sgst")) + paise(i.get("cess")) for i in items)
                out["bills"].append({"gstin": sup.get("ctin"), "name": sup.get("trdnm") or "", "no": inv.get("inum"), "date": day_of(inv.get("dt")),
                                     "value": paise(inv.get("val")), "taxable": sum(paise(i.get("txval")) for i in items), "tax": tax,
                                     "itc": inv.get("itcavl", "Y") != "N" and inv.get("rev", "N") != "Y"})
        return out
    if "sup_details" in d or "itc_elg" in d:
        o = (d.get("sup_details") or {}).get("osup_det") or {}
        net = (d.get("itc_elg") or {}).get("itc_net") or {}
        avl = (d.get("itc_elg") or {}).get("itc_avl") or []
        itc = sum(paise(net.get(k)) for k in ("iamt", "camt", "samt", "csamt")) if net else \
            sum(paise(a.get(k)) for a in avl for k in ("iamt", "camt", "samt", "csamt"))
        return {"return": "GSTR-3B", "period": period_of(d.get("ret_period")), "gstin": d.get("gstin"),
                "taxable": paise(o.get("txval")), "tax": sum(paise(o.get(k)) for k in ("iamt", "camt", "samt", "csamt")), "itc": itc}
    if any(k in d for k in ("b2b", "b2cs", "b2cl", "cdnr", "fp")):
        out = {"return": "GSTR-1", "period": period_of(d.get("fp")), "gstin": d.get("gstin"), "invoices": [], "other": {"taxable": 0, "tax": 0}}
        for rec in d.get("b2b") or []:
            for inv in rec.get("inv") or []:
                dets = [i.get("itm_det") or i for i in inv.get("itms") or []]
                out["invoices"].append({"gstin": rec.get("ctin"), "no": inv.get("inum"), "date": day_of(inv.get("idt")), "value": paise(inv.get("val")),
                                        "taxable": sum(paise(x.get("txval")) for x in dets),
                                        "tax": sum(paise(x.get(k)) for x in dets for k in ("iamt", "camt", "samt", "csamt"))})
        for sec in ("b2cs", "b2cl", "exp"):
            for rec in d.get(sec) or []:
                rows = [rec] if "txval" in rec else [i.get("itm_det") or i for inv in rec.get("inv") or [] for i in inv.get("itms") or []]
                for x in rows:
                    out["other"]["taxable"] += paise(x.get("txval"))
                    out["other"]["tax"] += sum(paise(x.get(k)) for k in ("iamt", "camt", "samt", "csamt"))
        # Credit and debit notes change the month's tax (a credit note lowers it).
        for rec in d.get("cdnr") or []:
            for nt in rec.get("nt") or []:
                sign = -1 if str(nt.get("ntty", "C")).upper() == "C" else 1
                for i in nt.get("itms") or []:
                    x = i.get("itm_det") or i
                    out["other"]["taxable"] += sign * paise(x.get("txval"))
                    out["other"]["tax"] += sign * sum(paise(x.get(k)) for k in ("iamt", "camt", "samt", "csamt"))
        return out
    return None


HEAD = {
    "gstin": ("gstin of supplier", "gstin/uin of recipient", "gstin of recipient", "gstin", "supplier gstin", "ctin"),
    "name": ("trade/legal name", "trade name", "legal name", "receiver name", "supplier name"),
    "no": ("invoice number", "invoice no", "inum", "invoice no."),
    "date": ("invoice date", "invoice dt", "idt"),
    "value": ("invoice value", "invoice value(₹)", "val"),
    "taxable": ("taxable value", "taxable value (₹)", "txval"),
    "igst": ("integrated tax", "integrated tax(₹)", "igst", "integrated tax amount"),
    "cgst": ("central tax", "central tax(₹)", "cgst", "central tax amount"),
    "sgst": ("state/ut tax", "state/ut tax(₹)", "sgst", "state tax"),
    "cess": ("cess", "cess(₹)", "cess amount"),
    "rate": ("rate", "rate (%)"),
    "itc": ("itc availability",),
}


def head_of(cell) -> str | None:
    c = re.sub(r"\s+", " ", str(cell or "").strip().lower())
    c2 = re.sub(r"\s*\(₹\)|\s*\(rs\.?\)|\s*\(%\)", "", c).strip()
    for k, names in HEAD.items():
        if c in names or c2 in names or any(c2 == re.sub(r"\s*\(₹\)", "", n) for n in names):
            return k
    return None


def from_rows(rows: list[list], name: str):
    """A B2B sheet (GSTR-2B or GSTR-1, from Excel or CSV): the header row found by its names, one bill or invoice a row."""
    best, cols = -1, {}
    for i, r in enumerate(rows[:30]):
        found = {}
        for j, c in enumerate(r):
            k = head_of(c)
            if k and k not in found:
                found[k] = j
        if len(found) >= 4 and {"no", "taxable"} <= found.keys() and len(found) > len(cols):
            best, cols = i, found
    if best < 0:
        return None
    two_b = "itc" in cols or "name" in cols or re.search(r"2b|gstr.?2", name, re.I)
    period = None
    m = re.search(r"(0[1-9]|1[0-2])[-_ ]?(20\d{2})", name)
    if m:
        period = f"{m.group(2)}-{m.group(1)}"
    out = []
    for r in rows[best + 1:]:
        get = lambda k: r[cols[k]] if k in cols and cols[k] < len(r) else None  # noqa: E731
        no = get("no")
        if not no or str(no).strip().lower() in ("total", "grand total"):
            continue
        tax = sum(paise(get(k)) for k in ("igst", "cgst", "sgst", "cess"))
        if not tax and "rate" in cols:
            tax = round(paise(get("taxable")) * float(re.sub(r"[^\d.]", "", str(get("rate") or "0")) or 0) / 100)
        out.append({"gstin": str(get("gstin") or "").strip() or None, "name": str(get("name") or ""), "no": str(no).strip(), "date": day_of(get("date")),
                    "value": paise(get("value")), "taxable": paise(get("taxable")), "tax": tax, "itc": str(get("itc") or "Yes").strip().lower() not in ("no", "n")})
    if not out:
        return None
    if not period:
        ms = sorted({x["date"][:7] for x in out if x["date"]})
        period = ms[-1] if ms else None
    if two_b:
        return {"return": "GSTR-2B", "period": period, "gstin": None, "bills": out}
    return {"return": "GSTR-1", "period": period, "gstin": None, "invoices": out, "other": {"taxable": 0, "tax": 0}}


def read_file(path: Path, name: str):
    low = name.lower()
    raw = path.read_bytes()
    if low.endswith(".json") or raw[:1] in (b"{", b"["):
        try:
            d = json.loads(raw.decode("utf-8-sig"))
        except (ValueError, UnicodeDecodeError):
            return None, "It is not a GST portal JSON file."
        docs = d if isinstance(d, list) else [d]
        got = [x for x in (from_json(x, name) for x in docs if isinstance(x, dict)) if x]
        return (got, None) if got else (None, "I could not see a GSTR-1, GSTR-3B or GSTR-2B in it.")
    if low.endswith((".xlsx", ".xlsm")):
        try:
            import openpyxl  # noqa: PLC0415
        except ImportError:
            return None, "Excel needs openpyxl in the sandbox; send the JSON download instead."
        wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        got = []
        for ws in wb.worksheets:
            if not re.search(r"b2b|b2b invoices", ws.title, re.I):
                continue
            r = from_rows([list(x) for x in ws.iter_rows(values_only=True)], f"{name} {ws.title}")
            if r:
                got.append(r)
        return (got, None) if got else (None, "No B2B sheet I could read: send the JSON download from the GST portal.")
    if low.endswith((".csv", ".txt")):
        text = raw.decode("utf-8-sig", errors="replace")
        r = from_rows([row for row in csv.reader(io.StringIO(text))], name)
        return ([r], None) if r else (None, "No B2B columns I could read.")
    return None, "Send the GST portal's JSON (or its Excel) download."


# ----------------------------------------------------------------------------------------------- checking
def main(inp: Path, out: Path) -> int:
    t0 = time.time()
    job = json.loads((inp / "job.json").read_text())
    own = (job.get("gstin") or "").strip().upper() or None
    files_out, returns = [], []
    files = job.get("files") or []
    for n, f in enumerate(files):
        name = f.get("name") or f["path"]
        say(5 + int(40 * n / max(1, len(files))), f"Reading {name}…")
        got, why = read_file(inp / f["path"], name)
        if not got:
            files_out.append({"name": name, "ok": False, "why": why})
            continue
        for g in got:
            if g.get("gstin") and own and str(g["gstin"]).upper() != own:
                g["otherGstin"] = True
            returns.append(g)
            files_out.append({"name": name, "ok": True, "return": g["return"], "period": g.get("period"), "gstin": g.get("gstin")})
    say(50, f"Checking {len(returns)} return{'s' if len(returns) != 1 else ''} against Pulse…")

    g1: dict[str, dict] = {}
    g3: dict[str, dict] = {}
    g2: dict[str, dict] = {}
    for r in returns:
        p = r.get("period")
        if not p:
            continue
        if r["return"] == "GSTR-1":
            e = g1.setdefault(p, {"invoices": {}, "taxable": 0, "tax": 0})
            for i in r["invoices"]:
                e["invoices"][inv_key(i["no"])] = i
                e["taxable"] += i["taxable"]
                e["tax"] += i["tax"]
            e["taxable"] += r["other"]["taxable"]
            e["tax"] += r["other"]["tax"]
        elif r["return"] == "GSTR-3B":
            g3[p] = r
        else:
            e = g2.setdefault(p, {"bills": [], "taxable": 0, "itc": 0})
            for b in r["bills"]:
                e["bills"].append(b)
                e["taxable"] += b["taxable"]
                if b["itc"]:
                    e["itc"] += b["tax"]

    findings = []

    def find(kind, month, what, amount=0, party=None, doc=None, severity="check"):
        findings.append({"kind": kind, "month": month, "what": what[:300], "amountMinor": int(amount), "party": party, "doc": doc, "severity": severity})

    # Pulse's own invoices by month (issued ones; drafts and cancelled never reach a return).
    pulse = defaultdict(dict)
    for i in job.get("invoices") or []:
        d = str(i.get("date") or "")[:10]
        if not i.get("no") or len(d) < 7 or i.get("status") in ("draft", "cancelled"):
            continue
        pulse[d[:7]][inv_key(i["no"])] = i

    # 1. GSTR-1 against Pulse's invoices (B2B: the ones with a buyer GSTIN), only for months that have a GSTR-1.
    for m, e in sorted(g1.items()):
        mine = pulse.get(m, {})
        for k, i in mine.items():
            if not i.get("gstin"):
                continue
            g = e["invoices"].get(k)
            if not g:
                find("invoice_not_in_gstr1", m, f"Invoice {i['no']} ({i.get('client') or 'client'}, {month_words(m)}) is in Pulse but not in that month's GSTR-1.",
                     i.get("gst") or 0, i.get("client"), i["no"], "high")
            else:
                pt = (i.get("cgst") or 0) + (i.get("sgst") or 0) + (i.get("igst") or 0)
                if abs(pt - g["tax"]) > TOL or (i.get("taxable") and abs(int(i["taxable"]) - g["taxable"]) > TOL):
                    find("invoice_mismatch", m, f"Invoice {i['no']}: Pulse has ₹{(i.get('taxable') or 0) / 100:,.2f} taxable and ₹{pt / 100:,.2f} GST; GSTR-1 has ₹{g['taxable'] / 100:,.2f} and ₹{g['tax'] / 100:,.2f}.",
                         abs(pt - g["tax"]), i.get("client"), i["no"], "high")
        if mine:
            for k, g in e["invoices"].items():
                if k not in mine:
                    find("gstr1_not_in_pulse", m, f"GSTR-1 for {month_words(m)} has invoice {g['no']} (₹{g['value'] / 100:,.2f}), which Pulse does not have.",
                         g["tax"], g.get("gstin"), g["no"])

    # 2. GSTR-3B against GSTR-1: output tax declared below what was reported.
    for m in sorted(set(g1) & set(g3)):
        gap = g1[m]["tax"] - g3[m]["tax"]
        if gap > TOL:
            find("gstr1_vs_3b", m, f"{month_words(m)}: GSTR-1 reports ₹{g1[m]['tax'] / 100:,.2f} of GST on sales, GSTR-3B declared ₹{g3[m]['tax'] / 100:,.2f}: ₹{gap / 100:,.2f} less. This is what a DRC-01B notice asks about.",
                 gap, None, None, "high")
        elif gap < -TOL:
            find("gstr3b_above_1", m, f"{month_words(m)}: GSTR-3B declared ₹{-gap / 100:,.2f} more GST on sales than GSTR-1 reports. Check whether invoices are missing from GSTR-1.", -gap)

    # 3. GSTR-3B's input tax credit against GSTR-2B: credit claimed above what suppliers filed.
    for m in sorted(set(g2) & set(g3)):
        over = g3[m]["itc"] - g2[m]["itc"]
        if over > TOL:
            find("itc_over_2b", m, f"{month_words(m)}: GSTR-3B claimed ₹{g3[m]['itc'] / 100:,.2f} of input credit, GSTR-2B shows ₹{g2[m]['itc'] / 100:,.2f}: ₹{over / 100:,.2f} more. This is what a DRC-01C notice asks about.",
                 over, None, None, "high")

    # 4. GSTR-2B bills against the bank payments: each bill paid in full, or less TDS (1, 2 or 10 % of the taxable value).
    pays = []
    for p in job.get("payments") or []:
        try:
            pays.append({"date": date.fromisoformat(str(p["date"])[:10]), "amount": int(p["amount"]), "tokens": name_tokens(f"{p.get('who') or ''} {p.get('narration') or ''}"), "used": False})
        except (KeyError, ValueError, TypeError):
            continue
    unpaid = 0
    if pays:
        for m, e in sorted(g2.items()):
            for b in e["bills"]:
                if not b["itc"] or not b["date"]:
                    continue
                bd = date.fromisoformat(b["date"])
                want = {b["value"]} | {b["value"] - round(b["taxable"] * r) for r in (0.01, 0.02, 0.1)}
                toks = name_tokens(b["name"])
                hit = next((p for p in pays if not p["used"] and -7 <= (p["date"] - bd).days <= 180 and any(abs(p["amount"] - w) <= TOL for w in want)
                            and (not toks or toks & p["tokens"])), None)
                if hit:
                    hit["used"] = True
                    continue
                unpaid += 1
                if unpaid <= 200:
                    find("itc_no_payment", m, f"{b['name'] or b['gstin']}: bill {b['no']} of {b['date']} (₹{b['value'] / 100:,.2f}, GST ₹{b['tax'] / 100:,.2f}) is in GSTR-2B, but I found no payment for it in the bank lines. Credit on a bill unpaid for 180 days has to be reversed.",
                         b["tax"], b["name"] or b["gstin"], b["no"])

    months = sorted(set(g1) | set(g2) | set(g3))
    table = []
    for m in months:
        mine = pulse.get(m, {})
        table.append({"month": m,
                      "gstr1": {"taxable": g1[m]["taxable"], "tax": g1[m]["tax"], "invoices": len(g1[m]["invoices"])} if m in g1 else None,
                      "gstr3b": {"taxable": g3[m]["taxable"], "tax": g3[m]["tax"], "itc": g3[m]["itc"]} if m in g3 else None,
                      "gstr2b": {"taxable": g2[m]["taxable"], "itc": g2[m]["itc"], "bills": len(g2[m]["bills"])} if m in g2 else None,
                      "pulse": {"invoices": len(mine), "tax": sum((i.get("cgst") or 0) + (i.get("sgst") or 0) + (i.get("igst") or 0) for i in mine.values())}})
    sev = {"high": 0, "check": 1}
    findings.sort(key=lambda f: (sev.get(f["severity"], 2), f["month"] or "", -f["amountMinor"]))
    counts = defaultdict(int)
    for f in findings:
        counts[f["kind"]] += 1
    result = {"kind": "gst", "files": files_out, "months": table, "findings": findings[:400], "counts": dict(counts),
              "returns": len(returns), "seconds": round(time.time() - t0, 2),
              "notes": ([] if job.get("payments") else ["There were no bank lines in Pulse to check GSTR-2B's bills against: send the bank statements too."])
              + ([] if job.get("invoices") else ["There are no invoices in Pulse to check GSTR-1 against: send the invoice register."])}
    (out / "result.json").write_text(json.dumps(result))
    say(100, f"Done: {len(returns)} returns, {len(findings)} things to check.")
    return 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1]), Path(sys.argv[2])))
