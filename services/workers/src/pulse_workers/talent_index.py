# ruff: noqa: E501  (SQL kept on one line per statement)
"""R55: the talent index. Which model shot for which client and project, when and where, what came out of it and
what it cost.

Sources, all read-only:
- the shoot coordinator's sheets in Drive, read exactly through a Drive export (drive.readonly, as the file's owner):
  "shoot Details" (client, segment, deliverable, model, language, place, day) and the "Model & Cinematographer Pay
  Tracker" (day, model, crew, scripts, place, fee, travel, extras, status);
- the EA index: the model roster folders (Client Video Shoot/Past data/EA Sample Model videos & Outfits/<model>),
  files named for a model inside model folders, and the dated model videos in each project's folder;
- Pulse: talent contacts, projects (their Drive folder and month), localities (for the shoot's place).

A model's name links itself when it is written exactly, as a spelling variant ("Cheetna"), or as a first name only one
model has. A first name two models share, or a shoot whose project is unsure, becomes a suggestion in Review data
(kind 'talent'); decisions there are kept on the next run. A name no contact holds becomes a new talent contact, marked
as added by Pulse from the sheet. Fees go only to pulse_priv.talent_fee (leadership with finance grants read them).
Nothing is sent, and no source is changed.

    python -m pulse_workers.talent_index --org UUID [--dry-run] [--no-drive]

EA_INDEX_DATABASE_URL: the read-only EA index. PULSE_DATABASE_URL_WORKER (or DATABASE_URL): Pulse, worker role.
PULSE_GOOGLE_KEY: the read-only Drive reader (default /etc/estate-autopilots/google/indexer-sa.json).
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from difflib import SequenceMatcher

from .finance_live.common import MONTHS, as_date, money

KEY_PATH = "/etc/estate-autopilots/google/indexer-sa.json"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
SHEET = "application/vnd.google-apps.spreadsheet"
ROSTER_ROOT = "Client Video Shoot/Past data/EA Sample Model videos & Outfits/"
PAY_NAME = re.compile(r"^\s*model (?:& cinematographer )?pay tracker", re.I)
SHOOT_NAME = re.compile(r"^\s*shoot details\s*$", re.I)
# Folders that hold a model's material, and model videos inside a project ("4) Model Final Videos & Its Hooks").
MODEL_FOLDER = re.compile(r"(?i)(model|EA Sample Model)")
MODEL_VIDEO = re.compile(r"(?i)/[^/]*(model (?:final|fnal)?\s*videos|final model videos|models final|main model)[^/]*/")
# Never listed as a model's material, whatever the folder: pay, bank, identity and similar documents.
PRIVATE = re.compile(r"(?i)(salary|payroll|payslip|(?<![a-z])pay(?![a-z])|invoice|bank|kyc|aadha|passport|pan card|agreement|contract|password)")
# Words in a model column that are not a model, and descriptors written after a name ("Retir male", "Varedi (2duet)").
NOT_A_MODEL = {"na", "n a", "none", "nil", "total", "drone", "b roll", "broll", "voice over", "vov", "tbd", "tba", "model", "models", "client", "founder", "child artist", "kid", "kids"}
DESCRIPTORS = re.compile(r"(?i)\b(male|female|new|old|duet|\d+duet|portfolio|profile)\b|\(.*?\)|\d+")
WEEKDAY = r"(?:mon|tues|wednes|thurs|fri|satur|sun)day"
DATED_NAME = re.compile(r"(?i)(?:" + WEEKDAY + r")?[\s,\-]*(\d{1,2})(?:st|nd|rd|th)?[\s,\-]+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*")


def key(name) -> str:
    """The comparison key of a written name; the same as SQL pulse.talent_key."""
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", str(name or "").lower())).strip()


def clean(name) -> str:
    """A written model name without descriptors: 'Varedi (2duet)' -> 'varedi', 'Retir male' -> 'retir'."""
    return key(DESCRIPTORS.sub(" ", str(name or "")))


def split_models(raw) -> list[str]:
    """A model cell can hold a pair: 'omoza & sobuha', 'Omoza duet'. Each name as written, without descriptors."""
    out = []
    for part in re.split(r"\s*(?:&|,|/|\+|\band\b)\s*", str(raw or ""), flags=re.I):
        k = clean(part)
        if len(k.replace(" ", "")) >= 3 and k not in NOT_A_MODEL and re.search(r"[a-z]", k):
            out.append(k)
    return out


def ratio(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def same_first(a: str, b: str) -> bool:
    """'cosiru' ~ 'cheetna' ~ 'cutagar'; 'yufebog' ~ 'yukuza'; 'retir' ~ 'repeti'. Short names must match exactly."""
    if a == b:
        return True
    if min(len(a), len(b)) < 4 or a[0] != b[0]:
        return False
    return ratio(a, b) >= 0.85


def same_last(a: str, b: str) -> bool:
    """A surname, or its initial ('sobuha o' ~ 'sobuha ofik'), or a close spelling ('colulu' ~ 'chawan')."""
    if not a or not b:
        return True
    if len(a) == 1 or len(b) == 1:
        return a[0] == b[0]
    return a == b or ratio(a, b) >= 0.8


@dataclass
class Model:
    person_id: uuid.UUID
    name: str
    key: str
    roster: bool = False                 # a portfolio folder of this name exists
    new: bool = False                    # created by this run

    @property
    def first(self) -> str:
        return self.key.split(" ")[0]

    @property
    def last(self) -> str:
        parts = self.key.split(" ")
        return parts[-1] if len(parts) > 1 else ""


@dataclass
class Resolution:
    person_id: uuid.UUID | None
    basis: str                           # exact | variant | first_name | new | review
    confidence: float
    candidates: list[uuid.UUID] = field(default_factory=list)


class Roster:
    """The models Pulse knows: talent contacts and portfolio folders. Full names are the canonical records; a contact
    that holds only a first name ("Cosiru") is an alias of the one full-name model it can mean."""

    def __init__(self, models: list[Model], seen_full: Counter | None = None):
        self.models = models
        self.seen_full = seen_full or Counter()

    def full(self) -> list[Model]:
        return [m for m in self.models if m.last]

    def resolve(self, alias_key: str) -> Resolution:
        words = alias_key.split()
        if not words:
            return Resolution(None, "review", 0.0)
        first, last = words[0], words[-1] if len(words) > 1 else ""
        exact = [m for m in self.models if m.key == alias_key]
        full_exact = [m for m in exact if m.last]
        if len(full_exact) == 1:
            return Resolution(full_exact[0].person_id, "exact", 1.0)
        if last:
            variants = [m for m in self.full() if same_first(first, m.first) and same_last(last, m.last)]
            if len(variants) == 1:
                return Resolution(variants[0].person_id, "exact" if variants[0].key == alias_key else "variant", 1.0 if variants[0].key == alias_key else 0.9)
            if len(variants) > 1:
                return Resolution(None, "review", 0.5, [m.person_id for m in variants])
        # A first name (or a name no full record holds): the full-name models it can mean.
        options = [m for m in self.full() if same_first(first, m.first) and (not last or not m.last)]
        if not last:
            options = [m for m in self.full() if same_first(first, m.first)]
        if len(options) == 1:
            return Resolution(options[0].person_id, "first_name", 0.8)
        if len(options) > 1:
            # One of them has a portfolio folder, or is written in full in the sheets: the likely one, to confirm.
            def evidence(m: Model) -> tuple[int, int]:
                return (int(m.roster), self.seen_full[m.key])
            ranked = sorted(options, key=evidence, reverse=True)
            if evidence(ranked[0]) > evidence(ranked[1]) and evidence(ranked[0]) > (0, 0):
                return Resolution(ranked[0].person_id, "first_name", 0.7, [m.person_id for m in ranked])
            return Resolution(None, "review", 0.4, [m.person_id for m in ranked])
        if exact:   # a single-name contact and nothing fuller: that contact is the model
            return Resolution(exact[0].person_id, "exact", 0.9)
        singles = [m for m in self.models if not m.last and same_first(first, m.first)]
        if len(singles) == 1:
            return Resolution(singles[0].person_id, "variant", 0.8)
        return Resolution(None, "new", 0.0)


# --------------------------------------------------------------------------------------------------- sheet readers
def _rows(ws):
    for index, row in enumerate(ws.iter_rows(values_only=True), start=1):
        if any(c not in (None, "") for c in row):
            yield index, list(row)


def _cell(row, i):
    return row[i] if i is not None and i < len(row) else None


def _header(rows, wanted: dict[str, tuple[str, ...]]):
    """The header row (within the first 10) and the column of each wanted field, by its words."""
    for row_no, row in rows[:10]:
        texts = [re.sub(r"\s+", " ", str(c or "")).strip().lower() for c in row]
        cols = {}
        for field_name, words in wanted.items():
            for i, t in enumerate(texts):
                if t and any(t == w or t.startswith(w) for w in words):
                    cols[field_name] = i
                    break
        if "model" in cols and len(cols) >= 3:
            return row_no, cols
    return None, {}


def tab_month(title: str, modified: date | None) -> date | None:
    """'Oct 26', 'August 25', 'Sep shoot', 'June Shoot': the tab's month. Without a year, the latest such month not
    after the file's last change."""
    words = re.sub(r"(?i)\bshoots?\b", " ", title or "").split()
    if not words or words[0].lower().rstrip(".") not in MONTHS:
        return None
    month = MONTHS[words[0].lower().rstrip(".")]
    if len(words) > 1 and re.fullmatch(r"\d{2,4}", words[1]):
        year = int(words[1]) + (2000 if len(words[1]) == 2 else 0)
    else:
        ref = modified or date.today()
        year = ref.year if month <= ref.month else ref.year - 1
    return date(year, month, 1)


def _day(value, month: date | None) -> date | None:
    """A shoot day: a real date, or '9th friday' / '2wednesday' / '12 monday' in the tab's month."""
    if isinstance(value, (datetime, date)):
        found = as_date(value)
        return found if found and 2020 <= found.year <= 2035 else None
    text = str(value or "").strip()
    found = as_date(text)
    if found:
        return found if 2020 <= found.year <= 2035 else None
    match = re.match(r"(\d{1,2})", text)
    if match and month:
        try:
            return month.replace(day=int(match.group(1)))
        except ValueError:
            return None
    return None


def _num(value) -> float | None:
    found = money(value)
    return float(found) if found is not None else None


def _text(value, limit=200) -> str | None:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if text in ("-", "—"):
        return None
    return text[:limit] or None


def _place(value) -> str | None:
    """A written place; older tabs keep a count of locations in the same column, which is not a place."""
    text = _text(value, 120)
    return None if text is None or re.fullmatch(r"[\d.,\s]+", text) or key(text) in ("office", "na") else text


def read_pay_tracker(wb, meta) -> list[dict]:
    """One row per paid shoot line; fee columns kept apart from everything else."""
    out = []
    for ws in wb.worksheets:
        month = tab_month(ws.title, meta.get("modified"))
        rows = list(_rows(ws))
        header, cols = _header(rows, {"date": ("shoot date", "date"), "model": ("model name", "model"), "crew": ("cinematographer",),
                                      "scripts": ("scripts", "script"), "place": ("locations", "location"), "charges": ("modeling charges", "modelling charges", "charges"),
                                      "travel": ("travel",), "extra": ("extra",), "total": ("total payable", "total"), "note": ("note",), "paid": ("payment status", "status")})
        if header is None:
            continue
        for row_no, row in rows:
            if row_no <= header:
                continue
            names = split_models(_cell(row, cols.get("model")))
            day = _day(_cell(row, cols.get("date")), month)
            if not names or not day:
                continue
            crew = [c for c in (key(x) for x in re.split(r"[,&/]", str(_cell(row, cols.get("crew")) or ""))) if c]
            out.append({"names": names, "written": _text(_cell(row, cols.get("model")), 120), "day": day, "month": day.replace(day=1),
                        "crew": crew, "scripts": _num(_cell(row, cols.get("scripts"))), "place": _place(_cell(row, cols.get("place"))),
                        "charges": _num(_cell(row, cols.get("charges"))), "travel": _num(_cell(row, cols.get("travel"))),
                        "extra": _num(_cell(row, cols.get("extra"))), "total": _num(_cell(row, cols.get("total"))),
                        "paid": _text(_cell(row, cols.get("paid")), 40),
                        "source": {"type": "sheet", "fileId": meta["id"], "file": meta["name"].strip(), "sheet": ws.title.strip(), "row": row_no}})
    return out


def read_shoot_sheet(wb, meta) -> list[dict]:
    """One row per planned or finished shoot that names a model."""
    out = []
    for ws in wb.worksheets:
        month = tab_month(ws.title, meta.get("modified"))
        if not month:
            continue
        rows = list(_rows(ws))
        header, cols = _header(rows, {"client": ("client",), "segment": ("segment",), "deliverable": ("deliverable",), "status": ("status",),
                                      "model": ("model",), "language": ("language",), "script": ("script",), "place": ("location",), "date": ("date of shoot", "date")})
        if header is None:
            continue
        for row_no, row in rows:
            if row_no <= header:
                continue
            names = split_models(_cell(row, cols.get("model")))
            client = _text(_cell(row, cols.get("client")), 160)
            if not names or not client:
                continue
            day = _day(_cell(row, cols.get("date")), month)
            out.append({"names": names, "written": _text(_cell(row, cols.get("model")), 120), "client": client, "day": day, "month": (day or month).replace(day=1),
                        "segment": _text(_cell(row, cols.get("segment")), 60), "deliverable": _text(_cell(row, cols.get("deliverable")), 160),
                        "status": _text(_cell(row, cols.get("status")), 40), "language": _text(_cell(row, cols.get("language")), 40),
                        "place": _place(_cell(row, cols.get("place"))),
                        "source": {"type": "sheet", "fileId": meta["id"], "file": meta["name"].strip(), "sheet": ws.title.strip(), "row": row_no}})
    return out


# ------------------------------------------------------------------------------------------------ projects & places
@dataclass
class Project:
    id: uuid.UUID
    title: str
    name: str
    location: str
    month: date | None
    client: str
    root: str | None = None


def months_between(a: date, b: date) -> int:
    return (a.year - b.year) * 12 + a.month - b.month


def _words(value) -> list[str]:
    from .finance_live.common import name_key
    words = name_key(value).split()
    return words[:-1] if len(words) > 1 and len(words[-1]) == 1 else words


def text_score(a: str, b: str) -> float:
    """How well a written client or project name matches a Pulse name. Mostly: how many of the written words the Pulse
    name holds (a word of 3+ letters matches the word it begins), less for every extra word; for single names, a close
    spelling ('Vozituhefa' ~ 'Valentina', 'mangrover' ~ 'Mangrove')."""
    if not a or not b:
        return 0.0
    x, y = _words(a), _words(b)
    if not x or not y:
        return 0.0
    hits = sum(1 for w in x if any(w == o or (min(len(w), len(o)) >= 3 and (w.startswith(o) or o.startswith(w))) for o in y))
    words = 0.65 * hits / len(x) + 0.35 * hits / max(len(x), len(y))
    ca, cb = re.sub(r"[^a-z0-9]", "", a.lower()), re.sub(r"[^a-z0-9]", "", b.lower())
    spelled = ratio(ca, cb) if min(len(ca), len(cb)) >= 5 else 0.0
    return max(words, spelled if spelled >= 0.8 else 0.0)


def label_score(label: str, p: Project) -> float:
    """The first part of a written client is the project's name; later parts (developer, place) count for less."""
    parts = [x for x in re.split(r"\s*\|\s*", label or "") if x.strip()][:3]
    best = 0.0
    for i, part in enumerate(parts):
        weight = 1.0 if i == 0 else 0.75
        best = max(best, weight * text_score(part, p.title), weight * 0.9 * text_score(part, p.name.split("|")[0] if p.name else ""), weight * 0.8 * text_score(part, p.client))
    return best


def place_score(place: str | None, p: Project) -> float:
    if not place or not p.location:
        return 0.0
    return text_score(place, p.location)


def dated_names(name: str, created: datetime | None) -> date | None:
    """'Wednesday, 9 september - Pivapoha Villas …' -> 9 Sep of the year the file was made (or the year before when
    that would be after the file existed)."""
    match = DATED_NAME.search(name or "")
    if not match or not created:
        return None
    day, mon = int(match.group(1)), MONTHS.get(match.group(2).lower()[:3])
    if not mon:
        return None
    for year in (created.year, created.year - 1):
        try:
            found = date(year, mon, day)
        except ValueError:
            return None
        if found <= created.date() + timedelta(days=2) and (created.date() - found).days <= 150:
            return found
    return None


def match_project(shoot: dict, projects: list[Project], videos: dict[date, set[uuid.UUID]], uploads: dict[date, set[uuid.UUID]] | None = None) -> tuple[uuid.UUID | None, str, float, list[tuple[uuid.UUID, float]]]:
    """The project a shoot was for, with its basis, confidence and the runners-up.

    Evidence: the client written in the shoot sheet (strongest), a model video in the project's folder dated that day,
    raw footage uploaded to the project that day or the next, the written place against the project's place, and the
    project's start month. A line with no client links only when one project alone has that day's videos or footage."""
    month, day = shoot["month"], shoot.get("day")
    filmed = videos.get(day, set()) if day else set()
    uploaded = (uploads or {}).get(day, set()) | (uploads or {}).get(day + timedelta(days=1), set()) if day else set()
    scored = []
    for p in projects:
        lbl = label_score(shoot.get("client") or "", p) if shoot.get("client") else 0.0
        vid = 1.0 if p.id in filmed else 0.0
        raw = 1.0 if p.id in uploaded else 0.0
        plc = place_score(shoot.get("place"), p)
        if lbl < 0.45 and not vid and not raw and plc < 0.8:
            continue
        adj = 0.0
        if p.month:
            d = months_between(month, p.month)
            adj = 0.12 if 0 <= d <= 3 else 0.06 if d == -1 or 4 <= d <= 6 else -0.25 if d < -1 else -0.15
        total = min(1.0, 0.7 * lbl + 0.45 * vid + 0.3 * raw + 0.15 * plc + adj)
        if not shoot.get("client") and not vid and not raw:      # a place and a month alone: never better than a guess
            total = min(total, 0.55 if plc >= 0.8 and adj > 0 else 0.0)
        basis = "client_name" if lbl >= 0.6 else "dated_video" if vid else "shoot_day_upload" if raw else "place_month"
        if total > 0:
            scored.append((p.id, total, basis))
    scored.sort(key=lambda x: -x[1])
    if not scored:
        return None, "none", 0.0, []
    best, second = scored[0], scored[1][1] if len(scored) > 1 else 0.0
    ranked = [(pid, round(score, 2)) for pid, score, _ in scored[:3]]
    if best[1] >= 0.62 and best[1] - second >= 0.12:
        return best[0], best[2], round(min(0.95, best[1]), 2), ranked
    if not shoot.get("client") and best[1] >= 0.38 and len(scored) == 1:
        return best[0], best[2], round(min(0.7, best[1] + 0.2), 2), ranked
    if best[1] >= 0.5 and best[2] == "place_month" and best[1] - second >= 0.12:
        return best[0], best[2], round(best[1], 2), ranked
    return None, "review" if best[1] >= 0.45 else "none", round(best[1], 2), ranked


@dataclass
class Place:
    id: uuid.UUID
    name: str
    city: str
    lat: float | None
    lng: float | None
    keys: list[str]


def find_place(text: str | None, places: list[Place]) -> Place | None:
    """A written shoot place ('nibm', 'kiwale', 'Goregaon Mumbai') to a known locality with a point, when one place
    fits: its own name first, then its recorded aliases, then a first word or a close spelling. Two places that fit
    equally well ("Talegaon": Dubakir or Dipusinal) leave the shoot unplaced."""
    k = key(text)
    if not k:
        return None
    first = k.split(" ")[0]
    tests = (
        lambda p: k in (key(p.name), key(f"{p.name} {p.city}")),
        lambda p: k in p.keys,
        lambda p: len(first) >= 4 and key(p.name).split(" ")[0] == first,
        lambda p: len(first) >= 5 and any(ratio(first, x.split(" ")[0]) >= 0.86 for x in p.keys),
    )
    for test in tests:
        hits = [p for p in places if p.lat is not None and test(p)]
        if len({(p.name, p.city) for p in hits}) == 1:
            return hits[0]
        if hits:
            return None
    return None


# -------------------------------------------------------------------------------------------------------- the run
def build(pay: list[dict], shoots: list[dict], roster: Roster, decisions: dict[str, dict]) -> dict:
    """Pure assembly: resolve names, merge the two sheets into shoots, and keep fees apart. Returns rows to store."""
    aliases: dict[str, dict] = {}

    def person_for(name_key: str, written: str | None):
        if name_key not in aliases:
            decided = decisions.get("alias:" + name_key)
            if decided and decided["status"] in ("accepted", "dismissed"):
                pid = uuid.UUID(decided["chosen"]) if decided["status"] == "accepted" and decided.get("chosen") else None
                res = Resolution(pid, "review", 1.0 if pid else 0.0)
                status = "confirmed" if pid else "rejected"
            else:
                res = roster.resolve(name_key)
                status = "review" if res.basis == "review" or (res.basis == "first_name" and len(res.candidates) > 1) else "auto"
            aliases[name_key] = {"key": name_key, "alias": written or name_key, "res": res, "status": status, "seen": 0}
        aliases[name_key]["seen"] += 1
        return aliases[name_key]["res"].person_id

    shoot_rows: list[dict] = []
    by_person_day: dict[tuple, list[dict]] = defaultdict(list)
    for s in shoots:
        for n in s["names"]:
            pid = person_for(n, s["written"] if len(s["names"]) == 1 else n)
            row = {**s, "alias": n, "person_id": pid, "sources": ["shoot_sheet"], "crew": [], "scripts": None,
                   "source_key": f"sd:{s['source']['fileId'][:12]}:{s['source']['sheet']}:{s['source']['row']}:{n}"}
            shoot_rows.append(row)
            if s.get("day"):
                by_person_day[(pid or n, s["day"])].append(row)
    fees = []
    for p in pay:
        share = len(p["names"])
        for n in p["names"]:
            pid = person_for(n, p["written"] if share == 1 else n)
            fee_key = f"pt:{p['source']['fileId'][:12]}:{p['source']['sheet']}:{p['source']['row']}:{n}"
            matched = by_person_day.get((pid or n, p["day"]), [])
            if matched:
                for row in matched:
                    row["sources"] = ["shoot_sheet", "pay_tracker"]
                    row["crew"], row["scripts"] = p["crew"], (p["scripts"] / len(matched)) if p["scripts"] else None
                    row["place"] = row.get("place") or p["place"]
                    row["status"] = row.get("status") or p["paid"]
                keys = [r["source_key"] for r in matched]
            else:
                row = {"names": [n], "alias": n, "person_id": pid, "client": None, "day": p["day"], "month": p["month"], "segment": None,
                       "deliverable": None, "status": p["paid"], "language": None, "place": p["place"], "crew": p["crew"], "scripts": p["scripts"],
                       "sources": ["pay_tracker"], "source": p["source"], "source_key": fee_key}
                shoot_rows.append(row)
                keys = [fee_key]
            fees.append({"source_key": fee_key, "person_id": pid, "alias": n, "shoot_on": p["day"], "month": p["month"],
                         "charges": _share(p["charges"], share), "travel": _share(p["travel"], share), "extra": _share(p["extra"], share),
                         "total": _share(p["total"], share),
                         "paid": p["paid"], "shoot_keys": keys, "source": p["source"]})
    return {"aliases": aliases, "shoots": shoot_rows, "fees": fees}


def _share(value: float | None, people: int) -> float | None:
    """A pair shares one pay line: each model's part of it."""
    return round(value / people, 2) if value is not None else None


def _drive(key_path: str, subject: str):
    from google.oauth2 import service_account
    from googleapiclient.discovery import build as gbuild

    credentials = service_account.Credentials.from_service_account_file(key_path, scopes=["https://www.googleapis.com/auth/drive.readonly"], subject=subject)
    return gbuild("drive", "v3", credentials=credentials, cache_discovery=False)


def _open(service, meta):
    import openpyxl

    data = service.files().export(fileId=meta["id"], mimeType=XLSX).execute() if meta["mime"] == SHEET else service.files().get_media(fileId=meta["id"], supportsAllDrives=True).execute()
    return openpyxl.load_workbook(io.BytesIO(data), data_only=True, read_only=True)


def sheets_in(index) -> list[dict]:
    """The coordinator's sheets in the index, newest copy of each name first; read as the owner when inside Workspace."""
    rows = index.execute("select id,name,mime,owner,seen_by,modified from drive_file where not coalesce(trashed,false) and mime=%s and (name ~* %s or name ~* %s) order by modified desc",
                         (SHEET, PAY_NAME.pattern, SHOOT_NAME.pattern)).fetchall()
    out, names = [], set()
    for r in rows:
        kind = "pay" if PAY_NAME.search(r["name"]) else "shoot"
        if (kind, r["name"].strip().lower()) in names:
            continue
        names.add((kind, r["name"].strip().lower()))
        subject = r["owner"] if (r["owner"] or "").endswith("@estateautopilots.com") else next((s for s in r["seen_by"] or [] if s.endswith("@estateautopilots.com")), None)
        out.append({"id": r["id"], "name": r["name"], "mime": r["mime"], "kind": kind, "subject": subject,
                    "modified": r["modified"].date() if r["modified"] else None})
    return out


def run(args) -> dict:
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb

    from pulse_sdk.db import connect, tenant_tx

    org = uuid.UUID(args.org)
    key_path = os.environ.get("PULSE_GOOGLE_KEY", KEY_PATH)
    counts: Counter = Counter()
    sources: list[dict] = []
    with psycopg.connect(os.environ["EA_INDEX_DATABASE_URL"], row_factory=dict_row, autocommit=True, options="-c default_transaction_read_only=on") as index, connect("worker") as conn:
        # Sheets: exact cells through a read-only Drive export, or nothing (index text drops empty cells).
        pay, shoots = [], []
        readers = {}
        for meta in sheets_in(index):
            if args.no_drive or not os.access(key_path, os.R_OK) or not meta["subject"]:
                sources.append({"file": meta["name"].strip(), "status": "not read: no Drive reader"})
                continue
            try:
                if meta["subject"] not in readers:
                    readers[meta["subject"]] = _drive(key_path, meta["subject"])
                wb = _open(readers[meta["subject"]], meta)
                found = read_pay_tracker(wb, meta) if meta["kind"] == "pay" else read_shoot_sheet(wb, meta)
                (pay if meta["kind"] == "pay" else shoots).extend(found)
                sources.append({"file": meta["name"].strip(), "status": "read", "rows": len(found), "modified": str(meta["modified"])})
            except Exception as exc:  # one unreadable sheet never stops the others
                sources.append({"file": meta["name"].strip(), "status": f"not read: {type(exc).__name__}"})
        counts["pay_rows"], counts["shoot_rows"] = len(pay), len(shoots)

        with tenant_tx(conn, org):
            run_id = conn.execute("insert into pulse.talent_run(org_id) values(%s) returning id", (org,)).fetchone()["id"]
        try:
            with tenant_tx(conn, org):
                result = store(conn, index, org, run_id, pay, shoots, counts, dry=args.dry_run)
                conn.execute("update pulse.talent_run set finished_at=now(),ok=true,counts=%s,sources=%s where id=%s", (Jsonb(dict(counts)), Jsonb(sources), run_id))
                if args.dry_run:
                    raise _DryRun()
        except _DryRun:
            pass
        except Exception as exc:
            with tenant_tx(conn, org):
                conn.execute("update pulse.talent_run set finished_at=now(),ok=false,error=%s,sources=%s where id=%s", (type(exc).__name__, Jsonb(sources), run_id))
            raise
    return {"org": str(org)[:8], "dryRun": args.dry_run, "counts": dict(counts), "sources": [{k: v for k, v in s.items() if k != "modified"} for s in sources], **result}


class _DryRun(Exception):
    pass


def store(conn, index, org, run_id, pay, shoots, counts, *, dry=False) -> dict:
    from psycopg.types.json import Jsonb

    # Models Pulse knows, and their portfolio folders in the index.
    contacts = conn.execute("select p.id,p.display_name from pulse.contact_profile cp join pulse.person p on p.id=cp.person_id where cp.contact_type='talent' and p.status<>'offboarded'").fetchall()
    folders = index.execute("select id,name,path from drive_file where not coalesce(trashed,false) and mime='application/vnd.google-apps.folder' and path like %s and path not like %s",
                            (ROSTER_ROOT + "%", ROSTER_ROOT + "%/%")).fetchall()
    models = [Model(r["id"], r["display_name"], clean(r["display_name"])) for r in contacts if clean(r["display_name"])]
    seen_full = Counter(n for row in pay + shoots for n in row["names"] if " " in n)
    roster = Roster(models, seen_full)
    for f in folders:
        k = clean(f["name"])
        hit = roster.resolve(k) if k else None
        if hit and hit.person_id and hit.basis in ("exact", "variant"):
            next(m for m in models if m.person_id == hit.person_id).roster = True
    # A portfolio folder or a sheet name that no contact holds: a new talent contact, added by Pulse from that source.
    new_names = {clean(f["name"]): f["name"].strip() for f in folders if clean(f["name"])}
    for row in pay + shoots:
        for n in row["names"]:
            new_names.setdefault(n, n.title())
    for k, written in sorted(new_names.items()):
        if roster.resolve(k).basis != "new":
            continue
        pid = uuid.uuid5(org, "talent:" + k)
        models.append(Model(pid, written.title() if written.islower() else written, k, roster=k in {clean(f["name"]) for f in folders}, new=True))
        counts["contacts_added"] += 1
        conn.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'talent') on conflict(id) do nothing", (pid, org, models[-1].name))
        conn.execute("insert into pulse.contact_profile(org_id,person_id,contact_type,source,type_status,confidence) values(%s,%s,'talent','talent_index','evidence_typed',0.8) on conflict(person_id) do nothing", (org, pid))
    by_id = {m.person_id: m for m in models}

    # Decisions already taken in Review data.
    decisions = {}
    for r in conn.execute("select source_key,status,proposed from pulse.review_item where kind='talent' and status in ('accepted','dismissed')").fetchall():
        decisions[r["source_key"].removeprefix("talent:")] = {"status": r["status"], "chosen": (r["proposed"] or {}).get("chosen")}
    built = build(pay, shoots, roster, decisions)

    # Projects, their Drive folders and the dated model videos inside them.
    projects = [Project(r["id"], r["title"] or "", r["name"] or "", r["location"] or "", r["start_month"], r["client"] or "",
                        r["storage_root"].removeprefix("index-path:") if (r["storage_root"] or "").startswith("index-path:") else None)
                for r in conn.execute("select p.id,p.title,p.name,p.location,p.start_month,p.storage_root,c.display_name client from pulse.project p left join pulse.client c on c.id=p.client_id where p.kind='client_work'").fetchall()]
    roots = sorted(((p.root.rstrip("/") + "/", p.id) for p in projects if p.root), key=lambda x: -len(x[0]))

    def project_of(path: str | None):
        return next((pid for root, pid in roots if (path or "").startswith(root)), None)

    videos: dict[date, set[uuid.UUID]] = defaultdict(set)
    uploads: dict[date, set[uuid.UUID]] = defaultdict(set)
    for f in index.execute("select path,created from drive_file where not coalesce(trashed,false) and mime like 'video/%%' and path like 'Client Video Shoot/%%' and path ~* '/[^/]*raw[^/]*/'").fetchall():
        pid = project_of(f["path"])
        if pid and f["created"]:
            uploads[f["created"].date()].add(pid)
    video_files: list[dict] = []
    for f in index.execute("select id,name,mime,path,link,created from drive_file where not coalesce(trashed,false) and mime not like 'application/vnd.google-apps.folder' and path like 'Client Video Shoot/%%' and path ~* %s",
                           (r"model (final|fnal)?\s*videos|final model videos|models final|main model",)).fetchall():
        pid = project_of(f["path"])
        if not pid or not MODEL_VIDEO.search(f["path"] or ""):
            continue
        on = dated_names(f["name"], f["created"])
        if on:
            videos[on].add(pid)
        video_files.append({**f, "project_id": pid, "on": on})
    counts["model_videos"] = len(video_files)

    # Shoot -> project, place -> locality.
    places = [Place(r["id"], r["name"] or r["city"], r["city"], r["lat"], r["lng"], [x for x in {key(r["name"] or r["city"]), *map(key, r["aliases"] or [])} if x])
              for r in conn.execute("select id,name,city,lat,lng,aliases from pulse.locality").fetchall()]
    points = {r["project_id"]: r for r in conn.execute("select m.project_id,l.lat,l.lng,l.precision from pulse.project_location_member m join pulse.project_location l on l.id=m.location_id where l.lat is not null").fetchall()}
    reviews = []
    for s in built["shoots"]:
        decided = decisions.get("shoot:" + s["source_key"])
        if decided and decided["status"] == "accepted" and decided.get("chosen"):
            s["project_id"], s["project_basis"], s["project_confidence"] = uuid.UUID(decided["chosen"]), "review", 1.0
        elif decided and decided["status"] == "dismissed":
            s["project_id"], s["project_basis"], s["project_confidence"] = None, "none", None
        else:
            pid, basis, conf, ranked = match_project(s, projects, videos, uploads)
            s["project_id"], s["project_basis"], s["project_confidence"] = pid, basis if pid else ("review" if basis == "review" else "none"), conf if pid else None
            if not pid and basis == "review":
                s["project_basis"] = "none"
                reviews.append(("shoot:" + s["source_key"], s, ranked))
        place = find_place(s.get("place"), places)
        if place:
            s["locality_id"], s["lat"], s["lng"], s["place_basis"] = place.id, place.lat, place.lng, "locality"
        elif s.get("project_id") in points and points[s["project_id"]]["precision"] in ("exact", "building", "street", "locality"):
            pt = points[s["project_id"]]
            s["locality_id"], s["lat"], s["lng"], s["place_basis"] = None, pt["lat"], pt["lng"], "project"
        else:
            s["locality_id"], s["lat"], s["lng"], s["place_basis"] = None, None, None, "none"
    counts["shoots"] = len(built["shoots"])
    counts["shoots_with_project"] = sum(1 for s in built["shoots"] if s["project_id"])
    counts["shoots_placed"] = sum(1 for s in built["shoots"] if s["lat"] is not None)
    counts["fees"] = len(built["fees"])

    # Media: portfolio folders, files named for a model inside model folders, and the model videos of their shoots.
    media: dict[tuple, dict] = {}
    folder_person = {}
    for f in folders:
        k = clean(f["name"])
        hit = roster.resolve(k) if k else None
        pid = hit.person_id if hit and hit.person_id else uuid.uuid5(org, "talent:" + k) if uuid.uuid5(org, "talent:" + k) in by_id else None
        if pid:
            folder_person[f["path"].rstrip("/") + "/"] = pid
    for f in index.execute("select id,name,mime,path,link,created from drive_file where not coalesce(trashed,false) and mime not like 'application/vnd.google-apps.folder' and path like %s", (ROSTER_ROOT + "%",)).fetchall():
        pid = next((p for root, p in folder_person.items() if (f["path"] or "").startswith(root)), None)
        if pid and not PRIVATE.search(f["name"]):
            media[(f["id"], pid)] = {"file_id": f["id"], "person_id": pid, "project_id": None, "kind": _kind(f["mime"]), "name": f["name"], "mime": f["mime"], "path": f["path"],
                                     "link": f["link"], "created_at": f["created"], "basis": "portfolio_folder"}
    named = [(m, re.compile(r"(?i)^" + re.escape(m.key).replace(r"\ ", r"[\s_.-]+") + r"(?![a-z])")) for m in models if len(m.key.replace(" ", "")) >= 4]
    for f in index.execute("select id,name,mime,path,link,created from drive_file where not coalesce(trashed,false) and mime not like 'application/vnd.google-apps.folder' and path ~* %s and path not like %s",
                           (r"model", ROSTER_ROOT + "%")).fetchall():
        if PRIVATE.search(f["name"]):
            continue
        hits = [m for m, rx in named if rx.search(f["name"])]
        full = [m for m in hits if m.last] or hits
        if len({m.person_id for m in full}) == 1:
            m = full[0]
            media[(f["id"], m.person_id)] = {"file_id": f["id"], "person_id": m.person_id, "project_id": project_of(f["path"]), "kind": _kind(f["mime"]), "name": f["name"],
                                             "mime": f["mime"], "path": f["path"], "link": f["link"], "created_at": f["created"], "basis": "file_name"}
    # A project's model videos belong to the model who shot that day; when one model shot the project, to them.
    shot_by: dict[uuid.UUID, set] = defaultdict(set)
    shot_on: dict[tuple, set] = defaultdict(set)
    for s in built["shoots"]:
        if s["project_id"] and s["person_id"]:
            shot_by[s["project_id"]].add(s["person_id"])
            if s.get("day"):
                shot_on[(s["project_id"], s["day"])].add(s["person_id"])
    for f in video_files:
        people = shot_on.get((f["project_id"], f["on"])) if f["on"] else None
        basis = "shoot_date"
        if not people:
            people = shot_by.get(f["project_id"]) if len(shot_by.get(f["project_id"], ())) == 1 else None
            basis = "shoot_project"
        for pid in people or ():
            media.setdefault((f["id"], pid), {"file_id": f["id"], "person_id": pid, "project_id": f["project_id"], "kind": _kind(f["mime"]), "name": f["name"], "mime": f["mime"],
                                              "path": f["path"], "link": f["link"], "created_at": f["created"], "basis": basis})
    counts["media"] = len(media)

    # Store: derived rows are rebuilt; decisions live on the aliases and the review items.
    for table in ("pulse.talent_shoot", "pulse.talent_media", "pulse_priv.talent_fee"):
        conn.execute(f"delete from {table} where org_id=%s", (org,))
    for a in built["aliases"].values():
        res = a["res"]
        conn.execute("insert into pulse.talent_alias(org_id,alias_key,alias,person_id,basis,confidence,status,seen) values(%s,%s,%s,%s,%s,%s,%s,%s) "
                     "on conflict(org_id,alias_key) do update set alias=excluded.alias,seen=excluded.seen,"
                     "person_id=case when talent_alias.status in ('confirmed','rejected') then talent_alias.person_id else excluded.person_id end,"
                     "basis=case when talent_alias.status in ('confirmed','rejected') then talent_alias.basis else excluded.basis end,"
                     "confidence=case when talent_alias.status in ('confirmed','rejected') then talent_alias.confidence else excluded.confidence end,"
                     "status=case when talent_alias.status in ('confirmed','rejected') then talent_alias.status else excluded.status end",
                     (org, a["key"][:80], a["alias"][:120], res.person_id, res.basis if res.basis != "new" else "new", res.confidence, a["status"], a["seen"]))
        if a["status"] == "review":
            options = [by_id[c] for c in res.candidates if c in by_id]
            reviews.append(("alias:" + a["key"], {"alias": a["alias"], "aliasKey": a["key"], "seen": a["seen"], "options": options, "person_id": res.person_id}, None))
    # The alias table is the truth after a person decided (also for names written the old way).
    final = {r["alias_key"]: r["person_id"] for r in conn.execute("select alias_key,person_id from pulse.talent_alias").fetchall()}
    for s in built["shoots"]:
        s["person_id"] = final.get(s["alias"], s["person_id"])
        conn.execute("insert into pulse.talent_shoot(org_id,source_key,person_id,alias,shoot_on,month,client_label,project_id,project_basis,project_confidence,place,locality_id,lat,lng,place_basis,"
                     "deliverable,segment,language,scripts,crew,status,sources,source,run_id) values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict(org_id,source_key) do nothing",
                     (org, s["source_key"][:200], s["person_id"], s["alias"], s.get("day"), s["month"], s.get("client"), s["project_id"], s["project_basis"], s["project_confidence"],
                      s.get("place"), s["locality_id"], s["lat"], s["lng"], s["place_basis"], s.get("deliverable"), s.get("segment"), s.get("language"),
                      s.get("scripts") if s.get("scripts") is None or 0 <= s["scripts"] < 100 else None, s.get("crew") or [], s.get("status"), s["sources"], Jsonb(s["source"]), run_id))
    for f in built["fees"]:
        conn.execute("insert into pulse_priv.talent_fee(org_id,source_key,person_id,alias,shoot_on,month,charges,travel,extra,total,paid,shoot_keys,source) values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict do nothing",
                     (org, f["source_key"][:200], final.get(f["alias"], f["person_id"]), f["alias"], f["shoot_on"], f["month"], f["charges"], f["travel"], f["extra"],
                      f["total"] if f["total"] is None or f["total"] >= 0 else None, f["paid"], [k[:200] for k in f["shoot_keys"]], Jsonb(f["source"])))
    for m in media.values():
        conn.execute("insert into pulse.talent_media(org_id,file_id,person_id,project_id,kind,name,mime,path,link,created_at,basis) values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict do nothing",
                     (org, m["file_id"], m["person_id"], m["project_id"], m["kind"], m["name"][:300], m["mime"], (m["path"] or "")[:600], m["link"], m["created_at"], m["basis"]))

    # Suggestions for Review data: who a name means, and which project a shoot was for.
    names = {r["id"]: r["name"] for r in conn.execute("select id,coalesce(title,name) as name from pulse.project where kind='client_work'").fetchall()}
    open_items = 0
    for source_key, item, ranked in reviews:
        if source_key in decisions:
            continue
        if source_key.startswith("alias:"):
            opts = item["options"]
            title = f"Which model is “{item['alias']}”? ({item['seen']} shoot {'line' if item['seen'] == 1 else 'lines'})"
            proposed = {"what": "alias", "aliasKey": item["aliasKey"], "personId": str(item["person_id"]) if item["person_id"] else None,
                        "options": [{"id": str(m.person_id), "label": m.name, "note": "portfolio folder" if m.roster else "contact"} for m in opts]}
            evidence = {"why": "The name is written without a surname and more than one model has that first name." if len(opts) > 1 else "Pulse could not tell which model this is.",
                        "source": "Shoot coordinator's sheets (shoot Details, Model & Cinematographer Pay Tracker)"}
            confidence = 0.7 if item["person_id"] else 0.4
        else:
            s = item
            title = f"Which project was {s['alias'].title()}’s shoot on {s['day'].strftime('%-d %b %Y') if s.get('day') else s['month'].strftime('%b %Y')} for?"
            proposed = {"what": "shoot_project", "sourceKey": s["source_key"], "projectId": str(ranked[0][0]) if ranked else None,
                        "options": [{"id": str(pid), "label": names.get(pid, "Project"), "score": score} for pid, score in ranked]}
            evidence = {"why": "More than one project fits the client, the place and the month, or the fit is weak.",
                        "client": s.get("client"), "place": s.get("place"), "month": s["month"].strftime("%b %Y"), "source": s["source"]}
            confidence = ranked[0][1] if ranked else 0.3
        open_items += 1
        conn.execute("insert into pulse.review_item(org_id,source_key,kind,title,proposed,confidence,evidence) values(%s,%s,'talent',%s,%s,%s,%s) "
                     "on conflict(org_id,source_key) do update set title=excluded.title,proposed=excluded.proposed,confidence=excluded.confidence,evidence=excluded.evidence where review_item.status='pending'",
                     (org, "talent:" + source_key[:190], title[:300], Jsonb(proposed), confidence, Jsonb(evidence)))
    counts["review_open"] = open_items
    counts["models"] = len({s["person_id"] for s in built["shoots"] if s["person_id"]})
    return {"stored": not dry}


def _kind(mime: str | None) -> str:
    m = mime or ""
    return "video" if m.startswith("video/") else "image" if m.startswith("image/") else "document"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="pulse_workers.talent_index", description=__doc__.split("\n\n")[0])
    parser.add_argument("--org", required=True)
    parser.add_argument("--dry-run", action="store_true", help="read and match everything, then roll back")
    parser.add_argument("--no-drive", action="store_true", help="do not open the sheets through Drive (index only)")
    args = parser.parse_args(argv)
    print(json.dumps(run(args), default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
