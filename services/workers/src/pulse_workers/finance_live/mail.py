# ruff: noqa: E501
"""Finance mail: selected from the EA index by sender allowlist and subject, then only PDF attachments are read.

Mail bodies are never parsed or stored. Filing notices and Meta receipts use the index's existing header and snippet
fields. Every rule below names a finance sender; anything else in a mailbox is never selected.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from datetime import date

from .common import HIGH, LOW, MEDIUM, as_date, digest, money, norm_name, title_name

MAILBOXES = ("marketing@estateautopilots.com", "sales@estateautopilots.com")
# kazuk@ and info@ are aliases of the sales@ mailbox (same Gmail profile); billing@ is a group delivered to marketing@.
ALIASES = {
    "user-1f3a5731@estateautopilots.com": "sales@estateautopilots.com",
    "info@estateautopilots.com": "sales@estateautopilots.com",
}
NOT_FINANCE = re.compile(
    r"\b(OTP|one[- ]time password|verification code|password|webinar|cashback|offer|sale|newsletter)\b", re.I
)


@dataclass(frozen=True)
class Rule:
    vendor: str
    category: str
    sender: str
    subject: str
    cadence: str | None = None
    kind: str = "bill"  # bill | sales | filing


RULES = [
    Rule(
        "Zoho Invoice (sales)",
        "Sales invoices",
        r"message-service@sender\.zohoinvoice\.in",
        r"^(package renewal )?invoice - INV-\d+ from vikriya",
        kind="sales",
    ),
    Rule("Anthropic (Claude)", "Software & AI", r"@mail\.anthropic\.com", r"receipt|invoice", "monthly"),
    Rule("OpenAI (ChatGPT)", "Software & AI", r"openai\.com", r"receipt|invoice|renew", "monthly"),
    Rule("Make (Celonis)", "Software & AI", r"@make\.com|celonis", r"receipt|invoice", "monthly"),
    Rule(
        "Google Workspace",
        "Software & AI",
        r"(user\-46754be8|user\-0987543a)@org\-c0f283\.example",
        r"invoice|receipt|payment|statement|billing",
        "monthly",
    ),
    Rule(
        "Google Ads",
        "Ad spend",
        r"ads(-account)?-noreply@google\.com",
        r"receipt|invoice|payment|billing",
        None,
    ),
    Rule(
        "Airtel Wi-Fi",
        "Internet & phone",
        r"user-3357d85e@airtel\.com|user-19fa20ce@airtel\.com",
        r"bill|receipt",
        "monthly",
    ),
    Rule("Hathway Internet", "Internet & phone", r"hathway\.com", r"invoice|bill", "monthly"),
    Rule(
        "Zoho (subscriptions)",
        "Software & AI",
        r"zohostore\.in|user-876d9723@org-ba9890\.example|zohobooks\.com",
        r"payment|invoice|receipt|renew|subscription",
        "annual",
    ),
    Rule("Bitwarden", "Software & AI", r"bitwarden\.com", r"receipt|invoice", "annual"),
    Rule(
        "ElevenLabs", "Software & AI", r"eleven ?labs|acct_1M07hSLmdOdiMXBs", r"receipt|credit note|invoice", "monthly"
    ),
    Rule(
        "Adobe",
        "Software & AI",
        r"@(mail\.)?adobe\.com|@e\.adobe\.com",
        r"receipt|invoice|order|payment|renew",
        "monthly",
    ),
    Rule("Netlify", "Software & AI", r"netlify\.com", r"receipt|invoice|payment received", "monthly"),
    Rule("Canva", "Software & AI", r"canva\.com", r"receipt|invoice|payment", "monthly"),
    Rule("Kling AI", "Software & AI", r"kling|klingai", r"receipt|invoice|order|payment", "monthly"),
    Rule("Loom", "Software & AI", r"loom\.com", r"receipt|invoice", "monthly"),
    Rule("Manus", "Software & AI", r"manus\.im", r"receipt|invoice|payment", "monthly"),
    Rule("Manychat", "Software & AI", r"manychat", r"receipt|invoice|payment", "monthly"),
    Rule("Pabbly", "Software & AI", r"pabbly\.com", r"receipt|invoice|payment", "annual"),
    Rule("GoDaddy", "Software & AI", r"godaddy\.com", r"thank you for your order|receipt|failed billing", "annual"),
    Rule("Hostinger", "Software & AI", r"hostinger\.com", r"invoice|receipt|payment|order", "annual"),
    Rule("Cloudflare", "Software & AI", r"cloudflare\.com", r"invoice|receipt|purchased", None),
    Rule(
        "WhatsApp Business",
        "Ad spend",
        r"business\.whatsapp\.com|facebookmail\.com",
        r"invoice|receipt|payment for whatsapp",
        None,
    ),
    Rule("Amazon", "Equipment & supplies", r"user-199a0c50@org-805909\.example", r"order of|ordered", None),
    Rule("CS Pirumo Jamunegenu", "Accounting & compliance", r"user-610c5a46@gmail\.com", r"invoice no", None),
    Rule("Startupwala", "Accounting & compliance", r"startupwala\.com", r"invoice|payment|receipt", None),
]
# The company secretary writes from these addresses (finance_desk.CS). Full addresses, never a bare username,
# so the sanitized public mirror rewrites every mention the same way (EST-1582).
CS_SENDERS = ("user-610c5a46@gmail.com", "user-a64fb393@gmail.com", "user-d8b39a58@gmail.com")
FILING_SENDERS = r"gst\.gov\.in|tdscpc\.gov\.in|incometax\.gov\.in|mahagst\.gov\.in|user-7b81126a@gmail\.com|user-610c5a46@gmail\.com|startupwala\.com"
META_SENDERS = r"(facebook|facebookmail|metamail)\.com"


BILLING_GROUP = "billing@estateautopilots.com"


def rule_for(sender: str, subject: str, recipients: str = "") -> Rule | None:
    if NOT_FINANCE.search(subject or ""):
        return None
    for rule in RULES:
        if re.search(rule.sender, sender or "", re.I) and re.search(rule.subject, subject or "", re.I):
            return rule
    # billing@ is the finance distribution group: anything addressed to it is finance mail (attachments only).
    if BILLING_GROUP in (recipients or "").lower():
        return Rule("billing@ group", "Purchase invoices", re.escape(sender or ""), ".*")
    return None


def select(index, since: date | None = None):
    """Finance headers from the index for the finance mailboxes. Nothing else is selected."""
    rows = index.execute(
        "select user_email,id,thread_id,from_addr,to_addr,cc_addr,subject,sent_at,snippet,size from gmail_message "
        "where user_email = any(%s) and (sent_at >= %s or %s::date is null) order by sent_at,id",
        (list(MAILBOXES), since, since),
    ).fetchall()
    bills, filings = [], []
    for row in rows:
        sender, subject = row["from_addr"] or "", row["subject"] or ""
        rule = rule_for(sender, subject, " ".join(filter(None, [row.get("to_addr"), row.get("cc_addr")])))
        if rule:
            bills.append({**row, "rule": rule})
        elif re.search(FILING_SENDERS, sender, re.I) and not NOT_FINANCE.search(subject):
            filings.append(row)
    return bills, filings


# --- PDF attachments ------------------------------------------------------------------------------------------------


def pdf_text(content: bytes) -> str:
    from pypdf import PdfReader

    if not content.startswith(b"%PDF-") or len(content) > 10 * 1024 * 1024:
        raise ValueError("Not a finance PDF under 10 MB")
    reader = PdfReader(io.BytesIO(content))
    if reader.is_encrypted:
        raise ValueError("Encrypted PDF needs manual extraction")
    return "\n".join(page.extract_text() or "" for page in reader.pages[:20])


GSTIN = re.compile(r"\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b")
AMOUNT = r"(?:₹|Rs\.?|INR|\$|USD)?\s*([\d,]+\.\d{2})"


def zoho_invoice(text: str, own_gstin: str) -> dict:
    """Vikriya Solutions LLP sales invoice rendered by Zoho Invoice."""

    def find(pattern, flags=re.I):
        match = re.search(pattern, text, flags)
        return match.group(1).strip() if match else None

    number = find(r"#\s*:\s*(INV-\d+)")
    issued = as_date(find(r"Invoice Date\s*:\s*([\d/.-]+)"))
    due = as_date(find(r"Due Date\s*:\s*([\d/.-]+)"))
    client = find(r"Place Of Supply\s*:[^\n]*\n\s*([^\n]+)")
    gstins = [g for g in GSTIN.findall(text) if g != own_gstin]
    sub = money(find(r"Sub Total\s*" + AMOUNT))
    cgst = money(find(r"CGST[\d.]*\s*\([\d.]+%\)\s*" + AMOUNT))
    sgst = money(find(r"SGST[\d.]*\s*\([\d.]+%\)\s*" + AMOUNT))
    igst = money(find(r"IGST[\d.]*\s*\([\d.]+%\)\s*" + AMOUNT))
    total = money(find(r"(?m)^\s*Total\s*" + AMOUNT))
    balance = money(find(r"Balance Due\s*" + AMOUNT))
    paid = money(find(r"Payment Made\s*\(?-?\)?\s*" + AMOUNT))
    lines = re.findall(r"^\s*\d+\s+(.+?)\s+9983\d{2}\b", text, re.M)
    issues = []
    if not (number and issued and total is not None):
        issues.append("Invoice number, date or total not found")
    if None not in (sub, total) and abs((sub + (cgst or 0) + (sgst or 0) + (igst or 0)) - total) > 1:
        issues.append("Tax arithmetic does not balance")
    return {
        "number": number,
        "date": issued.isoformat() if issued else None,
        "due": due.isoformat() if due else None,
        "client": title_name(client) if client else None,
        "clientGstin": gstins[0] if gstins else None,
        "taxable": sub,
        "cgst": cgst,
        "sgst": sgst,
        "igst": igst,
        "total": total,
        "balanceDue": balance,
        "paidAtIssue": paid,
        "description": ", ".join(dict.fromkeys(line.strip() for line in lines))[:120] or None,
        "ourGstinPresent": own_gstin in text,
        "issues": issues,
        "confidence": HIGH if not issues else LOW,
    }


BILL_PARSER = (
    2  # bump to re-read every vendor bill PDF once (Gmail attachments are fetched again; Drive filing is idempotent)
)


def bill(text: str, own_gstin: str) -> dict:
    """Generic vendor invoice or receipt: total, invoice number, date, GSTINs. Missing fields stay None."""
    flat = re.sub(r"[ \t]+", " ", text)
    total = None
    figure = r"(?:₹|Rs\.?|INR|\$|USD)?\s*([\d,]+(?:\.\d{1,2})?)"
    for pattern in (
        r"₹\s?([\d,]+\.\d{2})\s*Total in INR",
        r"(?:Amount paid|Paid amount|Total amount paid)\s*:?\s*" + figure,
        r"(?:Grand Total|Total Amount|Amount Due|Total Due|Invoice Total|Net Payable|Total payable|Amount Payable)[^\d₹$\n]{0,20}"
        + AMOUNT,
        r"(?m)^\s*Total\s*:?\s*" + figure + r"\s*$",
        r"\bTotal\b[^\d₹$\n]{0,20}" + AMOUNT,
    ):
        match = re.search(pattern, flat, re.I)
        if match and money(match.group(1)):
            total = money(match.group(1))
            break
    currency = (
        "USD" if re.search(r"\$\s?[\d,]+\.\d{2}|\bUSD\b", flat) and not re.search(r"₹|\bINR\b|Rs\.", flat) else "INR"
    )
    number = None
    for label in (
        r"Invoice (?:number|no\.?|#)",
        r"Receipt (?:number|no\.?|#)",
        r"Bill (?:number|no\.?)",
        r"INVOICE NO\.?",
    ):
        match = re.search(label + r"\s*[:#]?\s*([A-Z0-9][A-Z0-9/_-]{2,30})", flat, re.I)
        if match:
            number = match.group(1)
            break
    issued = None
    google = re.search(r"(\d{1,2} [A-Za-z]{3} \d{4})\s*Invoice date", flat)
    if google:
        issued = as_date(google.group(1).replace(" ", "-", 1).replace(" ", "-"))
    for label in (
        ()
        if issued
        else (
            r"Date paid",
            r"Payment date",
            r"Invoice date",
            r"Date of issue",
            r"Bill date",
            r"Receipt date",
            r"SRN Date",
            r"Date",
        )
    ):
        match = re.search(
            label
            + r"\s*[:]?\s*([A-Za-z]{3,9} \d{1,2}, \d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}[- ][A-Za-z]{3,9}[- ,]+\d{4})",
            flat,
            re.I,
        )
        if match:
            raw = match.group(1)
            parsed = None
            m2 = re.fullmatch(r"([A-Za-z]{3,9}) (\d{1,2}), (\d{4})", raw)
            if m2:
                parsed = as_date(f"{m2.group(2)}-{m2.group(1)}-{m2.group(3)}")
            issued = parsed or as_date(raw)
            if issued:
                break
    gstins = GSTIN.findall(flat)
    vendor_gstin = next((g for g in gstins if g != own_gstin), None)
    taxes = {}
    for key, patterns in {
        "taxable": (
            r"₹\s?([\d,]+\.\d{2})\s*Subtotal in INR",
            r"(?:Sub ?total|Taxable (?:value|amount)|Amount before tax)\s*(?:\(INR\))?\s*:?\s*(?:₹|Rs\.?|INR)?\s*([\d,]+\.\d{2})",
        ),
        "igst": (
            r"₹\s?([\d,]+\.\d{2})\s*Integrated GST",
            r"IGST\s*(?:@\s*[\d.]+\s*%|\(?[\d.]+\s*%\)?)?\s*:?\s*(?:₹|Rs\.?|INR)?\s*([\d,]+\.\d{2})",
        ),
        "cgst": (r"CGST\s*(?:@\s*[\d.]+\s*%|\(?[\d.]+\s*%\)?)?\s*:?\s*(?:₹|Rs\.?|INR)?\s*([\d,]+\.\d{2})",),
        "sgst": (r"SGST\s*(?:@\s*[\d.]+\s*%|\(?[\d.]+\s*%\)?)?\s*:?\s*(?:₹|Rs\.?|INR)?\s*([\d,]+\.\d{2})",),
    }.items():
        for pattern in patterns:
            match = re.search(pattern, flat, re.I)
            if match and money(match.group(1)) is not None:
                taxes[key] = money(match.group(1))
                break
    # Google Workspace sometimes prints the three figures before their labels.
    block = re.search(
        r"₹\s?([\d,]+\.\d{2})\s*₹\s?([\d,]+\.\d{2})\s*₹\s?([\d,]+\.\d{2})\s*Subtotal in INR\s*Integrated GST[^\n]*\s*Total in INR",
        flat,
    )
    if block:
        taxes.update(taxable=money(block.group(1)), igst=money(block.group(2)))
        total = total if total is not None else money(block.group(3))
    lump = re.search(r"\bTaxes(?: \(GST\))?\s+(?:`|₹|Rs\.?)?\s*([\d,]+\.\d{2})\b", flat)
    split = sum(taxes.get(k) or 0 for k in ("cgst", "sgst", "igst"))
    gst = split if split else money(lump.group(1)) if lump else None
    if gst is not None:
        taxes["gst"] = gst
        if taxes.get("taxable") is None and total is not None:
            taxes["taxable"] = total - gst
    # Tax lines are kept only when they add up to the total; otherwise the CA reads them from the filed PDF.
    if total is None or taxes.get("taxable") is None or abs(taxes["taxable"] + (taxes.get("gst") or 0) - total) > 1:
        taxes = {}
    return {
        **taxes,
        "parser": BILL_PARSER,
        "total": total,
        "currency": currency,
        "invoiceNo": number,
        "date": issued.isoformat() if issued else None,
        "vendorGstin": vendor_gstin,
        "ourGstinPresent": bool(own_gstin) and own_gstin in flat,
        "confidence": HIGH if total is not None and issued else MEDIUM if total is not None else LOW,
    }


def snippet_amount(snippet: str) -> tuple[float | None, str]:
    text = snippet or ""
    for pattern, currency in ((r"(?:₹|Rs\.?|INR)\s?([\d,]+(?:\.\d{1,2})?)", "INR"), (r"\$\s?([\d,]+\.\d{2})", "USD")):
        match = re.search(pattern, text)
        if match:
            value = money(match.group(1))
            if value is not None:
                return float(value), currency
    return None, "INR"


# --- filings --------------------------------------------------------------------------------------------------------

ARN = re.compile(r"\b(A[A-Z])(\d{2})(\d{2})(\d{2})(\w{6,9})\b")


def filing(row: dict) -> dict | None:
    """GST, TDS, ITR, LLP and PT events from subject and the indexed snippet."""
    subject, snippet, sender = row["subject"] or "", row["snippet"] or "", row["from_addr"] or ""
    sent = row["sent_at"].date().isoformat() if row.get("sent_at") else None
    arn = ARN.search(snippet)
    period = None
    if arn and arn.group(2) == "27":
        period = f"20{arn.group(4)}-{arn.group(3)}"

    def make(kind, status, **extra):
        return {
            "type": kind,
            "status": status,
            "date": sent,
            "period": period,
            "arn": arn.group(0) if arn else None,
            "subject": subject[:120],
            "sender": re.sub(r".*<|>.*", "", sender)[:80],
            **extra,
        }

    s = subject.lower()
    if "mahagst.gov.in" in sender:
        # The Maharashtra Profession Tax office; checked before the GST portal, whose domain it contains.
        if "show cause" in s or "notice" in s:
            return make("Profession tax", "notice")
        if "reminder" in s:
            return make("Profession tax", "reminder")
        return None
    if "gst.gov.in" in sender:
        if "gstr-3b" in s and "acknowledg" in s:
            return make("GSTR-3B", "filed")
        if "outward supplies" in s:
            return make("IFF" if re.search(r"\bIFF\b", subject) else "GSTR-1", "filed")
        if "notice to return defaulters" in s or "gstr-3a" in s:
            m = re.search(r"tax period ([A-Za-z]+(?:-[A-Za-z]+)?,? ?\d{4})", snippet)
            return make("GSTR-3B", "default notice", noticePeriod=m.group(1) if m else None)
        if "letter of undertaking" in s or "lut" in s:
            return make("LUT", "filed" if "deemed approval" in s or "arn" in s else "update")
        if "transaction alert" in s:
            amount = re.search(r"Rs\s?\.?\s?([\d,]+)", snippet)
            return make(
                "GST payment",
                "paid" if "credited" in snippet else "pending",
                amount=float(money(amount.group(1))) if amount else None,
            )
        if "registration" in s and ("welcome" in s or "approved" in s):
            return make("GST registration", "approved")
        return None
    if "tdscpc" in sender:
        q = re.search(r"\bfor (Q\d) of (?:TY|FY) (\d{4}-\d{2})", subject)
        if re.search(r"filed|statement", s) and q:
            return make("TDS return", "filed", quarter=f"{q.group(1)} {q.group(2)}")
        if "form 16a" in s or "certificate" in s:
            return make("TDS certificates", "reminder")
        if "default" in s or "notice" in s or "demand" in s:
            return make("TDS", "notice")
        return None
    if "incometax.gov.in" in sender:
        ay = re.search(r"(?:AY|of) (\d{4}-\d{2})", snippet + " " + subject)
        if "e-verification" in s or "e-verified" in snippet.lower():
            return make("ITR", "verified", assessmentYear=ay.group(1) if ay else None)
        if "intimation" in s:
            return make("ITR", "processed", assessmentYear=ay.group(1) if ay else None)
        return None
    if "mahagst.gov.in" in sender:
        if "show cause" in s or "notice" in s:
            return make("Profession tax", "notice")
        if "reminder" in s:
            return make("Profession tax", "reminder")
        return None
    if "caprajakta" in sender:
        fy = re.search(r"FY ?(\d{4}-\d{2})", subject)
        if "itr" in s or "income tax return" in s:
            return make("ITR", "CA documents", financialYear=fy.group(1) if fy else None)
        if "gstr" in s:
            return make("GST", "CA documents", financialYear=fy.group(1) if fy else None)
        if "ptrc" in s or "ptec" in s:
            return make("Profession tax", "CA challan", financialYear=fy.group(1) if fy else None)
        if "balance sheet" in s:
            return make("Financial statements", "CA documents", financialYear=fy.group(1) if fy else None)
        return None
    if any(address in sender for address in CS_SENDERS) or "startupwala" in sender:
        form = re.search(r"Form ?(8|11)", subject, re.I)
        if form:
            return make("LLP Form " + form.group(1), "pending questionnaire" if "pending" in s else "drafts")
        return None
    return None


# --- Meta receipts (index snippets) ---------------------------------------------------------------------------------

DEV = str.maketrans("०१२३४५६७८९", "0123456789")
META_AMOUNT = re.compile(
    r"(?:Funded|Amount billed|You added|You paid)\s*(?:₹|Rs\.?|QAR|\$)?\s?([\d,]+\.\d\d)\s*([A-Z]{3})?"
)
META_ACCOUNT = re.compile(r"(?:Payment receipt for|Transaction for|पेमेंट पावती:)\s*(.+?)\s*\((\d{9,20})\)")
META_TXN = re.compile(r"Transaction ID ([0-9-]+)")
META_SUBJECT_ID = re.compile(r"\(\s*account ID:?\s*(\d+)\s*\)|आयडी\s*(\d+)", re.I)


def meta_receipts(index, since: date | None = None):
    """Distinct Meta ad payments seen in any EA mailbox, from the index's receipt headers and snippets."""
    rows = index.execute(
        "select user_email,id,sent_at,subject,snippet from gmail_message where from_addr ~* %s "
        "and (subject ilike '%%receipt%%' or subject like '%%पावती%%') and (sent_at >= %s or %s::date is null) order by sent_at,id",
        (META_SENDERS, since, since),
    ).fetchall()
    out, counts = {}, {"mails": len(rows), "parsed": 0, "unparsed": 0, "duplicates": 0}
    for row in rows:
        subject, text = row["subject"] or "", (row["snippet"] or "").translate(DEV)
        kind = "funds" if ("funds" in subject.lower() or "निधी" in subject) else "billed"
        account = META_ACCOUNT.search(text)
        from_subject = META_SUBJECT_ID.search(subject)
        account_id = (
            account.group(2) if account else (from_subject.group(1) or from_subject.group(2)) if from_subject else None
        )
        amount = META_AMOUNT.search(text)
        if not amount and "जोडले" in text:
            amount = re.search(r"₹?([\d,]+\.\d\d)\s*(INR)", text)
        if not (amount and account_id):
            counts["unparsed"] += 1
            continue
        value = money(amount.group(1))
        currency = amount.group(2) or ("QAR" if "QAR" in text else "INR")
        txn = META_TXN.search(text)
        key = txn.group(1) if txn else f"{account_id}|{value}|{row['sent_at'].date()}"
        if key in out:
            counts["duplicates"] += 1
            continue
        counts["parsed"] += 1
        out[key] = {
            "txn": key,
            "accountId": account_id,
            "accountName": (account.group(1).strip()[:80] if account else ""),
            "kind": kind,
            "day": row["sent_at"].date().isoformat(),
            "amount": value,
            "currency": currency,
            "mailbox": row["user_email"],
            "message": row["id"],
        }
    return list(out.values()), counts


def client_from_account(name: str) -> str | None:
    """Meta ad account names usually carry the project or client: 'Borup Murufup | Tathawade'."""
    first = re.split(r"[|(\-–]", name or "")[0]
    clean = norm_name(first)
    return title_name(clean) if len(clean) >= 4 else None


def message_key(mailbox: str, message_id: str, part: str) -> str:
    return digest(f"{mailbox}|{message_id}|{part}")


def confidence_for(parsed: dict) -> str:
    return parsed.get("confidence") or LOW
