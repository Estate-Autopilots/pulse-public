"""WA-REPORT: load an edition of the company's analysis book into Pulse (migration 1074). Company-neutral: the book is
built outside this repository from the company's own data; this tool only stores it and maps the message and group
keys it cites to this database's imported chats (keys of tools/wa-import.py).

  Edition directory:
    build.json   {"version", "build", "built_at", "pages_printed", "chapters": {part: n}, "words", ...}
    pages.jsonl  {"key", "part", "level", "sort", "title", "subtitle", "summary", "blocks", "subject": {kind, id}|null,
                  "md", "printed": {start, pages}|null, "evidence": [message keys]}
    book.pdf, book.md (optional), slices/<anchor>.pdf (optional: one page's PDF; the anchor is the key with / -> -)

    PULSE_DATABASE_URL_MIGRATE=... uv run --all-packages python tools/wa-report.py load <dir> [--replace]
    ... tools/wa-report.py status

A load writes a new edition and makes it current in one transaction (the previous one becomes old; the last three
editions are kept). Loading the same version again does nothing unless --replace. Prints counts only.
"""
import argparse
import hashlib
import importlib.util
import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

from psycopg.types.json import Jsonb

spec = importlib.util.spec_from_file_location("wa_import", Path(__file__).with_name("wa-import.py"))
wa_import = importlib.util.module_from_spec(spec); spec.loader.exec_module(wa_import)

PART = 1 << 20
KEEP = 3
GROUP = re.compile(r"\bg_[0-9a-f]{16}\b")


def import_key(message_key):
    """The import key tools/wa-import.py stores for a message of the export (wa_message.import_key)."""
    return hashlib.sha256(("wa-import/1:" + message_key).encode()).hexdigest()


def anchor(key):
    return re.sub(r"[^a-z0-9]+", "-", key.lower()).strip("-")


def store_file(cur, edition, key, path, mime):
    data = Path(path).read_bytes()
    parts = -(-len(data) // PART) if data else 0
    cur.execute("insert into pulse_priv.report_file (org_id, edition_id, key, mime, size, sha256, parts) values (pulse.current_org(), %s, %s, %s, %s, %s, %s)",
                (edition, key, mime, len(data), hashlib.sha256(data).hexdigest(), parts))
    for n in range(parts):
        cur.execute("insert into pulse_priv.report_file_part (edition_id, key, n, data) values (%s, %s, %s, %s)", (edition, key, n, data[n * PART:(n + 1) * PART]))
    return len(data)


def load(args):
    d = Path(args.dir)
    meta = json.loads((d / "build.json").read_text())
    version = f"{meta['build']}/{meta['version']}"
    con = wa_import.connect(args.org)
    old = con.execute("select id, status from pulse_priv.report_edition where org_id = pulse.current_org() and version = %s", (version,)).fetchone()
    if old and not args.replace:
        print(json.dumps({"already": True, "version": version, "status": old["status"]})); return
    chats = {r["source_key"]: str(r["id"]) for r in con.execute("select source_key, id from pulse_priv.wa_chat where org_id = pulse.current_org()")}
    keys = {r["import_key"]: (str(r["chat_id"]), str(r["id"])) for r in con.execute("select chat_id, import_key, id from pulse_priv.wa_message where org_id = pulse.current_org()")}
    counts = Counter()
    with con.cursor() as cur:
        if old:
            cur.execute("delete from pulse_priv.report_edition where id = %s", (old["id"],))
        built = datetime.strptime(meta["built_at"], "%d %b %Y %H:%M IST").isoformat() + "+05:30" if "IST" in meta["built_at"] else meta["built_at"]
        cur.execute("""insert into pulse_priv.report_edition (org_id, version, title, built_at, pages_printed, chapters, stats)
                       values (pulse.current_org(), %s, %s, %s, %s, %s, %s) returning id""",
                    (version, meta.get("title") or "The analysis of the client groups", built, meta.get("pages_printed"), sum((meta.get("chapters") or {}).values()),
                     Jsonb({"chapters": meta.get("chapters"), "words": meta.get("words"), "sources": meta.get("sources"), "v3": meta.get("v3")})))
        edition = cur.fetchone()["id"]
        batch = []
        for line in (d / "pages.jsonl").read_text().split("\n"):
            if not line.strip(): continue
            p = json.loads(line)
            ev = {}
            for m in p.get("evidence") or []:
                hit = keys.get(import_key(m))
                if hit: ev[m] = list(hit); counts["evidence"] += 1
                else: counts["evidence_missing"] += 1
            links = {g: chats[g] for g in set(GROUP.findall(json.dumps(p["blocks"]))) | ({p["subject"]["id"]} if p.get("subject") and p["subject"]["kind"] == "group" else set()) if g in chats}
            subj = p.get("subject") or {}
            batch.append((edition, p["key"], p["part"], p.get("level") or 2, p["sort"], p["title"][:300], p.get("subtitle"), p.get("summary"),
                          subj.get("kind"), subj.get("id"), Jsonb(p["blocks"]), p["md"], Jsonb(ev), Jsonb(links), Jsonb(p.get("printed")) if p.get("printed") else None,
                          p["title"], p.get("summary") or "", p["md"][:200000]))
            counts["pages"] += 1; counts[f"part:{p['part']}"] += 1
            if len(batch) >= 200:
                ins(cur, batch); batch = []
        if batch: ins(cur, batch)
        size = 0
        if (d / "book.pdf").exists(): size += store_file(cur, edition, "book.pdf", d / "book.pdf", "application/pdf"); counts["files"] += 1
        if (d / "book.md").exists(): size += store_file(cur, edition, "book.md", d / "book.md", "text/markdown"); counts["files"] += 1
        pages = {anchor(k["key"]): k["key"] for k in con.execute("select key from pulse_priv.report_page where edition_id = %s", (edition,)).fetchall()}
        if (d / "slices").exists():
            for f in sorted((d / "slices").glob("*.pdf")):
                key = pages.get(f.stem)
                if not key: counts["slice_unknown"] += 1; continue
                size += store_file(cur, edition, f"slice:{key}", f, "application/pdf"); counts["slices"] += 1
        cur.execute("update pulse_priv.report_edition set status = 'old' where org_id = pulse.current_org() and status = 'current'")
        cur.execute("update pulse_priv.report_edition set status = 'current', loaded_at = now() where id = %s", (edition,))
        cur.execute("""delete from pulse_priv.report_edition where org_id = pulse.current_org() and id in (
                         select id from pulse_priv.report_edition where org_id = pulse.current_org() and status = 'old' order by loaded_at desc offset %s)""", (KEEP - 1,))
        counts["bytes"] = size
    con.commit()
    print(json.dumps({"version": version, **counts}))


def ins(cur, batch):
    cur.executemany("""insert into pulse_priv.report_page (org_id, edition_id, key, part, level, sort, title, subtitle, summary, subject_kind, subject_id, blocks, md,
                          evidence, links, printed, search)
                       values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                               setweight(to_tsvector('simple', %s), 'A') || setweight(to_tsvector('simple', %s), 'B') || to_tsvector('simple', %s))""", batch)


def status(args):
    con = wa_import.connect(args.org)
    for r in con.execute("""select version, status, pages_printed, chapters, loaded_at, (select count(*) from pulse_priv.report_page p where p.edition_id = e.id) pages,
                              (select count(*) from pulse_priv.report_file f where f.edition_id = e.id) files from pulse_priv.report_edition e
                            where org_id = pulse.current_org() order by loaded_at desc"""):
        print(json.dumps({k: (str(v) if k == "loaded_at" else v) for k, v in r.items()}))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--org"); sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("load"); a.add_argument("dir"); a.add_argument("--replace", action="store_true")
    sub.add_parser("status")
    args = ap.parse_args()
    {"load": load, "status": status}[args.cmd](args)


if __name__ == "__main__":
    main()
