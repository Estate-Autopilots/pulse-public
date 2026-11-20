"""PRESENCE-ONBOARD: proposals for what is missing in a person's onboarding, each with its source. A person or HR
confirms in Pulse; nothing is ever filled in automatically.

Sources, all read-only:
- HR's document import (``pulse_priv.hr_document``): "Aadhaar / PAN / bank details on file in HR's Drive" becomes a
  document proposal that only points at HR's records. It carries no number and copies no file.
- HR sheets in the EA index (Drive, ``drive.readonly``), only from the Drives of the accounts that hold HR material
  (``sensitive_access`` in the tenant configuration): spreadsheets with an employee-details header (a name column and a
  date of birth, phone, personal email, address or emergency-contact column). Rows match the roster only by an exact full
  name or a configured alias (PEOPLE-LIVE's ``People``).
- KYC files in those Drives whose name or folder carries the person's full roster name: a document pointer proposal.
  Files elsewhere (client KYC in project folders) are never proposed.

Never read into a proposal: salary or pay cells, Aadhaar, PAN, bank or other account numbers (columns named for them
are skipped and any cell that looks like one is dropped), mail. Proposals are idempotent (a unique index), so a
rejected proposal is not offered again from the same source.
"""
# ruff: noqa: E501
from __future__ import annotations

import json
import os
import re
from datetime import date, datetime

from pulse_sdk.db import tenant_tx
from pulse_sdk.sheet_rows import tables

from .people_work import People, load_config, norm

FIELDS = {
    "name": ("name", "employee name", "full name", "staff name", "name of employee", "member name"),
    "dob": ("date of birth", "dob", "d.o.b", "d.o.b.", "birth date", "birthday"),
    "personalPhone": ("mobile", "mobile no", "mobile number", "phone", "phone number", "contact", "contact no", "contact number", "personal phone", "personal mobile", "whatsapp"),
    "personalEmail": ("personal email", "personal email id", "email id", "email", "personal mail", "gmail"),
    "address": ("address", "current address", "residential address", "permanent address", "home address"),
    "emergencyName": ("emergency contact", "emergency contact name", "emergency name", "emergency person", "in case of emergency"),
    "emergencyRelation": ("relation", "relationship", "emergency relation", "emergency contact relation"),
    "emergencyPhone": ("emergency phone", "emergency number", "emergency contact number", "emergency mobile", "emergency contact no"),
}
# A column named for any of these is never read, whatever else its header says.
FORBIDDEN_HEADER = re.compile(r"(?i)aadh?aa?r|(?<![a-z])pan(?![a-z])|account|a/c|ifsc|bank|salary|ctc|(?<![a-z])pay|uan|esic|(?<![a-z])pf(?![a-z])|passport|voter|licen[cs]e|password")
# Any value that looks like a government ID or an account number is dropped.
ID_LIKE = re.compile(r"(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)|\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b|(?<!\d)\d{13,}(?!\d)", re.I)
KYC_NAME = re.compile(r"(?i)aadh?aa?r|(?<![a-z])pan(?![a-z])|pan ?card|cancell?ed cheque|passbook")
SHEET_MIME = "application/vnd.google-apps.spreadsheet"
MISSING_FOR = {"dob": "dob", "personalPhone": "phone", "personalEmail": "email", "address": "address",
               "emergencyName": "emergency", "emergencyPhone": "emergency", "emergencyRelation": "emergency"}


def header_map(row: list[str]) -> dict[str, int]:
    """Which column holds which field, for a header row; forbidden columns are left out."""
    found: dict[str, int] = {}
    for i, cell in enumerate(row):
        h = " ".join(str(cell or "").lower().replace("_", " ").split()).strip(" :")
        if not h or FORBIDDEN_HEADER.search(h):
            continue
        for field, names in FIELDS.items():
            if field not in found and h in names:
                found[field] = i
    # "Emergency contact" alone names the person; a second emergency column with digits is their phone.
    return found


def clean(field: str, raw: str) -> str | None:
    value = " ".join(str(raw or "").split()).strip()
    if not value or len(value) > 200:
        return None
    if field in ("personalPhone", "emergencyPhone"):
        digits = re.sub(r"[^\d+]", "", value)
        bare = digits.lstrip("+")
        if bare.startswith("91") and len(bare) == 12:
            bare = bare[2:]
        return f"+91 {bare[:5]} {bare[5:]}" if re.fullmatch(r"[6-9]\d{9}", bare) else None
    if ID_LIKE.search(value):
        return None
    if field == "dob":
        for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%d %b %Y", "%d %B %Y", "%d-%b-%Y", "%Y-%m-%d %H:%M:%S"):
            try:
                d = datetime.strptime(value, fmt).date()
            except ValueError:
                continue
            return d.isoformat() if date(1940, 1, 1) <= d <= date(date.today().year - 15, 12, 31) else None
        return None
    if field == "personalEmail":
        return value.lower() if re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value) and not value.lower().endswith("@estateautopilots.com") else None
    if field == "emergencyName" and re.search(r"\d", value):
        return None
    return value


def sheet_rows(rows: list[list[str]]):
    """(written name, {field: value}) for each data row under an employee-details header in a sheet."""
    for start in range(min(5, len(rows))):
        cols = header_map(rows[start])
        if "name" not in cols or len(cols) < 2:
            continue
        for row in rows[start + 1:]:
            cell = lambda i, row=row: row[i] if i < len(row) else ""  # noqa: E731
            name = cell(cols["name"])
            values = {f: v for f, i in cols.items() if f != "name" and (v := clean(f, cell(i)))}
            if norm(name) and values:
                yield name, values
        return


class Proposer:
    def __init__(self, index, pulse, org, config: dict):
        self.index, self.pulse, self.org = index, pulse, org
        self.hr_accounts = sorted({a.lower() for a in config.get("sensitive_access", ())})
        with tenant_tx(pulse, org):
            pulse.execute("select pulse.onboarding_defaults()")   # the documents HR asks for (Aadhaar, PAN, …)
            staff = pulse.execute("select p.id,p.display_name,p.status from pulse.person p where p.side='staff' and p.status='active'").fetchall()
            self.missing = {r["person_id"]: set(r["missing"]) for r in pulse.execute(
                "select p.id person_id,pulse.onboarding_missing(p.id) missing from pulse.person p where p.side='staff' and p.status='active'").fetchall()}
        self.people = People(staff, config)
        self.counts = {"document": 0, "sheet": 0, "drive": 0}

    def add(self, person, field, value, kind, source, label, ref) -> None:
        with tenant_tx(self.pulse, self.org):
            row = self.pulse.execute("insert into pulse_priv.profile_proposal(org_id,person_id,field,value,document_kind,source,source_label,source_ref) "
                                     "values(%s,%s,%s,%s,%s,%s,%s,%s) on conflict do nothing returning id",
                                     (self.org, person, field, value, kind, source, label[:200], ref[:300])).fetchone()
        if row:
            self.counts["drive" if source == "drive" and ref.startswith("drive:") else "document" if field == "document" else "sheet"] += 1

    def hr_documents(self) -> None:
        kinds = {"id_aadhaar": ("aadhaar", "Aadhaar"), "id_pan": ("pan", "PAN"), "bank_details": ("bank_proof", "bank details")}
        with tenant_tx(self.pulse, self.org):
            rows = self.pulse.execute("select id,person_id,doc_type,location from pulse_priv.hr_document where doc_type = any(%s)", (list(kinds),)).fetchall()
        for r in rows:
            kind, label = kinds[r["doc_type"]]
            if f"doc:{kind}" not in self.missing.get(r["person_id"], set()) and kind != "bank_proof":
                continue
            where = f" · {r['location']}" if r["location"] else ""
            self.add(r["person_id"], "document", None, kind, "drive", f"HR's records: {label} on file in HR's Drive{where}", f"hr_document:{r['id']}")

    def sheets(self) -> None:
        if not self.hr_accounts:
            return
        files = self.index.execute(
            "select f.id,f.name,f.path,t.body from drive_file f join drive_text t on t.file_id=f.id "
            "where not coalesce(f.trashed,false) and f.mime=%s and lower(f.owner)=any(%s) "
            "and t.body ~* '(date of birth|d\\.o\\.b|dob|emergency|personal email|residential address)' limit 50",
            (SHEET_MIME, self.hr_accounts)).fetchall()
        for f in files:
            for tab, rows, _ in tables(f["body"]):
                for written, values in sheet_rows(rows):
                    match = self.people.match(written)
                    if not match or not match.exact:
                        continue
                    person = match.person["id"]
                    for field, value in values.items():
                        if MISSING_FOR[field] in self.missing.get(person, set()):
                            self.add(person, field, value, None, "hr_sheet", f"HR sheet · {f['name']} · {tab}", f"sheet:{f['id']}:{tab}")

    def kyc_files(self) -> None:
        if not self.hr_accounts:
            return
        files = self.index.execute(
            "select id,name,path from drive_file where not coalesce(trashed,false) and lower(owner)=any(%s) "
            "and (name ~* 'aadh?aa?r' or name ~* '(^|[^a-z])pan([^a-z]|$)' or name ~* 'pan ?card') limit 500", (self.hr_accounts,)).fetchall()
        for f in files:
            where = f"{f['path'] or ''}/{f['name']}"
            hits = {p["id"] for n, ps in self.people.names.items() if len(n.split()) >= 2 and n in norm(where) for p in ps}
            if len(hits) != 1:
                continue
            person = hits.pop()
            kind = "aadhaar" if re.search(r"(?i)aadh?aa?r", f["name"]) else "pan"
            if f"doc:{kind}" in self.missing.get(person, set()):
                self.add(person, "document", None, kind, "drive", f"Drive · {where}"[:200], f"drive:{f['id']}")

    def run(self) -> dict:
        self.hr_documents()
        self.sheets()
        self.kyc_files()
        return {"proposed": self.counts}


def propose(index, pulse, org, config: dict | None = None) -> dict:
    with tenant_tx(pulse, org):
        pulse.execute("select pg_advisory_xact_lock(hashtextextended(%s,0))", (f"onboard-proposals:{org}",))
    return Proposer(index, pulse, org, config if config is not None else load_config()).run()


def main() -> int:
    import psycopg
    from psycopg.rows import dict_row

    from pulse_sdk.db import url_for
    try:
        with psycopg.connect(os.environ["EA_INDEX_DATABASE_URL"], autocommit=True, row_factory=dict_row, options="-c default_transaction_read_only=on") as index, \
                psycopg.connect(url_for("worker"), autocommit=True, row_factory=dict_row) as pulse:
            org = pulse.execute("select pulse.install_org() org").fetchone()["org"]
            if not org:
                raise RuntimeError("Tenant is not installed")
            result = propose(index, pulse, org)
        print(json.dumps({"ok": True, **result}), flush=True)
        return 0
    except Exception as exc:  # database messages can carry private data
        print(json.dumps({"ok": False, "error": type(exc).__name__}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
