"""SOP-WORKFLOW: documents in Drive that read like an SOP, handed to Pulse as SOP sources (``pulse.sop_source``) with
their text, a score and the reasons. Leadership confirms each one in Pulse (SOPs → From Drive), where the API reads it
into steps, roles, inputs and outputs; nothing becomes an SOP by itself.

Source, read-only: the EA index (``drive_file`` and the extracted ``drive_text``). A document is a candidate when its
title says what it is (SOP, process, procedure, workflow, checklist, playbook, how-to, step by step, responsibilities,
the Sell-Out system…) or its text says "standard operating procedure", and it has the shape of one: numbered steps, a
step table, phases, roles.

Never captured: documents whose name or folder says pay, salary, expenses, invoices, agreements, contracts, letters,
KYC, passwords or recovery; client material inside client project folders unless it is plainly an SOP; anything only
the HR-sensitive accounts can see (``sensitive_access``); and any text that reads like a contact roster (several
e-mail addresses or phone numbers: a "Models … SOP" sheet in Drive is a list of people). Stray e-mail addresses, phone
numbers and ID-like numbers left in a captured text are replaced before it leaves this process.

    python -m pulse_gdrive_snapshot.sop_sources [--dry-run]

EA_INDEX_DATABASE_URL: the read-only EA index. PULSE_DATABASE_URL_WORKER (or DATABASE_URL): Pulse, worker role.
"""

# ruff: noqa: E501
from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, field

from psycopg.types.json import Jsonb

from pulse_sdk.db import tenant_tx

from .people_work import load_config

DOC = "application/vnd.google-apps.document"
SHEET = "application/vnd.google-apps.spreadsheet"
SLIDES = "application/vnd.google-apps.presentation"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
MIMES = (DOC, SHEET, SLIDES, DOCX, "application/pdf", "text/plain", "text/markdown")
MAX_BODY = 120_000
MAX_SOURCES = 60
THRESHOLD = 0.45

# What a title says about the document.
STRONG_TITLE = re.compile(
    r"(?i)(\bsops?\b|\bsop,?s\b|standard operating|\bprocedures?\b|\bworkflows?\b|\bprocess(es)?\b|step[\s-]*by[\s-]*step|responsibilit(y|ies)|sell[\s-]?out system)"
)
WEAK_TITLE = re.compile(
    r"(?i)(checklist|playbook|how[\s-]?to\b|guidelines?|\bsystem\b|onboarding|implementation|handbook|manual)"
)
# Names and folders never read: pay, money, legal and personal documents, and private kits.
PRIVATE = re.compile(
    r"(?i)(salary|salaries|payroll|payslip|(?<![a-z])pay(?![a-z])|expense|invoice|bill(s|ing)?\b|bank|kyc|aadh?aa?r|(?<![a-z])pan(?![a-z])|passport|"
    r"agreement|contract|offer letter|appointment letter|experience letter|relieving|password|recovery|private|do not share|confidential|resume|\bcv\b|job applications?)"
)
# Folders that hold a client's own material (brochures, the client's process notes).
CLIENT_FOLDER = re.compile(r"(?i)^(client video shoot/|#0 - client work|[^/]*client work video package)")
# Text that reads like a roster of people, or carries identity numbers.
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE = re.compile(r"(?<![\w/])(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?:\.0)?(?![\w/])")
ID_LIKE = re.compile(
    r"(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)|\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b|(?<!\d)\d{13,}(?!\d)"
)
NUMBERED = re.compile(r"(?m)^[\t ]*(?:step\s*)?\d{1,2}[.)]\s+\S")
BULLET = re.compile(r"(?m)^[\t ]*(?:[*•\-–]|\d{1,2}[.)])\s+\S")
PHASE = re.compile(r"(?im)^[\t ]*(phase|stage|part|section|step)\s*#?\d+\b")
STEP_TABLE = re.compile(r"(?im)^\s*(step|stage|activity)\s*$\n\t")
ROLE_WORDS = re.compile(
    r"(?i)\b(pgs|strategist|designer|editor|videographer|cinematographer|coordinator|executive|manager|marketer|sales team|client|head|intern|owner|responsible)\b"
)


@dataclass
class Candidate:
    file_id: str
    name: str
    mime: str
    path: str
    link: str | None
    owner: str | None
    modified: str | None
    body: str
    score: float
    reasons: list[str] = field(default_factory=list)

    @property
    def text_hash(self) -> str:
        return hashlib.sha256(self.body.encode()).hexdigest()

    def item(self) -> dict:
        return {
            "fileId": self.file_id,
            "name": self.name,
            "mime": self.mime,
            "path": self.path,
            "link": self.link,
            "ownerEmail": self.owner,
            "modifiedAt": self.modified,
            "textHash": self.text_hash,
            "body": self.body,
            "score": round(self.score, 3),
            "reasons": self.reasons,
        }


def redact(text: str) -> str:
    """E-mail addresses, phone numbers and ID-like numbers are replaced; the rest of the text is kept as written."""
    text = EMAIL.sub("[e-mail]", text)
    text = ID_LIKE.sub("[number]", text)
    return PHONE.sub("[phone]", text)


def looks_like_roster(text: str) -> bool:
    """Several e-mail addresses or phone numbers: a list of people, not a procedure."""
    return len(EMAIL.findall(text)) >= 3 or len(PHONE.findall(text)) >= 3 or len(ID_LIKE.findall(text)) >= 2


SECTION = re.compile(r"\n[ \t]*_{5,}[ \t]*\n|\n[ \t]*\n[ \t]*\n")


def without_contact_sections(text: str) -> tuple[str, int]:
    """The text without any section (between separator lines or double blank lines) that holds contact details or ID
    numbers: an SOP may end with a table of the people it involves (the shoot SOP's model list). Returns the text and
    how many sections were left out."""
    parts = SECTION.split(text)
    kept = [p for p in parts if not (EMAIL.search(p) or PHONE.search(p) or ID_LIKE.search(p))]
    return "\n\n\n".join(kept), len(parts) - len(kept)


def judge(row: dict, sensitive: set[str]) -> Candidate | None:
    """A candidate with its score and reasons, or None when it is not one (or must never be read)."""
    name, path = (row.get("name") or "").strip(), row.get("path") or ""
    body = (row.get("body") or "").replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    owner = (row.get("owner") or "").lower() or None
    seen = {s.lower() for s in (row.get("seen_by") or [])}
    if (
        len(re.findall(r"[A-Za-z]", name)) < 4
        or len(body.strip()) < 300
        or PRIVATE.search(name)
        or PRIVATE.search(path)
    ):
        return None
    # Only the accounts that hold HR material can see it: never read here.
    if (owner in sensitive) and not (seen - sensitive):
        return None
    body, dropped = without_contact_sections(body[: MAX_BODY * 2])
    if len(body.strip()) < 300 or looks_like_roster(body[:60000]):
        return None
    strong, weak = STRONG_TITLE.search(name), WEAK_TITLE.search(name)
    says_sop = re.search(r"(?i)standard operating procedure|\bSOP\b", body[:20000]) is not None
    if not (strong or weak or says_sop):
        return None
    score, reasons = 0.0, []
    if strong:
        score += 0.4
        reasons.append(f"The title says “{strong.group(0).strip()}”")
    elif weak:
        score += 0.22
        reasons.append(f"The title says “{weak.group(0).strip()}”")
    if says_sop and not strong:
        score += 0.15
        reasons.append("The text calls itself a standard operating procedure")
    head = body[:MAX_BODY]
    steps, bullets, phases = (
        len(NUMBERED.findall(head)),
        len(BULLET.findall(head)),
        len({m.group(0).strip().lower() for m in PHASE.finditer(head)}),
    )
    if STEP_TABLE.search(head):
        score += 0.25
        reasons.append("A table of steps")
    elif steps >= 6:
        score += 0.25
        reasons.append(f"{steps} numbered steps")
    elif steps >= 3:
        score += 0.15
        reasons.append(f"{steps} numbered steps")
    elif bullets >= 6:
        score += 0.08
        reasons.append(f"{bullets} listed points")
    if phases >= 2:
        score += 0.08
        reasons.append(f"{phases} phases or stages")
    roles = {m.group(0).lower() for m in ROLE_WORDS.finditer(head[:30000])}
    if len(roles) >= 2:
        score += 0.07
        reasons.append("Names who does what")
    if CLIENT_FOLDER.search(path):
        score -= 0.3
        reasons.append("Filed in a client's project folder")
    # A book or a long essay: much reading, few steps.
    if re.search(r"(?i)(^|/)books?/", path) or (len(head) > 60000 and steps < 12):
        score -= 0.2
    if re.match(r"(?i)copy of\b", name):
        score -= 0.08
    if row.get("mime") == SHEET:
        score -= 0.05
    if dropped:
        reasons.append("A list of people's contact details in it was left out")
    score = max(0.0, min(0.99, score))
    modified = row.get("modified")
    return Candidate(
        file_id=row["id"],
        name=name[:300],
        mime=row.get("mime") or "",
        path=path[:1000],
        link=row.get("link") if str(row.get("link") or "").startswith("https://") else None,
        owner=owner,
        modified=modified.isoformat() if hasattr(modified, "isoformat") else modified,
        body=redact(head),
        score=score,
        reasons=reasons[:6],
    )


QUERY = """select f.id,f.name,f.mime,f.path,f.link,f.owner,f.seen_by,f.modified,t.body
 from drive_file f join drive_text t on t.file_id=f.id
 where not coalesce(f.trashed,false) and f.mime=any(%s) and t.chars>=300
  and (f.name ~* %s or t.tsv @@ to_tsquery('english','(standard <-> operating <-> procedure) | sop'))
 order by f.modified desc nulls last limit 2000"""


def find(index, sensitive: set[str]) -> list[Candidate]:
    title = r"(sops?\M|sop,?s|standard operating|procedure|workflow|process|step[ -]*by[ -]*step|responsibilit|sell[ -]?out|checklist|playbook|how[ -]?to|guideline|system|onboarding|implementation|handbook|manual)"
    found = [
        c
        for c in (judge(r, sensitive) for r in index.execute(QUERY, (list(MIMES), title)).fetchall())
        if c and c.score >= THRESHOLD
    ]
    # The same text or the same title in several places (copies, exports): the best scored, then the newest, is kept.
    best: dict[str, Candidate] = {}
    seen_titles: set[str] = set()
    for c in sorted(sorted(found, key=lambda c: c.modified or "", reverse=True), key=lambda c: -c.score):
        title = re.sub(r"(?i)^copy of\s+|\.(pdf|docx?)$|[^a-z0-9]+", " ", c.name.lower()).strip()
        if c.text_hash in best or title in seen_titles:
            continue
        best[c.text_hash] = c
        seen_titles.add(title)
    return sorted(best.values(), key=lambda c: (-c.score, c.name.lower()))[:MAX_SOURCES]


def capture_sop_sources(index, pulse, org, config: dict | None = None) -> dict:
    """One tenant transaction. Returns counts only."""
    cfg = config if config is not None else load_config()
    sensitive = {a.lower() for a in cfg.get("sensitive_access", ())}
    found = find(index, sensitive)
    with tenant_tx(pulse, org):
        if (
            pulse.execute("select to_regprocedure('pulse.sop_source_capture(jsonb)') is not null ready").fetchone()[
                "ready"
            ]
            is not True
        ):
            return {"ok": True, "skipped": "no SOP sources in this database yet"}
        pulse.execute("select pg_advisory_xact_lock(hashtextextended(%s,0))", (f"sop-sources:{org}",))
        result = pulse.execute(
            "select pulse.sop_source_capture(%s) r", (Jsonb({"items": [c.item() for c in found], "complete": True}),)
        ).fetchone()["r"]
    return {"ok": True, **result}


def main() -> int:
    import argparse

    import psycopg
    from psycopg.rows import dict_row

    from pulse_sdk.db import url_for

    parser = argparse.ArgumentParser(prog="pulse_gdrive_snapshot.sop_sources", description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="list what would be handed over (names and scores only)")
    args = parser.parse_args()
    try:
        with psycopg.connect(
            os.environ["EA_INDEX_DATABASE_URL"],
            autocommit=True,
            row_factory=dict_row,
            options="-c default_transaction_read_only=on",
        ) as index:
            if args.dry_run:
                cfg = load_config()
                found = find(index, {a.lower() for a in cfg.get("sensitive_access", ())})
                print(
                    json.dumps(
                        {
                            "ok": True,
                            "found": len(found),
                            "sources": [
                                {"name": c.name, "score": round(c.score, 2), "reasons": c.reasons} for c in found
                            ],
                        },
                        ensure_ascii=False,
                        indent=1,
                    ),
                    flush=True,
                )
                return 0
            with psycopg.connect(url_for("worker"), autocommit=True, row_factory=dict_row) as pulse:
                org = pulse.execute("select pulse.install_org() org").fetchone()["org"]
                if not org:
                    raise RuntimeError("Tenant is not installed")
                result = capture_sop_sources(index, pulse, org)
        print(json.dumps(result), flush=True)
        return 0
    except Exception as exc:  # database messages can carry private data
        print(json.dumps({"ok": False, "error": type(exc).__name__}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
