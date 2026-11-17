#!/usr/bin/env python3
"""EA-PATTERNS (2170): the company memory — index, search and decision models.

  index   cut every source into chunks (imported WhatsApp groups, Pulse conversations, tasks, meeting transcripts, docs,
          invoice lines) with who / when / client / project and the events they hold, embed new or changed chunks with
          multilingual-e5-small (int8 ONNX on CPU, 384-d; Hindi, Marathi, English and the romanised mix in one space),
          write them to memory.chunk, drop chunks whose source is gone, recount words. Read-only on every source.
  risks   build the three decision models from the company's own history (client churn, late payment, deliverable
          delay), evaluate each on later data it did not learn from, score what is open now, write memory.risk_score
          (with the reasons) and memory.model_card (with the evaluation).
  ask     search as a person (as pulse.memory_search sees it) and print the citations: a check from the command line.
  status  what the memory holds.

  PULSE_DATABASE_URL_MIGRATE=… python tools/company-memory.py index [--org <uuid>] [--sources whatsapp,task] [--max-embed N]
  PULSE_DATABASE_URL_MIGRATE=… python tools/company-memory.py risks [--org <uuid>]
  PULSE_DATABASE_URL_MIGRATE=… python tools/company-memory.py ask --as <person uuid> "which clients complained about delays in October?"

Dependencies: psycopg, numpy, onnxruntime, tokenizers, huggingface_hub (the model is read from the local Hugging Face
cache when present). No text leaves the server; nothing is logged except counts. Run it niced (nice -n 15).
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg.rows import dict_row

MODEL_REPO, MODEL_FILE = "Xenova/multilingual-e5-small", "onnx/model_quantized.onnx"
MODEL_NAME = "multilingual-e5-small-int8"
MAX_TOKENS = 256
GAP = timedelta(hours=3)
MAX_CHARS, MAX_MSGS = 1100, 16
INTENT_EVENT = {"complaint": "complaint", "request": "request", "approval": "approval", "payment": "payment",
                "change": "change", "deliverable": "delivery", "schedule": "schedule"}
WORK_EVENT = {("promise", "team"): "promise", ("promise", "client"): "client promise", ("material_request", None): "material ask",
              ("approval_request", None): "approval ask", ("change_request", None): "change", ("deliverable", None): "delivery"}
MEDIA = {"image": "[photo]", "video": "[video]", "audio": "[voice note]", "document": "[file]", "sticker": "[sticker]"}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def connect(org=None):
    url = os.environ.get("PULSE_DATABASE_URL_MIGRATE") or os.environ.get("MIGRATE_DATABASE_URL")
    if not url:
        sys.exit("set PULSE_DATABASE_URL_MIGRATE (the database owner's login)")
    con = psycopg.connect(url, row_factory=dict_row, autocommit=False, application_name="company-memory")
    owner = os.environ.get("PULSE_DB_OWNER") or con.execute(
        "select pg_get_userbyid(datdba) r from pg_database where datname = current_database()").fetchone()["r"]
    con.execute(f'set role "{owner}"')
    if not con.execute("select 1 from pg_namespace where nspname = 'memory'").fetchone():
        sys.exit("memory schema missing: migration 2170 is not applied here")
    con.commit()
    return con


def orgs(con, org):
    if org:
        return [org]
    return [r["o"] for r in con.execute("select o from pulse.list_active_orgs() o")]


def set_org(con, org):
    con.execute("select set_config('pulse.org_id', %s, false)", (str(org),))


def h(*parts):
    m = hashlib.sha256()
    for p in parts:
        m.update(json.dumps(p, default=str, ensure_ascii=False, sort_keys=True).encode())
        m.update(b"\0")
    return m.hexdigest()[:32]


def clean(s, n=None):
    s = re.sub(r"\s+", " ", s or "").strip()
    return s[:n] if n else s


# ------------------------------------------------------------------------------------------------------------ sources
def wa_chunks(con):
    """Imported WhatsApp groups: runs of messages in one chat (a 3-hour gap, ~1,100 characters or 16 messages end a run)."""
    chats = con.execute("""select c.id, c.channel_id, c.title, c.client_id, c.project_id from pulse_priv.wa_chat c
                            where c.org_id = pulse.current_org()""").fetchall()
    for ch in chats:
        rows = con.execute("""
          select m.id, m.sent_at, m.kind, m.body, m.media_type,
                 coalesce(case when p.person_id is not null then per.display_name end, p.label, 'Unknown') speaker,
                 p.person_id, (p.kind = 'colleague') team, s.intent, s.lang, t.text transcript
            from pulse_priv.wa_message m
            left join pulse_priv.wa_participant p on p.org_id = m.org_id and p.id = m.participant_id
            left join pulse.person per on per.id = p.person_id
            left join pulse_priv.wa_message_signal s on s.message_id = m.id
            left join pulse_priv.wa_transcript t on t.org_id = m.org_id and t.sha256 = m.file_sha256
           where m.org_id = pulse.current_org() and m.chat_id = %s and m.kind not in ('system', 'deleted')
           order by m.sent_at, m.seq""", (ch["id"],)).fetchall()
        sig, late, native = {}, set(), {}
        for g in con.execute("select message_id, kind from pulse_priv.wa_signal where org_id = pulse.current_org() and chat_id = %s", (ch["id"],)):
            sig.setdefault(g["message_id"], set()).add(g["kind"])
        for g in con.execute("select message_id from pulse_priv.wa_milestone where org_id = pulse.current_org() and chat_id = %s and delayed", (ch["id"],)):
            late.add(g["message_id"])
        # WA-INTEL's work items: a team promise, a client's material / approval / change ask, a team request
        work = {}
        for g in con.execute("""select message_id, kind, owner_side from pulse_priv.wa_work_item where org_id = pulse.current_org() and chat_id = %s
                                 and message_id is not null""", (ch["id"],)):
            tag = WORK_EVENT.get((g["kind"], g["owner_side"])) or WORK_EVENT.get((g["kind"], None))
            if tag:
                work.setdefault(g["message_id"], set()).add(tag)
        if ch["channel_id"]:
            for g in con.execute("""select id, import_ref from pulse.chat_message where org_id = pulse.current_org() and channel_id = %s
                                     and import_ref is not null""", (ch["channel_id"],)):
                native[g["import_ref"]] = g["id"]
        for r in rows:
            r["signals"], r["delayed"], r["native_id"], r["work"] = sig.get(r["id"]), r["id"] in late, native.get(r["id"]), work.get(r["id"])
        run = []

        def flush():
            if not run:
                return None
            lines, events, persons, speakers, langs = [], set(), [], [], set()
            for r in run:
                text = clean(r["body"])
                if r["transcript"]:
                    text = (text + " " if text else "") + "[voice] " + clean(r["transcript"], 600)
                elif not text and r["media_type"]:
                    text = MEDIA.get(r["media_type"], "[file]")
                if not text:
                    continue
                lines.append(f"{r['speaker']}: {text}")
                if r["intent"] in INTENT_EVENT and not r["team"] and r["intent"] in ("complaint", "request", "approval", "payment", "change"):
                    events.add(INTENT_EVENT[r["intent"]])
                if r["intent"] == "deliverable" and r["team"]:
                    events.add("delivery")
                for g in r["signals"] or []:
                    events.add({"lead_quality": "lead quality", "churn_risk": "churn risk"}.get(g, g))
                if r["delayed"]:
                    events.add("delay")
                events.update(r["work"] or ())
                if r["person_id"] and r["person_id"] not in persons:
                    persons.append(r["person_id"])
                if r["speaker"] not in speakers:
                    speakers.append(r["speaker"])
                if r["lang"]:
                    langs.add(r["lang"])
            if not lines:
                return None
            first = run[0]
            body = (f"Events: {', '.join(sorted(events))}\n" if events else "") + "\n".join(lines)
            body = body[:7900]
            day = first["sent_at"].strftime("%d %b %Y")
            return dict(source_kind="whatsapp", source_key=f"wa:{first['id']}", access="wa_chat", access_ref=ch["id"],
                        channel_id=ch["channel_id"], message_id=first["native_id"], client_id=ch["client_id"], project_id=ch["project_id"],
                        persons=persons, speakers=speakers, first_at=first["sent_at"], last_at=run[-1]["sent_at"],
                        title=clean(f"{ch['title'] or 'WhatsApp group'} · {day}", 290), body=body, events=sorted(events), langs=sorted(langs),
                        link=f"/chats?channel={ch['channel_id']}" + (f"&message={first['native_id']}" if first["native_id"] else ""))

        size = 0
        for r in rows:
            if run and (r["sent_at"] - run[-1]["sent_at"] > GAP or size > MAX_CHARS or len(run) >= MAX_MSGS):
                c = flush()
                if c:
                    yield c
                run, size = [], 0
            run.append(r)
            size += len(r["body"] or "") + len(r["transcript"] or "")
        c = flush()
        if c:
            yield c


def chat_chunks(con):
    """Pulse's own conversations (not the imported history): runs of messages per conversation."""
    chans = con.execute("""select c.id, c.name, c.kind, gi.client_id, gi.project_id from pulse.chat_channel c
                            left join pulse.chat_group_info gi on gi.org_id = c.org_id and gi.channel_id = c.id
                           where c.org_id = pulse.current_org()""").fetchall()
    for ch in chans:
        rows = con.execute("""select m.id, m.created_at, m.body, m.author_id, coalesce(p.display_name, g.label, 'Someone') speaker
                                from pulse.chat_message m left join pulse.person p on p.id = m.author_id
                                left join pulse.chat_guest g on g.id = m.guest_id
                               where m.org_id = pulse.current_org() and m.channel_id = %s and m.import_ref is null
                                 and m.removed_at is null and coalesce(m.body, '') <> '' order by m.created_at""", (ch["id"],)).fetchall()
        run, size = [], 0

        def flush():
            if not run:
                return None
            persons = list(dict.fromkeys(r["author_id"] for r in run if r["author_id"]))
            speakers = list(dict.fromkeys(r["speaker"] for r in run))
            first = run[0]
            return dict(source_kind="chat", source_key=f"chat:{first['id']}", access="chat", access_ref=None, channel_id=ch["id"],
                        message_id=first["id"], client_id=ch["client_id"], project_id=ch["project_id"], persons=persons, speakers=speakers,
                        first_at=first["created_at"], last_at=run[-1]["created_at"],
                        title=clean(f"{ch['name'] or ('Direct messages' if ch['kind'] == 'direct' else 'Conversation')} · {first['created_at']:%d %b %Y}", 290),
                        body="\n".join(f"{r['speaker']}: {clean(r['body'], 1500)}" for r in run)[:7900], events=[], langs=[],
                        link=f"/chats?channel={ch['id']}&message={first['id']}")
        for r in rows:
            if run and (r["created_at"] - run[-1]["created_at"] > GAP or size > MAX_CHARS or len(run) >= MAX_MSGS):
                c = flush()
                if c:
                    yield c
                run, size = [], 0
            run.append(r)
            size += len(r["body"] or "")
        c = flush()
        if c:
            yield c


def task_chunks(con):
    for t in con.execute("""select t.id, t.title, t.notes, t.status, t.priority, t.deliverable_type, t.category, t.due_at, t.created_at,
                                   t.done_at, t.updated_at, t.assignee_person_id, a.display_name assignee, t.project_id,
                                   p.client_id, coalesce(p.title, p.name) project
                              from pulse.task t left join pulse.person a on a.id = t.assignee_person_id
                              left join pulse.project p on p.id = t.project_id
                             where t.org_id = pulse.current_org() and t.deleted_at is null""").fetchall():
        parts = [t["title"] or "Task"]
        meta = [f"status {t['status']}"]
        for k, lab in (("assignee", "for"), ("project", "project"), ("deliverable_type", "type"), ("category", "category"), ("priority", "priority")):
            if t[k]:
                meta.append(f"{lab} {t[k]}")
        if t["due_at"]:
            meta.append(f"due {t['due_at']:%d %b %Y}")
        if t["done_at"]:
            meta.append(f"done {t['done_at']:%d %b %Y}")
        at = t["created_at"] or t["due_at"] or t["updated_at"] or datetime.now(timezone.utc)
        late = bool(t["due_at"] and t["done_at"] and t["done_at"] > t["due_at"])
        overdue = bool(t["due_at"] and not t["done_at"] and t["status"] not in ("done", "accepted", "cancelled") and t["due_at"] < datetime.now(timezone.utc))
        events = ["delay"] if late or overdue else []
        if late or overdue:
            meta.append("overdue, still open" if overdue else "finished late")
        body = clean(parts[0], 300) + "\n" + ", ".join(meta) + ("\n" + clean(t["notes"], 6000) if t["notes"] else "")
        yield dict(source_kind="task", source_key=f"task:{t['id']}", access="task", access_ref=t["id"], channel_id=None, message_id=None,
                   client_id=t["client_id"], project_id=t["project_id"], persons=[t["assignee_person_id"]] if t["assignee_person_id"] else [],
                   speakers=[t["assignee"]] if t["assignee"] else [], first_at=at, last_at=max(at, t["done_at"] or at),
                   title=clean(t["title"] or "Task", 290), body=body[:7900], events=events, langs=[], link=f"/tasks/{t['id']}")


def meeting_chunks(con):
    for m in con.execute("""select id, title, client_id, project_id, started_at, held_on, seconds, summary from pulse.meeting
                             where org_id = pulse.current_org() and removed_at is null and transcript_state = 'done'""").fetchall():
        lines = con.execute("""select n, speaker, at_s, words from pulse.meeting_line where org_id = pulse.current_org() and meeting_id = %s
                                order by n""", (m["id"],)).fetchall()
        start = m["started_at"] or datetime.combine(m["held_on"], datetime.min.time(), timezone.utc)
        run, size, part = [], 0, 0
        for ln in lines + [None]:
            if ln is None or size > MAX_CHARS * 1.5:
                if run:
                    part += 1
                    yield dict(source_kind="meeting", source_key=f"meeting:{m['id']}:{part}", access="meeting", access_ref=m["id"], channel_id=None,
                               message_id=None, client_id=m["client_id"], project_id=m["project_id"], persons=[],
                               speakers=list(dict.fromkeys(r["speaker"] or "Speaker" for r in run)),
                               first_at=start + timedelta(seconds=float(run[0]["at_s"] or 0)), last_at=start + timedelta(seconds=float(run[-1]["at_s"] or 0)),
                               title=clean(f"{m['title'] or 'Meeting'} · {start:%d %b %Y}", 290),
                               body="\n".join(f"{r['speaker'] or 'Speaker'}: {clean(r['words'])}" for r in run)[:7900], events=[], langs=[],
                               link=f"/meetings/{m['id']}")
                run, size = [], 0
            if ln is not None:
                run.append(ln)
                size += len(ln["words"] or "")


def doc_chunks(con):
    for d in con.execute("""select id, title, body_text, created_by, created_at, updated_at from pulse.doc
                             where org_id = pulse.current_org() and archived_at is null and coalesce(body_text, '') <> ''""").fetchall():
        text = d["body_text"]
        paras, cur, part = re.split(r"\n\s*\n", text), "", 0
        for para in paras + [None]:
            if para is None or len(cur) + len(para) > 1500:
                if cur.strip():
                    part += 1
                    yield dict(source_kind="doc", source_key=f"doc:{d['id']}:{part}", access="doc", access_ref=d["id"], channel_id=None,
                               message_id=None, client_id=None, project_id=None, persons=[d["created_by"]] if d["created_by"] else [], speakers=[],
                               first_at=d["created_at"], last_at=d["updated_at"] or d["created_at"], title=clean(d["title"] or "Doc", 290),
                               body=cur.strip()[:7900], events=[], langs=[], link=f"/docs/{d['id']}")
                cur = ""
            if para is not None:
                cur += para + "\n\n"


def invoice_chunks(con):
    """Invoice lines: Pulse's own billing documents, then the finance records read from the company's books."""
    for d in con.execute("""select d.id, d.doc_type, d.number, d.status, d.issue_date, d.due_date, d.client_id, d.project_id, d.taxable, d.total, d.paid,
                                   d.created_at, coalesce(c.display_name, d.buyer->>'name') buyer,
                                   (select string_agg(coalesce(l.description, ''), '; ' order by l.position) from pulse.erp_line l where l.org_id = d.org_id and l.document_id = d.id) lines
                              from pulse.erp_document d left join pulse.client c on c.id = d.client_id
                             where d.org_id = pulse.current_org() and d.cancelled_at is null""").fetchall():
        at = datetime.combine(d["issue_date"], datetime.min.time(), timezone.utc) if d["issue_date"] else d["created_at"]
        body = (f"{d['doc_type']} {d['number'] or ''} for {d['buyer'] or 'a client'}: taxable Rs {(d['taxable'] or 0) / 100:,.0f}, total Rs {(d['total'] or 0) / 100:,.0f}, "
                f"paid Rs {(d['paid'] or 0) / 100:,.0f}, status {d['status']}" + (f", due {d['due_date']:%d %b %Y}" if d["due_date"] else "") +
                (f"\nLines: {clean(d['lines'], 3000)}" if d["lines"] else ""))
        yield dict(source_kind="invoice", source_key=f"erp:{d['id']}", access="money", access_ref=None, channel_id=None, message_id=None,
                   client_id=d["client_id"], project_id=d["project_id"], persons=[], speakers=[], first_at=at, last_at=at,
                   title=clean(f"{d['doc_type'].title()} {d['number'] or ''} · {d['buyer'] or ''}", 290), body=body[:7900],
                   events=["payment"], langs=[], link=f"/erp/documents/{d['id']}")
    for r in con.execute("""select body from pulse_priv.finance_live_record where org_id = pulse.current_org() and kind = 'invoice'""").fetchall():
        b = r["body"]
        if str(b.get("test")).lower() == "true" or not b.get("number"):
            continue
        try:
            at = datetime.fromisoformat(str(b.get("date"))).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        body = (f"Invoice {b.get('number')} for {b.get('client') or 'a client'} dated {at:%d %b %Y}: taxable Rs {float(b.get('taxable') or 0):,.0f}, "
                f"total Rs {float(b.get('total') or 0):,.0f}" + (f", due {b.get('due')}" if b.get("due") else "") +
                (f", balance due Rs {float(b.get('balanceDue') or 0):,.0f}" if b.get("balanceDue") not in (None, "") else "") +
                (f"\nFor: {clean(b.get('description'), 500)}" if b.get("description") else ""))
        yield dict(source_kind="invoice", source_key=f"inv:{re.sub(r'[^0-9A-Za-z_.:-]', '', str(b.get('number')))[:60]}", access="money", access_ref=None,
                   channel_id=None, message_id=None, client_id=None, project_id=None, persons=[], speakers=[], first_at=at, last_at=at,
                   title=clean(f"Invoice {b.get('number')} · {b.get('client') or ''}", 290), body=body[:7900], events=["payment"], langs=[],
                   link="/finance?tab=revenue")


SOURCES = {"whatsapp": wa_chunks, "chat": chat_chunks, "task": task_chunks, "meeting": meeting_chunks, "doc": doc_chunks, "invoice": invoice_chunks}


# ----------------------------------------------------------------------------------------------------------- embedder
class Embedder:
    def __init__(self, threads=2):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")    # read the model from the local cache; set before the import reads it
        import numpy as np
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        from tokenizers import Tokenizer
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        try:
            tok_path, model_path = hf_hub_download(MODEL_REPO, "tokenizer.json"), hf_hub_download(MODEL_REPO, MODEL_FILE)
        except Exception:
            os.environ["HF_HUB_OFFLINE"] = "0"
            tok_path, model_path = hf_hub_download(MODEL_REPO, "tokenizer.json"), hf_hub_download(MODEL_REPO, MODEL_FILE)
        self.np = np
        self.tok = Tokenizer.from_file(tok_path)
        self.tok.enable_truncation(MAX_TOKENS)
        self.tok.enable_padding(pad_id=1, pad_token="<pad>")
        so = ort.SessionOptions()
        so.intra_op_num_threads, so.inter_op_num_threads = threads, 1
        self.sess = ort.InferenceSession(model_path, so, providers=["CPUExecutionProvider"])
        self.tt = "token_type_ids" in {i.name for i in self.sess.get_inputs()}

    def __call__(self, texts, kind="passage"):
        np = self.np
        enc = self.tok.encode_batch([f"{kind}: {t}" for t in texts])
        ids = np.array([e.ids for e in enc], dtype=np.int64)
        mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        if self.tt:
            feed["token_type_ids"] = np.zeros_like(ids)
        out = self.sess.run(None, feed)[0]
        m = mask[..., None].astype("float32")
        v = (out * m).sum(1) / m.sum(1).clip(1e-9)
        v = v / np.linalg.norm(v, axis=1, keepdims=True)
        return ["[" + ",".join(f"{x:.5f}" for x in row) + "]" for row in v]


# ------------------------------------------------------------------------------------------------------------- index
def index(con, org, sources, max_embed, threads):
    set_org(con, org)
    run = con.execute("insert into memory.index_run (org_id, model) values (pulse.current_org(), %s) returning id", (MODEL_NAME,)).fetchone()["id"]
    con.commit()
    counts = {}
    for kind in sources:
        t0 = time.time()
        existing = {r["source_key"]: r["content_hash"] for r in con.execute(
            "select source_key, content_hash from memory.chunk where org_id = pulse.current_org() and source_kind = %s", (kind,))}
        seen, new, changed = set(), 0, 0
        batch = []
        for c in SOURCES[kind](con):
            c["content_hash"] = h(c["title"], c["body"], c["events"], c["client_id"], c["project_id"], c["link"], c["access"], c["access_ref"])
            if c["source_key"] in seen:
                continue
            seen.add(c["source_key"])
            old = existing.get(c["source_key"])
            if old == c["content_hash"]:
                continue
            new += old is None
            changed += old is not None
            batch.append(c)
            if len(batch) >= 500:
                upsert(con, batch)
                batch = []
        upsert(con, batch)
        gone = [k for k in existing if k not in seen]
        for i in range(0, len(gone), 1000):
            con.execute("delete from memory.chunk where org_id = pulse.current_org() and source_kind = %s and source_key = any(%s)", (kind, gone[i:i + 1000]))
        con.commit()
        counts[kind] = dict(chunks=len(seen), new=new, changed=changed, removed=len(gone), seconds=round(time.time() - t0, 1))
        log(org, kind, counts[kind])
    embedded = embed_missing(con, max_embed, threads)
    terms = con.execute("select pulse.memory_terms_refresh() n").fetchone()["n"]
    counts["_embedded"], counts["_terms"] = embedded, terms
    con.execute("update memory.index_run set finished_at = now(), counts = %s where org_id = pulse.current_org() and id = %s",
                (json.dumps(counts), run))
    con.commit()
    return counts


COLS = ["source_kind", "source_key", "access", "access_ref", "channel_id", "message_id", "client_id", "project_id", "persons", "speakers",
        "first_at", "last_at", "title", "body", "events", "langs", "link", "content_hash"]


def upsert(con, batch):
    if not batch:
        return
    with con.cursor() as cur:
        cur.executemany(f"""insert into memory.chunk (org_id, {', '.join(COLS)}) values (pulse.current_org(), {', '.join(['%s'] * len(COLS))})
          on conflict (org_id, source_key) do update set {', '.join(f'{c} = excluded.{c}' for c in COLS if c != 'source_key')},
             embedding = null, model = null, indexed_at = now()""", [[c[k] for k in COLS] for c in batch])


def embed_missing(con, max_embed, threads):
    todo = con.execute("""select id, title, array_to_string(events, ', ') ev, body from memory.chunk
                           where org_id = pulse.current_org() and (embedding is null or model is distinct from %s)
                           order by first_at desc limit %s""", (MODEL_NAME, max_embed)).fetchall()
    con.commit()
    if not todo:
        return 0
    emb, done, t0 = Embedder(threads), 0, time.time()
    for i in range(0, len(todo), 16):
        part = todo[i:i + 16]
        vecs = emb([f"{r['title']}. {r['ev']}. {r['body']}" for r in part])
        with con.cursor() as cur:
            cur.executemany("update memory.chunk set embedding = %s::halfvec, model = %s where org_id = pulse.current_org() and id = %s",
                            [(v, MODEL_NAME, r["id"]) for v, r in zip(vecs, part)])
        con.commit()
        done += len(part)
        if done % 1600 == 0:
            log(f"embedded {done}/{len(todo)} ({done / (time.time() - t0):.1f}/s)")
    log(f"embedded {done} in {time.time() - t0:.0f}s")
    return done


# ------------------------------------------------------------------------------------------------------ decision models
def floats(rows):
    """Postgres numerics arrive as Decimal: make them floats for the arithmetic below."""
    from decimal import Decimal
    return [{k: float(v) if isinstance(v, Decimal) else v for k, v in r.items()} for r in rows]


def fit_select(Xtr, ytr, Xte, yte, names, subsets, rule):
    """Pick the feature set by AUC on the last quarter of the training period (never the test period), refit it on the
    whole training period, test it on the later data. subsets: {name: [feature names]}; rule: the simple rule's feature."""
    import numpy as np
    k = int(len(ytr) * 0.75)
    val = {}
    for nm, feats_ in subsets.items():
        cols = [names.index(f) for f in feats_]
        val[nm] = auc(ytr[k:], lr_predict(lr_fit(Xtr[:k][:, cols], ytr[:k]), Xtr[k:][:, cols])) or 0.0
    best = max(val, key=val.get)
    cols = [names.index(f) for f in subsets[best]]
    ev = evaluate(yte, lr_predict(lr_fit(Xtr[:, cols], ytr), Xte[:, cols]), base_p=Xte[:, names.index(rule)])
    ev.update(chosen=best, chosen_features=subsets[best], validation_auc={k_: round(v, 3) for k_, v in val.items()})
    full = lr_fit(np.vstack([Xtr, Xte])[:, cols], np.concatenate([ytr, yte]))
    return cols, full, ev


def lr_fit(X, y, l2=1.0, iters=600, lr=0.2):
    """Logistic regression on standardised features (numpy, full-batch gradient descent, L2). Returns (w, b, mu, sd)."""
    import numpy as np
    mu, sd = X.mean(0), X.std(0) + 1e-9
    Z = (X - mu) / sd
    w, b = np.zeros(Z.shape[1]), 0.0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(Z @ w + b)))
        g = p - y
        w -= lr * (Z.T @ g / len(y) + l2 * w / len(y))
        b -= lr * g.mean()
    return w, b, mu, sd


def lr_predict(m, X):
    import numpy as np
    w, b, mu, sd = m
    return 1 / (1 + np.exp(-(((X - mu) / sd) @ w + b)))


def auc(y, p):
    import numpy as np
    y, p = np.asarray(y), np.asarray(p)
    pos, neg = p[y == 1], p[y == 0]
    if not len(pos) or not len(neg):
        return None
    order = np.argsort(np.concatenate([pos, neg]))
    ranks = np.empty(len(order))
    ranks[order] = np.arange(1, len(order) + 1)
    return float((ranks[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def evaluate(y, p, base_p=None):
    import numpy as np
    y, p = np.asarray(y, float), np.asarray(p, float)
    top = p >= np.quantile(p, 0.8) if len(p) >= 5 else p > 0.5
    out = dict(n=int(len(y)), base_rate=round(float(y.mean()), 3) if len(y) else None, auc=round(auc(y, p), 3) if auc(y, p) is not None else None,
               top_fifth_rate=round(float(y[top].mean()), 3) if top.any() else None, top_fifth_lift=round(float(y[top].mean() / max(y.mean(), 1e-9)), 2) if top.any() and y.mean() else None,
               brier=round(float(((p - y) ** 2).mean()), 4) if len(y) else None)
    if base_p is not None:
        out["auc_simple_rule"] = round(auc(y, base_p), 3) if auc(y, base_p) is not None else None
    return out


def reasons_of(m, x, names, words, k=3):
    """The features pushing this score up the most (standardised value x weight), in plain words."""
    import numpy as np
    w, b, mu, sd = m
    contrib = ((x - mu) / sd) * w
    order = np.argsort(-contrib)
    out = []
    for i in order[:k]:
        if contrib[i] <= 0.05:
            break
        out.append(dict(text=words[names[i]](x[i]), weight=round(float(contrib[i]), 2)))
    return out or [dict(text="Nothing stands out: close to the usual for this company", weight=0)]


def band(p, lo, hi):
    return "high" if p >= hi else "medium" if p >= lo else "low"


def churn_model(con):
    """Client churn: one row per client and month end, features from the 30-90 days before, label = the relationship
    ends within 60 days (its last message falls inside them). Learn on the earlier months, test on the later ones."""
    import numpy as np
    rows = floats(con.execute("""
      with msg as (
        select c.client_id, m.sent_at, (p.kind = 'colleague') team, s.intent
          from pulse_priv.wa_message m join pulse_priv.wa_chat c on c.org_id = m.org_id and c.id = m.chat_id
          left join pulse_priv.wa_participant p on p.org_id = m.org_id and p.id = m.participant_id
          left join pulse_priv.wa_message_signal s on s.org_id = m.org_id and s.message_id = m.id
         where m.org_id = pulse.current_org() and c.client_id is not null and m.kind <> 'system'
        union all
        select k.client_id, m.created_at, coalesce(pe.side = 'staff', true), null
          from pulse.chat_message m join pulse.chat_group_info k on k.org_id = m.org_id and k.channel_id = m.channel_id
          left join pulse.person pe on pe.id = m.author_id
         where m.org_id = pulse.current_org() and k.client_id is not null and m.import_ref is null and m.removed_at is null),
      life as (select client_id, min(sent_at) first_at, max(sent_at) last_at from msg group by 1),
      ends as (select max(sent_at) data_end from msg),
      months as (select l.client_id, l.first_at, l.last_at, g::timestamptz as_of
                   from life l cross join ends e,
                        generate_series(date_trunc('month', l.first_at) + interval '1 month', date_trunc('month', least(l.last_at + interval '1 month', e.data_end)), interval '1 month') g
                  where g > l.first_at + interval '30 days'),
      resp as (select c.client_id, mm.sent_at, r.working_s from pulse_priv.wa_response r
                 join pulse_priv.wa_chat c on c.org_id = r.org_id and c.id = r.chat_id
                 join pulse_priv.wa_message mm on mm.org_id = r.org_id and mm.id = r.message_id
                where r.org_id = pulse.current_org() and r.responder_side = 'team' and c.client_id is not null),
      live as (select client_id, "at" from pulse_priv.wa_milestone where org_id = pulse.current_org() and kind = 'leads_flowing')
      select mo.client_id, mo.as_of, extract(day from mo.as_of - mo.first_at)::int tenure,
             (mo.last_at < mo.as_of + interval '60 days' and mo.last_at < (select data_end from ends) - interval '60 days') ended60,
             (mo.as_of > (select data_end from ends) - interval '60 days') censored,
             (mo.as_of >= mo.last_at - interval '7 days' and mo.last_at >= (select data_end from ends) - interval '60 days') open_now,
             count(*) filter (where not x.team and x.sent_at >= mo.as_of - interval '30 days') c30,
             count(*) filter (where not x.team and x.sent_at < mo.as_of - interval '30 days') / 2.0 c_prev,
             count(*) filter (where x.team and x.sent_at >= mo.as_of - interval '30 days') t30,
             count(*) filter (where not x.team and x.intent = 'complaint' and x.sent_at >= mo.as_of - interval '30 days') complaints30,
             coalesce(extract(epoch from mo.as_of - max(x.sent_at) filter (where not x.team)) / 86400, 90) quiet_days,
             (select percentile_cont(0.5) within group (order by r.working_s) / 60.0 from resp r where r.client_id = mo.client_id
                and r.sent_at < mo.as_of and r.sent_at >= mo.as_of - interval '30 days') reply_min,
             (select count(*) from live l where l.client_id = mo.client_id and l."at" < mo.as_of and l."at" >= mo.as_of - interval '30 days') leads30
        from months mo join msg x on x.client_id = mo.client_id and x.sent_at < mo.as_of and x.sent_at >= mo.as_of - interval '90 days'
       group by mo.client_id, mo.as_of, mo.first_at, mo.last_at""").fetchall())
    if len(rows) < 60:
        return None
    names = ["term_end", "first_quarter", "slow_reply", "reply_missing", "quiet", "drop", "no_leads", "complaints", "volume"]

    def feats(r):
        ten_m = r["tenure"] / 30.4
        drop = 1.0 if r["c_prev"] >= 4 and r["c30"] < 0.5 * r["c_prev"] else 0.0
        return [1.0 if 3 <= ten_m < 6 else 0.0, 1.0 if ten_m < 3 else 0.0, 1.0 if (r["reply_min"] or 0) > 30 else 0.0,
                1.0 if r["reply_min"] is None else 0.0, min(float(r["quiet_days"]), 90) / 30, drop, 1.0 if r["leads30"] == 0 else 0.0,
                min(r["complaints30"], 10), np.log1p(r["c30"] + r["t30"])]
    words = {"term_end": lambda v: "End of the first package (months 3-5): a third of departures happen here",
             "first_quarter": lambda v: "In the first three months",
             "slow_reply": lambda v: "The team's median reply was over 30 working minutes in the last 30 days",
             "reply_missing": lambda v: "No client message needed a reply in the last 30 days",
             "quiet": lambda v: f"Client last wrote {v * 30:.0f} days ago",
             "drop": lambda v: "Client messages fell by half against the two months before",
             "no_leads": lambda v: "No 'leads are coming' update in the last 30 days",
             "complaints": lambda v: f"{v:.0f} complaints in the last 30 days",
             "volume": lambda v: "Little activity in the group"}
    lab = [r for r in rows if not r["censored"] and not r["open_now"]]
    lab.sort(key=lambda r: r["as_of"])
    cut = lab[int(len(lab) * 0.7)]["as_of"]
    tr = [r for r in lab if r["as_of"] < cut]
    te = [r for r in lab if r["as_of"] >= cut]
    Xtr, ytr = np.array([feats(r) for r in tr]), np.array([float(r["ended60"]) for r in tr])
    Xte, yte = np.array([feats(r) for r in te]), np.array([float(r["ended60"]) for r in te])
    cols, mfull, ev = fit_select(Xtr, ytr, Xte, yte, names, {"all": names, "core": ["quiet", "slow_reply", "term_end", "drop"],
                                 "quiet only": ["quiet"]}, "quiet")
    ev.update(train_n=len(tr), split=f"learned on month ends before {cut:%d %b %Y}, tested on the {len(te)} after",
              simple_rule="days since the client last wrote")
    now = {}
    for r in rows:
        if r["open_now"]:
            if r["client_id"] not in now or r["as_of"] > now[r["client_id"]]["as_of"]:
                now[r["client_id"]] = r
    base = float(np.concatenate([ytr, yte]).mean())
    out = []
    for cid, r in now.items():
        x = np.array(feats(r))[cols]
        p = float(lr_predict(mfull, x[None, :])[0])
        out.append(dict(subject_kind="client", subject_key=str(cid), subject_id=cid, client_id=cid, p=p, x=x, as_of=r["as_of"]))
    card = dict(method=("Logistic regression on client-month snapshots (features from the 30-90 days before each month end; label: the "
                        "client's last message falls within the next 60 days). Reasons are the features that push a score up most."),
                features=[names[i] for i in cols], evaluation=ev)
    return dict(model="churn", fit=mfull, names=[names[i] for i in cols], words=words, rows=out, card=card, lo=base, hi=base * 1.6)


def late_payment_model(con):
    """Late payment: each money ask in a client's groups (fee payment, a promised payment, an ad top-up) is late when no
    payment or top-up shows within 7 days. Features: that client's own record before the ask."""
    import numpy as np
    rows = floats(con.execute("""
      with ev as (select f.client_id, f.chat_id, f."at", f.kind, f.amount_inr from pulse_priv.wa_finance_event f
                   where f.org_id = pulse.current_org() and f.client_id is not null),
      asks as (select * from ev where kind in ('payment_request', 'payment_promised', 'topup_request')),
      ends as (select max("at") data_end from ev)
      select a.client_id, a."at", a.kind,
             exists (select 1 from ev d where d.client_id = a.client_id and d.kind in ('payment_made', 'topup_done') and d."at" between a."at" and a."at" + interval '7 days') paid7,
             (a."at" > (select data_end from ends) - interval '7 days') censored,
             (select count(*) from asks b where b.client_id = a.client_id and b."at" < a."at") prev_asks,
             (select count(*) from asks b where b.client_id = a.client_id and b."at" < a."at" - interval '7 days'
                and not exists (select 1 from ev d where d.client_id = b.client_id and d.kind in ('payment_made', 'topup_done') and d."at" between b."at" and b."at" + interval '7 days')) prev_late,
             (select count(*) from asks b where b.client_id = a.client_id and b."at" < a."at" and b."at" >= a."at" - interval '14 days') open14,
             (select count(*) from ev d where d.client_id = a.client_id and d.kind in ('dispute', 'refund') and d."at" < a."at") disputes,
             coalesce(extract(epoch from a."at" - (select max(d."at") from ev d where d.client_id = a.client_id and d.kind in ('payment_made', 'topup_done') and d."at" < a."at")) / 86400, 120) since_paid,
             coalesce(a.amount_inr, 0) amount
        from asks a""").fetchall())
    if len(rows) < 80:
        return None
    names = ["late_share", "no_history", "open14", "disputes", "since_paid", "fee_ask", "big"]

    def feats(r):
        return [(r["prev_late"] + 0.5) / (r["prev_asks"] + 1.5), 1.0 if r["prev_asks"] == 0 else 0.0, min(r["open14"], 6), min(r["disputes"], 3),
                min(float(r["since_paid"]), 120) / 30, 1.0 if r["kind"] != "topup_request" else 0.0, 1.0 if float(r["amount"]) >= 25000 else 0.0]
    words = {"late_share": lambda v: f"Paid late on about {v * 100:.0f}% of earlier asks",
             "no_history": lambda v: "No payment record yet",
             "open14": lambda v: f"{v:.0f} other money asks in the last 14 days",
             "disputes": lambda v: f"{v:.0f} disputes or refund talks before",
             "since_paid": lambda v: f"Last payment or top-up seen {v * 30:.0f} days ago",
             "fee_ask": lambda v: "A fee payment (not an ad top-up)",
             "big": lambda v: "A large amount (Rs 25,000 or more)"}
    lab = sorted([r for r in rows if not r["censored"]], key=lambda r: r["at"])
    cut = lab[int(len(lab) * 0.7)]["at"]
    tr, te = [r for r in lab if r["at"] < cut], [r for r in lab if r["at"] >= cut]
    Xtr, ytr = np.array([feats(r) for r in tr]), np.array([0.0 if r["paid7"] else 1.0 for r in tr])
    Xte, yte = np.array([feats(r) for r in te]), np.array([0.0 if r["paid7"] else 1.0 for r in te])
    cols, mfull, ev = fit_select(Xtr, ytr, Xte, yte, names, {"all": names, "core": ["late_share", "no_history", "since_paid", "fee_ask"],
                                 "late share only": ["late_share"]}, "late_share")
    ev.update(train_n=len(tr), split=f"learned on asks before {cut:%d %b %Y}, tested on the {len(te)} after", simple_rule="the client's own late share so far")
    # Score every client with an ask in the last 90 days of the data: the risk that their next ask is paid late.
    last = {}
    data_end = max(r["at"] for r in rows)
    for r in rows:
        if r["at"] >= data_end - timedelta(days=90) and (r["client_id"] not in last or r["at"] > last[r["client_id"]]["at"]):
            last[r["client_id"]] = r
    out = []
    for cid, r in last.items():
        x = np.array(feats(r))[cols]
        out.append(dict(subject_kind="client", subject_key=str(cid), subject_id=cid, client_id=cid, p=float(lr_predict(mfull, x[None, :])[0]), x=x, as_of=r["at"]))
    base = float(np.concatenate([ytr, yte]).mean())
    card = dict(method=("Logistic regression on each money ask in a client's groups (fee request, promised payment, ad top-up): late = no "
                        "payment or top-up within 7 days. Features: the client's own record before the ask."),
                features=[names[i] for i in cols], evaluation=ev)
    return dict(model="late_payment", fit=mfull, names=[names[i] for i in cols], words=words, rows=out, card=card, lo=base, hi=min(0.95, base * 1.25))


TYPES = ["shoot", "video", "ads", "creative", "content", "leads", "tech", "project", "finance", "relation"]


def delay_model(con):
    """Deliverable delay: each dated piece of team work in the client groups is late when finished after its date (or not
    shown done). Features known when it is asked: its type, the weekday, the owner's recent late share and open load, and
    what the client still owes. Scores Pulse's open tasks with a due date."""
    import numpy as np
    rows = floats(con.execute("""
      with w as (select id, client_id, owner_id, topic, asked_at, late, status from pulse_priv.wa_work_item
                  where org_id = pulse.current_org() and owner_side = 'team' and asked_at is not null and late is not null)
      select w.id, w.topic, w.asked_at, w.late, extract(isodow from w.asked_at)::int dow,
             (select avg(case when v.late then 1.0 else 0 end) from w v where v.owner_id = w.owner_id and v.asked_at < w.asked_at and v.asked_at >= w.asked_at - interval '60 days') owner_late,
             (select count(*) from w v where v.owner_id = w.owner_id and v.asked_at < w.asked_at and v.asked_at >= w.asked_at - interval '14 days') owner_load,
             (select count(*) from pulse_priv.wa_work_item c where c.org_id = pulse.current_org() and c.client_id = w.client_id and c.owner_side = 'client'
                 and c.asked_at < w.asked_at and c.asked_at >= w.asked_at - interval '14 days' and (c.done_at is null or c.done_at > w.asked_at)) client_owes
        from w""").fetchall())
    if len(rows) < 200:
        return None
    names = [f"type_{t}" for t in TYPES] + ["weekend_monday", "owner_late", "owner_unknown", "owner_load", "client_owes"]

    def feats(topic, dow, owner_late, owner_load, client_owes):
        return [1.0 if topic == t else 0.0 for t in TYPES] + [1.0 if dow in (1, 6, 7) else 0.0, owner_late if owner_late is not None else 0.35,
                                                               1.0 if owner_late is None else 0.0, min(owner_load, 40) / 10, min(client_owes, 10)]
    words = {**{f"type_{t}": (lambda t: lambda v: f"{t.title()} work runs late more often than other work")(t) for t in TYPES},
             "weekend_monday": lambda v: "Asked on a Saturday, Sunday or Monday",
             "owner_late": lambda v: f"Its owner finished {v * 100:.0f}% of the last 60 days' work late",
             "owner_unknown": lambda v: "No record yet for its owner",
             "owner_load": lambda v: f"Its owner took on {v * 10:.0f} pieces of work in the last 14 days",
             "client_owes": lambda v: f"The client still owes {v:.0f} things (material, approvals, funds)"}
    rows.sort(key=lambda r: r["asked_at"])
    cut = rows[int(len(rows) * 0.7)]["asked_at"]
    tr, te = [r for r in rows if r["asked_at"] < cut], [r for r in rows if r["asked_at"] >= cut]
    f = lambda r: feats(r["topic"], r["dow"], float(r["owner_late"]) if r["owner_late"] is not None else None, r["owner_load"], r["client_owes"])
    Xtr, ytr = np.array([f(r) for r in tr]), np.array([float(r["late"]) for r in tr])
    Xte, yte = np.array([f(r) for r in te]), np.array([float(r["late"]) for r in te])
    cols, mfull, ev = fit_select(Xtr, ytr, Xte, yte, names, {"all": names, "no client": [n for n in names if n != "client_owes"],
                                 "owner only": ["owner_late", "owner_unknown"]}, "owner_late")
    ev.update(train_n=len(tr), split=f"learned on work asked before {cut:%d %b %Y}, tested on the {len(te)} after", simple_rule="the owner's recent late share")
    # Score open Pulse tasks with a due date: their type from the deliverable/category, the assignee's record.
    tmap = {"video_shoot": "shoot", "video_edit": "video", "design": "creative", "scripting": "content", "meta_ads": "ads", "onboarding": "project",
            "finance": "finance", "client_service": "relation", "engineering": "tech"}
    tasks = floats(con.execute("""
      select t.id, t.title, t.category, t.due_at, t.assignee_person_id, p.client_id, t.created_at,
             (select avg(case when v.late then 1.0 else 0 end) from pulse_priv.wa_work_item v where v.org_id = t.org_id and v.owner_id = t.assignee_person_id
                and v.asked_at >= now() - interval '120 days') wa_late,
             (select avg(case when x.done_at > x.due_at then 1.0 else 0 end) from pulse.task x where x.org_id = t.org_id and x.assignee_person_id = t.assignee_person_id
                and x.done_at is not null and x.due_at is not null and x.done_at >= now() - interval '60 days') task_late,
             (select count(*) from pulse.task x where x.org_id = t.org_id and x.assignee_person_id = t.assignee_person_id and x.deleted_at is null
                and x.status in ('open', 'in_progress', 'blocked', 'in_review')) load
        from pulse.task t left join pulse.project p on p.id = t.project_id
       where t.org_id = pulse.current_org() and t.deleted_at is null and t.due_at is not null and t.status in ('open', 'in_progress', 'blocked', 'in_review')""").fetchall())
    out = []
    for t in tasks:
        ol = t["task_late"] if t["task_late"] is not None else t["wa_late"]
        x = np.array(feats(tmap.get(t["category"] or "", "project"), (t["created_at"] or t["due_at"]).isoweekday(), float(ol) if ol is not None else None, min(int(t["load"]), 40), 0))[cols]
        out.append(dict(subject_kind="task", subject_key=str(t["id"]), subject_id=t["id"], client_id=t["client_id"], owner_id=t["assignee_person_id"],
                        p=float(lr_predict(mfull, x[None, :])[0]), x=x, as_of=datetime.now(timezone.utc), label=t["title"]))
    base = float(np.concatenate([ytr, yte]).mean())
    card = dict(method=("Logistic regression on dated team work in the client groups (late = finished after its date). Features known when it "
                        "is asked: type, weekday, the owner's late share and load in the weeks before, what the client still owes."),
                features=[names[i] for i in cols], evaluation=ev)
    return dict(model="delivery_delay", fit=mfull, names=[names[i] for i in cols], words=words, rows=out, card=card, lo=base, hi=min(0.9, base * 1.35))


def risks(con, org):
    set_org(con, org)
    done = {}
    for build in (churn_model, late_payment_model, delay_model):
        res = build(con)
        con.commit()
        if not res:
            continue
        labels = {r["id"]: r["display_name"] for r in con.execute("select id, display_name from pulse.client where org_id = pulse.current_org()")}
        owners = {r["id"]: r["relationship_owner_id"] for r in con.execute("select id, relationship_owner_id from pulse.client where org_id = pulse.current_org()")}
        leads = {r["client_id"]: r["lead_person_id"] for r in con.execute(
            "select distinct on (client_id) client_id, lead_person_id from pulse.project where org_id = pulse.current_org() and client_id is not null and lead_person_id is not null and deleted_at is null order by client_id, starts_on desc nulls last")}
        con.execute("delete from memory.risk_score where org_id = pulse.current_org() and model = %s", (res["model"],))
        version = time.strftime("%Y%m%d")
        with con.cursor() as cur:
            for r in res["rows"]:
                owner = r.get("owner_id") or (leads.get(r["client_id"]) if r.get("client_id") else None) or (owners.get(r["client_id"]) if r.get("client_id") else None)
                label = r.get("label") or labels.get(r.get("client_id")) or "Client"
                cur.execute("""insert into memory.risk_score (org_id, model, subject_kind, subject_key, subject_id, client_id, owner_id, label, score, band, reasons, as_of, model_version)
                               values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                            (res["model"], r["subject_kind"], r["subject_key"], r["subject_id"], r.get("client_id"), owner, clean(label, 290),
                             round(r["p"], 4), band(r["p"], res["lo"], res["hi"]), json.dumps(reasons_of(res["fit"], r["x"], res["names"], res["words"])),
                             r["as_of"], version))
        con.execute("""insert into memory.model_card (org_id, model, version, method, features, evaluation) values (pulse.current_org(), %s, %s, %s, %s, %s)
                       on conflict (org_id, model) do update set version = excluded.version, built_at = now(), method = excluded.method,
                          features = excluded.features, evaluation = excluded.evaluation""",
                    (res["model"], version, res["card"]["method"], json.dumps(res["card"]["features"]), json.dumps(res["card"]["evaluation"])))
        con.commit()
        bands = {}
        for r in res["rows"]:
            b = band(r["p"], res["lo"], res["hi"])
            bands[b] = bands.get(b, 0) + 1
        done[res["model"]] = dict(scored=len(res["rows"]), bands=bands, evaluation=res["card"]["evaluation"])
        log(org, res["model"], done[res["model"]])
    return done


# --------------------------------------------------------------------------------------------------------------- ask
def ask(con, org, person, question, limit=8, embed=True):
    set_org(con, org)
    con.execute("select set_config('pulse.viewer_id', %s, false)", (str(person),))
    vec = Embedder(2)([question], "query")[0] if embed else None
    return con.execute("select pulse.memory_search(%s) r", (json.dumps({"q": question, "vec": vec, "limit": limit}),)).fetchone()["r"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["index", "risks", "ask", "status", "nightly"])
    ap.add_argument("question", nargs="?")
    ap.add_argument("--org")
    ap.add_argument("--as", dest="person")
    ap.add_argument("--sources", default=",".join(SOURCES))
    ap.add_argument("--max-embed", type=int, default=200000)
    ap.add_argument("--threads", type=int, default=2)
    a = ap.parse_args()
    con = connect()
    if a.cmd in ("index", "nightly"):
        for org in orgs(con, a.org):
            print(json.dumps({"org": str(org), "index": index(con, org, [s for s in a.sources.split(",") if s in SOURCES], a.max_embed, a.threads)}, default=str))
    if a.cmd in ("risks", "nightly"):
        for org in orgs(con, a.org):
            print(json.dumps({"org": str(org), "risks": risks(con, org)}, default=str))
    if a.cmd == "ask":
        if not (a.org and a.person and a.question):
            sys.exit("ask needs --org, --as <person id> and a question")
        for hit in ask(con, a.org, a.person, a.question):
            print(f"{hit['score']:.4f} [{hit['kind']}] {hit['title']} · {str(hit['from'])[:10]} · {hit.get('client') or ''} · {hit['link']} · events {hit['events']}")
    if a.cmd == "status":
        for org in orgs(con, a.org):
            set_org(con, org)
            print(json.dumps({"org": str(org), **con.execute("select (select count(*) from memory.chunk where org_id = pulse.current_org()) chunks").fetchone()}))


if __name__ == "__main__":
    main()
