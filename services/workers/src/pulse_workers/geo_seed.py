"""Load the project location research files into the Pulse Map tables, with provenance.

    python -m pulse_workers.geo_seed --dir ~/ea-research/data/geo [--org UUID] [--dry-run]

Reads ``projects_geo.csv`` and ``localities.csv`` (plus ``project_engagements.csv`` to link each Drive project
folder to its development, ``manual_review.csv`` for review flags and ``manifest.json`` for the build time). Each
file is recorded in ``pulse.geo_import`` with its SHA-256. Loading again is safe: rows are matched on the research
key, and a pin that someone placed in the app (``pinned_at`` set) keeps its position; only its seed columns refresh.
"""
# ruff: noqa: E501  (SQL kept on one line per column)
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

from pulse_sdk.db import active_orgs, connect, tenant_tx

PRECISIONS = {"exact", "building", "street", "locality", "city"}


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower()


def split(text: str) -> list[str]:
    return [part.strip() for part in (text or "").split(";") if part.strip()]


def read_csv(path: Path) -> tuple[list[dict[str, str]], str]:
    raw = path.read_bytes()
    return list(csv.DictReader(raw.decode("utf-8-sig").splitlines())), hashlib.sha256(raw).hexdigest()


def point(row: dict[str, str]) -> tuple[float | None, float | None, str | None]:
    """A row has a point only when latitude, longitude and a known precision are all present and in range."""
    try:
        lat, lng = float(row["lat"]), float(row["lng"])
    except (KeyError, ValueError):
        return None, None, None
    precision = row.get("precision", "").strip()
    if precision not in PRECISIONS or not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None, None, None
    return lat, lng, precision


def record_import(conn, org, name: str, sha: str, rows: int, built_at: str | None, note: str) -> str:
    return conn.execute(
        """insert into pulse.geo_import(org_id,file_name,sha256,row_count,built_at,note) values (%s,%s,%s,%s,%s,%s)
           on conflict (org_id,file_name,sha256) do update set imported_at=now(),row_count=excluded.row_count,note=excluded.note
           returning id""", (org, name, sha, rows, built_at, note)).fetchone()["id"]


def load(conn, org, directory: Path) -> dict[str, int]:
    projects, projects_sha = read_csv(directory / "projects_geo.csv")
    localities, localities_sha = read_csv(directory / "localities.csv")
    engagements, engagements_sha = read_csv(directory / "project_engagements.csv") if (directory / "project_engagements.csv").exists() else ([], "")
    review, review_sha = read_csv(directory / "manual_review.csv") if (directory / "manual_review.csv").exists() else ([], "")
    manifest = json.loads((directory / "manifest.json").read_text()) if (directory / "manifest.json").exists() else {}
    built_at = manifest.get("generated_at")
    flags = {r["project_id"]: [f for f in split(r.get("reason", "")) if f != "manual_project_pin_needed"] for r in review}
    stats: dict[str, int] = defaultdict(int)
    for name, rows, sha in (("project_engagements.csv", engagements, engagements_sha),
                            ("manual_review.csv", review, review_sha)):
        if sha:
            record_import(conn, org, name, sha, len(rows), built_at, "Join and review evidence for the location seed")

    batch = record_import(conn, org, "localities.csv", localities_sha, len(localities), built_at, f"Project location research, {directory}")
    conn.execute("delete from pulse.locality where import_id is distinct from %s", (batch,))
    for r in localities:
        lat, lng, precision = point(r)
        conn.execute(
            """insert into pulse.locality(org_id,name,city,lat,lng,precision,source,project_count,engagement_count,aliases,import_id)
               values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               on conflict (org_id,city,name) do update set lat=excluded.lat,lng=excluded.lng,precision=excluded.precision,source=excluded.source,
                 project_count=excluded.project_count,engagement_count=excluded.engagement_count,aliases=excluded.aliases,import_id=excluded.import_id""",
            (org, r["locality"].strip(), r["city"].strip(), lat, lng, precision if precision in ("locality", "city") else None,
             r["source"].strip() or None, int(r["project_count"] or 0), int(r["engagement_count"] or 0), split(r["aliases"]), batch))
        stats["localities"] += 1

    batch = record_import(conn, org, "projects_geo.csv", projects_sha, len(projects), built_at, f"Project location research, {directory}")
    ids: dict[str, str] = {}
    for r in projects:
        lat, lng, precision = point(r)
        source = r["source"].strip() or None
        ids[r["project_id"]] = conn.execute(
            """insert into pulse.project_location(org_id,geo_key,name,client_label,locality,city,lat,lng,precision,source,
                 rera_numbers,maps_links,review_flags,seed_lat,seed_lng,seed_precision,seed_source,import_id)
               values (%(org)s,%(key)s,%(name)s,%(client)s,%(locality)s,%(city)s,%(lat)s,%(lng)s,%(precision)s,%(source)s,
                 %(rera)s,%(maps)s,%(flags)s,%(lat)s,%(lng)s,%(precision)s,%(source)s,%(batch)s)
               on conflict (org_id,geo_key) do update set name=excluded.name,client_label=excluded.client_label,locality=excluded.locality,
                 city=excluded.city,rera_numbers=excluded.rera_numbers,maps_links=excluded.maps_links,review_flags=excluded.review_flags,
                 seed_lat=excluded.seed_lat,seed_lng=excluded.seed_lng,seed_precision=excluded.seed_precision,seed_source=excluded.seed_source,
                 import_id=excluded.import_id,updated_at=now(),
                 lat=case when pulse.project_location.pinned_at is null then excluded.lat else pulse.project_location.lat end,
                 lng=case when pulse.project_location.pinned_at is null then excluded.lng else pulse.project_location.lng end,
                 precision=case when pulse.project_location.pinned_at is null then excluded.precision else pulse.project_location.precision end,
                 source=case when pulse.project_location.pinned_at is null then excluded.source else pulse.project_location.source end
               returning id""",
            {"org": org, "key": r["project_id"], "name": r["name"].strip() or None, "client": r["client"].strip() or None,
             "locality": r["locality"].strip() or None, "city": r["city"].strip() or None, "lat": lat, "lng": lng,
             "precision": precision, "source": source if precision else None, "rera": split(r["rera_numbers"]),
             "maps": split(r["maps_link"]), "flags": flags.get(r["project_id"], []), "batch": batch}).fetchone()["id"]
        stats["locations"] += 1
        stats["located" if precision else "unlocated"] += 1

    # Link each Drive project folder to its development: folder names are what both sides share.
    by_name: dict[str, list[dict]] = defaultdict(list)
    for p in conn.execute("select id,name,start_month::text as month from pulse.project where kind='client_work' and not exists(select 1 from pulse.record_merge r where r.entity_type='project' and r.gone_id=project.id and r.undone_at is null)").fetchall():
        by_name[norm(p["name"])].append(p)
    conn.execute("delete from pulse.project_location_member where basis<>'pulse'")
    linked: set[str] = set()
    for e in engagements:
        location = ids.get(e["project_id"])
        # A "/" in a folder name splits the indexed path, so the project keeps only the part before it.
        names = {norm(e["folder_name"]), norm(e["folder_name"].split("/")[0])}
        candidates = [p for name in names for p in by_name.get(name, []) if str(p["id"]) not in linked]
        if not location or not candidates:
            stats["folders_unmatched"] += 1
            continue
        same_month = [p for p in candidates if (p["month"] or "")[:7] == e["month"]]
        matches = same_month or candidates
        if len(matches) != 1:
            stats["folders_ambiguous"] += 1
            stats["folders_unmatched"] += 1
            continue
        project = matches[0]
        linked.add(str(project["id"]))
        conn.execute("insert into pulse.project_location_member(org_id,project_id,location_id,folder_id) values (%s,%s,%s,%s) on conflict(project_id) do nothing",
                     (org, project["id"], location, e["folder_id"] or None))
        stats["folders_linked"] += 1
    return dict(stats)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pulse_workers.geo_seed", description=__doc__.split("\n\n")[0])
    ap.add_argument("--dir", type=Path, required=True, help="directory holding projects_geo.csv and localities.csv")
    ap.add_argument("--org", default=None, help="tenant (default: the only active organisation)")
    ap.add_argument("--dry-run", action="store_true", help="load, report, then roll back")
    args = ap.parse_args(argv)
    with connect("worker") as conn:
        conn.autocommit = True
        orgs = [args.org] if args.org else active_orgs(conn)
        if len(orgs) != 1:
            print(f"pass --org: {len(orgs)} active organisations", file=sys.stderr)
            return 2

        class Rollback(Exception):
            pass
        try:
            with tenant_tx(conn, orgs[0]):
                stats = load(conn, orgs[0], args.dir.expanduser())
                print(json.dumps(stats, sort_keys=True))
                if args.dry_run:
                    raise Rollback
        except Rollback:
            print("dry run: rolled back")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
