# ruff: noqa: E501
"""Axis bank narrations (as copied into EA's sheets or exported as statements) to counterparties and categories.

Payments to individuals are payroll or freelance payments. Their names never leave this module: the stored line keeps
only the category, a reference token and a digest, so individual pay stays in the restricted HR salary area.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .common import COMPANY_WORDS, digest, is_company, name_key, norm_name, similar, title_name

INVOICE_REF = re.compile(r"\b(?:inv(?:oice|oce)?|bill)\s*[.:#-]?\s*(?:no\.?\s*)?(?:INV-?)?0*(\d{3,6})\b", re.I)
ZOHO_NO = re.compile(r"INV-?0*(\d{3,6})", re.I)

PEOPLE = "Salaries & people"
FOUNDERS = "Founders & directors"
FREELANCE = "Freelancers & individuals"
CLIENT_RECEIPTS = "Client receipts"
INDIVIDUAL_CATEGORIES = (PEOPLE, FOUNDERS, FREELANCE)
VENDOR_CATEGORIES = [
    (re.compile(r"FACEBOOK|META ?PLATFORMS|\bMETA\b|FB ADS|ADS ?PAYMENT|\bADS\b", re.I), "Ad spend"),
    (re.compile(r"GOOGLE ?ADS|ADWORDS", re.I), "Ad spend"),
    (re.compile(r"CLIENT ADS? SPEND", re.I), "Client ad spend (pass-through)"),
    (re.compile(r"GOOGLE|WORKSPACE|GSUITE", re.I), "Software & AI"),
    (
        re.compile(
            r"ANTHROPIC|CLAUDE|OPENAI|CHATGPT|MAKE\.COM|CELONIS|\bMAKE\b|CANVA|ADOBE|NETLIFY|ELEVEN ?LABS|KLING|LOOM|"
            r"ZOHO|HOSTINGER|GODADDY|CLOUDFLARE|BITWARDEN|ATLASSIAN|MANYCHAT|PABBLY|PRIVYR|MANUS|TOOLS?\b|SOFTWARE|"
            r"SUBSCRIPTION",
            re.I,
        ),
        "Software & AI",
    ),
    (
        re.compile(r"AIRTEL|HATHWAY|JIO|VODAFONE|\bVI\b|BSNL|WIFI|BROADBAND|SIM RECHARGE|RECHARGE", re.I),
        "Internet & phone",
    ),
    (re.compile(r"\bRENT\b|LANDLORD|LEASE|MAINTENANCE|SOCIETY", re.I), "Office & rent"),
    (re.compile(r"ELECTRIC|MSEDCL|MAHAVITARAN|POWER", re.I), "Office & rent"),
    (
        re.compile(r"\bGST\b|CBDT|\bTDS\b|INCOME ?TAX|PROFESSION ?TAX|PTRC|PTEC|ADVANCE TAX|CHALLAN", re.I),
        "Taxes & statutory",
    ),
    (
        re.compile(r"\bCA\b|CHARTERED|NEHUDEKOV|JAMUNEGENU|STARTUPWALA|LEGAL|ADVOCATE|COMPLIANCE", re.I),
        "Accounting & compliance",
    ),
    (re.compile(r"MODEL|SHOOT|CINEMATOG|VIDEOGRAPH|DRONE|STUDIO|PRODUCTION", re.I), "Production & shoots"),
    (re.compile(r"TRAVEL|UBER|OLA|RAPIDO|IRCTC|FUEL|PETROL", re.I), "Travel"),
    (re.compile(r"FOOD|SWIGGY|ZOMATO|CAFE|RESTAURANT|SNACK", re.I), "Food & office supplies"),
    (re.compile(r"AMAZON|FLIPKART|CROMA|STATIONERY", re.I), "Equipment & supplies"),
    (re.compile(r"BANK CHARGES|CHGS|CHARGES|SMS ALERT|GST ON CHG|CONSOLIDATED CHARGES", re.I), "Bank charges"),
    (re.compile(r"REFUND", re.I), "Refunds"),
]


@dataclass
class Narration:
    channel: str = "OTHER"
    reference: str | None = None
    counterparty: str | None = None
    remark: str = ""
    invoices: list[str] = field(default_factory=list)


def parse(text: str) -> Narration:
    """Split an Axis narration into channel, reference token, counterparty and remark."""
    raw = re.sub(r"\s+", " ", str(text or "")).strip()
    parts = [p.strip() for p in raw.split("/")]
    head = parts[0].upper() if parts else ""
    out = Narration(remark=raw)
    out.invoices = sorted(
        {f"INV-{int(n):08d}" for n in INVOICE_REF.findall(raw) + ZOHO_NO.findall(raw) if int(n) >= 100}
    )

    def at(i):
        return parts[i] if len(parts) > i and parts[i] else None

    if head == "INB" and len(parts) > 2:
        kind = parts[1].upper()
        if kind in ("NEFT", "RTGS", "IMPS"):
            out.channel, out.reference, out.counterparty = kind, at(2), at(3)
        else:
            out.channel, out.counterparty = "IFT", at(2)
    elif head in ("NEFT", "RTGS"):
        if (at(1) or "").upper() == "RETURN":
            out.channel, out.reference, out.counterparty = "RETURN", at(2), at(4) or at(3)
        else:
            out.channel, out.reference, out.counterparty = head, at(1), at(2)
    elif head in ("IMPS", "UPI") and len(parts) > 3:
        out.channel, out.reference, out.counterparty = head, at(2), at(3)
    elif head == "MOB" and len(parts) > 2:
        out.channel, out.counterparty, out.reference = "MOB", at(2), at(3)
    elif head == "TRF":
        out.channel, out.counterparty = "TRF", at(1)
    elif head == "CLG":
        out.channel, out.reference = "CHEQUE", "-".join(p for p in parts[1:3] if p)
    elif head == "SAK" or "CASH DEP" in raw.upper():
        out.channel, out.reference = "CASH", at(2) or at(1)
    elif head.startswith(("ACH", "ECS", "NACH")):
        out.channel, out.counterparty = "ACH", at(1)
    elif head.startswith(("POS", "ECOM", "VPS", "IPS")):
        out.channel, out.counterparty = "CARD", at(2) or at(1)
    elif head.startswith(("GST", "CBDT", "TAX")):
        out.channel, out.counterparty = "TAX", head
    if out.reference and not re.search(r"\d{4}", out.reference):
        out.reference = None
    if out.counterparty and (re.fullmatch(r"[\d ]+", out.counterparty) or len(norm_name(out.counterparty)) < 3):
        out.counterparty = None
    return out


@dataclass
class People:
    """Names that identify payroll, founder and known individual payees. Only used to classify, never stored."""

    founders: list[str] = field(default_factory=list)
    staff: list[str] = field(default_factory=list)

    def match(self, name: str | None) -> str | None:
        if not name:
            return None
        key = name_key(name).replace(" ", "")
        if len(key) < 3:
            return None
        for group, label in ((self.founders, FOUNDERS), (self.staff, PEOPLE)):
            for person in group:
                full = name_key(person)
                compact = full.replace(" ", "")
                first = full.split()[0] if full else ""
                # Bank fields truncate names (IMPS keeps 8 characters); a bare first name only matches a staff first name.
                if compact and (
                    compact.startswith(key)
                    and len(key) >= 6
                    or key.startswith(compact)
                    or similar(name, person) >= 0.67
                ):
                    return label
                if first and len(first) >= 4 and key == first:
                    return label
        return None


def individual(name: str | None) -> bool:
    if not name:
        return False
    words = norm_name(name).split()
    return 1 <= len(words) <= 4 and not COMPANY_WORDS.search(" ".join(words)) and all(w.isalpha() for w in words)


def classify(direction: str, text: str, people: People, hint: str | None = None) -> dict:
    """Return the storable classification for one bank line. Individual payee names are dropped here."""
    n = parse(text)
    counterparty = n.counterparty
    label = hint or ""
    if direction == "out":
        who = people.match(counterparty) or people.match(label)
        if who:
            return {
                "category": who,
                "counterparty": None,
                "kind": "individual",
                "channel": n.channel,
                "reference": n.reference,
                "invoices": n.invoices,
            }
        if individual(counterparty) and len(norm_name(counterparty).split()) >= 2:
            return {
                "category": FREELANCE,
                "counterparty": None,
                "kind": "individual",
                "channel": n.channel,
                "reference": n.reference,
                "invoices": n.invoices,
            }
        for pattern, category in VENDOR_CATEGORIES:
            if pattern.search(label) or pattern.search(text):
                return {
                    "category": category,
                    "counterparty": title_name(counterparty) if counterparty and not individual(counterparty) else None,
                    "kind": "vendor" if counterparty and not individual(counterparty) else "unknown",
                    "channel": n.channel,
                    "reference": n.reference,
                    "invoices": n.invoices,
                }
        if individual(counterparty) or (not counterparty and individual(label)):
            return {
                "category": FREELANCE,
                "counterparty": None,
                "kind": "individual",
                "channel": n.channel,
                "reference": n.reference,
                "invoices": n.invoices,
            }
        return {
            "category": "Vendors & services" if counterparty else "Unclassified payments",
            "counterparty": title_name(counterparty) if counterparty else None,
            "kind": "vendor" if counterparty else "unknown",
            "channel": n.channel,
            "reference": n.reference,
            "invoices": n.invoices,
        }
    # Inflows: client receipts unless the payer is a founder or the line returns an own payment.
    if n.channel == "RETURN":
        return {
            "category": "Returned payments",
            "counterparty": None,
            "kind": "return",
            "channel": n.channel,
            "reference": n.reference,
            "invoices": n.invoices,
        }
    payer = counterparty or (label if label and not re.search(r"[/\d]{6,}", label) else None)
    who = people.match(payer)
    if who == FOUNDERS:
        return {
            "category": "Founder transfers in",
            "counterparty": None,
            "kind": "founder",
            "channel": n.channel,
            "reference": n.reference,
            "invoices": n.invoices,
        }
    if n.channel == "CASH":
        payer, kind = "Cash deposit (payer not recorded)", "unknown"
    elif n.channel == "CHEQUE" and not payer:
        payer, kind = "Cheque (payer not recorded)", "unknown"
    else:
        kind = "client" if payer else "unknown"
    return {
        "category": CLIENT_RECEIPTS,
        "counterparty": title_name(payer) if payer and kind == "client" else payer,
        "kind": kind,
        "channel": n.channel,
        "reference": n.reference,
        "invoices": n.invoices,
    }


def line_key(direction: str, amount, reference: str | None, day: str | None, text: str) -> str:
    """Duplicate copies of one bank line across sheets share direction, amount and the bank reference token."""
    if reference:
        return digest(f"{direction}|{amount}|{reference.upper()}")
    return digest(f"{direction}|{amount}|{day}|{norm_name(text)[:60]}")


def company_name(value: str | None) -> bool:
    return bool(value) and is_company(value)
