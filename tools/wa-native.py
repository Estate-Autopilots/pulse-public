"""WA-NATIVE: move imported WhatsApp groups' history into their Pulse chats (migration 1051), check it, or undo it.
Company-neutral: works on whatever pulse.wa_* holds for the company.

  Sync (idempotent: a chat already in step adds nothing; one chat per transaction, smallest first; waits while the
  server is busy):
    PULSE_DATABASE_URL_MIGRATE=... uv run --all-packages python tools/wa-native.py sync [--chat <wa_chat id>] [--limit N]
  Check every chat (counts only): source messages (minus the encryption notice) = chat messages, every imported
  message's time, kind and author against its source, and the mention rates:
    PULSE_DATABASE_URL_MIGRATE=... uv run --all-packages python tools/wa-native.py verify
  Undo one chat (its imported messages and guests leave the Pulse chat; the WhatsApp tables are untouched):
    PULSE_DATABASE_URL_MIGRATE=... uv run --all-packages python tools/wa-native.py undo --chat <wa_chat id>
  Load the SOP proposal for review (once): a draft "…: proposed changes from the WhatsApp groups" made from the active SOP
  the chats were measured against, each step annotated with its measured share and timing (the same draft Insights →
  Onboarding SOP → "Prepare it for review" makes; leaders add each recommendation to it in one click; never active):
    PULSE_DATABASE_URL_MIGRATE=... uv run --all-packages python tools/wa-native.py sop

Runs as the database's owner role with the company set (--org, else the install's company). Prints counts only, never
message text, names or numbers.
"""
import argparse
import json
import os
import sys
import time

import psycopg
from psycopg.rows import dict_row


def connect(org=None):
    url = os.environ.get("PULSE_DATABASE_URL_MIGRATE") or os.environ.get("MIGRATE_DATABASE_URL")
    if not url:
        sys.exit("set PULSE_DATABASE_URL_MIGRATE (the database owner's login)")
    con = psycopg.connect(url, row_factory=dict_row, autocommit=False, application_name="wa-native")
    owner = os.environ.get("PULSE_DB_OWNER") or con.execute(
        "select pg_get_userbyid(datdba) r from pg_database where datname = current_database()").fetchone()["r"]
    con.execute(f'set role "{owner}"')
    org = org or con.execute("select pulse.install_org() o").fetchone()["o"]
    if not org:
        sys.exit("no company: pass --org")
    con.execute("select set_config('pulse.org_id', %s, false)", (str(org),))
    con.commit()
    return con


def busy(limit):
    return limit and os.getloadavg()[0] > limit


def sync(args):
    con = connect(args.org)
    where = "where c.id = %s" if args.chat else ""
    chats = con.execute(f"""select c.id, c.messages from pulse_priv.wa_chat c {where}
                             order by c.messages {'desc' if args.largest_first else ''}, c.id""", (args.chat,) if args.chat else ()).fetchall()
    if args.skip_synced:  # a second runner beside the first: groups already in step are passed over
        done = {r["chat_id"] for r in con.execute("select chat_id from pulse_priv.wa_native")}
        chats = [c for c in chats if c["id"] not in done]
    con.commit()
    total = {"chats": 0, "added": 0, "mentionsFound": 0, "mentionsPeople": 0, "mentionsGuests": 0, "moved": 0, "removed": 0}
    for i, c in enumerate(chats[: args.limit or None]):
        while busy(args.max_load):
            time.sleep(15)
        t0 = time.time()
        con.execute("set local lock_timeout = '10s'")
        r = con.execute("select pulse.wa_native_sync(%s) r", (c["id"],)).fetchone()["r"]
        con.commit()
        total["chats"] += 1
        for k in ("added", "mentionsFound", "mentionsPeople", "mentionsGuests", "moved", "removed"):
            total[k] += int(r.get(k) or 0)
        print(json.dumps({"n": i + 1, "of": len(chats), "chat": str(c["id"])[:8], "source": r["source"], "messages": r["messages"], "added": r["added"],
                          "skipped": r["skipped"], "guests": r["guests"], "mentions": [r.get("mentionsFound"), r.get("mentionsPeople"), r.get("mentionsGuests")],
                          "s": round(time.time() - t0, 2)}), flush=True)
    print(json.dumps({"total": total}))


def verify(args):
    con = connect(args.org)
    rows = con.execute("""
      with src as (select m.chat_id, count(*) filter (where not (m.kind = 'system' and coalesce(m.subtype, '') = 'encryption')) n
                     from pulse_priv.wa_message m join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
                    group by 1),
           nat as (select c.id chat_id, count(x.id) n,
                          count(x.id) filter (where date_trunc('minute', x.created_at) <> date_trunc('minute', m.sent_at)) bad_time,
                          count(x.id) filter (where (x.kind = 'event') <> (m.kind in ('system', 'call'))) bad_kind,
                          count(x.id) filter (where (x.removed_at is not null) <> (m.kind = 'deleted')) bad_deleted,
                          count(x.id) filter (where x.author_id <> coalesce(pa.person_id, o.author_id)) bad_author,
                          count(x.id) filter (where pa.person_id is null and m.participant_id is not null and x.guest_id is null) bad_guest,
                          count(x.id) filter (where m.file_state = 'attached' and not (x.attachments->0 ? 'wa' or x.attachments->0 ? 'omitted')) bad_file,
                          count(x.id) filter (where x.channel_id <> c.channel_id) bad_channel
                     from pulse_priv.wa_chat c
                     left join pulse.chat_message x on x.org_id = c.org_id and x.channel_id = c.channel_id and x.import_ref is not null
                     left join pulse_priv.wa_message m on m.org_id = x.org_id and m.id = x.import_ref
                     left join pulse_priv.wa_participant pa on pa.org_id = m.org_id and pa.id = m.participant_id
                     left join pulse_priv.wa_native_org o on o.org_id = c.org_id
                    group by 1)
      select c.id, coalesce(s.n, 0) source, coalesce(n.n, 0) native, n.bad_time, n.bad_kind, n.bad_deleted, n.bad_author, n.bad_guest, n.bad_file, n.bad_channel,
             (select count(*) from pulse.chat_message x where x.org_id = c.org_id and x.channel_id = c.channel_id and x.import_ref is not null
               and x.created_at > (select min(cm.read_through) from pulse.chat_member cm where cm.channel_id = c.channel_id)) unread_imported
        from pulse_priv.wa_chat c left join src s on s.chat_id = c.id left join nat n on n.chat_id = c.id order by c.messages""").fetchall()
    st = con.execute("""select coalesce(sum((stats->>'mentionsFound')::int), 0) found, coalesce(sum((stats->>'mentionsPeople')::int), 0) people,
                               coalesce(sum((stats->>'mentionsGuests')::int), 0) guests, coalesce(sum((stats->>'messagesWithMentions')::int), 0) msgs,
                               count(*) chats from pulse_priv.wa_native""").fetchone()
    notes = con.execute("""select count(*) n from pulse.notification nt join pulse.chat_message x on x.id = nt.message_id where x.import_ref is not null""").fetchone()["n"]
    con.rollback()
    keys = ("bad_time", "bad_kind", "bad_deleted", "bad_author", "bad_guest", "bad_file", "bad_channel", "unread_imported")
    out = {"chats": len(rows), "in_step": sum(1 for r in rows if r["source"] == r["native"]), "source": sum(r["source"] for r in rows),
           "native": sum(r["native"] for r in rows), **{k: sum(int(r[k] or 0) for r in rows) for k in keys},
           "notifications_from_imported": notes, "mentions": {k: int(v) for k, v in st.items()}}
    out["not_in_step"] = [str(r["id"])[:8] for r in rows if r["source"] != r["native"]][:20]
    print(json.dumps(out))
    clean = out["in_step"] == out["chats"] and not any(out[k] for k in keys) and not notes
    sys.exit(0 if clean else 1)


def undo(args):
    if not args.chat:
        sys.exit("undo takes one chat: --chat <wa_chat id>")
    con = connect(args.org)
    r = con.execute("select pulse.wa_native_undo(%s) r", (args.chat,)).fetchone()["r"]
    con.commit()
    print(json.dumps(r))


def pct(x):
    return f"{round(x * 100)}%" if isinstance(x, (int, float)) else "–"


def days(h):
    return round(h / 24 * 10) / 10 if isinstance(h, (int, float)) else None


def sop(args):
    """Insights' proposal(), as the database owner: the measured SOP with each step's share and timing, as a draft."""
    con = connect(args.org)
    have = con.execute("""select id from pulse.sop where org_id = pulse.current_org() and 'whatsapp_import' = any(tags) and 'proposed' = any(tags)
                          and status <> 'archived' limit 1""").fetchone()
    if have:
        print(json.dumps({"sop": str(have["id"])[:8], "already": True}))
        return
    m = con.execute("select metrics from pulse_priv.wa_insight where org_id = pulse.current_org() and subject = 'company'").fetchone()
    steps = (m or {}).get("metrics", {}).get("sop") or []
    names = {str(s["step"]).lower(): s for s in steps}
    groups = con.execute("select count(*) n from pulse_priv.wa_chat where org_id = pulse.current_org()").fetchone()["n"]
    base = None
    for s in con.execute("select id, title, doc, category from pulse.sop where org_id = pulse.current_org() and status = 'active' order by updated_at desc").fetchall():
        hits = sum(1 for x in s["doc"].get("steps", []) if str(x.get("title", "")).lower() in names)
        if hits and (base is None or hits > base[0]):
            base = (hits, s)
    if not base:
        sys.exit("no active SOP matches the measured steps")
    b = base[1]
    doc = dict(b["doc"])
    out = []
    for x in doc.get("steps", []):
        ms = names.get(str(x.get("title", "")).lower())
        if ms:
            note = f"Measured in the WhatsApp groups: seen in {pct(ms['observed_share'])} of {ms['groups']} groups, median {days(ms.get('median_hours_from_start')) if ms.get('median_hours_from_start') is not None else '–'} days after start."
            x = {**x, "detail": "\n\n".join(d for d in [x.get("detail"), note] if d)}
        out.append(x)
    doc["steps"] = out
    title = f"{b['title']}: proposed changes from the WhatsApp groups"[:200]
    purpose = (f'For review: "{b["title"]}" with what {groups:,} WhatsApp groups show (each step\'s measured share and timing) and the changes proposed '
               "from Insights → Client operations. Nothing changes until a leader makes it active.")
    sid = con.execute("""insert into pulse.sop (org_id, title, purpose, status, doc, category, tags, source) values (pulse.current_org(), %s, %s, 'draft', %s, %s,
                         '{whatsapp_import,proposed}', 'pulse') returning id""", (title, purpose, json.dumps(doc), b["category"] or "Onboarding")).fetchone()["id"]
    con.execute("insert into pulse.sop_version (org_id, sop_id, version, title, doc, note) values (pulse.current_org(), %s, 1, %s, %s, 'Proposed from the WhatsApp analysis')",
                (sid, title, json.dumps(doc)))
    con.execute("select pulse.audit_write('create', 'sop', %s)", (str(sid),))
    if con.execute("select to_regclass('pulse_priv.wa_insights_cache') is not null ok").fetchone()["ok"]:
        con.execute("delete from pulse_priv.wa_insights_cache where org_id = pulse.current_org()")  # Insights reads the new draft at once
    con.commit()
    print(json.dumps({"sop": str(sid)[:8], "steps": len(out), "measured": sum(1 for x in doc["steps"] if "Measured in" in (x.get("detail") or ""))}))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["sync", "verify", "undo", "sop"])
    ap.add_argument("--org")
    ap.add_argument("--chat")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--largest-first", action="store_true", help="biggest groups first (a second runner beside a smallest-first one)")
    ap.add_argument("--skip-synced", action="store_true", help="pass over groups synced already")
    ap.add_argument("--max-load", type=float, default=float(os.environ.get("WA_MAX_LOAD", "0") or 0), help="wait while the 1-minute load is above this")
    args = ap.parse_args()
    {"sync": sync, "verify": verify, "undo": undo, "sop": sop}[args.command](args)


if __name__ == "__main__":
    main()
