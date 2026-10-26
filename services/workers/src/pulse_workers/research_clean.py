# ruff: noqa: E501
"""Shared cleaning rules (see ../CLEANING.md). Pure functions, no I/O."""

import difflib
import html
import re
import unicodedata
from datetime import UTC, datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))

# ---------- text ----------
HONORIFIC = re.compile(r"^\s*(mr|mrs|miss|ms|dr|shri|smt)\.?\s+", re.I)
SIR = re.compile(r"\s+(sir|ji|madam|maam|ma'am)\s*$", re.I)
COMPANY_WORDS = r"(pvt|private|ltd|limited|llp|realty|realtors|developers?|builders?|infra(structure)?|group|constructions?|properties|estates?|promoters|ventures|homes|associates|corporation|enterprises|mvpl|india)"


def fold(s):
    """lower-case, strip accents/fancy unicode, collapse spaces."""
    s = unicodedata.normalize("NFKC", html.unescape(s or ""))
    s = "".join(ch for ch in unicodedata.normalize("NFKD", s) if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", s).strip().lower()


def person_key(s):
    s = fold(s)
    s = HONORIFIC.sub("", s)
    s = SIR.sub("", s)
    s = re.sub(r"[^a-z ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


STOP = {
    "project",
    "new",
    "codename",
    "the",
    "phase",
    "ph",
    "estate",
    "autopilots",
    "ea",
    "business",
    "marathi",
    "hindi",
    "english",
    "leads",
    "lead",
    "feedback",
    "ad",
    "ads",
    "account",
    "sir",
    "mr",
    "mrs",
    "miss",
    "copy",
    "of",
}


def project_key(s):
    """normalised project key used across folders, sheets, ad accounts and campaign names."""
    s = fold(s)
    s = re.sub(r"\bphase\s*([0-9ivx]+)\b", r"ph\1", s)
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    toks = [t for t in s.split() if t not in STOP]
    return " ".join(toks)


def sim(a, b):
    return difflib.SequenceMatcher(None, a, b).ratio()


# ---------- places ----------
LOCALITY_ALIAS = {
    "poonawale": "punawale",
    "punawle": "punawale",
    "charoli": "charholi",
    "charholi bk": "charholi",
    "charholi budruk": "charholi",
    "hinjawadi": "hinjewadi",
    "hinjwadi": "hinjewadi",
    "kothud": "kothrud",
    "nodia": "noida",
    "banee": "baner",
    "pcmc": "pimpri chinchwad",
    "pimpri-chinchwad": "pimpri chinchwad",
    "wenuger pune": "wenuger",
    "moshi pune": "moshi",
    "talegaon": "talegaon dubakir",
    "ravet pune": "ravet",
    "keshavnagar": "keshav nagar",
    "baner balewadi": "baner",
    "balewadi": "baner",
}


def locality_key(s):
    s = fold(s)
    s = re.sub(r"[^a-z ]", " ", s)
    s = re.sub(r"\b(pune|road|rd|east|west|bk|budruk|khurd|phase \d|p\d)\b", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return LOCALITY_ALIAS.get(s, s)


# ---------- dates ----------
MONTHS = {
    m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)
}


def parse_ts(s):
    """ISO / Meta export timestamps → aware datetime in IST; None if absent or impossible."""
    m = re.search(r"(20\d\d)-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?(?:\.\d+)?(Z|[+-]\d\d:?\d\d)?", s or "")
    if not m:
        return None
    y, mo, d, hh, mi, ss, tz = m.groups()
    try:
        dt = datetime(int(y), int(mo), int(d), int(hh), int(mi), int(ss or 0))
    except ValueError:
        return None
    if tz in (None, "Z"):
        dt = dt.replace(tzinfo=UTC)
    else:
        sign = 1 if tz[0] == "+" else -1
        tz = tz[1:].replace(":", "")
        dt = dt.replace(tzinfo=timezone(sign * timedelta(hours=int(tz[:2]), minutes=int(tz[2:]))))
    return dt.astimezone(IST)


def parse_human_date(s):
    """'19 Apr 2025', 'Nov 16, 2025', '12 Feb 2026' → date."""
    s = s or ""
    m = re.search(r"(\d{1,2}) ([A-Za-z]{3})[a-z]* (20\d\d)", s)
    if m:
        d, mo, y = m.groups()
    else:
        m = re.search(r"([A-Za-z]{3})[a-z]* (\d{1,2}),? (20\d\d)", s)
        if not m:
            return None
        mo, d, y = m.groups()
    mo = MONTHS.get(mo.lower()[:3])
    if not mo:
        return None
    try:
        return datetime(int(y), mo, int(d)).date()
    except ValueError:
        return None


# ---------- creatives (ad names, file names) ----------
CREATIVE_RULES = [  # (type, regex) first match wins; ids captured where present
    ("no_hook", r"\bno[ -]?hooks?\b"),
    ("all_hooks", r"\ball[ -]?hooks?\b"),
    ("vov", r"\bvov\s*#?\s*(\d+)?"),
    ("model_video", r"\b(model\s*video|mv)\s*#?\s*(\d+)?"),
    ("teaser", r"\bteaser\s*#?\s*(\d+)?"),
    ("walkthrough", r"\b(walk ?through|sample flat|site tour)\b"),
    ("testimonial", r"\btestimonial"),
    ("founder", r"\b(founder|cmd|director)\b"),
    ("cp_video", r"\bcp (video|meet)\b"),
    ("carousel", r"\b(carousel|carousal|crsl)\b\s*#?\s*(\d+)?"),
    ("reel", r"\breels?\b\s*#?\s*(\d+)?"),
    ("hook", r"\b(hook|h)\s*#?\s*(\d+(?:\.\d+)?)\b"),
    ("image_ad", r"\b(img|image|static|creative|post|banner|single image|si)\s*#?\s*(\d+)?\b"),
    ("video", r"\b(video|vid)\s*#?\s*(\d+)?\b"),
]
LANG_RULES = [
    ("marathi", r"marathi|marthi|मराठी|\bmr\b"),
    ("hindi", r"hindi|\bhind\b|हिंदी|\bhi\b"),
    ("english", r"english|\beng\b|\ben\b"),
]


def creative(name):
    """ad name / campaign segment → (type, number, language). Unknown stays 'unknown'."""
    s = fold(name)
    s = s.replace("_", " ")
    ctype, num = "unknown", ""
    for t, rx in CREATIVE_RULES:
        m = re.search(rx, s)
        if m:
            ctype = t
            nums = [g for g in m.groups() if g and re.fullmatch(r"\d+(\.\d+)?", g)]
            num = nums[0] if nums else ""
            break
    if ctype == "unknown" and re.fullmatch(r"(h|c|i|v)\s*\d+.*", s):
        ctype = {"h": "hook", "c": "carousel", "i": "image_ad", "v": "video"}[s[0]]
    lang = next((language for language, rx in LANG_RULES if re.search(rx, s)), "")
    return ctype, num, lang
