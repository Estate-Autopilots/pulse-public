# ruff: noqa: E501
"""Shared parsing for live finance sources: Indian amounts, dates, months, names and provenance."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

HIGH, MEDIUM, LOW = "high", "medium", "low"
CONFIDENCE_RANK = {HIGH: 3, MEDIUM: 2, LOW: 1}
MONTHS = {
    m: i + 1
    for i, names in enumerate(
        [
            ("jan", "january"),
            ("feb", "february"),
            ("mar", "march"),
            ("apr", "april", "aprl"),
            ("may",),
            ("jun", "june"),
            ("jul", "july"),
            ("aug", "august"),
            ("sep", "sept", "september"),
            ("oct", "october"),
            ("nov", "november"),
            ("dec", "december"),
        ]
    )
    for m in names
}
COMPANY_WORDS = re.compile(
    r"\b(LLP|PVT|PRIVATE|LTD|LIMITED|LIMI|DEVELOPERS?|DEVELOPMENTS?|REALTY|REALTORS?|REALITIES|INFRA+|INFRASTRUCTURE|"
    r"PROPERT(Y|IES)|CONSTRUCTIONS?|BUILDCON|BUILDTECH|BUILDERS?|HOMES?|ESTATES?|GROUP|ASSOCIATES|ENTERPRISES?|"
    r"VENTURES?|SOLUTIONS?|SERVICES?|TECHNOLOGIES|TECH|CORPORATION|CORP|INC|COMPANY|CO|PROMOTERS|LANDMARKS?|"
    r"SPACES?|LIFESPACES?|HOUSING|INDUSTRIES|TRADERS|AGENCY|MEDIA|DIGITAL|INTERIORS|PROJECTS?|AOP|FARMS?|"
    r"CONSULTANTS?|CONSULTANCY|MARKETING|STUDIOS?|FOUNDATION|TRUST|BANK|INSURANCE|SOCIETY|HOSPITALITY|"
    r"CAPITAL|FINANCE|FINPROP|MANAGEMENT|RESIDENCY|CITY|HEIGHTS|PARK|COMMERCIAL|DESIGNATE|RERA|AIRTEL|GOOGLE|"
    r"FACEBOOK|META|AMAZON|ZOHO|HOSTINGER|CLOUDFLARE|ANTHROPIC|OPENAI|ADOBE|CANVA|MAKE|NETLIFY|HATHWAY)\b",
    re.I,
)


def digest(value: bytes | str) -> str:
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def stable_hash(value) -> str:
    return digest(json.dumps(value, sort_keys=True, default=str, ensure_ascii=False))


def money(value) -> Decimal | None:
    """Indian-format amounts ("1,10,000.00", "₹27,140.00", 23000.0, "1,19,787.00") to Decimal; else None."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        try:
            result = Decimal(str(value))
        except InvalidOperation:
            return None
        return result.quantize(Decimal("0.01"), ROUND_HALF_UP) if result.is_finite() else None
    text = str(value).strip().replace("₹", "").replace("Rs.", "").replace("Rs", "").replace("INR", "").strip()
    text = re.sub(r"\s+", "", text)
    if not re.fullmatch(r"-?\d[\d,]*(\.\d+)?", text):
        return None
    try:
        return Decimal(text.replace(",", "")).quantize(Decimal("0.01"), ROUND_HALF_UP)
    except InvalidOperation:
        return None


def number(value) -> float | None:
    result = money(value)
    return float(result) if result is not None else None


def as_date(value, *, dayfirst: bool = True) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if value is None:
        return None
    text = str(value).strip()
    match = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?", text)
    if match:
        y, m, d = map(int, match.groups())
    else:
        match = re.fullmatch(r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})", text)
        if not match:
            match = re.fullmatch(r"(\d{1,2})[- ]([A-Za-z]{3,9})[- ,]+(\d{2,4})", text)
            if not match or match.group(2).lower() not in MONTHS:
                return None
            d, m, y = int(match.group(1)), MONTHS[match.group(2).lower()], int(match.group(3))
        else:
            a, b, y = map(int, match.groups())
            d, m = (a, b) if dayfirst else (b, a)
        if y < 100:
            y += 2000
    try:
        return date(y, m, d)
    except ValueError:
        return None


def month_of(value) -> str | None:
    day = as_date(value)
    return day.isoformat()[:7] if day else None


def tab_month(title: str, default_year: int | None) -> str | None:
    """Month from a tab name like "Jan", "aug 25", "June 26", "Sep 2025", "July 2025", " Nov 2025"."""
    match = re.fullmatch(r"\s*([A-Za-z]+)\.?\s*(\d{2,4})?\s*", title or "")
    if not match or match.group(1).lower() not in MONTHS:
        return None
    year = int(match.group(2)) if match.group(2) else default_year
    if year is None:
        return None
    if year < 100:
        year += 2000
    return f"{year:04d}-{MONTHS[match.group(1).lower()]:02d}"


def fiscal_year(day: str) -> str:
    year, month = int(day[:4]), int(day[5:7])
    start = year if month >= 4 else year - 1
    return f"FY{start}-{str(start + 1)[2:]}"


def month_range(first: str, last: str) -> list[str]:
    out, year, month = [], int(first[:4]), int(first[5:7])
    while f"{year:04d}-{month:02d}" <= last:
        out.append(f"{year:04d}-{month:02d}")
        month += 1
        if month == 13:
            year, month = year + 1, 1
    return out


def add_months(day: date, months: int) -> date:
    month = day.month - 1 + months
    year = day.year + month // 12
    month = month % 12 + 1
    last = (date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)).day
    return date(year, month, min(day.day, last))


def norm_name(value) -> str:
    text = re.sub(r"[^A-Za-z0-9 ]+", " ", str(value or "")).upper()
    text = re.sub(r"\b(MR|MRS|MS|MISS|DR|M S|MESSRS)\b", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def title_name(value) -> str:
    words = norm_name(value).split()
    keep = {"LLP", "AOP", "RERA", "GS", "SPB", "RPD", "SBS", "HR", "IT", "AI", "PVT", "LTD", "CP"}
    return " ".join(
        w if w in keep or len(w) <= 2 and w.isalpha() and w not in ("OF", "AND") else w.title() for w in words
    )


def is_company(name: str) -> bool:
    return bool(COMPANY_WORDS.search(norm_name(name)))


def name_key(value) -> str:
    """Comparison key: drops legal suffixes and filler words so 'Basil Avante LLP' ~ 'BASIL AVANTE'."""
    words = [
        w
        for w in norm_name(value).split()
        if w
        not in {
            "LLP",
            "PVT",
            "PRIVATE",
            "LTD",
            "LIMITED",
            "THE",
            "AND",
            "OF",
            "M",
            "S",
            "C",
            "RERA",
            "DESIG",
            "DESIGNATE",
        }
    ]
    return " ".join(words)


def similar(a: str, b: str) -> float:
    """Token overlap of two name keys. Bank fields truncate and abbreviate names ('SEFAVIB DIAMOND DEVELOPERS C',
    'BUVATUR COMMERCIAL DEV COMPA'), so a token of 3+ letters matches the token it begins, and a trailing one-letter
    fragment is ignored."""
    x, y = name_key(a).split(), name_key(b).split()
    x = x[:-1] if len(x) > 1 and len(x[-1]) == 1 else x
    y = y[:-1] if len(y) > 1 and len(y[-1]) == 1 else y
    if not x or not y:
        return 0.0
    hits = 0
    for word in x:
        if any(
            word == other or (min(len(word), len(other)) >= 3 and (word.startswith(other) or other.startswith(word)))
            for other in y
        ):
            hits += 1
    return hits / max(len(x), len(y))


def lowest(*levels: str) -> str:
    present = [level for level in levels if level in CONFIDENCE_RANK]
    return min(present, key=CONFIDENCE_RANK.__getitem__) if present else LOW


def rupees(value: Decimal | float | None) -> float | None:
    return None if value is None else float(Decimal(str(value)).quantize(Decimal("0.01"), ROUND_HALF_UP))
