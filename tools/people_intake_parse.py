"""SELLER-ONBOARD (owner, 17 Nov 2026): read people's details out of whatever someone sends: rows pasted from a sheet
(tabs), a pipe or CSV table, "Name: …" blocks, a free list ("1. Ruvin Durineho - 98765 43210 - user-33a81669@gmail.com - …"),
the words a photo of a written list gives (OCR), a CSV or Excel file, or a doc's table. Each person becomes one row of
the nine details a people intake collects, with what is wrong or missing said per row:

  name · phone (WhatsApp) · email (the Google account on their phone) · role · active + joining date · reports to ·
  city / area · languages · Android + model

Pure and offline (standard library only: the Excel reader is a small zip + XML reader), so it is tested on its own
(tests/core/test_people_intake_parse.py). tools/people-intake.py feeds it and posts the preview; nothing here decides
who is added: the API matches the rows against People and an approver confirms.
"""
from __future__ import annotations

import csv
import html as htmlmod
import io
import re
import unicodedata
import zipfile
from datetime import date, timedelta
from html.parser import HTMLParser
from xml.etree import ElementTree

MAX_ROWS = 300

# Column headings, checked in this order (the more specific first: "Phone: Android? + model" is the phone's model,
# "Reports to (manager's name)" is the manager, not the name).
HEADINGS = [
    ("n", [r"^#$", r"^s\.? ?no\.?$", r"^sr\.? ?no\.?$", r"^no\.?$", r"^serial", r"^sl\.? ?no"]),
    ("android", [r"android", r"\bmodel\b", r"handset", r"\bdevice\b", r"which phone", r"smart ?phone"]),
    ("email", [r"g ?mail", r"e-? ?mail", r"\bmail\b", r"google", r"ई-?मेल", r"जीमेल"]),
    ("reportsTo", [r"report", r"manager", r"\btl\b", r"team ?lead", r"\bsenior\b", r"\bunder\b", r"\bboss\b", r"reporting"]),
    ("active", [r"active", r"status", r"working", r"current"]),
    ("joined", [r"join", r"\bdoj\b", r"\bsince\b", r"start"]),
    ("area", [r"city", r"area", r"location", r"territory", r"region", r"\bzone\b", r"cover", r"शहर", r"भाग"]),
    ("languages", [r"language", r"bhasha", r"भाषा", r"speak", r"lang\b"]),
    ("role", [r"\brole\b", r"designation", r"position", r"\bpost\b", r"\btitle\b", r"\bपद\b", r"type"]),
    ("phone", [r"mobile", r"phone", r"whats ?app", r"\bnumber\b", r"\bno\b", r"contact", r"\bcell\b", r"मोबा", r"फोन", r"नंबर", r"क्रमांक"]),
    ("name", [r"name", r"naam", r"नाव", r"नाम", r"seller", r"employee", r"person", r"staff"]),
]
ROLES = [
    ("owner_admin", r"owner|admin|director|founder|partner|proprietor|md\b|ceo|malik|मालक|मालिक"),
    ("manager", r"manager|\basm\b|\brsm\b|\bbm\b|head|incharge|in-charge|mgr|व्यवस्थापक"),
    ("team_lead", r"team ?lead|team ?leader|\btl\b|\blead\b|supervisor|captain"),
    ("sales_executive", r"sales ?exec|executive|\bse\b|\bexec\b|sales ?person|salesman|sales ?rep|\brep\b|field|telecaller|tele-caller|caller|seller|agent|associate|^sales$"),
]
YES = r"^(y|yes|yeah|yep|haan|ha|han|hoy|ho|active|working|current|currently working|true|1|✓|✔|हाँ|हां|हो)$"
NO = r"^(n|no|nope|nahi|nahin|na|inactive|left|resigned|quit|not active|not working|false|0|✗|✘|नाही|नहीं)$"
LANGUAGES = {
    "hindi": "Hindi", "hin": "Hindi", "हिंदी": "Hindi", "हिन्दी": "Hindi", "marathi": "Marathi", "mar": "Marathi", "मराठी": "Marathi",
    "english": "English", "eng": "English", "en": "English", "इंग्रजी": "English", "अंग्रेजी": "English", "अंग्रेज़ी": "English",
    "gujarati": "Gujarati", "kannada": "Kannada", "telugu": "Telugu", "tamil": "Tamil", "urdu": "Urdu", "bengali": "Bengali", "bangla": "Bengali",
    "pokazam": "Pokazam", "konkani": "Konkani", "malayalam": "Malayalam", "odia": "Odia", "oriya": "Odia", "sindhi": "Sindhi", "marwari": "Marwari",
}
ANDROID = r"android|samsung|galaxy|redmi|xiaomi|\bmi\b|poco|realme|oppo|vivo|one ?plus|motorola|\bmoto\b|nokia|iqoo|infinix|tecno|itel|lava|micromax|pixel|honor|huawei|nothing phone|asus|lenovo|narzo|nord"
IPHONE = r"iphone|apple|\bios\b"
PLACES = r"pune|pimpri|chinchwad|pcmc|mumbai|thane|navi mumbai|nashik|nagpur|aurangabad|subosobu|kolhapur|satara|sipizo|solapur|ahmednagar|ahilyanagar|lonavala|baramati|kothrud|hadapsar|wakad|baner|hinjewadi|kharadi|viman nagar|wenuger|katraj|warje|aundh|camp|shivaji ?nagar|swargate|bhosari|nigdi|ravet|moshi|chakan|talegaon|delhi|bangalore|bengaluru|hyderabad|ahmedabad|surat|goa|indore|\bnagar\b|\broad\b|\bpeth\b|\bwadi\b|\bgaon\b|\bcity\b|district|taluka|east|west|north|south|\barea\b"
MONTHS = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+")
PHONE = re.compile(r"(?<![\w@])(?:\+?\d[\d \-().]{8,18}\d)(?![\w@])")
# "Label: value"; a hint in brackets inside the label ("Gmail jo unke phone pe chalta hai (Sales X-Ray tester list aur
# Pulse sign-in ke liye) : …", as the list is asked for in the chat) does not count towards its length.
KV = re.compile(r"^\s*([^\W\d_](?:\([^():=\n]{0,90}\)|[^:=]){0,38}?)\s*[:=]\s*(.*)$", re.UNICODE)
GMAIL_TYPOS = re.compile(r"@(gmai1|gmal|gmial|gmall|gmaill|gnail|grnail|gmail\.co|gmaii|gamil|gmeil|gmali)(\.com)?$", re.I)


def clean(s: object) -> str:
    t = unicodedata.normalize("NFKC", str(s if s is not None else ""))
    t = re.sub(r"[​-‏⁠﻿]", "", t).replace(" ", " ")
    return re.sub(r"[ \t]+", " ", t).strip()


def line_of(s: str) -> str:
    """One line as sent: Unicode tidied, invisible characters gone, but tabs and runs of spaces kept (they separate
    columns in a pasted sheet and in a photo's words)."""
    t = unicodedata.normalize("NFKC", str(s if s is not None else ""))
    return re.sub(r"[\u200b-\u200f\u2060\ufeff]", "", t).replace("\u00a0", " ").rstrip()


def key(s: str) -> str:
    t = unicodedata.normalize("NFKD", clean(s).lower())
    t = "".join(ch for ch in t if not unicodedata.combining(ch))
    return re.sub(r"[^\w]+", " ", t).strip()


def heading(cell: str) -> str | None:
    k = clean(re.sub(r"\([^()]*\)", " ", clean(cell))).lower() or clean(cell).lower()  # "Calling languages (Hindi / …)"
    if not k or len(k) > 60 or EMAIL.search(k) or len(re.sub(r"\D", "", k)) >= 6:
        return None
    for field, pats in HEADINGS:
        if any(re.search(p, k) for p in pats):
            if field == "active" and re.search(r"join|since|date|doj", k):
                return "active+joined"
            if field == "phone" and re.search(r"android|model", k):
                return "android"
            return field
    return None


# ------------------------------------------------------------------------------------------------------- values
def phone_of(raw: str) -> tuple[str | None, str | None]:
    """(+91 98765 43210, None) or (None, why). Ten digits from 6-9 are an Indian mobile; 0 or 91 in front are dropped."""
    t = clean(raw)
    if not t:
        return None, None
    d = re.sub(r"\D", "", t)
    if t.startswith("+") and not d.startswith("91") and 8 <= len(d) <= 15:
        return "+" + d, None
    if len(d) == 12 and d.startswith("91"):
        d = d[2:]
    elif len(d) == 11 and d.startswith("0"):
        d = d[1:]
    elif len(d) == 13 and d.startswith("091"):
        d = d[3:]
    if len(d) == 10 and d[0] in "6789":
        return f"+91 {d[:5]} {d[5:]}", None
    return None, f"check the number “{t}” ({len(d)} digits)"


def email_of(raw: str) -> tuple[str | None, str | None]:
    m = EMAIL.search(clean(raw).replace(" ", "") if "@" in raw else clean(raw))
    if not m:
        return None, None
    e = m.group(0).strip(".").lower()
    fixed = GMAIL_TYPOS.sub("@gmail.com", e)
    if fixed != e:
        return fixed, f"read as {fixed} (it looked like {e}): check it"
    return e, None


def role_of(raw: str) -> tuple[str | None, str | None]:
    k = key(raw)
    if not k:
        return None, None
    for role, pat in ROLES:
        if re.search(pat, k):
            return role, clean(raw)
    return None, clean(raw)[:80]


def yes_no(raw: str) -> bool | None:
    k = key(raw)
    if re.match(YES, k):
        return True
    if re.match(NO, k):
        return False
    return None


def date_of(raw: str) -> str | None:
    """12/08/2025, 12-8-25, 2025-08-12, 12 Aug 2025, Aug 2025 (the 1st), an Excel day number."""
    t = clean(raw).lower().replace(",", " ")
    if not t:
        return None
    if re.fullmatch(r"\d{5}(\.0+)?", t) and 20000 < float(t) < 60000:
        return (date(1899, 12, 30) + timedelta(days=int(float(t)))).isoformat()
    m = re.search(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b", t)
    if m:
        y, mo, d = int(m[1]), int(m[2]), int(m[3])
    else:
        m = re.search(r"\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b", t)
        if m:
            d, mo, y = int(m[1]), int(m[2]), int(m[3])
        else:
            m = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)?\s*([a-z]{3,9})\.?\s*(\d{2,4})\b", t)
            if m and m[2][:3] in MONTHS:
                d, mo, y = int(m[1]), MONTHS[m[2][:3]], int(m[3])
            else:
                m = re.search(r"\b([a-z]{3,9})\.?\s*(\d{1,2})?(?:st|nd|rd|th)?\s*[\s']\s*(\d{2,4})\b", t)
                if not m or m[1][:3] not in MONTHS:
                    return None
                d, mo, y = int(m[2] or 1), MONTHS[m[1][:3]], int(m[3])
    if y < 100:
        y += 2000
    try:
        v = date(y, mo, d)
    except ValueError:
        return None
    return v.isoformat() if date(1990, 1, 1) <= v <= date.today() + timedelta(days=60) else None


def languages_of(raw: str) -> list[str]:
    out: list[str] = []
    for part in re.split(r"[,/&+|;]|\band\b|\s+", clean(raw), flags=re.I):
        p = key(part)
        if not p:
            continue
        name = LANGUAGES.get(p) or LANGUAGES.get(clean(part))
        if name and name not in out:
            out.append(name)
    return out[:8]


def only_languages(raw: str) -> bool:
    parts = [key(p) for p in re.split(r"[,/&+|;]|\band\b|\s+", clean(raw), flags=re.I) if key(p)]
    return bool(parts) and all(p in LANGUAGES or clean(p) in LANGUAGES for p in parts)


def android_of(raw: str) -> tuple[bool | None, str | None]:
    t = clean(raw)
    k = t.lower()
    if not k:
        return None, None
    yn = yes_no(re.split(r"[,(\-–:]", k)[0])
    rest = re.sub(r"^\s*(yes|no|y|n|haan|ha|nahi|android)\b[\s,:\-–()]*", "", t, flags=re.I).strip(" ()")
    if re.search(IPHONE, k):
        return False, t[:60]
    model = rest if rest and yes_no(rest) is None else None
    if yn is not None:
        return yn, (model[:60] if model else None)
    if re.search(ANDROID, k):
        return True, (rest or t)[:60]
    return None, (t[:60] if t else None)


def name_of(raw: str) -> str | None:
    t = clean(re.sub(r"^\s*(\d{1,3}[.)]|[-*•·])\s*", "", raw)).strip(" .,-:")
    t = re.sub(r"^(mr|mrs|ms|miss|shri|smt|sri)\.?\s+", "", t, flags=re.I)
    if not t or re.search(r"\d|@", t) or len(t) > 80:
        return None
    letters = [ch for ch in t if ch.isalpha()]
    if len(letters) < 2:
        return None
    if t.isascii() and (t.isupper() or t.islower()):
        t = " ".join(w.capitalize() for w in t.split())
    return t


def looks_like_name(t: str) -> bool:
    n = name_of(t)
    return bool(n) and 1 <= len(n.split()) <= 4 and not re.search(PLACES, n.lower()) and role_of(n)[0] is None and yes_no(n) is None \
        and not only_languages(n) and not re.search(ANDROID + "|" + IPHONE, n.lower())


# -------------------------------------------------------------------------------------------------------- rows
def empty() -> dict:
    return {"name": None, "phone": None, "email": None, "role": None, "active": None, "joined": None, "reportsTo": None,
            "area": None, "languages": None, "android": None}


def put(raw: dict, field: str, value: str) -> None:
    value = clean(value)
    if not value:
        return
    if field == "active+joined":
        put(raw, "active", value)
        put(raw, "joined", value)
        return
    if field == "n":
        return
    if field == "phone" and not re.search(r"\d{5}", value) and (re.search(ANDROID + "|" + IPHONE, value.lower()) or yes_no(value.split()[0]) is not None):
        field = "android"
    if raw.get(field):
        raw[field] = f"{raw[field]}, {value}" if field in ("area", "languages") else raw[field]
    else:
        raw[field] = value


MONTH_WORD = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?"
PIECES = [
    EMAIL,
    re.compile(r"(?<![\w@])\+?\d[\d \-]{8,16}\d(?![\w@])"),
    re.compile(r"\b\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b|\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+" + MONTH_WORD + r"\s+\d{2,4}\b|\b" + MONTH_WORD + r"\s+\d{4}\b", re.I),
    re.compile(r"\b(?:" + ANDROID + "|" + IPHONE + r")\b(?:\s+(?:" + ANDROID + r"|[a-z]*\d[\w+]*|note|pro|plus|max|lite|ultra|prime|neo|play|power|mini|edge|nord|galaxy|5g)\b){0,3}", re.I),
    re.compile(r"\b(?:sales\s*executive|sales\s*exec|sales\s*person|salesman|team\s*lead(?:er)?|tele-?caller|manager|asm|owner|admin|director|executive)\b", re.I),
    re.compile(r"\bTL\b"),
    re.compile(r"\b(?:hindi|marathi|english|gujarati|kannada|telugu|tamil|urdu|bengali|pokazam|konkani|malayalam)\b|हिंदी|हिन्दी|मराठी|इंग्रजी|अंग्रेजी", re.I),
    re.compile(r"\b(?:yes|no|haan|nahi|active|inactive|left)\b", re.I),
]


LABELLED = r"^(joined|joining|doj|since|active since|working since|reports? to|reporting to|under|manager\s*[:\-–]|mgr|tl\s*[:\-–]|team lead\s*[:\-–]|r/t)\b"


def explode(t: str) -> list[str]:
    """A run of words with no separators (a photo's line, "Kedab Putig 98765 43210 user-08d25d17@gmail.com Sales exec Yes")
    as the pieces it holds, in order: what is between them stays together (a name, an area)."""
    if len(t.split()) < 3 or re.match(LABELLED, t, re.I):
        return [t]
    spans: list[tuple[int, int]] = []
    for rx in PIECES:
        for m in rx.finditer(t):
            if rx.pattern.startswith("(?<![\\w@])") and len(re.sub(r"\D", "", m.group(0))) < 10:
                continue
            if not any(m.start() < e and s < m.end() for s, e in spans):
                spans.append((m.start(), m.end()))
    if not spans:
        return [t]
    out, at = [], 0
    for s, e in sorted(spans):
        if t[at:s].strip(" ,-–:()"):
            out.append(t[at:s].strip(" ,-–:()"))
        out.append(t[s:e])
        at = e
    if t[at:].strip(" ,-–:()"):
        out.append(t[at:].strip(" ,-–:()"))
    return out


def classify(tokens: list[str], raw: dict | None = None) -> dict:
    """Free tokens of one person, each to the detail it looks like; text left over is the manager (a person's name)
    or the area, in the order the details are asked."""
    raw = raw if raw is not None else empty()
    leftovers: list[str] = []
    pieces: list[str] = []
    for tok in tokens:
        t = clean(tok)
        kv = KV.match(t)
        pieces += [t] if (kv and heading(kv[1])) else explode(t)
    for tok in pieces:
        t = clean(tok)
        if not t:
            continue
        kv = KV.match(t)
        if kv and heading(kv[1]) and kv[2].strip():
            put(raw, heading(kv[1]), kv[2])
            continue
        m = EMAIL.search(t)
        if m:
            put(raw, "email", m.group(0))
            t = clean(t.replace(m.group(0), " ")).strip(" ,-–:()")
            if not t:
                continue
        p = PHONE.search(t)
        if p and len(re.sub(r"\D", "", p.group(0))) >= 10:
            put(raw, "phone", p.group(0))
            t = clean(t.replace(p.group(0), " ")).strip(" ,-–:()")
            if not t:
                continue
        lower = t.lower()
        rt = re.match(r"^(reports? to|reporting to|under|manager|mgr|tl|team lead|r/t)\s*[:\-–]?\s+(.+)$", t, re.I)
        if rt:
            put(raw, "reportsTo", rt[2])
            continue
        if re.match(r"^(joined|joining|doj|since|active since|working since)\b", lower) and date_of(t):
            if re.match(r"^(active|working)", lower):
                put(raw, "active", "yes")
            put(raw, "joined", t)
            continue
        if re.search(ANDROID + "|" + IPHONE, lower) and not raw.get("android"):
            put(raw, "android", t)
            continue
        yn = yes_no(re.split(r"[\s,]", lower)[0]) if lower else None
        if yn is not None and len(t.split()) <= 6:
            rest = clean(re.sub(r"^\S+[\s,]*", "", t))
            if raw.get("active") is None:
                put(raw, "active", t.split()[0])
                if rest and date_of(rest):
                    put(raw, "joined", rest)
                elif rest and re.search(ANDROID + "|" + IPHONE, rest.lower()):
                    put(raw, "android", t)
            elif raw.get("android") is None:
                put(raw, "android", t)
            continue
        if date_of(t) and not raw.get("joined"):
            put(raw, "joined", t)
            continue
        if only_languages(t):
            put(raw, "languages", t)
            continue
        if role_of(t)[0] and len(t.split()) <= 4 and not raw.get("role"):
            put(raw, "role", t)
            continue
        leftovers.append(t)
    for t in leftovers:
        if not raw.get("name") and looks_like_name(t):
            raw["name"] = t
        elif not raw.get("reportsTo") and looks_like_name(t) and not re.search(PLACES, t.lower()):
            raw["reportsTo"] = t
        else:
            put(raw, "area", t)
    return raw


def table_rows(cells: list[list[str]]) -> list[dict]:
    """A table (sheet, CSV, pipes, a doc): by its headings when it has them, else each row read as free tokens."""
    rows = [[clean(c) for c in r] for r in cells if any(clean(c) for c in r)]
    if not rows:
        return []
    head_at, head = None, None
    for i, r in enumerate(rows[:5]):
        fields = [heading(c) for c in r]
        named = {f for f in fields if f and f != "n"}
        if len(named) >= 2 and not any(EMAIL.search(c) or len(re.sub(r"\D", "", c)) >= 10 for c in r):
            head_at, head = i, fields
            break
    out = []
    for r in rows[(head_at + 1) if head_at is not None else 0:]:
        if head:
            raw = empty()
            spill = []
            for i, c in enumerate(r):
                f = head[i] if i < len(head) else None
                if f:
                    put(raw, f, c)
                elif c:
                    spill.append(c)
            if spill:
                classify(spill, raw)
        else:
            raw = classify(r)
        out.append(raw)
    return out


def blocks_of(text: str) -> list[dict] | None:
    """"Name: Ruvin" … lines, one person per block (a blank line or the next "Name:" starts the next)."""
    lines = [clean(l) for l in text.split("\n")]
    hits = [l for l in lines if KV.match(l) and heading(KV.match(l)[1])]
    if len(hits) < 2:
        return None
    out, cur = [], empty()
    for l in lines:
        m = KV.match(l) if l else None
        f = heading(m[1]) if m else None
        if not l or (f == "name" and cur.get("name")):
            if any(cur.values()):
                out.append(cur)
            cur = empty()
            if not l:
                continue
        if f:
            put(cur, f, m[2])
        else:
            classify([l], cur)
    if any(cur.values()):
        out.append(cur)
    return out


def lines_of(text: str, ocr: bool = False) -> list[dict]:
    """A free list: a person per line, or (a photo, a phone's notes) a person over a few lines."""
    split = r"\s*(?:\||;|\t| - | – | — |,(?!\d{3}))\s*" + (r"|\s{2,}" if ocr else "")
    out, cur = [], None
    for line in text.split("\n"):
        line = re.sub(r"^\s*(\d{1,3}[.)]|[-*•·])\s+", "", line_of(line)).strip()
        if not line:
            if cur and any(cur.values()):
                out.append(cur)
            cur = None
            continue
        tokens = [clean(t) for t in re.split(split, line) if clean(t)]
        got = classify(tokens)
        if cur is None or (not (cur.get("name") or cur.get("phone") or cur.get("email")) and got.get("name") and (got.get("phone") or got.get("email"))):
            cur = got
            continue
        starts_new = got.get("name") and cur.get("name") and (cur.get("phone") or cur.get("email"))
        if starts_new or (got.get("phone") and cur.get("phone")) or (got.get("email") and cur.get("email")):
            out.append(cur)
            cur = got
        else:
            for k, v in got.items():
                if v and not cur.get(k):
                    cur[k] = v
                elif v and k == "area":
                    put(cur, k, v)
    if cur and any(cur.values()):
        out.append(cur)
    return out


def text_rows(text: str, ocr: bool = False) -> list[dict]:
    text = "\n".join(line_of(l) for l in str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"))
    raw_lines = [l for l in text.split("\n") if l.strip()]
    if sum("\t" in l for l in raw_lines) >= 2:
        return table_rows([l.split("\t") for l in raw_lines])
    if sum(l.strip().startswith("|") for l in raw_lines) >= 2:
        cells = [[c for c in l.strip().strip("|").split("|")] for l in raw_lines if l.strip().startswith("|")]
        return table_rows([r for r in cells if not all(re.fullmatch(r"\s*:?-{2,}:?\s*", c) for c in r)])
    if len(raw_lines) >= 2 and all(l.count(",") >= 3 for l in raw_lines[:3]) and heading(raw_lines[0].split(",")[0]):
        return table_rows(list(csv.reader(io.StringIO("\n".join(raw_lines)))))
    blocks = blocks_of(text)
    if blocks is not None:
        return blocks
    return lines_of(text, ocr=ocr)


# -------------------------------------------------------------------------------------------------------- files
def csv_rows(data: bytes) -> list[dict]:
    for enc in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        return []
    sample = text[:4000]
    delim = max([",", ";", "\t"], key=sample.count)
    return table_rows(list(csv.reader(io.StringIO(text), delimiter=delim)))


def xlsx_cells(data: bytes) -> list[list[str]]:
    """The first sheet of an .xlsx as text cells (shared and inline strings, numbers as written: a 10-digit number
    stays 9876543210, not 9.87E9)."""
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main", "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = set(z.namelist())
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            for si in ElementTree.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{ns['m']}}}t")))
        sheet = "xl/worksheets/sheet1.xml"
        if "xl/workbook.xml" in names and "xl/_rels/workbook.xml.rels" in names:
            wb = ElementTree.fromstring(z.read("xl/workbook.xml"))
            first = wb.find("m:sheets/m:sheet", ns)
            rels = ElementTree.fromstring(z.read("xl/_rels/workbook.xml.rels"))
            rid = first.get(f"{{{ns['r']}}}id") if first is not None else None
            for rel in rels:
                if rel.get("Id") == rid:
                    target = rel.get("Target", "").lstrip("/")
                    sheet = target if target.startswith("xl/") else "xl/" + target
        if sheet not in names:
            return []
        out: list[list[str]] = []
        for row in ElementTree.fromstring(z.read(sheet)).iter(f"{{{ns['m']}}}row"):
            cells: dict[int, str] = {}
            for c in row.findall("m:c", ns):
                ref = c.get("r", "")
                col = 0
                for ch in re.match(r"[A-Z]*", ref).group(0):
                    col = col * 26 + ord(ch) - 64
                kind, v = c.get("t"), c.find("m:v", ns)
                if kind == "s" and v is not None:
                    text = shared[int(v.text)]
                elif kind == "inlineStr":
                    text = "".join(t.text or "" for t in c.iter(f"{{{ns['m']}}}t"))
                else:
                    text = v.text if v is not None and v.text else ""
                    if re.fullmatch(r"-?\d+\.0+", text) or re.fullmatch(r"\d+(\.\d+)?E\+?\d+", text, re.I):
                        try:
                            text = str(int(float(text)))
                        except ValueError:
                            pass
                cells[max(col - 1, len(cells) if not ref else col - 1)] = text
            if cells:
                out.append([cells.get(i, "") for i in range(max(cells) + 1)])
            if len(out) > MAX_ROWS + 5:
                break
        return out


class _Tables(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables: list[list[list[str]]] = []
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.tables.append([])
        elif tag == "tr" and self.tables:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []
        elif tag in ("br", "p", "div", "li") and self._cell is not None:
            self._cell.append(" ")

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._row is not None and self._cell is not None:
            self._row.append(clean("".join(self._cell)))
            self._cell = None
        elif tag == "tr" and self._row is not None and self.tables:
            self.tables[-1].append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def doc_rows(body_html: str) -> list[dict]:
    """The doc's table whose headings name the details (at least four of them); an example table is not read."""
    p = _Tables()
    p.feed(htmlmod.unescape(body_html or "") if "&lt;table" in (body_html or "") else (body_html or ""))
    for t in p.tables:
        if not t:
            continue
        fields = {heading(c) for c in t[0]} - {None, "n"}
        if len(fields) >= 4 and "name" in fields:
            return table_rows(t)
    return []


# ------------------------------------------------------------------------------------------------- the 9 details
def finish(raws: list[dict]) -> list[dict]:
    """Raw texts to the intake's rows: values cleaned, what is wrong said per row (block: not added; warn: added, with
    something missing; info: worth knowing), a number or Gmail that repeats an earlier row blocked."""
    rows, seen_phone, seen_email = [], {}, {}
    for raw in raws[:MAX_ROWS]:
        problems: list[dict] = []
        say = lambda level, code, text: problems.append({"level": level, "code": code, "text": text})  # noqa: E731
        name = name_of(raw.get("name") or "")
        phone, why_phone = phone_of(raw.get("phone") or "")
        email, why_email = email_of(raw.get("email") or "")
        if not (name or phone or email):
            continue
        role_key, role_text = role_of(raw.get("role") or "")
        active = yes_no((raw.get("active") or "").split(",")[0].split()[0] if raw.get("active") else "")
        if active is None and raw.get("active") and re.search(r"\bactive\b|\bworking\b", raw["active"].lower()) and not re.search(r"\b(not|in)active|left", raw["active"].lower()):
            active = True
        joined_raw = raw.get("joined") or ""
        joined = date_of(joined_raw)
        if active is None and joined and raw.get("active") == joined_raw:
            active = True  # only a date given for "Active? + joining date": active since then
        android, model = android_of(raw.get("android") or "")
        langs = languages_of(raw.get("languages") or "")
        reports = name_of(raw.get("reportsTo") or "") or (clean(raw.get("reportsTo") or "")[:80] or None)
        area = clean(raw.get("area") or "")[:60] or None
        n = len(rows) + 1
        if not name:
            say("block", "no_name", "No name: not added")
        if not phone and not email:
            say("block", "no_contact", "No number and no Gmail: not added")
        if why_phone:
            say("warn", "phone_check", why_phone.capitalize() + ": the number is left empty")
        elif not phone and email:
            say("warn", "no_phone", "No WhatsApp number")
        if why_email:
            say("warn", "email_check", why_email.capitalize())
        if not email:
            say("warn", "no_email", "No Gmail: added without an invite, and not on the tester list")
        elif not re.search(r"@(gmail|googlemail)\.com$", email):
            say("info", "not_gmail", "Not a Gmail address: make sure it is the Google account on their phone")
        if phone:
            if phone in seen_phone:
                say("block", "duplicate_phone", f"Same number as row {seen_phone[phone]}: not added twice")
            else:
                seen_phone[phone] = n
        if email:
            if email in seen_email:
                say("block", "duplicate_email", f"Same Gmail as row {seen_email[email]}: not added twice")
            else:
                seen_email[email] = n
        if active is False:
            say("info", "inactive", "Not active now: kept in Pulse as not active, with no invite")
        elif active is None:
            say("warn", "active_unknown", "Active? not given: added as active")
        if joined_raw and not joined and re.search(r"\d", joined_raw):
            say("warn", "joined_check", f"Joining date “{clean(joined_raw)[:30]}” not understood: left empty")
        if not role_key and not role_text:
            say("info", "role_default", "No role given: added as Sales executive")
        elif not role_key:
            say("info", "role_as_typed", f"Role “{role_text}” kept as written")
        if android is False:
            say("info", "not_android", "Not an Android phone: not on the tester list")
        elif android is None:
            say("info", "android_unknown", "Android? not given: on the tester list if they have a Gmail")
        rows.append({"n": n, "name": name, "phone": phone, "email": email, "role": role_text, "roleKey": role_key, "active": active,
                     "joinedOn": joined, "reportsTo": reports, "area": area, "languages": langs, "android": android, "model": model,
                     "problems": problems})
    return rows


def has_people(rows: list[dict]) -> bool:
    """Plain talk ("ok, will send tomorrow") is not a list: at least one row has a name and a number or a Gmail."""
    return any(r["name"] and (r["phone"] or r["email"]) for r in rows)


DETAIL_WORDS = re.compile(r"\b(?:mobile|whats ?app|g ?mail|e-? ?mail|phone|contact)\b|मोबा|फोन|नंबर|जीमेल|ई-?मेल", re.I)


def meant_as_list(text: str) -> bool:
    """PHOTO-PEOPLE (18 Nov 2026): whether a photo's words show any sign of people's details, so that one where nobody
    could be read is worth saying: a number long enough to be a phone's (8+ digits, even half read), an address, or a
    detail's word (Mobile, WhatsApp, Gmail, Phone, मोबाईल). A screenshot of a chat or of the app (times, "Voice call",
    "bug spotted") has none, and is passed by in silence, as plain talk is."""
    t = clean(text)
    return bool(EMAIL.search(t) or DETAIL_WORDS.search(t) or re.search(r"\d(?:[ \-.]?\d){7,}", t))
