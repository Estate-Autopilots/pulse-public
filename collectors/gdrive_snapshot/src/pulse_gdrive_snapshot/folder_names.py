"""EA project-folder names → fields (project, contact, place, month, segment, company, model).

The Access Coordinator names each engagement folder "#N - Project | Contact | Location | Mon YYYY | Segment". These
rules were tuned and measured by hand in EST-16 (77% of names fully right on a held-out sample; project 82%,
contact 87%, location 92%), so every value they produce is a seed that people correct in the app, never a fact.
"""
# ruff: noqa: E501  (rules ported verbatim from the EST-16 research parser)
from __future__ import annotations

import difflib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from pulse_rules.folder_rules import project_path_match as _project_path_match
from pulse_rules.folder_rules import source_norm

MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "set": 9, "oct": 10,
          "nov": 11, "dec": 12}
MONTH_RE = re.compile(r"^(jan|feb|mar|apr|may|jun|jul|aug|sep|setp|oct|nov|dec)[a-z]*\.?\s*[-']?\s*(\d{2}|\d{4})?\.?$", re.I)
SEP_RE = re.compile(r"\s*\|\s*|\s+[lI]\s+")
SERIAL_RE = re.compile(r"^\s*(#\s*\d+\s*[-–.)]?|\d+\s*[).]\s*|#\d+-)\s*")
SEGMENTS = {"p": "Plotting", "r": "Residential", "c": "Commercial", "l": "Luxury", "lr": "Luxury residential",
            "lux": "Luxury", "mid": "Mid", "m": "M (unclear)", "m+r": "M+R (unclear)", "l+r": "Luxury+Residential",
            "sp": "SP (unclear)", "s": "S (unclear)", "r+c": "Residential+Commercial", "c+r": "Residential+Commercial",
            "villa": "Villa", "na plot": "Plotting", "plotting": "Plotting", "commercial": "Commercial",
            "residential": "Residential", "lux - pre launch": "Luxury"}
FLAG_RE = re.compile(r"^(video\s*shoot\s*only|videoshoot only|video only|video shoot|cross[ -]?(sel+ing|seeling|project)?|"
                     r"\d+\s*months?|r?untitled folder|shop|showroom|open bungl?ow|\d+(st|nd|rd|th) project|"
                     r"\d+\s*projects?|project\s*\d+|new plan|\d+\s*videos?|generic|feedback|leads?( new| feedback)?|"
                     r"editor acc?ess|kk|untitled folder|pre[- ]?launch|discounted homes|nri|copy|old|new)$", re.I)
CONTACT_RE = re.compile(r"^(mr|mrs|ms|dr|me|miss|mrm)\s*\.\s*\S|^(mr|mrs|ms|dr|me|miss)\s+\S|^\S+(\s\S+)?\s+(sir|madam|mam|ji)\b\.?$", re.I)
PLACEHOLDER = re.compile(r"^(project name|location|contact|name|-|)$", re.I)

# Places seen in EA folder names (Pune micro-markets + other cities). Lower-case, compared after normalising.
PLACES = """
pune pcmc pimpri chinchwad pimpri chinchwad wakad hinjewadi hinjewadi phase 1 hinjawadi baner balewadi aundh pashan
bavdhan kothrud karve nagar warje sinhagad road dhayari dhayri narhe ambegaon katraj kondhwa kondhawa kondwa undri
nibm wanowrie hadapsar magarpatta manjri mundhwa kharadi wagholi lohegaon dhanori viman nagar yerwada kalyani nagar
koregaon park camp shivajinagar deccan sadashiv peth kasba peth swargate bibwewadi market yard sus mahalunge
tathawade tathwade punawale ravet kiwale moshi chikhali charholi charoli talegaon talegaon dubakir chakan alandi
bhosari nigdi akurdi dighi bopkhel dudulgaon kesnand wadegaon loni kopidar uruli kanchan saswad bhor pirangut
mulshi lonavala somatane phata maan khandve nagar keshavnagar keshawnagar sanaswadi ranjangaon shikrapur narayangaon
markal kurkumbh daund baramati satara sangli kolhapur jaysingpur hatkanangale hatkanangle nashik nagpur mumbai thane
navi mumbai bhiwandi kalyan panvel mira bhayandar ratnagiri kokan konkan goa indore gandhinagar ahmedabad dubai qatar
hyderabad bangalore bengaluru turn west vadagaon wadgaon kokane chowk mukai chowk pimple saudagar pimple nilakh
pimple gurav rahatani thergaon sangvi aundh annex handewadi mohammadwadi undri pisoli fursungi manjari ambi midc
taljai hills taljai shewalewadi newale vasti morwadi bhugaon bhukum nande mann poonawale solapur ahilyanagar
ahmednagar jaysinghpur jaisinghpur karad malkapur kalaburgi khandwa dehu vadgaon maval karjat mamurdi erandwane lucknow shirur dahisar virar chembur vikhroli
keshav nagar rankala asangaon amravati senapati bapat goregaon andheri borivali kandivali malad powai worli
dipusinal nagar satara road pune satara road wadki wagholi lonikand alibaug neral badlapur ambernath dombivli
""".split("\n")
PLACE_WORDS = set(" ".join(PLACES).split())
MULTI = ["pimpri chinchwad", "hinjewadi phase 1", "sadashiv peth", "kasba peth", "loni kopidar", "uruli kanchan",
         "somatane phata", "khandve nagar", "talegaon dubakir", "navi mumbai", "mira bhayandar", "viman nagar",
         "kalyani nagar", "koregaon park", "karve nagar", "sinhagad road", "market yard", "kokane chowk",
         "mukai chowk", "pimple saudagar", "pimple nilakh", "pimple gurav", "turn west", "taljai hills",
         "newale vasti", "ambi midc", "kesnand wadegaon", "maan road", "vadgaon maval", "vadgaon bk", "keshav nagar",
         "senapati bapat road", "virar west", "pune satara road", "talegaon dipusinal", "hinjewadi p2", "nagala park",
         "malkapur karad", "east pune", "west pune"]
COMPANY_RE = re.compile(r"\b(realty|realtors?|realtech|developers?|devloper|group|infra|buildcon|builders?|properties|"
                        r"ventures|constructions?|constrotech|llp|pvt|ltd|associates|estates?|reality|housing|promoters|"
                        r"lifespaces|landmarks?|corp|mvpl|enterprises?|buildtech|infrastructure|spaces)\b", re.I)


def norm(s):
    return source_norm(s)


def is_place(tok):
    n = norm(tok)
    if not n:
        return False
    if n in MULTI:
        return True
    words = n.split()
    # every word a known place word, or the first word is (e.g. "Kondwa (Bhivre)", "Hinjewadi Maan Road")
    return all(w in PLACE_WORDS or w in ("road", "phase", "1", "2", "east", "west", "gaon", "budruk", "bk") for w in words) \
        or (words[0] in PLACE_WORDS and len(words) <= 3)


def is_place_strict(tok):
    n = norm(tok)
    return n in MULTI or (bool(n) and all(w in PLACE_WORDS for w in n.split()))


def contact_key(tok):
    n = norm(tok)
    n = re.sub(r"^(mr|mrs|ms|dr|me|miss|mrm|shri|smt)\s+", "", n)
    n = re.sub(r"\s+(sir|madam|mam|ji)$", "", n)
    return n.strip()


def parse_month(tok, year_hint):
    m = MONTH_RE.match(tok.strip())
    if not m:
        return None
    mon = MONTHS[m.group(1).lower()[:3]]
    y = m.group(2)
    if y:
        y = int(y) + (2000 if len(y) == 2 else 0)
    else:
        y = year_hint
    return (y, mon) if y else None


def split_tokens(name):
    body = SERIAL_RE.sub("", name.strip())
    toks = [t.strip(" -–_.,") for t in SEP_RE.split(body)]
    if len(toks) == 1 and re.search(r"\S\s{2,}\S", body):
        toks = [t.strip(" -–_.,") for t in re.split(r"\s{2,}", body)]
    return [t for t in toks if t]


SEG_WORD = r"(r|p|c|l|lr|m|mid|lux|sp|s|cs|hp|lp|rrl|range|raw house|villa|production|pre ?launch|generic ad)"
SEG_RE = rf"{SEG_WORD}((\s*[-+&]\s*|\s+){SEG_WORD})*"


FIRST_NAMES = set()   # filled by learn_first_names() from contacts that carry an honorific (Mr./Miss/... or "Sir")
NOT_FIRST = {"kevaleto", "lodha", "basil", "silver", "golden", "shree", "shri", "sai", "royal", "green", "new", "the",
             "project", "generic", "commercial", "east", "west", "north", "south", "pune", "upper", "skyline", "kiaan"}


def learn_first_names(names):
    for nm in names:
        for t in split_tokens(nm):
            if CONTACT_RE.match(t):
                w = contact_key(t).split()
                if w and len(w[0]) > 2 and w[0] not in NOT_FIRST:
                    FIRST_NAMES.add(w[0])


def looks_like_person(tok):
    w = norm(tok).split()
    return 2 <= len(w) <= 3 and w[0] in FIRST_NAMES and not COMPANY_RE.search(tok) and not is_place(tok)


def parse(name, year_hint=None, month_hint=None):
    toks = split_tokens(name)
    rec = dict(project=None, contact=None, location=None, developer=None, ym=None, segment=[], flags=[], extra=[], n_tokens=len(toks))
    rest = []
    for t in toks:
        tl = t.lower().strip()
        ym = parse_month(t, year_hint)
        if ym and rec["ym"] is None:
            rec["ym"] = ym
            continue
        if tl in SEGMENTS or re.fullmatch(SEG_RE, tl):
            rec["segment"].append(t)
            continue
        if re.fullmatch(r"\d", tl):          # "| 2" / "| 4": package / number of videos
            rec["flags"].append("pkg:" + tl)
            continue
        if FLAG_RE.match(tl):
            rec["flags"].append(t)
            continue
        if re.fullmatch(r"m\s*-\s*\w+", tl):  # "M - Sobuha": model name
            rec["flags"].append("model:" + t.split("-", 1)[1].strip())
            continue
        rest.append(t)
    # "Sanaswadi (MUBERIVIRU SAGASUK)": outer part may be a place, inner part a project/company
    expanded = []
    for t in rest:
        m = re.match(r"^(.*?)\((.+?)\)\s*(.*)$", t)
        if m and (m.group(1).strip() or m.group(3).strip()):
            outer = (m.group(1) + " " + m.group(3)).strip(" ,-")
            expanded += [outer, m.group(2).strip()]
        elif m:
            expanded.append(m.group(2).strip())
        else:
            expanded.append(t)
    rest = []
    for t in expanded:
        tl = t.lower().strip()
        if not t:
            continue
        if tl in SEGMENTS or re.fullmatch(SEG_RE, tl):
            rec["segment"].append(t)
        elif FLAG_RE.match(tl):
            rec["flags"].append(t)
        else:
            rest.append(t)
    rec["developer"] = None
    # contact first (explicit honorific), then place, then project = first remaining
    for t in rest:
        if rec["contact"] is None and CONTACT_RE.match(t) and not PLACEHOLDER.match(t):
            rec["contact"] = t
    if rec["contact"] is None:
        for t in rest:
            if looks_like_person(t):
                rec["contact"] = t
                rec["flags"].append("contact-by-first-name")
                break
    rest = [t for t in rest if t != rec["contact"]]
    for i, t in enumerate(rest):
        if rec["location"] is None and (is_place(t) if i > 0 or len(rest) == 1 else is_place_strict(t)):
            rec["location"] = t
    rest = [t for t in rest if t != rec["location"]]
    rest = [t for t in rest if not PLACEHOLDER.match(t)]
    for t in rest:
        if COMPANY_RE.search(t) and rec["developer"] is None and (len(rest) > 1 or rec["contact"]):
            rec["developer"] = t
    if len(rest) > 1 and rec["developer"] in rest[1:]:
        rest = [t for t in rest if t != rec["developer"]]
    elif len(rest) > 1 and rec["developer"] == rest[0]:
        rest = rest[1:] + [rest[0]]   # project name usually comes before the company
        rec["developer"] = None if not COMPANY_RE.search(rest[-1]) else rest[-1]
        rest = rest[:-1] if rec["developer"] else rest
    if rec["location"] is None and len(rest) > 1:      # positional fallback: Project | Contact | <Location>
        rec["location"] = rest[1]
        rec["flags"].append("location-positional")
        rest = [rest[0]] + rest[2:]
    if rest:
        rec["project"] = rest[0]
        rec["extra"] = rest[1:]
    if rec["ym"] is None and year_hint and month_hint:
        rec["ym"] = (year_hint, month_hint)
        rec["flags"].append("month-from-folder")
    return rec


# ---------------------------------------------------------------- identity resolution
STOP = {"project", "projects", "the", "new", "codename", "by", "and", "homes", "home", "residency", "pvt", "ltd", "llp",
        "video", "shoot", "shooting", "only"}


def project_key(name):
    n = norm(name)
    n = re.sub(r"\b(ph|phase)\s*(\d+)\b", r"ph\2", n)
    words = [w for w in n.split() if w not in STOP]
    return " ".join(words)


def similar(a, b):
    return difflib.SequenceMatcher(None, a, b).ratio()



NOT_WORK = re.compile(r"project files|untitled folder|new folder|copy of .*", re.I)


@dataclass(frozen=True)
class ProjectPathMatch:
    """A tenant-configured project root and its named semantic captures."""

    root: str
    captures: Mapping[str, str]

    @property
    def year_month(self) -> tuple[int | None, int | None] | None:
        raw_year = self.captures.get("year")
        year = int(raw_year) if raw_year and re.fullmatch(r"20\d{2}", raw_year) else None
        raw_month = self.captures.get("month")
        raw_month = SERIAL_RE.sub("", raw_month).strip() if raw_month else None
        if raw_month and raw_month.isdigit() and 1 <= int(raw_month) <= 12:
            month = int(raw_month)
            return (year, month) if year else None
        parsed = parse_month(raw_month, year) if raw_month else None
        return parsed or ((year, None) if year else None)


def project_path_match(path: str, rules: tuple[Mapping[str, Any], ...] | list[Mapping[str, Any]]) -> ProjectPathMatch | None:
    """Match a project path using ordered tenant rules; the ``project`` capture ends its stored root."""
    matched = _project_path_match(path, rules)
    return ProjectPathMatch(matched.root, matched.captures) if matched else None


def engagement(path: str, rules: tuple[Mapping[str, Any], ...] | list[Mapping[str, Any]]) -> ProjectPathMatch | None:
    """Return configured project-path captures unless the path is a template or setup tree."""
    if re.search(r"setup demo|setup ex", path, re.I):
        return None
    matched = project_path_match(path, rules)
    if not matched or NOT_WORK.fullmatch(matched.root.split("/")[-1]):
        return None
    date_hint = matched.year_month
    if not (date_hint and date_hint[0] and date_hint[1]) and not matched.captures.get("client"):
        return None
    return matched


def serial(name: str) -> int | None:
    m = re.match(r"\s*#?\s*(\d+)\s*[-–.)]", name)
    return int(m.group(1)) if m else None


def person_name(token: str) -> str:
    """'Mr. Rifob  Sulovar' becomes 'Rifob Sulovar': honorific removed, spacing and capitals tidied."""
    n = re.sub(r"\s+", " ", token.replace("’", "'")).strip(" .,-")
    n = re.sub(r"^(mr|mrs|ms|dr|me|miss|mrm|shri|smt)\b\.?\s*", "", n, flags=re.I)
    n = re.sub(r"\s+(sir|madam|mam|ji)\.?$", "", n, flags=re.I)
    return " ".join(w if (w.isupper() and len(w) <= 3) else w[:1].upper() + w[1:].lower() for w in n.split())


def segment_label(raw: str) -> str:
    return SEGMENTS.get(raw.lower().strip(), raw.strip())
