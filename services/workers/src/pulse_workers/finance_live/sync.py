# ruff: noqa: E501
"""One live finance sync: discover sources in the EA index, read them read-only, file invoice PDFs, store, model.

    python -m pulse_workers.finance_live sync [--org UUID] [--dry-run] [--no-drive] [--no-mail]

Reads: Drive exports (drive.readonly, impersonating the file owner or a Workspace user it is shared with), Gmail PDF
attachments of index-selected finance mail (gmail.readonly), and the index itself. Writes: Pulse finance tables and new
PDFs in the EA Finance Shared Drive (service account, `drive` scope, confined to that drive). No mail is sent and no
source sheet or message is changed. The printed receipt holds counts only.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import warnings
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path

from . import bank, mail, sheets
from .common import HIGH, LOW, MEDIUM, digest, fiscal_year, rupees, similar, stable_hash, tab_month
from .drive import FINANCE_DRIVE, SharedDrive, drive_service, file_name, readonly_drive, readonly_gmail  # noqa: F401

KEY_PATH = "/etc/estate-autopilots/google/indexer-sa.json"
OWN_GSTIN = "27AAXFV2138F1ZR"  # Vikriya Solutions LLP, printed on every sales invoice
HANDOFF = Path.home() / "ea-context/docs/EA-SETUP-HANDOFF.md"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
SHEET = "application/vnd.google-apps.spreadsheet"
SECRET_NAME = re.compile(r"pass(word)?s?\b|id pass|credential", re.I)

# Workbook families recognised by name. The index supplies the file ID, owner and who it is shared with.
FAMILIES = [
    (re.compile(r"^Agency Finance Sheet (\d{4})$", re.I), "agency"),
    (re.compile(r"^expenses (\d{4})$", re.I), "expenses"),
    (re.compile(r"^Revenue Sheet (\d{4})$", re.I), "revenue"),
    (re.compile(r"^Account_Statement_Report_\d{2}-\d{2}-(\d{4})_\d+hrs\.XLSX$", re.I), "statement"),
    (re.compile(r"^Salary & Expenses Details$", re.I), "costs"),
    (re.compile(r"^Salary & Per Task (\d{4})", re.I), "costs"),
    (re.compile(r"^salary & expenses \((\d{4})\)$", re.I), "costs"),
    (re.compile(r"^Daily Expense Tracker - EA$", re.I), "petty"),
    (re.compile(r"^Model & Cinematographer Pay Tracker", re.I), "models"),
    (re.compile(r"^Bank Payment - Vikriya\.xlsx$|^Suspense List\.xlsx$", re.I), "suspense"),
    (re.compile(r"^Per client expenses$", re.I), "packages"),
    (re.compile(r"^Pod \d+ Active Client & Result$|^Active Client \| EA$", re.I), "clients"),
]
SUPPLIER = {
    "agency": "Founders (Agency Finance Sheet)",
    "expenses": "Founders (expense sheets)",
    "revenue": "Founders (revenue sheet)",
    "statement": "Kazuk (Axis Bank statement export)",
    "costs": "Kazuk / HR (monthly cost sheet)",
    "petty": "Shoot coordinator (petty cash tracker)",
    "models": "Shoot coordinator (model pay tracker)",
    "suspense": "CA Pukapafa (Tally suspense ledger)",
    "packages": "Founders (package cost model)",
    "clients": "Pod leads (active client trackers)",
}


class DryRun(Exception):
    """Raised inside the final transaction so a dry run rolls back every write."""


@dataclass
class Result:
    records: dict[str, dict[str, dict]] = field(default_factory=lambda: defaultdict(dict))  # kind -> key -> row
    scopes: set[str] = field(default_factory=set)  # fully re-read scopes, pruned after a successful sync
    sources: dict[str, dict] = field(default_factory=dict)
    pdfs: list[dict] = field(default_factory=list)  # PDFs to file: content, parts, name, key
    ads: list[dict] = field(default_factory=list)
    counts: Counter = field(default_factory=Counter)

    def add(self, kind: str, key: str, body: dict, source: dict, confidence: str, scope: str):
        clean = json.loads(json.dumps(body, default=_json))
        self.records[kind][key] = {
            "kind": kind,
            "key": key,
            "body": clean,
            "source": json.loads(json.dumps(source, default=_json)),
            "confidence": confidence,
            "scope": scope,
            "hash": stable_hash([clean, source]),
        }


def _json(value):
    from decimal import Decimal

    if isinstance(value, Decimal):
        return rupees(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, set):
        return sorted(value)
    raise TypeError(type(value).__name__)


# --- discovery and sheet reading -----------------------------------------------------------------------------------


def discover(index) -> list[dict]:
    users = {
        r["email"] for r in index.execute("select email from ws_user where not coalesce(suspended,false)").fetchall()
    }
    rows = index.execute(
        "select id,name,mime,owner,seen_by,modified,coalesce(trashed,false) trashed from drive_file where mime = any(%s) order by modified desc",
        ([SHEET, XLSX],),
    ).fetchall()
    found = []
    for row in rows:
        if SECRET_NAME.search(row["name"]):
            continue
        for pattern, family in FAMILIES:
            match = pattern.match(row["name"].strip())
            if not match:
                continue
            subject = (
                row["owner"] if row["owner"] in users else next((u for u in row["seen_by"] or [] if u in users), None)
            )
            year = (
                int(match.group(1))
                if match.groups() and match.group(1)
                else (row["modified"].year if row["modified"] else None)
            )
            found.append(
                {
                    "id": row["id"],
                    "name": row["name"].strip(),
                    "mime": row["mime"],
                    "family": family,
                    "subject": subject,
                    "owner": row["owner"],
                    "modified": row["modified"].isoformat() if row["modified"] else None,
                    "year": year,
                    "trashed": row["trashed"],
                }
            )
            break
    return found


def open_workbook(service, meta):
    import openpyxl

    if meta["mime"] == SHEET:
        data = service.files().export(fileId=meta["id"], mimeType=XLSX).execute()
    else:
        data = service.files().get_media(fileId=meta["id"], supportsAllDrives=True).execute()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return openpyxl.load_workbook(io.BytesIO(data), data_only=True, read_only=True)


def people_from_db(conn) -> bank.People:
    founders = [
        r["display_name"]
        for r in conn.execute(
            "select p.display_name from pulse.person p where exists(select 1 from pulse.hr_cofounder c where c.org_id=p.org_id and c.person_id=p.id and c.active) "
            "or exists(select 1 from pulse.people_profile pp where pp.org_id=p.org_id and pp.person_id=p.id and pp.role ~* '(co-?founder|founder|director|\\mceo\\M)')"
        ).fetchall()
    ]
    staff = [
        r["display_name"] for r in conn.execute("select display_name from pulse.person where side='staff'").fetchall()
    ]
    return bank.People(founders=founders, staff=[s for s in staff if s not in founders])


def read_sheets(result: Result, workbooks: list[dict], opener, people: bank.People):
    lines, costs = [], []
    for meta in workbooks:
        scope = "sheet:" + meta["id"]
        if meta.get("trashed"):
            # The owner deleted it; it is listed so a founder can restore it, but it is never read.
            result.sources[scope] = _source(
                meta, "trashed", 0, missing="In the owner's Drive trash; restore it to include its lines"
            )
            continue
        if not meta.get("subject"):
            result.sources[scope] = _source(
                meta, "no access", 0, missing="Owned outside Workspace and not shared with a Workspace user"
            )
            continue
        try:
            wb = opener(meta)
        except Exception as exc:  # noqa: BLE001 - recorded per source; the sync continues
            result.sources[scope] = _source(meta, "error", 0, error=type(exc).__name__)
            result.counts["sheet_errors"] += 1
            continue
        result.scopes.add(scope)
        family, year = meta["family"], meta["year"]
        n = 0
        if family == "statement":
            found, balances = sheets.statement(wb, meta)
            lines += found
            for b in balances:
                result.add(
                    "bank_balance",
                    digest(meta["id"] + b["to"]),
                    b,
                    {"type": "sheet", "fileId": meta["id"], "file": meta["name"]},
                    HIGH,
                    scope,
                )
            n = len(found)
        elif family == "expenses":
            found, totals = sheets.dated_debits(wb, meta, year)
            lines += found
            for t in totals:
                result.add("bank_summary", f"{t['month']}|out|{meta['id']}", t, t["source"], LOW, scope)
            n = len(found)
        elif family in ("revenue", "agency"):
            found = sheets.dated_credits(wb, meta, year)
            monthly, summaries = sheets.monthly_tabs(wb, meta, year)
            lines += found + monthly
            for s in summaries:
                result.add("bank_summary", f"{s['month']}|{s['direction']}|{meta['id']}", s, s["source"], LOW, scope)
            if family == "agency":
                for p in sheets.plan_rows(wb, meta, (meta["modified"] or "")[:10]):
                    p["category"] = _plan_category(p["item"])
                    result.add("plan", digest(json.dumps(p["source"]) + p["item"]), p, p["source"], LOW, scope)
            n = len(found) + len(monthly)
        elif family == "costs":
            for c in sheets.monthly_costs(wb, meta, year):
                c["modified"] = meta["modified"]
                costs.append(c)
                n += 1
        elif family == "petty":
            for e in sheets.petty_cash(wb, meta, year):
                result.add("expense_month", f"petty|{e['month']}", e, e["source"], MEDIUM, scope)
                n += 1
        elif family == "models":
            for e in sheets.month_totals(
                wb, meta, year, label="Production: models & shoot travel", amount_header="total payable"
            ):
                result.add("expense_month", f"models|{e['month']}", e, e["source"], MEDIUM, scope)
                n += 1
        elif family == "suspense":
            for s in sheets.suspense(wb, meta):
                result.add(
                    "suspense",
                    digest(f"{s['date']}|{s['direction']}|{s['amount']}|{s['voucher']}|{s.get('reference')}"),
                    s,
                    s["source"],
                    HIGH,
                    scope,
                )
                n += 1
        elif family == "clients":
            for c in sheets.client_status(wb, meta):
                result.add(
                    "client_status", digest(meta["id"] + c["tab"] + c["client"].lower()), c, c["source"], MEDIUM, scope
                )
                n += 1
        elif family == "packages":
            for p in sheets.package_costs(wb, meta):
                result.add("package_cost", p["package"], p, p["source"], LOW, scope)
                n += 1
        result.sources[scope] = _source(meta, "ok" if n else "empty", n)
    # Monthly cost sheets: for a month in several workbooks, the most recently edited workbook wins.
    best = {}
    for c in sorted(costs, key=lambda c: c["modified"] or ""):
        best[c["month"]] = c
    for c in best.values():
        total = float(c["payroll"]) + sum(float(v) for v in c["items"].values())
        check = round(total / float(c["sheetTotal"]), 4) if c.get("sheetTotal") else None
        confidence = MEDIUM if check is not None and abs(check - 1) <= 0.01 else LOW
        body = {k: v for k, v in c.items() if k not in ("source", "modified")}
        body.update(check=check, confidence=confidence)
        result.add("cost_month", c["month"], body, c["source"], confidence, "sheet:" + c["source"]["fileId"])
    select_bank(result, lines, people)


def select_bank(result: Result, lines: list[dict], people: bank.People):
    """Classify every copy of a bank line, then count one source family per month and direction."""
    rank = {"statement": 3, "dated": 2, "monthly": 1}
    groups = defaultdict(lambda: defaultdict(list))
    for line in lines:
        info = bank.classify(line["direction"], line.get("text", ""), people, line.get("hint"))
        if line["direction"] == "in" and line["amount"] < 10:
            info["category"], info["kind"] = "Verification credits", "unknown"
        if info["reference"] or line.get("date"):
            key = bank.line_key(
                line["direction"],
                line["amount"],
                info["reference"],
                line.get("date"),
                line.get("text") or line.get("hint") or "",
            )
        else:
            # An undated month-tab row has no bank reference: it is its own line (file, tab and row).
            src = line["source"]
            key = digest(f"{line['direction']}|{line['amount']}|{src['fileId']}|{src['sheet']}|{src['row']}")
        if line.get("subkey"):
            key = digest(key + line["subkey"])
        body = {
            "date": line.get("date"),
            "month": line["month"],
            "direction": line["direction"],
            "amount": line["amount"],
            "category": info["category"],
            "counterparty": info["counterparty"],
            "kind": info["kind"],
            "channel": info["channel"],
            "reference": info["reference"],
            "invoices": info["invoices"],
            "family": line["family"],
            "confidence": line["confidence"],
        }
        if line.get("balance") is not None:
            body["balance"] = line["balance"]
        if line.get("package"):
            body["package"] = line["package"]
        groups[(line["month"], line["direction"])][line["family"]].append((key, body, line["source"]))
    for families in groups.values():
        ordered = sorted(families, key=lambda f: -rank[f])
        chosen = ordered[0]
        if chosen == "statement" and len(ordered) > 1:
            days = {b["date"] for _, b, _ in families["statement"] if b.get("date")}
            if len(days) < 10 and len(families[ordered[1]]) > len(families["statement"]):
                chosen = ordered[1]  # a one-week statement export does not replace a full month of sheet lines
        for fam, items in families.items():
            seen = set()
            for key, body, source in items:
                record_key = key[:40] + "|" + fam
                if record_key in seen:
                    continue  # the same line copied into two sheets of one family
                seen.add(record_key)
                body = {**body, "selected": fam == chosen, "basisFamily": chosen}
                result.add("bank_line", record_key, body, source, body["confidence"], "sheet:" + source["fileId"])


def _plan_category(item: str) -> str:
    text = item.lower()
    if re.search(r"rent|maintenance|cleaning|electric", text):
        return "Office & rent"
    if "food" in text:
        return "Food & office supplies"
    if re.search(r"travel", text):
        return "Travel"
    if re.search(r"model", text):
        return "Production & shoots"
    if re.search(r"wifi|wi-fi|sim", text):
        return "Internet & phone"
    return "Software & AI"


def _source(meta, status, count, **extra):
    return {
        "label": meta["name"],
        "kind": "sheet",
        "family": meta["family"],
        "fileId": meta["id"],
        "status": status,
        "records": count,
        "readAs": meta.get("subject"),
        "modified": meta.get("modified"),
        "supplier": SUPPLIER.get(meta["family"]),
        **extra,
    }


# --- handoff tool list -----------------------------------------------------------------------------------------------


def read_handoff(result: Result, path: Path):
    """Owner-reported monthly tools and office costs from the EA setup handoff (2 Oct 2026)."""
    scope = "doc:handoff"
    if not path.exists():
        result.sources[scope] = {
            "label": "EA-SETUP-HANDOFF (tool spend)",
            "kind": "document",
            "status": "missing",
            "records": 0,
            "supplier": "Owner (EA setup handoff)",
        }
        return
    text = path.read_text(errors="ignore")
    match = re.search(r"Monthly tools \(₹\):(.+?)Total about", text, re.S)
    n = 0
    if match:
        block = re.sub(r"\s+", " ", match.group(1))
        for name, amount in re.findall(r"([A-Za-z][A-Za-z .]+?)\s+([\d,]+)\b", block):
            name = name.strip(" ·.").replace("Office: ", "").strip()
            name = re.sub(r"^(about ₹[\d,]+\. )", "", name)
            if not name or name.lower().startswith(("about", "total")):
                continue
            value = float(amount.replace(",", ""))
            category = (
                _plan_category(name)
                if re.search(r"rent|maintenance|cleaning|food|electric|wifi|sim", name, re.I)
                else "Software & AI"
            )
            body = {
                "name": name.title() if name.islower() else name,
                "monthly": value,
                "category": category,
                "cadence": "monthly",
                "asOf": "2026-10-02",
                "basis": "Owner's monthly tool and office list in the EA setup handoff",
            }
            result.add(
                "subscription",
                digest("handoff|" + name.lower()),
                body,
                {"type": "document", "file": path.name, "section": "EA team accounts and tool spend"},
                LOW,
                scope,
            )
            result.add(
                "plan",
                digest("handoff-plan|" + name.lower()),
                {
                    "item": body["name"],
                    "monthly": value,
                    "asOf": "2026-10-02",
                    "category": category,
                    "basis": "Owner's current monthly tool and office budget",
                },
                {"type": "document", "file": path.name},
                LOW,
                scope,
            )
            n += 1
    result.scopes.add(scope)
    result.sources[scope] = {
        "label": "EA-SETUP-HANDOFF (tool spend)",
        "kind": "document",
        "status": "ok" if n else "empty",
        "records": n,
        "supplier": "Owner (EA setup handoff)",
        "modified": datetime.fromtimestamp(path.stat().st_mtime, UTC).isoformat(),
    }


# --- mail ------------------------------------------------------------------------------------------------------------


def read_mail(
    result: Result, index, gmail_for, known_messages: set[str], existing: dict[str, dict], fetch: bool = True
):
    bills, filing_rows = mail.select(index)
    by_mailbox = Counter(b["user_email"] for b in bills)
    # Filings come from headers already in the index; they are recomputed in full on every sync.
    seen = set()
    for row in filing_rows:
        f = mail.filing(row)
        if not f:
            continue
        ident = (f["type"], f["status"], f.get("period") or f["date"][:7], f.get("arn") or f["subject"][:40])
        if ident in seen:
            continue
        seen.add(ident)
        result.add(
            "filing",
            digest(json.dumps(ident)),
            f,
            {"type": "mail-header", "mailbox": row["user_email"], "message": row["id"]},
            HIGH,
            "index:filings",
        )
    result.scopes.add("index:filings")
    result.sources["index:filings"] = {
        "label": "GST, TDS, ITR, PT and LLP notices (mail headers)",
        "kind": "index",
        "status": "ok",
        "records": len(seen),
        "supplier": "GST portal, TDS CPC, Income Tax, CA Pukapafa, CS Jamunegenu",
    }
    invoices = {k: v for k, v in existing.get("invoice", {}).items()}
    new_messages = 0
    for row in bills:
        rule: mail.Rule = row["rule"]
        if row["id"] in known_messages:
            continue
        attachments = []
        if fetch:
            try:
                attachments = _attachments(gmail_for(row["user_email"]), row["id"])
            except Exception as exc:  # noqa: BLE001
                result.counts["mail_errors"] += 1
                result.counts["mail_error_" + type(exc).__name__] += 1
                continue
        new_messages += 1
        sent = row["sent_at"].date().isoformat()
        if rule.kind == "sales":
            for part, content in attachments:
                try:
                    parsed = mail.zoho_invoice(mail.pdf_text(content), OWN_GSTIN)
                except Exception:  # noqa: BLE001 - unreadable PDFs are proposals or scans; never invoices here
                    continue
                if not parsed["number"]:
                    continue  # proposal, agreement or package PDF attached to the invoice mail
                number = "INV-{:08d}".format(int(re.sub(r"\D", "", parsed["number"])))
                test = int(re.sub(r"\D", "", parsed["number"])) < 1000 or re.search(
                    r"testing", parsed.get("client") or "", re.I
                )
                pdf_key = digest(content)
                source = {
                    "type": "mail",
                    "mailbox": row["user_email"],
                    "message": row["id"],
                    "attachment": part,
                    "sent": sent,
                    "pdf": pdf_key,
                }
                previous = invoices.get(number)
                versions = sorted(set((previous or {}).get("body", {}).get("versions", []) + [pdf_key]))
                messages = sorted(set((previous or {}).get("body", {}).get("messages", []) + [row["id"]]))
                if previous and previous["source"].get("sent", "") > sent:
                    body, source = {**previous["body"], "versions": versions, "messages": messages}, previous["source"]
                else:
                    body = {
                        **parsed,
                        "number": number,
                        "rawNumber": parsed["number"],
                        "versions": versions,
                        "messages": messages,
                        "test": bool(test),
                        "mailDate": sent,
                    }
                    if previous and previous["body"].get("drive") and previous["source"].get("pdf") == pdf_key:
                        body["drive"] = previous["body"]["drive"]
                result.add("invoice", number, body, source, parsed["confidence"], "mail:sales")
                invoices[number] = result.records["invoice"][number]
                result.pdfs.append(
                    {
                        "content": content,
                        "key": pdf_key,
                        "category": "Sales invoices",
                        "date": parsed["date"] or sent,
                        "party": parsed.get("client"),
                        "amount": parsed.get("total"),
                        "number": number,
                        "record": ("invoice", number),
                    }
                )
        else:
            parsed_any = None
            for part, content in attachments:
                try:
                    parsed = mail.bill(mail.pdf_text(content), OWN_GSTIN)
                    parsed["basis"] = "pdf"
                except Exception as exc:  # noqa: BLE001
                    parsed = {
                        "total": None,
                        "currency": "INR",
                        "invoiceNo": None,
                        "date": None,
                        "confidence": LOW,
                        "basis": "pdf-unreadable",
                        "issue": "Encrypted or scanned PDF; amount needs manual entry"
                        if "ncrypt" in str(exc)
                        else "PDF text not readable",
                    }
                pdf_key = digest(content)
                if parsed_any is None or (parsed_any["total"] is None and parsed["total"] is not None):
                    parsed_any = {**parsed, "pdf": pdf_key, "part": part}
                result.pdfs.append(
                    {
                        "content": content,
                        "key": pdf_key,
                        "category": "Purchase invoices",
                        "date": parsed.get("date") or sent,
                        "party": rule.vendor,
                        "amount": parsed.get("total"),
                        "number": parsed.get("invoiceNo"),
                        "record": ("bill", row["id"]),
                    }
                )
            if parsed_any is not None and parsed_any.get("total") is None:
                amount, currency = mail.snippet_amount(row["snippet"] or "")
                if amount is not None:
                    parsed_any.update(
                        total=amount, currency=currency, amountBasis="mail snippet (PDF unreadable)", confidence=MEDIUM
                    )
            if parsed_any is None:
                amount, currency = mail.snippet_amount(row["snippet"] or "")
                parsed_any = {
                    "total": amount,
                    "currency": currency,
                    "invoiceNo": None,
                    "date": None,
                    "confidence": LOW if amount is None else MEDIUM,
                    "basis": "mail-header",
                    "part": None,
                }
            body = {
                "vendor": rule.vendor,
                "category": rule.category,
                "cadence": rule.cadence,
                "mailDate": sent,
                "subject": row["subject"][:120],
                **{k: v for k, v in parsed_any.items() if k not in ("confidence", "part")},
            }
            result.add(
                "bill",
                row["id"],
                body,
                {
                    "type": "mail",
                    "mailbox": row["user_email"],
                    "message": row["id"],
                    "attachment": parsed_any.get("part"),
                    "sent": sent,
                },
                parsed_any["confidence"],
                "mail:" + rule.vendor,
            )
    for vendor in sorted({b["rule"].vendor for b in bills}):
        key = "mail:" + vendor
        count = len([b for b in bills if b["rule"].vendor == vendor])
        result.sources[key] = {
            "label": vendor + (" invoices" if vendor.startswith("Zoho Invoice") else " bills"),
            "kind": "mail",
            "status": "ok",
            "records": count,
            "supplier": vendor,
            "mailboxes": sorted({b["user_email"] for b in bills if b["rule"].vendor == vendor}),
        }
    result.counts["mail_selected"] = len(bills)
    result.counts["mail_fetched"] = new_messages
    result.counts.update({"mailbox_" + k.split("@")[0]: v for k, v in by_mailbox.items()})


def _attachments(gmail, message_id: str):
    msg = (
        gmail.users()
        .messages()
        .get(
            userId="me",
            id=message_id,
            format="full",
            fields="id,payload(parts,mimeType,filename,body/attachmentId,body/size)",
        )
        .execute()
    )
    found = []

    def walk(part):
        name = (part.get("filename") or "").lower()
        body = part.get("body") or {}
        if (part.get("mimeType") == "application/pdf" or name.endswith(".pdf")) and body.get("attachmentId"):
            if (body.get("size") or 0) <= 10 * 1024 * 1024:
                found.append((part.get("filename") or "attachment.pdf", body["attachmentId"]))
        for child in part.get("parts") or []:
            walk(child)

    walk(msg.get("payload") or {})
    out = []
    for name, attachment_id in found:
        data = (
            gmail.users()
            .messages()
            .attachments()
            .get(userId="me", messageId=message_id, id=attachment_id)
            .execute()["data"]
        )
        content = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
        if content.startswith(b"%PDF-"):
            out.append((name[:120], content))
    return out


def read_meta(result: Result, index):
    receipts, counts = mail.meta_receipts(index)
    monthly = defaultdict(lambda: {"amount": 0.0, "receipts": 0, "accounts": set(), "funds": 0.0, "billed": 0.0})
    for r in receipts:
        key = (r["day"][:7], r["currency"])
        m = monthly[key]
        m["amount"] += float(r["amount"])
        m["receipts"] += 1
        m["accounts"].add(r["accountId"])
        m[r["kind"]] += float(r["amount"])
    for (month, currency), m in monthly.items():
        body = {
            "month": month,
            "currency": currency,
            "amount": round(m["amount"], 2),
            "receipts": m["receipts"],
            "accounts": len(m["accounts"]),
            "funds": round(m["funds"], 2),
            "billed": round(m["billed"], 2),
        }
        result.add(
            "ad_spend_month",
            f"{month}|{currency}",
            body,
            {"type": "index", "senders": "Meta receipts", "receipts": m["receipts"]},
            MEDIUM,
            "index:meta",
        )
    result.scopes.add("index:meta")
    result.ads = receipts
    result.sources["index:meta"] = {
        "label": "Meta ad payment receipts (index)",
        "kind": "index",
        "status": "ok",
        "records": len(receipts),
        "supplier": "Meta (receipts to EA mailboxes)",
        "detail": counts,
    }


# --- storage ---------------------------------------------------------------------------------------------------------


def load_existing(conn) -> dict[str, dict]:
    out = defaultdict(dict)
    for row in conn.execute(
        "select kind,key,body,source,confidence,scope,hash from pulse_priv.finance_live_record"
    ).fetchall():
        out[row["kind"]][row["key"]] = dict(row)
    return out


def store(conn, org, run_id, result: Result, existing) -> dict:
    from psycopg.types.json import Jsonb

    changed = inserted = pruned = 0
    for kind, rows in result.records.items():
        for key, r in rows.items():
            old = existing.get(kind, {}).get(key)
            if old and old["hash"] == r["hash"]:
                continue
            conn.execute(
                "insert into pulse_priv.finance_live_record(org_id,kind,key,scope,body,source,hash,confidence,run_id) values(%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "on conflict(org_id,kind,key) do update set scope=excluded.scope,body=excluded.body,source=excluded.source,hash=excluded.hash,"
                "confidence=excluded.confidence,run_id=excluded.run_id,changed_at=now() where finance_live_record.hash<>excluded.hash",
                (org, kind, key, r["scope"], Jsonb(r["body"]), Jsonb(r["source"]), r["hash"], r["confidence"], run_id),
            )
            inserted += old is None
            changed += old is not None
    for scope in result.scopes:
        keep = [
            f"{kind}\x1f{key}"
            for kind, rows in result.records.items()
            for key, r in rows.items()
            if r["scope"] == scope
        ]
        pruned += conn.execute(
            "delete from pulse_priv.finance_live_record where scope=%s and not (kind||chr(31)||key = any(%s))",
            (scope, keep),
        ).rowcount
    for key, body in result.sources.items():
        conn.execute(
            "insert into pulse_priv.finance_live_source(org_id,key,body,synced_at) values(%s,%s,%s,now()) "
            "on conflict(org_id,key) do update set body=excluded.body,synced_at=now()",
            (org, key, Jsonb(json.loads(json.dumps(body, default=_json)))),
        )
    return {"inserted": inserted, "changed": changed, "pruned": pruned}


def store_ads(conn, org, receipts):
    accounts = {}
    for r in receipts:
        accounts.setdefault(r["accountId"], r["accountName"])
    for account_id, name in accounts.items():
        conn.execute(
            "insert into pulse_priv.ad_account(org_id,account_id,name,match_method,confidence) values(%s,%s,%s,'receipt name',0.3) "
            "on conflict(org_id,account_id) do update set name=coalesce(nullif(excluded.name,''),ad_account.name) where not ad_account.manual",
            (org, account_id, name or "Meta ad account " + account_id),
        )
    n = 0
    for r in receipts:
        n += conn.execute(
            "insert into pulse_priv.ad_funding(org_id,txn_key,account_id,kind,day,amount,currency,source_ref) values(%s,%s,%s,%s,%s,%s,%s,%s) "
            "on conflict(org_id,txn_key) do nothing",
            (
                org,
                r["txn"][:120],
                r["accountId"],
                r["kind"],
                r["day"],
                r["amount"],
                r["currency"],
                "mail:" + digest(r["mailbox"] + r["message"])[:24],
            ),
        ).rowcount
    return {"accounts": len(accounts), "newReceipts": n}


def merge(existing: dict[str, dict], result: Result) -> dict[str, dict[str, dict]]:
    """Fully re-read scopes come from this sync only; append-only mail scopes keep earlier records."""
    out = defaultdict(dict)
    for kind, rows in existing.items():
        for key, row in rows.items():
            if row["scope"] not in result.scopes:
                out[kind][key] = row
    for kind, rows in result.records.items():
        out[kind].update(rows)
    return out


def file_pdfs_each(conn, org, drive: SharedDrive | None, result: Result, filed: dict[str, dict], tenant_tx):
    """Filing commits each PDF's ledger row on its own, so an interrupted sync resumes without duplicates."""

    class PerFile:
        def execute(self, sql, params):
            with tenant_tx(conn, org):
                return conn.execute(sql, params)

    return file_pdfs(PerFile(), org, drive, result, filed)


SKELETON = (
    "Sales invoices",
    "Purchase invoices",
    "Bank statements",
    "Payroll",
    "GST",
    "TDS",
    "Compliance",
    "Income tax",
    "Close packs",
)


def skeleton(drive: SharedDrive, today: date) -> int:
    """The folder skeleton for the current financial year, so the CA and founders find every category in place."""
    year = fiscal_year(today.isoformat())
    for category in SKELETON:
        drive.path([year, category])
    return len(SKELETON)


def file_pdfs(conn, org, drive: SharedDrive | None, result: Result, filed: dict[str, dict]):
    """File each distinct invoice PDF once: FY…/<category>/<YYYY-MM>/YYYY-MM-DD_Party_Amount_Number.pdf."""
    done = Counter()
    if drive is not None:
        done["skeleton"] = skeleton(drive, datetime.now(UTC).date())
    unique = {}
    for p in result.pdfs:
        unique.setdefault(p["key"], p)
    used_names = defaultdict(set)
    for row in filed.values():
        used_names[row["path"]].add(row["name"])
    for key, p in sorted(unique.items(), key=lambda kv: kv[1]["date"] or ""):
        if key in filed:
            link = filed[key]
            done["already"] += 1
        elif drive is None:
            done["skipped"] += 1
            continue
        else:
            day = (
                p["date"]
                if p["date"] and re.match(r"\d{4}-\d{2}-\d{2}$", p["date"])
                else datetime.now(UTC).date().isoformat()
            )
            parts = [fiscal_year(day), p["category"], day[:7]]
            path = "/".join(parts)
            name = file_name(day, p["party"], p["amount"], p["number"])
            if name in used_names[path]:
                name = name[:-4] + "_" + key[:10] + ".pdf"
            made = drive.put(parts, name, p["content"], key)
            used_names[path].add(name)
            conn.execute(
                "insert into pulse_priv.finance_live_filed(org_id,key,drive_id,file_id,path,name) values(%s,%s,%s,%s,%s,%s) on conflict do nothing",
                (org, key, drive.drive, made["id"], path, name),
            )
            link = {"file_id": made["id"], "path": path, "name": name}
            filed[key] = link
            done["created" if made["created"] else "found"] += 1
        kind, rec_key = p["record"]
        record = result.records.get(kind, {}).get(rec_key)
        if record is not None and (
            record["body"].get("pdf") == key
            or record["source"].get("pdf") == key
            or kind == "invoice"
            and record["source"].get("pdf") == key
        ):
            record["body"]["drive"] = {
                "id": link["file_id"],
                "path": "EA Finance/" + link["path"],
                "name": link["name"],
            }
            record["hash"] = stable_hash([record["body"], record["source"]])
    return dict(done)


# --- CA desk registers -----------------------------------------------------------------------------------------------


def desk_rows(records: dict[str, list[dict]], m: dict) -> dict[str, dict[str, dict]]:
    out = defaultdict(dict)
    paid = {i["number"]: i for i in m["collections"]["invoices"]}
    for inv in records.get("invoice", []):
        if inv.get("test") or not inv.get("number"):
            continue
        status = paid.get(inv["number"], {}).get("status")
        out["sales"][inv["number"]] = {
            "origin": "finance-live",
            "date": inv.get("date"),
            "vendor": inv.get("client"),
            "invoiceNo": inv["number"],
            "taxable": inv.get("taxable"),
            "cgst": inv.get("cgst"),
            "sgst": inv.get("sgst"),
            "igst": inv.get("igst"),
            "total": inv.get("total"),
            "currency": "INR",
            "clientGSTIN": inv.get("clientGstin"),
            "status": status,
            "drive": (inv.get("drive") or {}).get("path"),
            # ERP-INVOICE: an invoice issued in Pulse names its ERP document; a Zoho invoice its mail.
            "source": (
                {"system": "pulse-erp", "documentId": inv["source"].get("documentId")}
                if inv["source"].get("type") == "pulse-erp"
                else {
                    "mailbox": inv["source"]["mailbox"],
                    "message": inv["source"]["message"],
                    "attachment": inv["source"].get("attachment"),
                }
            ),
            "confidence": inv.get("confidence"),
        }
    for b in records.get("bill", []):
        if b.get("basis") not in ("pdf", "pdf-unreadable"):
            continue
        out["purchase"][b["key"]] = {
            "origin": "finance-live",
            "date": b.get("date") or b.get("mailDate"),
            "vendor": b["vendor"],
            "vendorGSTIN": b.get("vendorGstin"),
            "ourGSTINPresent": b.get("ourGstinPresent"),
            "invoiceNo": b.get("invoiceNo"),
            "taxable": b.get("taxable"),
            "cgst": b.get("cgst"),
            "sgst": b.get("sgst"),
            "igst": b.get("igst"),
            "gst": b.get("gst"),
            "total": b.get("total"),
            "currency": b.get("currency"),
            "inr": b.get("total") if b.get("currency") == "INR" else None,
            "status": "extracted" if b.get("total") is not None else "review",
            "drive": (b.get("drive") or {}).get("path"),
            "source": {
                "mailbox": b["source"]["mailbox"],
                "message": b["source"]["message"],
                "attachment": b["source"].get("attachment"),
            },
        }
    for p in m["payroll"]:
        if p.get("people"):
            out["payroll"]["payout:" + p["month"]] = {
                "origin": "finance-live",
                "month": p["month"],
                "name": "All staff (monthly total)",
                "kind": "monthly payout",
                "amount": p["total"],
                "currency": "INR",
                "components": f"{p['people']} people",
                "basis": p["basis"],
            }
    for v in m["expenses"]["vendors"][:60]:
        monthly = (
            v["lastAmount"]
            if v["cadence"] == "monthly"
            else round(v["lastAmount"] / 12, 2)
            if v["cadence"] == "annual" and v["lastAmount"]
            else None
        )
        out["vendor"][digest(v["vendor"])[:32]] = {
            "origin": "finance-live",
            "vendor": v["vendor"],
            "owner": "Owner required",
            "monthlyCost": monthly,
            "currency": v["currency"],
            "nextRenewal": v["nextRenewal"],
            "priceChange": v["priceChange"],
            "recurring": v["cadence"] in ("monthly", "annual"),
            "basis": v["renewalBasis"] or "Bills and bank debits",
        }
    for a in m["anomalies"]:
        out["exception"]["anomaly:" + a["kind"]] = {
            "origin": "finance-live",
            "type": a["kind"].replace("_", " "),
            "key": a["title"],
            "issues": [a["text"], "Who: " + a["who"]],
        }
    for i in m["collections"]["overdue"]["top"]:
        if i["status"] == "unpaid":
            out["exception"]["unpaid:" + i["number"]] = {
                "origin": "finance-live",
                "type": "invoice without payment",
                "key": i["number"],
                "issues": [f"{i['client']}: due {i['due']}, no matching bank credit"],
            }
    for s in m["suspense"][:80]:
        out["exception"]["suspense:" + digest(json.dumps(s, sort_keys=True))[:24]] = {
            "origin": "finance-live",
            "type": "suspense entry",
            "key": f"{s['date']} {s['direction']} {s['amount']}",
            "issues": [s.get("nature") or "No explanation recorded"],
        }
    return out


def store_desk(conn, rows: dict[str, dict[str, dict]]) -> dict:
    from psycopg.types.json import Jsonb

    counts = Counter()
    for kind in ("sales", "purchase", "payroll", "vendor", "exception"):
        for key, body in rows.get(kind, {}).items():
            changed = conn.execute(
                "select pulse.finance_desk_live_put(%s,%s,%s) changed",
                (kind, key, Jsonb(json.loads(json.dumps(body, default=_json)))),
            ).fetchone()["changed"]
            counts[kind + ("_changed" if changed else "_same")] += 1
        counts[kind + "_pruned"] = conn.execute(
            "select pulse.finance_desk_live_prune(%s,%s) n", (kind, list(rows.get(kind, {})))
        ).fetchone()["n"]
    return dict(counts)


def flat(records_by_kind: dict[str, dict[str, dict]]) -> dict[str, list[dict]]:
    out = defaultdict(list)
    for kind, rows in records_by_kind.items():
        for key, r in rows.items():
            out[kind].append({**r["body"], "key": key, "source": r["source"], "confidence": r["confidence"]})
    return out


def link_clients(conn, m: dict):
    known = [(r["id"], r["display_name"]) for r in conn.execute("select id,display_name from pulse.client").fetchall()]
    for row in m["revenue"]["clients"]:
        best = max(known, key=lambda k: similar(row["client"], k[1]), default=None)
        if best and similar(row["client"], best[1]) >= 0.8:
            row["clientId"] = str(best[0])


def tab_year(title: str, fallback: int) -> int:
    month = tab_month(title, fallback)
    return int(month[:4]) if month else fallback


def env_path(name: str, default: Path) -> Path:
    return Path(os.environ.get(name) or default)
