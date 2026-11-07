"""WA-IMPORT: load WhatsApp group history (with its media) into Pulse from an import bundle, and check it afterwards.
Company-neutral: the bundle is built outside this repository (from the company's own exports) and names nothing here.

  Bundle (one directory per WhatsApp group):
    chat.json       {"sourceKey", "title", "titles", "clientId", "projectId", "timeZone", "members": [person ids],
                     "participants": [{"key", "label", "raw", "kind", "person"}],
                     "persons": [{"key", "kind", "personId", "name", "clientId", "phone", "assignedTo", "basis"}],
                     "source": {...provenance: the exports the bundle came from...}}
    messages.jsonl  one message per line: {"key", "seq", "at", "local", "sender", "kind", "subtype", "body", "edited",
                     "versions", "file", "fileName", "fileState", "mediaType", "extra", "exports"}
    files.jsonl     one file per line: {"sha256", "size", "mime", "kind", "meta"}; the bytes in files/<sha256>
                    (absent when --skip-stored and the target already holds the file complete).

  Load (idempotent: the same bundle twice adds nothing; an overlapping export adds only new messages):
    PULSE_DATABASE_URL_MIGRATE=... uv run --all-packages python tools/wa-import.py load <bundle> \
        --approval "<who approved>" --run-by "<operator>"
  Check against the bundle (message count and kinds, every import key, times, senders, every file complete with the
  right SHA-256):
    PULSE_DATABASE_URL_MIGRATE=... uv run --all-packages python tools/wa-import.py verify <bundle> [--deep]

Runs as the database's owner role with the company set (--org, else the install's company). Writes only through the
pulse.wa_import_* functions (migration 1015). Prints counts only, never message text, names or numbers.
"""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

TOOL = "wa-import/1"
PART = 1048576
CHUNK = 400


def connect(org=None):
    url = os.environ.get("PULSE_DATABASE_URL_MIGRATE") or os.environ.get("MIGRATE_DATABASE_URL")
    if not url:
        sys.exit("set PULSE_DATABASE_URL_MIGRATE (the database owner's login)")
    con = psycopg.connect(url, row_factory=dict_row, autocommit=False, application_name="wa-import")
    owner = os.environ.get("PULSE_DB_OWNER") or con.execute(
        "select pg_get_userbyid(datdba) r from pg_database where datname = current_database()").fetchone()["r"]
    con.execute(f'set role "{owner}"')
    org = org or con.execute("select pulse.install_org() o").fetchone()["o"]
    if not org:
        sys.exit("no company: pass --org")
    con.execute("select set_config('pulse.org_id', %s, false)", (str(org),))
    con.commit()
    return con


def read_bundle(path):
    d = Path(path)
    chat = json.loads((d / "chat.json").read_text())
    messages = [json.loads(line) for line in (d / "messages.jsonl").read_text().split("\n") if line.strip()]
    files = [json.loads(line) for line in (d / "files.jsonl").read_text().split("\n") if line.strip()] if (d / "files.jsonl").exists() else []
    h = hashlib.sha256()
    for name in ("chat.json", "messages.jsonl", "files.jsonl"):
        if (d / name).exists():
            h.update(name.encode() + b"\0" + (d / name).read_bytes() + b"\0")
    return d, chat, messages, files, h.hexdigest()


def store_file(con, d, f):
    """Declare, send the parts, seal. Returns 'stored', 'present' or 'missing'."""
    sha = f["sha256"]
    if con.execute("select pulse.wa_import_file(%s,%s,%s,%s,%s,%s) ok",
                   (sha, f["size"], f["mime"], f["kind"], json.dumps(f.get("meta") or {}), -(-f["size"] // PART))).fetchone()["ok"]:
        con.commit()
        return "present"
    p = d / "files" / sha
    if not p.exists():
        con.rollback()
        return "missing"
    data = p.read_bytes()
    if hashlib.sha256(data).hexdigest() != sha or len(data) != f["size"]:
        con.rollback()
        raise SystemExit(f"file {sha[:12]}: bytes do not match the bundle's SHA-256 or size")
    for i in range(0, len(data), PART):
        con.execute("select pulse.wa_import_file_part(%s,%s,%s)", (sha, i // PART, data[i:i + PART]))
    if not con.execute("select pulse.wa_import_file_seal(%s) ok", (sha,)).fetchone()["ok"]:
        con.rollback()
        raise SystemExit(f"file {sha[:12]}: stored parts did not seal")
    con.commit()
    return "stored"


def load(args):
    d, chat, messages, files, bundle_sha = read_bundle(args.bundle)
    con = connect(args.org)
    persons = {}
    for p in chat.get("persons", []):
        persons[p["key"]] = str(con.execute("select pulse.wa_import_person(%s) id", (json.dumps(p),)).fetchone()["id"])
    con.commit()
    participants = []
    for p in chat["participants"]:
        participants.append({**p, "person": persons.get(p["key"], p.get("person"))})
    members = sorted({*chat.get("members", []), *(persons[p["key"]] for p in chat.get("persons", []) if p["kind"] == "colleague")})
    begin = {k: chat.get(k) for k in ("sourceKey", "title", "titles", "clientId", "projectId", "timeZone", "source")}
    begin.update(bundleSha256=bundle_sha, tool=TOOL, approvalRef=args.approval, runBy=args.run_by, members=members, participants=participants)
    b = con.execute("select pulse.wa_import_begin(%s) r", (json.dumps(begin),)).fetchone()["r"]
    con.commit()
    out = {"chat": b["chatId"], "batch": b["batchId"], "bundle": bundle_sha[:12], "persons": len(persons)}
    if b["done"]:
        print(json.dumps({**out, "already": True, "added": 0}))
        return
    counts = {"stored": 0, "present": 0, "missing": 0}
    for f in files:
        counts[store_file(con, d, f)] += 1
    if counts["missing"]:
        raise SystemExit(f"{counts['missing']} file(s) neither in the bundle nor stored: rebuild the bundle with the files")
    added = dupes = 0
    for i in range(0, len(messages), CHUNK):
        r = con.execute("select pulse.wa_import_messages(%s,%s) r", (b["batchId"], json.dumps(messages[i:i + CHUNK]))).fetchone()["r"]
        added += r["added"]; dupes += r["duplicates"]
    stats = {"bundleMessages": len(messages), "bundleFiles": len(files), "files": counts, "kinds": {}}
    for m in messages:
        stats["kinds"][m["kind"]] = stats["kinds"].get(m["kind"], 0) + 1
    fin = con.execute("select pulse.wa_import_finish(%s,%s) r", (b["batchId"], json.dumps(stats))).fetchone()["r"]
    con.commit()
    print(json.dumps({**out, "already": False, "added": added, "duplicates": dupes, "files": counts, "chatMessages": fin["messages"], "kinds": fin["kinds"]}))


def verify(args):
    d, chat, messages, files, bundle_sha = read_bundle(args.bundle)
    con = connect(args.org)
    c = con.execute("select id, channel_id from pulse_priv.wa_chat where org_id = pulse.current_org() and source_key = %s", (chat["sourceKey"],)).fetchone()
    if not c:
        print(json.dumps({"ok": False, "why": "chat not loaded"})); sys.exit(1)
    rows = {r["import_key"]: r for r in con.execute(
        """select m.import_key, m.sent_at, m.local_time, m.kind, m.subtype, m.edited, m.file_sha256, m.file_state, m.media_type,
                  md5(m.body) body_md5, p.source_key sender, b.withdrawn_at is not null withdrawn
           from pulse_priv.wa_message m join pulse_priv.wa_import_batch b on b.id = m.batch_id
           left join pulse_priv.wa_participant p on p.id = m.participant_id
           where m.org_id = pulse.current_org() and m.chat_id = %s""", (c["id"],))}
    problems = {}

    def bad(kind):
        problems[kind] = problems.get(kind, 0) + 1

    from datetime import datetime
    for m in messages:
        r = rows.get(m["key"])
        if r is None:
            bad("missing_message"); continue
        if r["withdrawn"]:
            bad("withdrawn")
        if r["sent_at"] != datetime.fromisoformat(m["at"].replace("Z", "+00:00")):
            bad("time")
        if r["local_time"] != m["local"]:
            bad("local_time")
        if (r["kind"], r["subtype"], bool(r["edited"])) != (m["kind"], m.get("subtype"), bool(m.get("edited"))):
            bad("kind_subtype_edited")
        if r["sender"] != m.get("sender"):
            bad("sender")
        if r["body_md5"] != hashlib.md5((m.get("body") or "").encode()).hexdigest():
            bad("body")
        if (r["file_sha256"], r["file_state"], r["media_type"]) != (m.get("file"), m.get("fileState"), m.get("mediaType")):
            bad("file_ref")
    extra = len(set(rows) - {m["key"] for m in messages})
    need = {f["sha256"] for f in files} | {m["file"] for m in messages if m.get("file")}
    stored = {r["sha256"]: r for r in con.execute(
        "select sha256, size, complete, parts from pulse_priv.wa_file where org_id = pulse.current_org() and sha256 = any(%s)", (list(need),))}
    for sha in need:
        f = stored.get(sha)
        if not f or not f["complete"]:
            bad("file_not_complete")
        elif args.deep:
            got = con.execute("""select encode(sha256(string_agg(data, ''::bytea order by part)), 'hex') h, count(*) n from pulse_priv.wa_file_part
                                 where org_id = pulse.current_org() and sha256 = %s""", (sha,)).fetchone()
            if got["h"] != sha or got["n"] != f["parts"]:
                bad("file_sha256")
    members = con.execute("select count(*) n from pulse.chat_member where channel_id = %s", (c["channel_id"],)).fetchone()["n"]
    out = {"ok": not problems, "chat": str(c["id"]), "bundleMessages": len(messages), "chatMessages": len(rows), "notInBundle": extra,
           "files": len(need), "filesComplete": sum(1 for s in need if stored.get(s, {}).get("complete")), "deep": bool(args.deep),
           "members": members, "problems": problems}
    print(json.dumps(out))
    con.rollback()
    if problems:
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    lo = sub.add_parser("load")
    lo.add_argument("bundle")
    lo.add_argument("--approval", required=True)
    lo.add_argument("--run-by", required=True)
    lo.add_argument("--org")
    ve = sub.add_parser("verify")
    ve.add_argument("bundle")
    ve.add_argument("--deep", action="store_true", help="recompute every stored file's SHA-256 from its parts")
    ve.add_argument("--org")
    args = ap.parse_args()
    (load if args.cmd == "load" else verify)(args)


if __name__ == "__main__":
    main()
