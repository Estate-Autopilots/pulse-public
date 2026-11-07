"""WA-INTEL: load the work the imported WhatsApp groups record into Pulse (migration 1070): work items (open ones become
suggested tasks for a leader's review), project milestones, decisions / incidents / practices / case studies, money
events, per-person performance from the chats, the company summary, SOP drafts and contact proposals for Review data.
Company-neutral: the files are built outside this repository from the company's own imports (keys are the import keys
of tools/wa-import.py); this tool maps keys to rows and puts names back from this database.

  Load directory (JSON lines unless said):
    work_items.jsonl  {"key", "group", "message", "done_message", "client", "project", "kind", "title", "detail", "topic",
                       "asked_by", "asked_side", "owner", "owner_side", "done_by", "asked_at", "due_on", "status", "done_at",
                       "hours_to_done", "working_hours_to_done", "follow_ups", "late", "confidence", "stale", "suggest"}
    milestones.jsonl  {"key", "group", "message", "client", "project", "kind", "at", "owner", "delayed", "delay_cause", "note"}
    learning.jsonl    {"key", "kind", "group", "client", "project", "category", "verdict", "title", "detail", "root_cause",
                       "prevention", "outcome", "by", "by_side", "at", "evidence": [message keys], "data": {}}
    finance.jsonl     {"key", "group", "message", "client", "project", "kind", "amount_inr", "period", "at", "by_side", "status", "note"}
    person_perf.jsonl {"sender" | "person", "side", "metrics": {}}
    summary.json      the company aggregate (one object)
    sop_drafts.jsonl  {"title", "purpose", "category", "tags", "confidence", "steps"}: made once as drafts, refreshed
                      only while nobody has touched them (never made active); an untouched earlier draft not in the
                      file is archived
    review_items.jsonl {"source_key", "kind", "entity_type", "entity": {"sender" | "client" | "project"}, "title", "proposed",
                       "confidence", "evidence"}: added to Review data once (a decided item is never re-opened); a sender
                       the chats name and Pulse lacks, with one proposed client, becomes a new-contact suggestion (1101)
  "group" is a chat's source key, "message" a message's import key, people are sender keys (wa_identity / the chat's
  participants). Text may hold {{p:<sender key>}}, {{c:<client id>}} and {{j:<project id>}}: replaced by this
  database's names (a sender without a person by the chat's label for them).

    PULSE_DATABASE_URL_MIGRATE=... uv run --all-packages python tools/wa-intel.py load <dir> [--org <id>] [--dry-run]

A re-run replaces what it loaded before; a suggestion a leader accepted or dismissed keeps its decision. Prints counts only."""
import argparse
import importlib.util
import json
import re
from collections import Counter
from pathlib import Path

from psycopg.types.json import Jsonb

spec = importlib.util.spec_from_file_location("wa_import", Path(__file__).with_name("wa-import.py"))
wa_import = importlib.util.module_from_spec(spec); spec.loader.exec_module(wa_import)
TOKEN = re.compile(r"\{\{([pcj]):([^}]+)\}\}")


def rows(d, name):
    p = Path(d) / f"{name}.jsonl"
    return [json.loads(line) for line in p.read_text().split("\n") if line.strip()] if p.exists() else []


def cut(s, n):
    return None if s is None else str(s)[:n]


def load(args):
    con = wa_import.connect(args.org)
    q = lambda sql, *a: con.execute(sql, a).fetchall()
    chats = {r["source_key"]: r["id"] for r in q("select source_key, id from pulse_priv.wa_chat where org_id = pulse.current_org()")}
    keys = {r["import_key"]: (r["chat_id"], r["id"]) for r in q("select chat_id, import_key, id from pulse_priv.wa_message where org_id = pulse.current_org()")}
    ident = {r["source_key"]: str(r["person_id"]) for r in q("select source_key, person_id from pulse_priv.wa_identity where org_id = pulse.current_org() and person_id is not null")}
    part = {}
    named = set()                                      # senders the chats name (not a bare number) and Pulse lacks
    for r in q("select source_key, person_id, label, kind from pulse_priv.wa_participant where org_id = pulse.current_org() order by last_at desc nulls last"):
        part.setdefault(r["source_key"], (str(r["person_id"]) if r["person_id"] else None, r["label"]))
        if not r["person_id"] and r["kind"] in ("client", "contact", "unknown") and re.search(r"[^\W\d_]{2}", r["label"]):
            named.add(r["source_key"])
    names = {str(r["id"]): r["display_name"] for r in q("select id, display_name from pulse.person where org_id = pulse.current_org()")}
    clients = {str(r["id"]): r["display_name"] for r in q("select id, display_name from pulse.client where org_id = pulse.current_org()")}
    projects = {str(r["id"]): r["n"] for r in q("select id, coalesce(title, name) n from pulse.project where org_id = pulse.current_org()")}
    sides = {str(r["id"]): r["side"] for r in q("select id, side from pulse.person where org_id = pulse.current_org()")}
    linked = {(str(r["client_id"]), str(r["person_id"])) for r in q("select client_id, person_id from pulse.client_contact where org_id = pulse.current_org()")}
    can_make = bool(q("select 1 from public.schema_migrations where version = '1101'"))     # accepting makes the contact only from 1101
    done, skipped = Counter(), Counter()

    def person(key):
        if not key:
            return None
        pid = ident.get(key) or (part.get(key) or (None, None))[0]
        return pid if pid in names else None

    def text(s, n):
        if s is None:
            return None
        def one(m):
            k, v = m.groups()
            if k == "p":
                pid = person(v)
                return names[pid] if pid else ((part.get(v) or (None, None))[1] or "someone")
            return (clients if k == "c" else projects).get(v) or ("the client" if k == "c" else "the project")
        return cut(TOKEN.sub(one, str(s)), n)

    def ref(r, field="message"):
        k = r.get(field)
        return keys.get(k, (None, None))[1] if k else None

    def uid(table, v):
        return v if v and v in table else None

    with con.cursor() as cur:
        loaded = sorted(set(chats.values()))
        # work items: replace untouched suggestions; keep a leader's decision on the same key
        seen = set()
        for r in rows(args.dir, "work_items"):
            c = chats.get(r["group"])
            if not c:
                skipped["work_items"] += 1; continue
            seen.add(r["key"])
            state = "suggested" if r.get("suggest") else "history"
            cur.execute("""insert into pulse_priv.wa_work_item (org_id, source_key, chat_id, message_id, done_message_id, client_id, project_id, kind, title, detail, topic,
                             asked_by, asked_side, owner_id, owner_side, done_by, asked_at, due_on, status, done_at, hours_to_done, working_hours_to_done, follow_ups, late,
                             confidence, stale, review_state)
                           values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                           on conflict (org_id, source_key) do update set chat_id = excluded.chat_id, message_id = excluded.message_id, done_message_id = excluded.done_message_id,
                             client_id = excluded.client_id, project_id = excluded.project_id, kind = excluded.kind, title = excluded.title, detail = excluded.detail, topic = excluded.topic,
                             asked_by = excluded.asked_by, asked_side = excluded.asked_side, owner_id = excluded.owner_id, owner_side = excluded.owner_side, done_by = excluded.done_by,
                             asked_at = excluded.asked_at, due_on = excluded.due_on, status = excluded.status, done_at = excluded.done_at, hours_to_done = excluded.hours_to_done,
                             working_hours_to_done = excluded.working_hours_to_done, follow_ups = excluded.follow_ups, late = excluded.late, confidence = excluded.confidence,
                             stale = excluded.stale,
                             review_state = case when pulse_priv.wa_work_item.review_state in ('accepted', 'dismissed') then pulse_priv.wa_work_item.review_state else excluded.review_state end""",
                        (cut(r["key"], 80), c, ref(r), ref(r, "done_message"), uid(clients, r.get("client")), uid(projects, r.get("project")), r["kind"],
                         text(r["title"], 300) or "(untitled)", text(r.get("detail"), 2000), cut(r.get("topic"), 20), person(r.get("asked_by")), r.get("asked_side"),
                         person(r.get("owner")), r.get("owner_side"), person(r.get("done_by")), r["asked_at"], r.get("due_on"), r["status"], r.get("done_at"),
                         r.get("hours_to_done"), r.get("working_hours_to_done"), r.get("follow_ups") or 0, r.get("late"), r.get("confidence"), bool(r.get("stale")), state))
            done["work_items"] += 1
        if seen:
            cur.execute("delete from pulse_priv.wa_work_item where org_id = pulse.current_org() and chat_id = any(%s) and review_state in ('suggested', 'history') and not (source_key = any(%s))",
                        (loaded, sorted(seen)))
        for t in ("wa_milestone", "wa_finance_event"):
            cur.execute(f"delete from pulse_priv.{t} where org_id = pulse.current_org() and chat_id = any(%s)", (loaded,))
        cur.execute("delete from pulse_priv.wa_learning where org_id = pulse.current_org()")
        batch = []
        for r in rows(args.dir, "milestones"):
            c = chats.get(r["group"])
            if not c:
                skipped["milestones"] += 1; continue
            batch.append((cut(r["key"], 80), c, ref(r), uid(clients, r.get("client")), uid(projects, r.get("project")), cut(r["kind"], 30), r["at"], person(r.get("owner")),
                          bool(r.get("delayed")), cut(r.get("delay_cause"), 30), text(r.get("note"), 600)))
        cur.executemany("""insert into pulse_priv.wa_milestone (org_id, source_key, chat_id, message_id, client_id, project_id, kind, at, owner_id, delayed, delay_cause, note)
                           values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) on conflict do nothing""", batch)
        done["milestones"] = len(batch)
        batch = []
        for r in rows(args.dir, "learning"):
            c = chats.get(r.get("group")) if r.get("group") else None
            ev = [keys[k][1] for k in r.get("evidence") or [] if k in keys]
            by = person(r.get("by"))
            batch.append((cut(r["key"], 80), r["kind"], c, uid(clients, r.get("client")), uid(projects, r.get("project")), cut(r.get("category"), 40), r.get("verdict"),
                          text(r["title"], 600) or "(untitled)", text(r.get("detail"), 4000), text(r.get("root_cause"), 1000), text(r.get("prevention"), 1000),
                          text(r.get("outcome"), 1000), by, r.get("by_side"), r.get("at"), ev, Jsonb(r.get("data") or {})))
        cur.executemany("""insert into pulse_priv.wa_learning (org_id, source_key, kind, chat_id, client_id, project_id, category, verdict, title, detail, root_cause, prevention,
                             outcome, by_id, by_side, at, evidence, data)
                           values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) on conflict do nothing""", batch)
        done["learning"] = len(batch)
        batch = []
        for r in rows(args.dir, "finance"):
            c = chats.get(r["group"])
            if not c:
                skipped["finance"] += 1; continue
            batch.append((cut(r["key"], 80), c, ref(r), uid(clients, r.get("client")), uid(projects, r.get("project")), r["kind"], r.get("amount_inr"), r.get("period"),
                          r["at"], r.get("by_side"), r.get("status"), text(r.get("note"), 600)))
        cur.executemany("""insert into pulse_priv.wa_finance_event (org_id, source_key, chat_id, message_id, client_id, project_id, kind, amount_inr, period, at, by_side, status, note)
                           values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) on conflict do nothing""", batch)
        done["finance"] = len(batch)
        cur.execute("delete from pulse_priv.wa_person_perf where org_id = pulse.current_org()")
        batch = []
        for r in rows(args.dir, "person_perf"):
            pid = r.get("person") if r.get("person") in names else person(r.get("sender"))
            if not pid:
                skipped["person_perf"] += 1; continue
            m = json.loads(text(json.dumps(r["metrics"], ensure_ascii=False), 1_000_000))
            batch.append((pid, "team" if sides.get(pid) in ("staff", "agent") else "client", Jsonb(m)))
        cur.executemany("""insert into pulse_priv.wa_person_perf (org_id, person_id, side, metrics) values (pulse.current_org(), %s, %s, %s)
                           on conflict (org_id, person_id) do update set metrics = excluded.metrics, side = excluded.side, as_of = now()""", batch)
        done["person_perf"] = len(batch)
        sp = Path(args.dir) / "summary.json"
        if sp.exists():
            summary = json.loads(text(sp.read_text(), 5_000_000))
            cur.execute("""insert into pulse_priv.wa_intel_summary (org_id, data) values (pulse.current_org(), %s)
                           on conflict (org_id) do update set data = excluded.data, as_of = now()""", (Jsonb(summary),))
            done["summary"] = 1
        for r in rows(args.dir, "sop_drafts"):
            doc = Jsonb({"steps": r["steps"], "connections": []})
            cur.execute("select id, status, updated_by, confirmed_by from pulse.sop where org_id = pulse.current_org() and title = %s and 'whatsapp_intel' = any(tags)", (r["title"][:200],))
            have = cur.fetchone()
            if not have:
                cur.execute("""insert into pulse.sop (org_id, title, purpose, status, doc, category, tags, source, confidence) values (pulse.current_org(), %s, %s, 'draft', %s, %s, %s, 'pulse', %s) returning id""",
                            (r["title"][:200], text(r["purpose"], 2000), doc, r.get("category"), sorted(set(r.get("tags", []) + ["whatsapp_intel"])), r.get("confidence")))
                sid = cur.fetchone()["id"]
                cur.execute("insert into pulse.sop_version (org_id, sop_id, version, title, doc, note) values (pulse.current_org(), %s, 1, %s, %s, 'Drafted from the WhatsApp groups (work analysis)')",
                            (sid, r["title"][:200], doc))
                done["sop_drafts"] += 1
            elif have["status"] == "draft" and have["updated_by"] is None and have["confirmed_by"] is None:
                cur.execute("update pulse.sop set doc = %s, purpose = %s, updated_at = now() where id = %s", (doc, text(r["purpose"], 2000), have["id"]))
                done["sop_drafts"] += 1
        titles = [r["title"][:200] for r in rows(args.dir, "sop_drafts")]
        if titles:                                     # an earlier draft nobody touched, now under another title
            cur.execute("""update pulse.sop set status = 'archived', updated_at = now() where org_id = pulse.current_org() and 'whatsapp_intel' = any(tags)
                           and status = 'draft' and updated_by is null and confirmed_by is null and not (title = any(%s))""", (titles,))
            done["sop_archived"] = cur.rowcount
        for r in rows(args.dir, "review_items"):
            e = r.get("entity") or {}
            eid = person(e["sender"]) if e.get("sender") else uid(clients, e.get("client")) or uid(projects, e.get("project"))
            cl = uid(clients, (r.get("proposed") or {}).get("clientId"))
            if eid and r["entity_type"] == "contact" and cl and (cl, eid) in linked:      # already that client's contact
                r = {**r, "proposed": {k: v for k, v in r["proposed"].items() if k != "clientId"},
                     "title": re.sub(r"(, |: )contact of \{\{c:[^}]+\}\}$", "", r["title"])}
                if not r["proposed"]:
                    skipped["review_items"] += 1; continue
            if not eid and can_make and e.get("sender") and e["sender"] not in ident and e["sender"] in named and cl:
                # someone the chats name and Pulse lacks: a new point of contact of the one client they speak for
                pr = {k: v for k, v in r["proposed"].items() if k in ("designation", "contactType")}
                r = {**r, "source_key": r["source_key"].replace(":profile:", ":new:"), "entity_type": "client", "proposed": {**pr, "newContact": e["sender"]},
                     "title": f"New contact {{{{p:{e['sender']}}}}}" + "".join(f", {x}" for x in (pr.get("designation"), "channel partner" if pr.get("contactType") else None) if x)
                     + f" at {{{{c:{cl}}}}}"}
                eid = cl
            if not eid:
                skipped["review_items"] += 1; continue
            cur.execute("""insert into pulse.review_item (org_id, source_key, kind, entity_type, entity_id, title, proposed, confidence, evidence, status)
                           values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s, %s, 'pending') on conflict (org_id, source_key) do nothing""",
                        (r["source_key"][:200], r["kind"], r["entity_type"], eid, text(r["title"], 300), Jsonb(r["proposed"]), r.get("confidence"), Jsonb(r.get("evidence") or {})))
            done["review_items"] += cur.rowcount
    if args.dry_run:
        con.rollback()
    else:
        con.commit()
    print(json.dumps({"loaded": dict(done), "skipped": dict(skipped), "chats": len(chats), "dry_run": args.dry_run}))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    lo = sub.add_parser("load"); lo.add_argument("dir"); lo.add_argument("--org")
    lo.add_argument("--dry-run", action="store_true", help="do everything, then roll back (the counts of a real run)")
    args = ap.parse_args()
    load(args)


if __name__ == "__main__":
    main()
