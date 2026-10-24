"""RF1 fixture finance agent. No live mailbox, credential, bank or outbound provider access.

Run through ea-heavy: python -m pulse_workers.finance_desk --output DIR [--org UUID].
An org imports synthetic evidence into Pulse. All provider ports remain fixture sinks until
the owner supplies finance-bot, a Finance root, bank formats and a Zoho Books client.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import re
import zipfile
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from email.utils import parseaddr
from pathlib import Path
from zoneinfo import ZoneInfo

from psycopg.types.json import Jsonb
from pypdf import PdfReader
from pypdf.errors import PdfReadError

CATEGORIES = (
    "Purchase invoices",
    "Sales invoices",
    "Bank statements",
    "Payroll",
    "GST",
    "TDS",
    "Compliance",
    "Income tax",
)
CA = "user-7b81126a@gmail.com"
CS = {"user-610c5a46@gmail.com", "user-a64fb393@gmail.com", "user-d8b39a58@gmail.com"}
SUBJECT = re.compile(
    r"\b(invoices?|receipts?|bills?|statements?|GST|GSTR[- ]?(?:1|3B)|ITR|TDS|ARN|"
    r"Form\s*(?:8|11)|payroll|salary|subscriptions?|renewals?)\b",
    re.I,
)
REGISTER_FIELDS = [
    "key",
    "vendor",
    "vendorGSTIN",
    "ourGSTINPresent",
    "invoiceNo",
    "date",
    "taxable",
    "cgst",
    "sgst",
    "igst",
    "total",
    "currency",
    "inr",
    "rbiRate",
    "rateDate",
    "rateSource",
]


def digest(value: bytes | str) -> str:
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def csv_bytes(rows: list[dict], fields: list[str]) -> bytes:
    out = io.StringIO(newline="")
    writer = csv.DictWriter(out, fields, extrasaction="ignore")
    writer.writeheader()
    # Prevent formulas when the CA opens an exported register in a spreadsheet.
    for row in rows:
        row = {k: json.dumps(v) if isinstance(v, (dict, list)) else v for k, v in row.items()}
        if isinstance(row.get("ourGSTINPresent"), bool):
            row["ourGSTINPresent"] = "yes" if row["ourGSTINPresent"] else "no"
        writer.writerow(
            {
                k: "'" + v if isinstance(v, str) and v.startswith(("=", "+", "-", "@")) else v
                for k, v in row.items()
                if k in fields
            }
        )
    return out.getvalue().encode()


def finance_mail(header: dict, config: dict) -> bool:
    """Call before fetching any body or attachment, including marketing mail."""
    sender = parseaddr(header.get("sender", ""))[1].lower()
    return (
        header.get("mailbox") in {config["billingMailbox"], "marketing@estateautopilots.com"}
        and sender in config["senders"]
        and bool(SUBJECT.search(header.get("subject", "")))
        and not re.search(r"\b(OTP|one[- ]time password|verification code)\b", header.get("subject", ""), re.I)
    )


def read_finance_mail(provider, config: dict) -> list[dict]:
    if config.get("mode") != "fixture" and not (
        config.get("mode") == "live"
        and config.get("financeBotExists") is True
        and config.get("billingMailbox") == "finance-bot@estateautopilots.com"
    ):
        raise ValueError("Live intake requires the owner finance-bot and provider setup; fixture mode only")
    selected = []
    for header in provider.headers():
        if finance_mail(header, config):
            selected.append({**header, **provider.content(header["id"])})
    return selected


def finance_category(subject: str) -> str:
    if re.search(r"\b(sales invoices?)\b|INV-000031\d+", subject, re.I):
        return "Sales invoices"
    if re.search(r"\b(invoices?|receipts?|bills?)\b", subject, re.I):
        return "Purchase invoices"
    if re.search(r"\b(statements?)\b", subject, re.I):
        return "Bank statements"
    if re.search(r"\b(payroll|salary)\b", subject, re.I):
        return "Payroll"
    if re.search(r"\bForm\s*(8|11)\b", subject, re.I):
        return "Compliance"
    if re.search(r"\bITR\b", subject, re.I):
        return "Income tax"
    if re.search(r"\bTDS\b", subject, re.I):
        return "TDS"
    if re.search(r"\b(GST|GSTR|ARN)", subject, re.I):
        return "GST"
    return "Purchase invoices"


class FixtureMail:
    def __init__(self, messages):
        self.messages = messages
        self.reads = []

    def headers(self):
        return [{k: m[k] for k in ("id", "mailbox", "sender", "subject")} for m in self.messages]

    def content(self, key):
        self.reads.append(key)
        return next(m for m in self.messages if m["id"] == key)


class FinanceDrive:
    """All mutations pass this boundary. IDs must belong to the configured root.

    The port resolves ancestry from authoritative metadata, never from a caller's path.
    A live adapter must implement the same port with Drive `drive` scope; prefer the
    service account on the Shared Drive. No drive.file dependency and no scope probe.
    """

    def __init__(self, port, root_id: str):
        if not root_id:
            raise ValueError("Finance folder ID required")
        self.port, self.root = port, root_id

    def confined(self, folder_id: str) -> None:
        seen = set()
        current = folder_id
        while current != self.root:
            if current in seen or len(seen) >= 20:
                raise ValueError("Write outside Finance root rejected")
            seen.add(current)
            parents = self.port.parents(current)
            if len(parents) != 1:
                raise ValueError("Write outside Finance root rejected")
            current = parents[0]
        # A shared-drive ID is not a folder; the port must confirm this root is a folder.
        if not self.port.is_folder(self.root):
            raise ValueError("Finance root must be a folder")

    def write(self, folder_id: str, name: str, content: bytes, mime: str, key: str) -> str:
        self.confined(folder_id)
        if "/" in name or "\\" in name or name in (".", "..") or not name:
            raise ValueError("Unsafe Finance filename")
        return self.port.write(folder_id, name, content, mime, key)

    def folder(self, parent_id: str, name: str) -> str:
        self.confined(parent_id)
        if "/" in name or "\\" in name or name in (".", "..") or not name:
            raise ValueError("Unsafe Finance folder")
        return self.port.folder(parent_id, name)

    def path(self, parts: list[str]) -> str:
        parent = self.root
        for name in parts:
            parent = self.folder(parent, name)
        return parent


class FixtureDrive:
    """A synthetic Shared Drive rooted at one output directory, with durable write keys."""

    def __init__(self, output: Path):
        self.output = output.resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.paths = {"fixture-finance-root": self.output}
        self.ancestry = {"fixture-finance-root": []}
        self.writes = []

    def parents(self, key):
        return self.ancestry.get(key, [])

    def is_folder(self, key):
        return key in self.paths

    def folder(self, parent, name):
        key = digest(parent + "/" + name)
        path = (self.paths[parent] / name).resolve()
        if not path.is_relative_to(self.output):
            raise ValueError("Write outside Finance root rejected")
        path.mkdir(exist_ok=True)
        self.paths[key], self.ancestry[key] = path, [parent]
        return key

    def write(self, parent, name, content, mime, key):
        target = self.paths[parent] / name
        if target.is_symlink() or not target.resolve().is_relative_to(self.output):
            raise ValueError("Write outside Finance root rejected")
        if target.exists() and target.read_bytes() != content and not key.startswith("sheet:"):
            raise ValueError("Immutable Finance artifact changed")
        target.write_bytes(content)
        artifact_key = key + ":" + digest(content) if key.startswith("sheet:") else key
        self.writes.append(
            {
                "key": artifact_key,
                "path": str(target.relative_to(self.output)),
                "mime": mime,
                "name": name,
                "data": base64.b64encode(content).decode(),
            }
        )
        return key


def pdf_text(content: bytes) -> str:
    if len(content) > 10 * 1024 * 1024 or not content.startswith(b"%PDF-"):
        raise ValueError("Invoice must be a PDF under 10 MB")
    pdf = PdfReader(io.BytesIO(content))
    if len(pdf.pages) > 100 or pdf.is_encrypted:
        raise ValueError("Invoice needs manual extraction")
    return "\n".join(page.extract_text() or "" for page in pdf.pages)


def extract_invoice(content: bytes, own_gstin: str, rates: dict) -> dict:
    """Fixture extractor: unsupported layouts/scans are filed and explicitly quarantined."""
    text = pdf_text(content)
    fields = {}
    for key, pattern in {
        "vendor": r"Vendor:\s*([^\n]+)",
        "vendorGSTIN": r"Vendor GSTIN:\s*([A-Z0-9]{15})",
        "invoiceNo": r"Invoice No:\s*([^\n]+)",
        "date": r"Date:\s*(\d{4}-\d{2}-\d{2})",
        "currency": r"Currency:\s*([A-Z]{3})",
        "taxable": r"Taxable:\s*([\d.]+)",
        "cgst": r"CGST:\s*([\d.]+)",
        "sgst": r"SGST:\s*([\d.]+)",
        "igst": r"IGST:\s*([\d.]+)",
        "total": r"Total:\s*([\d.]+)",
    }.items():
        match = re.search(pattern, text)
        fields[key] = match.group(1).strip() if match else None
    fields["ourGSTINPresent"] = bool(own_gstin and re.search(r"\b" + re.escape(own_gstin) + r"\b", text))
    issues = ["Missing " + k for k, v in fields.items() if v is None and k != "vendorGSTIN"]
    if not own_gstin:
        issues.append("Company GSTIN has not been configured")
    if fields["date"]:
        date.fromisoformat(fields["date"])
    if all(fields[k] is not None for k in ("taxable", "cgst", "sgst", "igst", "total")):
        values = [Decimal(fields[k]) for k in ("taxable", "cgst", "sgst", "igst", "total")]
        if any(v < 0 or v.as_tuple().exponent < -2 for v in values) or sum(values[:4]) != values[4]:
            issues.append("Invoice tax arithmetic does not balance")
    rate = rates.get(fields.get("date", "") + ":" + (fields.get("currency") or ""))
    if fields.get("currency") == "INR":
        rate = {"rate": "1", "source": "INR identity"}
    fields.update(inr=None, rbiRate=None, rateDate=fields["date"], rateSource=None)
    if rate and (fields["currency"] == "INR" or rate.get("source", "").startswith("RBI:")) and fields["total"]:
        if Decimal(rate["rate"]) <= 0:
            raise ValueError("Reference rate must be positive")
        fields.update(
            rbiRate=rate["rate"],
            rateSource=rate["source"],
            inr=str((Decimal(fields["total"]) * Decimal(rate["rate"])).quantize(Decimal(".01"), ROUND_HALF_UP)),
        )
    elif fields["currency"] != "INR":
        issues.append("RBI reference rate for invoice date unavailable; no invented FX")
    return {**fields, "issues": issues, "status": "quarantine" if issues else "extracted"}


def fiscal_year(day: str) -> str:
    d = date.fromisoformat(day)
    year = d.year if d.month >= 4 else d.year - 1
    return f"FY{year}-{str(year + 1)[2:]}"


def safe_name(value) -> str:
    return re.sub(r"[^\w.-]+", "_", str(value or "Unknown"), flags=re.ASCII).strip("._")[:100] or "Unknown"


def reconcile(invoices: list[dict], movements: list[dict]) -> dict:
    """Only reciprocal unique exact matches. Duplicate references remain exceptions."""
    matched = []

    def candidates(invoice):
        return [
            m
            for m in movements
            if invoice.get("status") == "extracted"
            and invoice.get("invoiceNo")
            and m["reference"] == invoice["invoiceNo"]
            and m["vendor"].casefold() == invoice["vendor"].casefold()
            and m["currency"] == invoice["currency"]
            and Decimal(m["amount"]) == Decimal(invoice["total"])
            and m["direction"] == ("inflow" if invoice.get("kind") == "sales" else "outflow")
            and abs((date.fromisoformat(m["date"]) - date.fromisoformat(invoice["date"])).days) <= 45
        ]

    pairs = [(i, candidates(i)) for i in invoices]
    for invoice, hits in pairs:
        if len(hits) == 1 and sum(hits[0] in cs for _, cs in pairs) == 1:
            matched.append(
                {
                    "invoice": invoice["key"],
                    "payment": hits[0]["key"],
                    "amount": hits[0]["amount"],
                    "currency": hits[0]["currency"],
                    "basis": "Exact reference/vendor/currency/amount, 45-day window",
                }
            )
    used_i = {m["invoice"] for m in matched}
    used_p = {m["payment"] for m in matched}
    exceptions = [
        {"type": "payment_without_invoice", "key": m["key"]}
        for m in movements
        if m["direction"] == "outflow" and m["key"] not in used_p
    ]
    exceptions += [{"type": "invoice_without_payment", "key": i["key"]} for i in invoices if i["key"] not in used_i]
    exceptions += [
        {"type": "missing_our_gstin", "key": i["key"]} for i in invoices if not i.get("ourGSTINPresent", False)
    ]
    exceptions += [
        {"type": "extraction_review", "key": i["key"], "issues": i["issues"]} for i in invoices if i.get("issues")
    ]
    return {
        "matches": matched,
        "exceptions": exceptions,
        "debits": sum(m["direction"] == "outflow" for m in movements),
        "invoices": len(invoices),
        "coverage": "Uploaded statements only; missing bank periods remain a risk",
    }


def bank_csv(content: bytes, bank: str) -> list[dict]:
    """Named bank adapters require owner samples; fixture CSV uses explicit normalized fields."""
    reader = csv.DictReader(io.StringIO(content.decode("utf-8-sig")))
    expected = {"id", "date", "vendor", "reference", "amount", "currency", "direction"}
    if not expected.issubset(set(reader.fieldnames or [])):
        raise ValueError("Statement format unsupported; retain file for manual review")
    rows = []
    ids = set()
    for row in reader:
        date.fromisoformat(row["date"])
        amount = Decimal(row["amount"])
        if amount <= 0 or amount.as_tuple().exponent < -2 or row["direction"] not in ("inflow", "outflow"):
            raise ValueError("Statement amount/direction ambiguous")
        if not row["id"] or row["id"] in ids or not re.fullmatch(r"[A-Z]{3}", row["currency"]):
            raise ValueError("Statement requires unique bank transaction IDs and currency")
        ids.add(row["id"])
        rows.append(
            {k: v for k, v in row.items() if k in expected} | {"key": digest(bank + ":" + row["id"]), "bank": bank}
        )
    return rows


def bank_upload(content: bytes, mime: str, bank: str) -> list[dict]:
    if mime == "application/pdf":
        # Synthetic PDF uses the normalized CSV table. Real bank layouts await named bank samples.
        content = pdf_text(content).encode()
    elif mime != "text/csv":
        raise ValueError("Bank upload must be PDF or CSV")
    return bank_csv(content, bank)


def subscriptions(invoices: list[dict], profiles: dict) -> list[dict]:
    rows = []
    vendors = set(profiles)
    vendors.update(
        i["vendor"]
        for i in invoices
        if i.get("vendor")
        and len({j["date"][:7] for j in invoices if j.get("vendor") == i["vendor"] and j.get("date")}) >= 2
    )
    for vendor in sorted(vendors):
        profile = profiles.get(vendor, {"cycle": "unknown"})
        charges = sorted(
            [i for i in invoices if i.get("vendor") == vendor and i["status"] == "extracted"],
            key=lambda i: (i["date"], i["key"]),
        )
        if not charges:
            continue
        latest = charges[-1]
        comparable = [i for i in charges[:-1] if i["currency"] == latest["currency"]]
        cost = Decimal(latest["total"])
        divisor = {"monthly": 1, "quarterly": 3, "annual": 12}.get(profile["cycle"])
        rows.append(
            {
                "vendor": vendor,
                "owner": profile.get("owner") or "Owner required",
                "cycle": profile["cycle"],
                "currency": latest["currency"],
                "monthlyCost": str((cost / divisor).quantize(Decimal(".01"))) if divisor else None,
                "nextRenewal": profile.get("nextRenewal"),
                "cost": str(cost),
                "priceChange": str(cost - Decimal(comparable[-1]["total"])) if comparable else None,
                "basis": "Register charges; recurring cadence and renewal require vendor profile confirmation",
            }
        )
    return rows


def due_reminders(day: date, pt_dates: list[str]) -> list[str]:
    # Owner-requested planning dates, not a claim about statutory extensions or state PT rules.
    reminders = {7: "TDS", 11: "GSTR-1", 20: "GSTR-3B"}
    due = [reminders[day.day]] if day.day in reminders else []
    if day.day == 15 and day.month in (3, 6, 9, 12):
        due.append("Advance tax")
    if day.isoformat() in pt_dates:
        due.append("PT")
    return due


def schedule(at: datetime, records: list[dict], pt_dates: list[str], facts: dict) -> list[dict]:
    local = at.astimezone(ZoneInfo("Asia/Kolkata"))
    day = local.date()
    jobs = []
    if day.day == 5:
        month = (day.replace(day=1) - timedelta(days=1)).isoformat()[:7]
        jobs.append({"kind": "close_due", "key": "close:" + month, "month": month})
    if day.weekday() == 0:
        jobs.append(
            {
                "kind": "weekly_exceptions",
                "key": "exceptions:" + day.isoformat(),
                "exceptions": [
                    r["body"]
                    for r in records
                    if r["kind"] == "exception" and r["body"].get("kind") != "weekly_exceptions"
                ],
            }
        )
    for name in due_reminders(day, pt_dates):
        jobs.append(
            {
                "kind": "reminder",
                "key": name + ":" + day.isoformat(),
                "title": name + " due today; founder review required",
            }
        )
    if local.hour >= 21:
        jobs.append(
            {
                "kind": "brief",
                "key": "brief:" + day.isoformat(),
                "date": day.isoformat(),
                "deliveries": facts.get("deliveries"),
                "whoWorked": facts.get("whoWorked"),
                "moneyIn": facts.get("moneyIn"),
                "moneyOut": facts.get("moneyOut"),
                "openApprovals": facts.get("openApprovals"),
                "risks": facts.get("risks", []),
                "coverage": "Missing facts remain unknown, never reported as zero",
            }
        )
    return jobs


def run_fixture(messages: list[dict], statement: bytes, config: dict, output: Path, at: datetime) -> dict:
    from .finance_providers import FixtureZohoBooks

    drive = FinanceDrive(FixtureDrive(output), config["financeFolderId"])
    zoho = FixtureZohoBooks()
    provider = FixtureMail(messages)
    manifest_path = output / "manifest.json"
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"records": [], "files": []}
    if previous.get("synthetic", True) is not True:
        raise ValueError("Fixture output must never mix with live data")
    records = [
        r
        for r in previous["records"]
        if r["kind"] in ("purchase", "sales", "reimbursement", "zoho", "close")
        or (
            r["kind"] == "exception"
            and r["body"].get("type")
            in ("compliance_document", "finance_mail_without_pdf", "statement_review_required")
        )
    ]
    invoices = [r["body"] for r in records if r["kind"] in ("purchase", "sales")]
    seen = {i["key"] for i in invoices}
    seen.update(r["body"]["fileKey"] for r in records if r["kind"] == "exception" and r["body"].get("fileKey"))
    sources = {(i["source"]["mailbox"], i["source"]["message"], i["source"]["attachment"]): i["key"] for i in invoices}
    drive.port.writes = previous["files"].copy()
    for mail in read_finance_mail(provider, config):
        pdfs = [a for a in mail.get("attachments", []) if a.get("mime") == "application/pdf"]
        if not pdfs:
            records.append(
                {
                    "kind": "exception",
                    "key": digest(mail["mailbox"] + mail["id"]),
                    "body": {"type": "finance_mail_without_pdf", "subject": mail["subject"], "sender": mail["sender"]},
                }
            )
        for index, attachment in enumerate(pdfs):
            content = attachment["bytes"]
            key = digest(content)  # deduplicates marketing/billing copies and mailbox replay
            part_id = attachment.get("id") or "part:" + str(index)
            source_key = (mail["mailbox"], mail["id"], part_id)
            if source_key in sources and sources[source_key] != key:
                raise ValueError("Immutable mail attachment changed; review required")
            sources[source_key] = key
            if key in seen:
                continue
            seen.add(key)
            try:
                invoice = extract_invoice(content, config["ourGSTIN"], config["rates"])
            except (ValueError, ArithmeticError, PdfReadError):
                invoice = {
                    "vendor": None,
                    "invoiceNo": None,
                    "date": None,
                    "total": None,
                    "currency": None,
                    "ourGSTINPresent": False,
                    "issues": ["PDF requires manual extraction"],
                    "status": "quarantine",
                }
            category = mail.get("category") or finance_category(mail["subject"])
            if category not in CATEGORIES:
                raise ValueError("Choose a Finance category")
            when = invoice.get("date") or mail["date"]
            name = (
                "_".join(
                    safe_name(x) for x in (when, invoice.get("vendor"), invoice.get("total"), invoice.get("invoiceNo"))
                )
                + ".pdf"
            )
            parent = drive.path([fiscal_year(when), category, when[:7]])
            # Avoid overwriting two distinct documents with the same visible identity.
            folder_path = f"{fiscal_year(when)}/{category}/{when[:7]}/"
            if any(
                f["name"] == name and f["key"] != key and f["path"].startswith(folder_path) for f in drive.port.writes
            ):
                name = name[:-4] + "_" + key[:12] + ".pdf"
            drive.write(parent, name, content, "application/pdf", key)
            kind = "sales" if category == "Sales invoices" else "purchase"
            invoice.update(
                key=key,
                kind=kind,
                filename=name,
                fileKey=key,
                folder=f"Finance/{fiscal_year(when)}/{category}/{when[:7]}",
                source={"mailbox": mail["mailbox"], "message": mail["id"], "attachment": part_id},
            )
            if category in ("Purchase invoices", "Sales invoices"):
                invoices.append(invoice)
                records.append({"kind": kind, "key": key, "body": invoice})
                reimbursement_owner = config.get("reimbursementOwners", {}).get(mail["id"])
                if kind == "purchase" and reimbursement_owner:
                    records.append(
                        {
                            "kind": "reimbursement",
                            "key": "reimbursement:" + key,
                            "body": {
                                **invoice,
                                "name": reimbursement_owner,
                                "purchaseKey": key,
                                "basis": "Receipt linked to a named reimbursement; one underlying purchase expense",
                            },
                        }
                    )
                if kind == "purchase":
                    handoff = (
                        zoho.create_bill(key, invoice, "fixture-vendor", "fixture-tax")
                        if invoice["status"] == "extracted"
                        else {"status": "quarantine"}
                    )
                    records.append(
                        {
                            "kind": "zoho",
                            "key": key,
                            "body": {
                                "status": handoff["status"],
                                "handoff": handoff,
                                "systemOfRecord": config["accountingSystem"],
                                "purchaseBill": invoice,
                                "idempotencyKey": "pulse:" + key,
                                "action": "Zoho Books purchase bill API handoff; no second ledger",
                            },
                        }
                    )
            else:
                records.append(
                    {
                        "kind": "exception",
                        "key": key,
                        "body": {
                            "type": "compliance_document",
                            "category": category,
                            "date": when,
                            "fileKey": key,
                            "subject": mail["subject"],
                        },
                    }
                )
    movements = []
    statement_uploads = config.get(
        "statementUploads",
        [
            {
                "name": "synthetic-bank.csv",
                "mime": "text/csv",
                "bytes": statement,
                "bank": "Synthetic Bank",
                "date": at.date().isoformat(),
            }
        ],
    )
    bank_keys = {r["key"]: r["body"] for r in previous["records"] if r["kind"] == "bank"}
    for upload in statement_uploads:
        parent = drive.path([fiscal_year(upload["date"]), "Bank statements", upload["date"][:7]])
        key = digest(upload["bytes"])
        drive.write(parent, safe_name(upload["name"]), upload["bytes"], upload["mime"], key)
        try:
            for movement in bank_upload(upload["bytes"], upload["mime"], upload["bank"]):
                movement["fileKey"] = key
                if movement["key"] in bank_keys and any(
                    bank_keys[movement["key"]][k] != v for k, v in movement.items() if k != "fileKey"
                ):
                    raise ValueError("Bank transaction changed across statement vintages")
                bank_keys.setdefault(movement["key"], movement)
        except (ValueError, ArithmeticError, PdfReadError):
            records.append(
                {
                    "kind": "exception",
                    "key": "statement:" + key,
                    "body": {
                        "type": "statement_review_required",
                        "fileKey": key,
                        "issues": ["Unsupported or ambiguous bank statement; coverage incomplete"],
                    },
                }
            )
    movements = list(bank_keys.values())
    records += [{"kind": "bank", "key": m["key"], "body": m} for m in movements]
    result = reconcile(invoices, movements)
    records += [
        {"kind": "exception", "key": digest(json.dumps(e, sort_keys=True)), "body": e} for e in result["exceptions"]
    ]
    for invoice in invoices:
        if invoice.get("vendor"):
            records.append(
                {
                    "kind": "vendor",
                    "key": digest(invoice["vendor"]),
                    "body": {
                        "vendor": invoice["vendor"],
                        "vendorGSTIN": invoice.get("vendorGSTIN"),
                        "owner": config["subscriptions"].get(invoice["vendor"], {}).get("owner") or "Owner required",
                        "recurring": False,
                        "basis": "Invoice vendor; recurring billing not established",
                    },
                }
            )
    for vendor in subscriptions(invoices, config["subscriptions"]):
        vendor["recurring"] = True
        vendor["vendorGSTIN"] = next(
            (i.get("vendorGSTIN") for i in reversed(invoices) if i.get("vendor") == vendor["vendor"]), None
        )
        records.append({"kind": "vendor", "key": digest(vendor["vendor"]), "body": vendor})
    # Sheet fixture is a CSV representing an idempotent key-indexed sheet in the SAME Finance root.
    register = csv_bytes(invoices, REGISTER_FIELDS)
    drive.write(
        config["financeFolderId"],
        "Purchase-register-sheet-fixture.csv",
        csv_bytes([i for i in invoices if i["kind"] == "purchase"], REGISTER_FIELDS),
        "text/csv",
        "sheet:purchase",
    )
    for target in ("Tally", "Zoho-Books"):
        drive.write(
            config["financeFolderId"],
            target + "-register_" + digest(register)[:12] + ".csv",
            register,
            "text/csv",
            "export:" + target + ":" + digest(register),
        )
    jobs = schedule(at, records, config.get("ptDates", []), config.get("founderFacts", {}))
    for job in jobs:
        if job["kind"] == "close_due":
            if any(r["kind"] == "close" and r["key"] == job["key"] for r in records):
                continue
            month = job["month"]
            selected = [i for i in invoices if (i.get("date") or "").startswith(month)]
            selected_keys = {i["key"] for i in selected}
            monthly_cash = [m for m in movements if m["date"].startswith(month)]
            monthly_result = reconcile(selected, monthly_cash)
            pack = io.BytesIO()
            with zipfile.ZipFile(pack, "w", zipfile.ZIP_DEFLATED) as archive:

                def pack_file(name, data):
                    info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(info, data)

                pack_file("register.csv", csv_bytes(selected, REGISTER_FIELDS))
                pack_file("reconciliation.json", json.dumps(monthly_result, indent=2))
                pack_file(
                    "open-exceptions.json",
                    json.dumps(
                        [
                            r["body"]
                            for r in records
                            if r["kind"] == "exception" and r["body"].get("kind") != "weekly_exceptions"
                        ],
                        indent=2,
                    ),
                )
                for file in drive.port.writes:
                    if file["key"] in selected_keys:
                        pack_file("PDFs/" + file["name"], base64.b64decode(file["data"]))
                    elif "/" + month + "/" in file["path"] and file["mime"] in ("application/pdf", "text/csv"):
                        pack_file("Evidence/" + file["path"], base64.b64decode(file["data"]))
            pack_key = "pack:" + month
            drive.write(
                drive.path([fiscal_year(month + "-01"), "Close packs", month]),
                month + "-close.zip",
                pack.getvalue(),
                "application/zip",
                pack_key,
            )
            records.append(
                {
                    "kind": "close",
                    "key": job["key"],
                    "body": {
                        "month": month,
                        "to": CA,
                        "subject": "Vikriya Solutions LLP — " + month + " close pack",
                        "emailBody": (
                            f"Please review the {month} register, invoice PDFs, "
                            "reconciliation and open exceptions in Pulse Finance."
                        ),
                        "packKey": pack_key,
                        "exceptions": monthly_result["exceptions"],
                        "status": "draft_founder_approval_required",
                        "coverage": monthly_result["coverage"],
                        "invoiceCount": len(selected),
                        "synthetic": True,
                    },
                }
            )
        else:
            kind = "exception" if job["kind"] == "weekly_exceptions" else job["kind"]
            records.append({"kind": kind, "key": job["key"], "body": job})
    manifest = {
        "synthetic": True,
        "records": records,
        "files": drive.port.writes,
        "mailReads": provider.reads,
        "reconciliation": result,
        "jobs": jobs,
        "systemOfRecord": config["accountingSystem"],
        "externalSends": 0,
    }
    # Durable local fixture replay; the Purchase Sheet remains a single current mirror.
    manifest["records"] = list({(r["kind"], r["key"]): r for r in manifest["records"]}.values())
    manifest["files"] = list({f["key"]: f for f in manifest["files"]}.values())
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def synthetic_pdf(text: str) -> bytes:
    """Small valid PDF fixture generated without a graphics dependency."""
    lines = [line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") for line in text.splitlines()]
    stream = ("BT /F1 10 Tf 40 750 Td " + " ".join(f"({line}) Tj 0 -15 Td" for line in lines) + " ET").encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
        ),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    output, offsets = b"%PDF-1.4\n", [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    start = len(output)
    output += b"xref\n0 6\n0000000000 65535 f \n" + b"".join(f"{n:010d} 00000 n \n".encode() for n in offsets[1:])
    return output + f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()


def fixtures():
    gstin = "27ABCDE1234F1Z5"  # synthetic, never claimed to be the company GSTIN
    config = {
        "mode": "fixture",
        "billingMailbox": "finance-bot@estateautopilots.com",
        "financeFolderId": "fixture-finance-root",
        "senders": [CA, *CS, "billing@synthetic-vendor.example"],
        "ourGSTIN": gstin,
        "rates": {"2026-09-01:USD": {"rate": "83.25", "source": "RBI:synthetic-reference-fixture"}},
        "accountingSystem": "Zoho Books (owner confirmation pending)",
        "subscriptions": {
            "Synthetic Software": {"owner": "Synthetic Founder", "cycle": "monthly", "nextRenewal": "2026-10-01"}
        },
        "ptDates": [],
        "founderFacts": {
            "deliveries": 4,
            "whoWorked": ["Synthetic Person"],
            "moneyIn": {"INR": "5000.00"},
            "moneyOut": {"INR": "1180.00"},
            "openApprovals": 2,
            "risks": ["Synthetic missing invoice"],
        },
    }
    text = (
        f"Vendor: Synthetic Software\nVendor GSTIN: 27AAAAA0000A1Z5\nOur GSTIN: {gstin}\n"
        "Invoice No: SYN-001\nDate: 2026-09-01\nCurrency: INR\nTaxable: 1000.00\n"
        "CGST: 90.00\nSGST: 90.00\nIGST: 0.00\nTotal: 1180.00"
    )
    messages = [
        {
            "id": "fixture-mail-1",
            "mailbox": config["billingMailbox"],
            "sender": "billing@synthetic-vendor.example",
            "subject": "Invoice SYN-001",
            "date": "2026-09-01",
            "attachments": [{"id": "part-1", "mime": "application/pdf", "bytes": synthetic_pdf(text)}],
        },
        {
            "id": "fixture-marketing-private",
            "mailbox": "marketing@estateautopilots.com",
            "sender": CA,
            "subject": "Campaign creative",
            "date": "2026-09-01",
            "attachments": [],
        },
    ]
    statement = (
        b"id,date,vendor,reference,amount,currency,direction\n"
        b"TX-1,2026-09-02,Synthetic Software,SYN-001,1180.00,INR,outflow\n"
        b"TX-2,2026-09-03,Synthetic Unknown,SYN-999,200.00,INR,outflow\n"
    )
    config["statementUploads"] = [
        {
            "name": "synthetic-bank.csv",
            "mime": "text/csv",
            "bytes": statement,
            "bank": "Synthetic Bank",
            "date": "2026-09-30",
        }
    ]
    return config, messages, statement


def import_manifest(conn, org, manifest):
    from pulse_sdk.db import tenant_tx

    with tenant_tx(conn, org):
        conn.execute("select pulse.finance_desk_fixture_refresh()")
        for record in manifest["records"]:
            conn.execute(
                "insert into pulse_priv.finance_desk_record(org_id,kind,key,body,synthetic) "
                "values(%s,%s,%s,%s,true) on conflict do nothing",
                (org, record["kind"], record["key"], Jsonb(record["body"])),
            )
            stored = conn.execute(
                "select body from pulse_priv.finance_desk_record where org_id=%s and synthetic and kind=%s and key=%s",
                (org, record["kind"], record["key"]),
            ).fetchone()
            if not stored or stored["body"] != record["body"]:
                raise ValueError("Immutable intake replay changed; manual review required")
        for file in manifest["files"]:
            conn.execute(
                "insert into pulse_priv.finance_desk_file(org_id,key,name,mime,bytes,synthetic) "
                "values(%s,%s,%s,%s,%s,true) on conflict do nothing",
                (org, file["key"], file["name"], file["mime"], base64.b64decode(file["data"])),
            )


def main():
    parser = argparse.ArgumentParser(description="RF1 synthetic intake; no live mail or external sends")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--org", help="Optional tenant for importing synthetic Pulse register/evidence")
    args = parser.parse_args()
    config, messages, statement = fixtures()
    manifest = run_fixture(
        messages, statement, config, args.output, datetime(2026, 10, 5, 16, 0, tzinfo=ZoneInfo("UTC"))
    )
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if args.org:
        from pulse_sdk.db import connect

        with connect("worker") as conn:
            import_manifest(conn, args.org, manifest)
    print(
        json.dumps(
            {
                "synthetic": True,
                "records": len(manifest["records"]),
                "files": len(manifest["files"]),
                "externalSends": 0,
            }
        )
    )


if __name__ == "__main__":
    main()
