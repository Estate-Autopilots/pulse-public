"""Import an approved skill taxonomy download (owner errand E16) into one company: a narrow ESCO or O*NET slice.

uv run --all-packages python -m pulse_workers.skill_taxonomy --manifest <manifest.json> [--commit]

Reads local files only: nothing is fetched, scraped or called. Without --commit the import runs inside a transaction,
prints its counts and rolls back. The manifest (JSON, next to the files) names the download and its SHA-256, the
classification DATA licence and, separately, any API SOFTWARE licence, the attribution the source requires, the
approved slice (codes, or a collection file listing them) and the owner's approval reference:

  {"family": "esco", "version": "1.2.0", "language": "en", "file": "skills_en.csv", "fileSha256": "<64 hex>",
   "dataLicence": "<as the download states it>", "softwareLicence": null,
   "attribution": "This service uses the ESCO classification of the European Commission.",
   "sourceUrl": "https://esco.ec.europa.eu/en/use-esco/download",
   "slice": {"description": "<what the owner approved>", "codesFile": "<collection>.csv"},
   "mappings": "<optional mappings.csv>", "approvalRef": "<the owner's E16 approval record>"}

ESCO: the skills CSV (conceptUri, preferredLabel, altLabels and hiddenLabels one per line, status, skillType,
description; an isReplacedBy/replacedBy column when present). O*NET: a tab-separated Content Model Reference file
(Element ID, Element Name, Description). Mappings: CSV fromFamily, fromCode, toFamily, toCode, relation. Lightcast is
refused (it needs a commercial contract). stdout carries counts only. See docs/ops/SKILLS.md.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import sys
import uuid
from pathlib import Path

from psycopg.types.json import Jsonb

from pulse_sdk.db import active_orgs, connect, tenant_tx

FAMILIES = {"esco", "onet"}
ONET_KIND = (("2.A", "skill"), ("2.B", "skill"), ("2.C", "knowledge"), ("1.A", "ability"), ("4.A", "work_activity"))


class Refused(Exception):
    """The download or manifest cannot be imported as it is; the message says why in plain words."""


def _text(path: Path) -> str:
    raw = path.read_bytes()
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise Refused(f"{path.name} is not UTF-8 text") from e


def _lines(cell: str | None) -> list[str]:
    return [x.strip() for x in (cell or "").replace("\r", "\n").split("\n") if x.strip()]


def read_esco(text: str) -> list[dict]:
    rows = list(csv.DictReader(io.StringIO(text)))
    if not rows or "conceptUri" not in rows[0] or "preferredLabel" not in rows[0]:
        raise Refused("Not an ESCO skills CSV: conceptUri and preferredLabel columns are missing")
    out = []
    for r in rows:
        out.append({"code": (r.get("conceptUri") or "").strip(), "label": (r.get("preferredLabel") or "").strip(),
                    "kind": "knowledge" if (r.get("skillType") or "").strip().lower() == "knowledge" else "skill",
                    "description": (r.get("description") or r.get("definition") or "").strip() or None,
                    "alternative": _lines(r.get("altLabels")), "hidden": _lines(r.get("hiddenLabels")),
                    "status": (r.get("status") or "released").strip().lower(),
                    "replacedBy": (r.get("isReplacedBy") or r.get("replacedBy") or "").strip() or None})
    return out


def read_onet(text: str) -> list[dict]:
    rows = list(csv.DictReader(io.StringIO(text), delimiter="\t"))
    if not rows or "Element ID" not in rows[0] or "Element Name" not in rows[0]:
        raise Refused("Not an O*NET content model file: Element ID and Element Name columns are missing")
    out = []
    for r in rows:
        code = (r.get("Element ID") or "").strip()
        kind = next((k for prefix, k in ONET_KIND if code.startswith(prefix)), "skill")
        out.append({"code": code, "label": (r.get("Element Name") or "").strip(), "kind": kind,
                    "description": (r.get("Description") or "").strip() or None,
                    "alternative": [], "hidden": [], "status": "released"})
    return out


def _slice_codes(m: dict, base: Path) -> set[str]:
    s = m.get("slice")
    if not isinstance(s, dict) or len(str(s.get("description") or "").strip()) < 3:
        raise Refused("Describe the approved slice (slice.description) and list its codes")
    if s.get("codes"):
        codes = {str(c).strip() for c in s["codes"] if str(c).strip()}
    elif s.get("codesFile"):
        rows = list(csv.DictReader(io.StringIO(_text(base / s["codesFile"]))))
        col = next((k for k in ("conceptUri", "code", "Element ID") if rows and k in rows[0]), None)
        if not col:
            raise Refused("The slice file needs a conceptUri, code or Element ID column")
        codes = {(r.get(col) or "").strip() for r in rows if (r.get(col) or "").strip()}
    else:
        raise Refused("A narrow slice: list the approved codes (slice.codes) or a collection file (slice.codesFile)")
    if not codes:
        raise Refused("The approved slice is empty")
    return codes


def read(manifest_path: Path) -> tuple[dict, list[dict], list[dict], dict]:
    """The manifest for the database, the concepts in the approved slice, the mappings and what was left out."""
    manifest_path = Path(manifest_path).expanduser()
    base = manifest_path.parent
    m = json.loads(_text(manifest_path))
    family = str(m.get("family") or "").lower()
    if family == "lightcast":
        raise Refused("Lightcast needs a commercial contract (owner errand E16); "
                      "Pulse imports approved downloads only and never scrapes it")
    if family not in FAMILIES:
        raise Refused("Import an approved ESCO or O*NET download")
    path = base / str(m.get("file") or "")
    if not m.get("file") or not path.is_file():
        raise Refused("The manifest's file is missing")
    raw = path.read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    if sha != str(m.get("fileSha256") or "").lower():
        raise Refused(f"{path.name} is not the approved file: its SHA-256 differs from the manifest's")
    text = _text(path)
    concepts = read_esco(text) if family == "esco" else read_onet(text)
    codes = _slice_codes(m, base)
    picked = [c for c in concepts if c["code"] in codes]
    left = {"inFile": len(concepts), "inSlice": len(picked),
            "sliceCodesNotInFile": len(codes - {c["code"] for c in concepts})}
    mappings = []
    if m.get("mappings"):
        mappings = [{k: (r.get(k) or "").strip() for k in ("fromFamily", "fromCode", "toFamily", "toCode", "relation")}
                    for r in csv.DictReader(io.StringIO(_text(base / m["mappings"])))]
    s = m["slice"]
    db = {"family": family, "version": m.get("version"), "language": m.get("language") or "en", "fileName": path.name,
          "fileSha256": sha, "dataLicence": m.get("dataLicence"), "softwareLicence": m.get("softwareLicence"),
          "attribution": m.get("attribution"), "sourceUrl": m.get("sourceUrl"), "approvalRef": m.get("approvalRef"),
          "slice": f"{str(s['description']).strip()[:240]} ({len(picked)} of {len(concepts)} concepts)"}
    return db, picked, mappings, left


def load(c, manifest_path: Path) -> dict:
    """Import into the tenant of the open transaction; the database checks the licences, attribution and approval."""
    db, concepts, mappings, left = read(manifest_path)
    r = c.execute("select pulse.skill_taxonomy_import(%s,%s,%s) r",
                  (Jsonb(db), Jsonb(concepts), Jsonb(mappings))).fetchone()
    return {**(r["r"] if isinstance(r, dict) else r[0]), **left}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--org", help="company id (default: the only active one)")
    ap.add_argument("--commit", action="store_true", help="keep the import (default: import, print counts, roll back)")
    a = ap.parse_args(argv)
    try:
        read(Path(a.manifest))      # refuse before connecting
    except Refused as e:
        raise SystemExit(str(e)) from None
    with connect("worker") as c:
        orgs = [uuid.UUID(a.org)] if a.org else active_orgs(c)
        if len(orgs) != 1:
            raise SystemExit("exactly one company expected: pass --org")
        out = None
        try:
            with tenant_tx(c, orgs[0]):
                out = load(c, Path(a.manifest))
                if not a.commit:
                    raise _Rollback()
        except _Rollback:
            pass
    print(json.dumps({"committed": a.commit, "counts": out}, default=str))


class _Rollback(Exception):
    pass


if __name__ == "__main__":
    try:
        main()
    except Refused as e:
        print(str(e), file=sys.stderr)
        raise SystemExit(2) from None
