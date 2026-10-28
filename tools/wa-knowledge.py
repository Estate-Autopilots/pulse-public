"""WA-DATASETS: load the retrieval corpus over imported WhatsApp history into Pulse (migration 1099: pulse_priv.wa_chunk,
wa_chunk_vec, wa_term). Company-neutral: the corpus is built outside this repository from the company's own imports
(redacted text, local multilingual embeddings); this tool only maps import keys to rows, replaces what it loaded before
for the same chats and recounts the word statistics.

  Load directory (JSON lines):
    chunks.jsonl {"key": chunk id, "group": the chat's source key (wa_chat.source_key), "messages": [message import
                  keys, in order], "client": uuid|null, "project": uuid|null, "stage", "first_at", "last_at",
                  "persons": [Pulse person uuids], "topics": [...], "langs": [...], "body": redacted text,
                  "vectors": [[768 numbers], …] (one per substantive message, may be empty), "model", "version"}

    PULSE_DATABASE_URL_MIGRATE=... uv run --all-packages python tools/wa-knowledge.py load <dir> [--org <uuid>]
    PULSE_DATABASE_URL_MIGRATE=... uv run --all-packages python tools/wa-knowledge.py status

Rows of chats not imported yet are skipped and counted; a client, project or person the company does not have is left
empty. Prints counts only, never text.
"""
import argparse
import importlib.util
import json
import sys
import uuid
from collections import Counter
from pathlib import Path

spec = importlib.util.spec_from_file_location("wa_import", Path(__file__).with_name("wa-import.py"))
wa_import = importlib.util.module_from_spec(spec); spec.loader.exec_module(wa_import)


def vec(v):
    if not v:
        return None
    if len(v) != 768:
        raise ValueError("embedding must have 768 numbers")
    return "[" + ",".join(f"{float(x):.6g}" for x in v) + "]"


def load(args):
    con = wa_import.connect(args.org)
    chats = {r["source_key"]: r["id"] for r in con.execute("select source_key, id from pulse_priv.wa_chat where org_id = pulse.current_org()")}
    clients = {str(r["id"]) for r in con.execute("select id from pulse.client where org_id = pulse.current_org()")}
    projects = {str(r["id"]) for r in con.execute("select id from pulse.project where org_id = pulse.current_org()")}
    persons = {str(r["id"]) for r in con.execute("select id from pulse.person where org_id = pulse.current_org()")}
    n, keys, seen = Counter(), {}, set()
    batch, vecs = [], []
    with open(Path(args.dir) / "chunks.jsonl", encoding="utf-8") as fh:      # streamed: the file holds every vector
        for line in fh:
            if not line.strip():
                continue
            r = json.loads(line)
            chat = chats.get(r["group"])
            if chat is None:
                n["skipped_chat_not_imported"] += 1; continue
            if chat not in seen:                    # a chat's first piece: replace what was loaded for it before
                seen.add(chat)
                con.execute("delete from pulse_priv.wa_chunk where org_id = pulse.current_org() and chat_id = %s", (chat,))
                for m in con.execute("select import_key, id from pulse_priv.wa_message where org_id = pulse.current_org() and chat_id = %s", (chat,)):
                    keys[(chat, m["import_key"])] = m["id"]
            msgs = [keys[(chat, k)] for k in r.get("messages", []) if (chat, k) in keys]
            n["messages_missing"] += len(r.get("messages", [])) - len(msgs)
            cl = r.get("client") if r.get("client") in clients else None
            pr = r.get("project") if r.get("project") in projects else None
            ps = [p for p in r.get("persons", []) if p in persons]
            cid = str(uuid.uuid4())
            batch.append((cid, chat, r["key"], r.get("version") or "unknown", cl, pr, r.get("stage"), r["first_at"], r["last_at"], msgs, ps,
                          r.get("topics") or [], r.get("langs") or [], r["body"][:24000], r.get("model")))
            vecs += [(cid, vec(v)) for v in r.get("vectors") or []]
            n["chunks"] += 1; n["with_vectors"] += 1 if r.get("vectors") else 0
            if len(batch) >= 500:
                flush(con, batch, vecs); batch, vecs = [], []
    flush(con, batch, vecs)
    n["vectors"] = con.execute("select count(*) n from pulse_priv.wa_chunk_vec where org_id = pulse.current_org()").fetchone()["n"]
    n["words"] = con.execute("select pulse.wa_terms_refresh() n").fetchone()["n"]
    con.commit()
    n["chats"] = len(seen)
    print(json.dumps(dict(n)))


def flush(con, batch, vecs):
    if not batch:
        return
    with con.cursor() as cur:
        cur.executemany("""insert into pulse_priv.wa_chunk (org_id, id, chat_id, source_key, version, client_id, project_id, stage, first_at, last_at,
                           messages, persons, topics, langs, body, model)
                           values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""", batch)
        cur.executemany("insert into pulse_priv.wa_chunk_vec (org_id, chunk_id, embedding) values (pulse.current_org(), %s, %s::public.halfvec)", vecs)


def status(args):
    con = wa_import.connect(args.org)
    r = con.execute("""select count(*) chunks, count(distinct chat_id) chats, count(client_id) with_client,
                       (select count(*) from pulse_priv.wa_chunk_vec v where v.org_id = pulse.current_org()) vectors,
                       (select count(*) from pulse_priv.wa_term t where t.org_id = pulse.current_org()) words,
                       min(version) version, max(loaded_at) loaded_at from pulse_priv.wa_chunk where org_id = pulse.current_org()""").fetchone()
    print(json.dumps(r, default=str))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["load", "status"]); ap.add_argument("dir", nargs="?"); ap.add_argument("--org")
    a = ap.parse_args()
    if a.cmd == "load" and not a.dir:
        sys.exit("load needs the directory with chunks.jsonl")
    load(a) if a.cmd == "load" else status(a)
