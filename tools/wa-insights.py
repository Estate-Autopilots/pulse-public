"""WA-IMPORT: load the structure computed from imported WhatsApp groups into Pulse (migration 1016): per-message
signals, voice-note transcripts, each chat's stages, response times, sales and service signals, places and the
aggregates per client, project, person, chat and company. Company-neutral: the files are built outside this repository
from the company's own imports, keyed by the import keys of tools/wa-import.py; this tool only maps keys to rows.

  Load directory (JSON lines):
    message_signals.jsonl {"group", "key", "lang", "intent", "intent_p", "topics", "sentiment", "sentiment_p", "flags", "basis", "model"}
    transcripts.jsonl     {"sha256", "language", "language_p", "text", "segments", "model", "seconds"}
    stages.jsonl          {"group", "stage", "first_at", "last_at", "messages", "evidence": [keys]}
    responses.jsonl       {"group", "key", "to_key", "responder" (sender key), "side", "waited_s", "working_s"}
    signals.jsonl         {"group", "key", "client", "project", "kind", "score", "at", "amount", "note"}
    places.jsonl          {"group", "key", "project_id", "kind", "lat", "lng", "label", "url", "at"}
    insights.jsonl        {"subject": client|project|person|chat_group|company, "id", "metrics"}
  "group" is a chat's source key (wa_chat.source_key). Rows of chats not loaded yet are skipped and counted.

    PULSE_DATABASE_URL_MIGRATE=... uv run --all-packages python tools/wa-insights.py load <dir>

Replaces what it loaded before for the same chats (a re-run reflects a new computation). Prints counts only.
"""
import argparse
import importlib.util
import json
import sys
from collections import Counter
from pathlib import Path

from psycopg.types.json import Jsonb

spec = importlib.util.spec_from_file_location("wa_import", Path(__file__).with_name("wa-import.py"))
wa_import = importlib.util.module_from_spec(spec); spec.loader.exec_module(wa_import)


def rows(d, name):
    p = Path(d) / f"{name}.jsonl"
    return [json.loads(l) for l in p.read_text().split("\n") if l.strip()] if p.exists() else []


def load(args):
    con = wa_import.connect(args.org)
    chats = {r["source_key"]: r["id"] for r in con.execute("select source_key, id from pulse_priv.wa_chat where org_id = pulse.current_org()")}
    keys = {}
    for r in con.execute("select chat_id, import_key, id from pulse_priv.wa_message where org_id = pulse.current_org()"):
        keys[(r["chat_id"], r["import_key"])] = r["id"]
    parts = {(r["chat_id"], r["source_key"]): r["id"] for r in con.execute("select chat_id, source_key, id from pulse_priv.wa_participant where org_id = pulse.current_org()")}
    files = {r["sha256"] for r in con.execute("select sha256 from pulse_priv.wa_file where org_id = pulse.current_org() and complete")}
    org = con.execute("select pulse.current_org() o").fetchone()["o"]
    done = Counter(); skipped = Counter()
    loaded = sorted(set(chats.values()))
    for t in ("wa_message_signal", "wa_chat_stage", "wa_response", "wa_signal", "wa_place"):
        con.execute(f"delete from pulse_priv.{t} where org_id = pulse.current_org() and chat_id = any(%s)", (loaded,))
    def mid(group, key):
        c = chats.get(group)
        return (c, keys.get((c, key))) if c else (None, None)
    with con.cursor() as cur:
        batch = []
        for r in rows(args.dir, "message_signals"):
            c, m = mid(r["group"], r["key"])
            if not m:
                skipped["message_signals"] += 1; continue
            batch.append((c, m, r.get("lang"), r["intent"], r.get("intent_p"), r.get("topics") or [], r.get("sentiment") or 0, r.get("sentiment_p"), r.get("flags") or [], r["basis"], r["model"]))
        cur.executemany("""insert into pulse_priv.wa_message_signal (org_id, chat_id, message_id, lang, intent, intent_p, topics, sentiment, sentiment_p, flags, basis, model)
                           values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""", batch)
        done["message_signals"] = len(batch)
        batch = []
        for r in rows(args.dir, "transcripts"):
            if r["sha256"] not in files:
                skipped["transcripts"] += 1; continue
            batch.append((r["sha256"], r.get("language"), r.get("language_p"), (r.get("text") or "")[:100000], Jsonb(r.get("segments") or []), r["model"], r.get("seconds")))
        cur.executemany("""insert into pulse_priv.wa_transcript (org_id, sha256, language, language_p, text, segments, model, seconds) values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s)
                           on conflict (org_id, sha256) do update set language = excluded.language, language_p = excluded.language_p, text = excluded.text,
                           segments = excluded.segments, model = excluded.model, seconds = excluded.seconds""", batch)
        done["transcripts"] = len(batch)
        batch = []
        for r in rows(args.dir, "stages"):
            c = chats.get(r["group"])
            if not c:
                skipped["stages"] += 1; continue
            ev = [keys[(c, k)] for k in r.get("evidence", []) if (c, k) in keys]
            batch.append((c, r["stage"], r["first_at"], r["last_at"], r["messages"], ev))
        cur.executemany("insert into pulse_priv.wa_chat_stage (org_id, chat_id, stage, first_at, last_at, messages, evidence) values (pulse.current_org(), %s, %s, %s, %s, %s, %s)", batch)
        done["stages"] = len(batch)
        batch = []
        for r in rows(args.dir, "responses"):
            c, m = mid(r["group"], r["key"]); _, q = mid(r["group"], r["to_key"])
            if not (m and q):
                skipped["responses"] += 1; continue
            batch.append((m, q, c, parts.get((c, r.get("responder"))), r["side"], r["waited_s"], r["working_s"]))
        cur.executemany("""insert into pulse_priv.wa_response (org_id, message_id, to_message_id, chat_id, responder_participant, responder_side, waited_s, working_s)
                           values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s) on conflict do nothing""", batch)
        done["responses"] = len(batch)
        batch = []
        for r in rows(args.dir, "signals"):
            c, m = mid(r["group"], r["key"])
            if not c:
                skipped["signals"] += 1; continue
            batch.append((c, m, r.get("client"), r.get("project"), r["kind"], r["score"], r["at"], r.get("amount"), (r.get("note") or "")[:300]))
        cur.executemany("""insert into pulse_priv.wa_signal (org_id, chat_id, message_id, client_id, project_id, kind, score, at, amount, note)
                           values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s, %s, %s) on conflict do nothing""", batch)
        done["signals"] = len(batch)
        batch = []
        for r in rows(args.dir, "places"):
            c, m = mid(r["group"], r["key"]) if r.get("key") else (chats.get(r["group"]), None)
            if not c:
                skipped["places"] += 1; continue
            batch.append((c, m, r.get("project_id"), r["kind"], r.get("lat"), r.get("lng"), r.get("label"), r.get("url"), r.get("at")))
        cur.executemany("""insert into pulse_priv.wa_place (org_id, chat_id, message_id, project_id, kind, lat, lng, label, url, at)
                           values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s, %s, %s) on conflict do nothing""", batch)
        done["places"] = len(batch)
        batch = []
        for r in rows(args.dir, "insights"):
            if r["subject"] == "chat_group":
                c = chats.get(r["id"])
                if not c:
                    skipped["insights"] += 1; continue
                batch.append(("chat", c, Jsonb(r["metrics"])))
            elif r["subject"] == "company":
                batch.append(("company", org, Jsonb(r["metrics"])))   # the company's aggregate is keyed by its own id
            else:
                batch.append((r["subject"], r["id"], Jsonb(r["metrics"])))
        cur.executemany("""insert into pulse_priv.wa_insight (org_id, subject, subject_id, metrics, as_of) values (pulse.current_org(), %s, %s, %s, now())
                           on conflict (org_id, subject, subject_id) do update set metrics = excluded.metrics, as_of = now()""", batch)
        done["insights"] = len(batch)
        # The map: a site location shared in a project's chat is offered on that project's map location (a maps link and
        # the review flag whatsapp_site_location) when nobody pinned it and it is not exact yet. An admin pins it on the
        # map (map.ts keeps the change log); nothing here moves a pin.
        offered = 0
        for r in rows(args.dir, "places"):
            if r["kind"] not in ("shared_location", "live_location") or r.get("lat") is None or not r.get("project_id") or not chats.get(r["group"]):
                continue
            link = f"https://maps.google.com/?q={float(r['lat']):.6f},{float(r['lng']):.6f}"
            cur.execute("""update pulse.project_location l set maps_links = case when $link = any(l.maps_links) then l.maps_links else l.maps_links || array[$link::text] end,
                             review_flags = case when 'whatsapp_site_location' = any(l.review_flags) then l.review_flags else l.review_flags || array['whatsapp_site_location'] end,
                             updated_at = now()
                           from pulse.project_location_member m
                           where m.org_id = pulse.current_org() and m.project_id = %(project)s and l.id = m.location_id and l.org_id = m.org_id
                             and l.pinned_at is null and coalesce(l.precision, '') <> 'exact' and not ($link = any(l.maps_links))""".replace("$link", "%(link)s"),
                        {"project": r["project_id"], "link": link})
            offered += cur.rowcount
        done["map_locations_offered"] = offered
        # An SOP draft (sop_draft.jsonl, one object: title, purpose, category, tags, confidence, steps): made once as a draft;
        # refreshed only while it is still an untouched draft (nobody edited, confirmed or activated it).
        for r in rows(args.dir, "sop_draft"):
            doc = Jsonb({"steps": r["steps"], "connections": []})
            cur.execute("""select id, status, updated_by, confirmed_by from pulse.sop where org_id = pulse.current_org() and title = %s and 'whatsapp_import' = any(tags)""", (r["title"][:200],))
            have = cur.fetchone()
            if not have:
                cur.execute("""insert into pulse.sop (org_id, title, purpose, status, doc, category, tags, source, confidence) values (pulse.current_org(), %s, %s, 'draft', %s, %s, %s, 'pulse', %s) returning id""",
                            (r["title"][:200], r["purpose"][:2000], doc, r.get("category"), r.get("tags", []), r.get("confidence")))
                sid = cur.fetchone()["id"]
                cur.execute("insert into pulse.sop_version (org_id, sop_id, version, title, doc, note) values (pulse.current_org(), %s, 1, %s, %s, 'Drafted from the imported WhatsApp groups')",
                            (sid, r["title"][:200], doc))
                done["sop_draft"] = 1
            elif have["status"] == "draft" and have["updated_by"] is None and have["confirmed_by"] is None:
                cur.execute("update pulse.sop set doc = %s, purpose = %s, updated_at = now() where id = %s", (doc, r["purpose"][:2000], have["id"]))
                done["sop_draft"] = 1
    con.commit()
    print(json.dumps({"loaded": dict(done), "skipped": dict(skipped), "chats": len(chats)}))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    lo = sub.add_parser("load"); lo.add_argument("dir"); lo.add_argument("--org")
    args = ap.parse_args()
    load(args)


if __name__ == "__main__":
    main()
