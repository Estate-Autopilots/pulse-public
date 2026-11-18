#!/usr/bin/env python3
"""Load the O*NET database into Pulse's skills library (PROFILE-2, owner, 17 Nov 2026: "a skills database (like
LinkedIn's) ... seed from an open taxonomy (ESCO / O*NET, check licence), no scraping").

    python3 tools/admin/skill-library-import.py --zip db_30_0_text.zip --sha256 <hex> --version 30.0 \\
        --approver "Owner Name (owner)" --words "..." --dsn-env /etc/estate-autopilots/db/pulse.env:PULSE_DATABASE_URL_MIGRATE [--apply]

  * Reads one local file: the O*NET "text" database download (https://www.onetcenter.org/database.html). Nothing is
    fetched or scraped here. The file must match --sha256.
  * Licence: the O*NET Database is under Creative Commons Attribution 4.0 (CC BY 4.0); the attribution below is stored
    with the list (pulse_priv.skill_library_source) and shown under the skill picker. O*NET is a trademark of USDOL/ETA.
  * What is taken: technology skill names (with their commodity title as the category), the Skills and Knowledge
    elements, occupation titles and their alternate and reported job titles (to match a person's role), and which
    occupations use what (the "important" skills and knowledge, IM >= 3.0, and every technology skill). Descriptions,
    tasks and ratings are not copied; the ratings only rank suggestions.
  * Pulse's own starting list (migration 2215) wins a clash of names. A re-run with a newer version updates the rows it
    owns and retires the ones the new file no longer has; people's skills keep their own words either way.
  * One transaction; without --apply it does everything, prints counts and rolls back. Runs only on the Pulse server.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import socket
import sys
import zipfile
from collections import defaultdict

import psycopg

APP = "pulse-skill-library-import"
DEFAULT_HOSTS = "host-49a12d.internal.example"
ATTRIBUTION = ("This list includes information from the O*NET {v} Database by the U.S. Department of Labor, Employment and "
               "Training Administration (USDOL/ETA). Used under the CC BY 4.0 license. O*NET® is a trademark of USDOL/ETA.")
ADAPTED = ("Pulse took the technology skill names, the Skills and Knowledge element names and the job titles, and ranks "
           "suggestions by how many occupations use each one; USDOL/ETA has not approved, endorsed or tested these changes.")


def dsn(args) -> str:
    if args.database:
        return args.database
    path, _, key = (args.dsn_env or "").partition(":")
    if not path or not key:
        raise SystemExit("Give --database or --dsn-env <file>:<variable>")
    for line in open(path, encoding="utf-8"):
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f"{key} is not in {path}")


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:150]


def table(z: zipfile.ZipFile, name: str) -> list[dict]:
    member = next((n for n in z.namelist() if n.endswith("/" + name) or n == name), None)
    if member is None:
        raise ValueError(f"{name} is not in the download")
    return list(csv.DictReader(io.StringIO(z.read(member).decode("utf-8-sig")), delimiter="\t"))


def read(path: str) -> dict:
    with zipfile.ZipFile(path) as z:
        tech, skills, know = table(z, "Technology Skills.txt"), table(z, "Skills.txt"), table(z, "Knowledge.txt")
        occ, alt = table(z, "Occupation Data.txt"), table(z, "Alternate Titles.txt")
        try:
            reported = table(z, "Sample of Reported Titles.txt")
        except ValueError:
            reported = []
    lib: dict[str, dict] = {}
    links: dict[tuple[str, str], float] = {}
    used = defaultdict(set)
    for r in tech:
        label = (r.get("Example") or "").strip()
        soc = (r.get("O*NET-SOC Code") or "").strip()
        if not label or not soc or len(label) > 120:
            continue
        sid = "onet:t:" + slug(label)
        hot = (r.get("Hot Technology") or "").strip() == "Y"
        row = lib.setdefault(sid, {"id": sid, "label": label, "kind": "software", "code": (r.get("Commodity Code") or "").strip()[:60] or None,
                                   "category": (r.get("Commodity Title") or "").strip()[:120] or None, "hot": False})
        row["hot"] = row["hot"] or hot
        used[sid].add(soc)
        links[(soc, sid)] = max(links.get((soc, sid), 0), 1.5 if hot else 1.0)
    for rows, kind in ((skills, "skill"), (know, "knowledge")):
        for r in rows:
            if (r.get("Scale ID") or "").strip() != "IM":
                continue
            eid, name, soc = (r.get("Element ID") or "").strip(), (r.get("Element Name") or "").strip(), (r.get("O*NET-SOC Code") or "").strip()
            try:
                im = float(r.get("Data Value") or 0)
            except ValueError:
                continue
            if not eid or not name or not soc:
                continue
            sid = "onet:" + eid
            lib.setdefault(sid, {"id": sid, "label": name, "kind": kind, "code": eid[:60], "category": "Skills" if kind == "skill" else "Knowledge", "hot": False})
            if im >= 3.0:
                used[sid].add(soc)
                links[(soc, sid)] = round((im - 2.5) * 0.8, 3)
    roles: dict[tuple[str, str], str] = {}
    for r in occ:
        soc, title = (r.get("O*NET-SOC Code") or "").strip(), (r.get("Title") or "").strip()
        if soc and title:
            roles[(soc, title.lower())] = title
    for r in alt:
        soc = (r.get("O*NET-SOC Code") or "").strip()
        for col in ("Alternate Title", "Short Title"):
            t = (r.get(col) or "").strip()
            if soc and t and t != "n/a" and len(t) <= 160:
                roles.setdefault((soc, t.lower()), t)
    for r in reported:
        soc, t = (r.get("O*NET-SOC Code") or "").strip(), (r.get("Reported Job Title") or "").strip()
        if soc and t and len(t) <= 160:
            roles.setdefault((soc, t.lower()), t)
    for sid, row in lib.items():
        row["weight"] = float(len(used[sid]))
    return {"lib": list(lib.values()), "links": [(s, k, w) for (s, k), w in links.items() if k in lib],
            "roles": [(soc, t) for (soc, _), t in roles.items()]}


def refuse(msg: str) -> int:
    print(f"Refused (nothing was written): {msg}", file=sys.stderr)
    return 2


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--zip", required=True, help="the O*NET text database download (.zip)")
    ap.add_argument("--sha256", required=True, help="the download's SHA-256")
    ap.add_argument("--version", required=True, help="the O*NET database version, e.g. 30.0")
    ap.add_argument("--approver", required=True)
    ap.add_argument("--words", required=True)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--database")
    ap.add_argument("--dsn-env")
    args = ap.parse_args(argv)
    allowed = {h.strip() for h in os.environ.get("PULSE_ADMIN_TOOL_HOSTS", DEFAULT_HOSTS).split(",") if h.strip()}
    if socket.gethostname() not in allowed:
        return refuse(f"this tool runs only on {', '.join(sorted(allowed))}")
    if not re.fullmatch(r"\d{1,3}\.\d{1,3}", args.version):
        return refuse("--version is like 30.0")
    if len(args.approver.strip()) < 3 or len(args.words.strip()) < 4:
        return refuse("name the approver and give their words")
    raw = open(args.zip, "rb").read()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != args.sha256.strip().lower():
        return refuse("the file does not match --sha256")
    try:
        data = read(args.zip)
    except (ValueError, zipfile.BadZipFile, KeyError) as e:
        return refuse(f"not an O*NET text database download: {e}")
    src = f"onet-{args.version}"
    actor = f"skill-library-import.py · approver: {args.approver.strip()}"[:120]
    try:
        with psycopg.connect(dsn(args), application_name=APP) as c:
            c.execute("set lock_timeout = '15s'")
            c.execute("set statement_timeout = '600s'")
            c.execute("""insert into pulse_priv.skill_library_source(id, name, version, licence, attribution, adapted, source_url, file_sha256, imported_by)
                         values (%s, 'O*NET Database', %s, 'Creative Commons Attribution 4.0 International (CC BY 4.0)', %s, %s,
                                 'https://www.onetcenter.org/database.html', %s, %s)
                         on conflict (id) do update set file_sha256 = excluded.file_sha256, imported_by = excluded.imported_by, imported_at = now()""",
                      (src, args.version, ATTRIBUTION.format(v=args.version), ADAPTED, digest, actor))
            c.execute("""create temp table lib_in (id text, label text, kind text, code text, category text, weight real, hot boolean) on commit drop""")
            with c.cursor().copy("copy lib_in from stdin") as cp:
                for r in data["lib"]:
                    cp.write_row((r["id"], r["label"], r["kind"], r["code"], r["category"], r["weight"], r["hot"]))
            updated = c.execute("""update pulse_priv.skill_library l set label = i.label, label_key = pulse.skill_library_key(i.label), kind = i.kind, code = i.code,
                  category = i.category, weight = i.weight, hot = i.hot, retired_at = null, source = %s
                  from lib_in i where l.id = i.id and l.source like 'onet-%%'""", (src,)).rowcount
            added = c.execute("""insert into pulse_priv.skill_library(id, source, kind, label, label_key, code, category, weight, hot)
                  select distinct on (pulse.skill_library_key(i.label)) i.id, %s, i.kind, i.label, pulse.skill_library_key(i.label), i.code, i.category, i.weight, i.hot
                    from lib_in i
                   where not exists (select 1 from pulse_priv.skill_library l where l.id = i.id)
                     and not exists (select 1 from pulse_priv.skill_library l where l.label_key = pulse.skill_library_key(i.label) and l.retired_at is null)
                   order by pulse.skill_library_key(i.label), i.weight desc""", (src,)).rowcount
            retired = c.execute("""update pulse_priv.skill_library l set retired_at = now() where l.source like 'onet-%%' and l.retired_at is null
                  and not exists (select 1 from lib_in i where i.id = l.id)""").rowcount
            c.execute("delete from pulse_priv.skill_library_link lk using pulse_priv.skill_library l where l.id = lk.skill_id and l.source like 'onet-%%'")
            c.execute("delete from pulse_priv.skill_library_role where source like 'onet-%%'")
            c.execute("create temp table link_in (occupation text, skill_id text, weight real) on commit drop")
            with c.cursor().copy("copy link_in from stdin") as cp:
                for row in data["links"]:
                    cp.write_row(row)
            links = c.execute("""insert into pulse_priv.skill_library_link(occupation, skill_id, weight)
                  select i.occupation, i.skill_id, max(i.weight) from link_in i join pulse_priv.skill_library l on l.id = i.skill_id and l.retired_at is null
                  group by 1, 2 on conflict do nothing""").rowcount
            c.execute("create temp table role_in (occupation text, title text) on commit drop")
            with c.cursor().copy("copy role_in from stdin") as cp:
                for row in data["roles"]:
                    cp.write_row(row)
            roles = c.execute("""insert into pulse_priv.skill_library_role(occupation, title, title_key, source)
                  select distinct on (occupation, pulse.skill_library_key(title)) occupation, title, pulse.skill_library_key(title), %s from role_in
                   where length(pulse.skill_library_key(title)) >= 1 order by occupation, pulse.skill_library_key(title) on conflict do nothing""", (src,)).rowcount
            relinked = c.execute("""update pulse_priv.account_profile set skill_refs = pulse.skill_refs_of(skills)
                  where cardinality(coalesce(skills, '{}')) > 0""").rowcount
            counts = {"inFile": len(data["lib"]), "added": added, "updated": updated, "retired": retired, "links": links, "jobTitles": roles,
                      "accountsRelinked": relinked, "live": c.execute("select count(*) from pulse_priv.skill_library where source = %s and retired_at is null", (src,)).fetchone()[0]}
            c.execute("update pulse_priv.skill_library_source set counts = %s where id = %s", (json.dumps(counts), src))
            c.execute("""insert into pulse_priv.platform_audit(actor, action, target_kind, target_id, reason, detail)
                         values (%s, %s, 'skill_library', %s, %s, %s)""",
                      (actor, "admin.skill_library_import" if args.apply else "admin.skill_library_import_dry_run", src, args.words.strip()[:400],
                       json.dumps({"sha256": digest, "file": os.path.basename(args.zip), **counts})))
            if args.apply:
                c.commit()
            else:
                c.rollback()
    except psycopg.Error as e:
        print(f"The database failed (nothing was written): {(e.diag.message_primary or str(e)).strip()}", file=sys.stderr)
        return 1
    print(json.dumps({"applied": args.apply, "source": src, **counts}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
