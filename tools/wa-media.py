"""WA-MEDIA: load what the files of imported WhatsApp groups show or say into Pulse (migration 1100): per file its class,
alt text, summary, readable text and structured facts (wa_media); the figures files carry, such as payments, ad funds,
ad spend, leads and invoices (wa_media_figure); and the creative library: each creative's series, version and what the
client said next (wa_creative). Company-neutral: the files are built outside this repository from the company's own
imports, keyed by file SHA-256 and the import keys of tools/wa-import.py; this tool only maps keys to rows.

  Load directory (JSON lines):
    media.jsonl      {"sha256", "kind", "class", "subclass", "alt_text", "summary", "visible_text", "languages", "facts",
                      "quality_issues", "sensitive", "confidence", "model", "version", "analysed_at"}
    figures.jsonl    {"sha256", "group", "key", "client", "project", "kind", "amount", "unit", "at", "stated_date", "period",
                      "label", "status", "method", "source"}
    creatives.jsonl  {"group", "key", "sha256", "client", "project", "sent_at", "sender_side", "kind", "class", "format",
                      "headline", "offer", "cta", "language", "series", "version_no", "versions", "status", "approvals",
                      "changes", "client_replies", "first_reply_minutes", "feedback": [keys], "change_notes": [lines]}
  "group" is a chat's source key (wa_chat.source_key); rows of files or chats not loaded yet are skipped and counted.

    PULSE_DATABASE_URL_MIGRATE=... uv run --all-packages python tools/wa-media.py load <dir>
    PULSE_DATABASE_URL_MIGRATE=... uv run --all-packages python tools/wa-media.py status

Replaces what it loaded before (a re-run reflects a new analysis). Prints counts only.
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

FIGURE_KINDS = {"ad_spend", "leads", "cost_per_lead", "impressions", "reach", "clicks", "payment", "ad_funds", "ad_balance", "invoice", "quotation", "receipt", "price", "budget"}


def rows(d, name):
    p = Path(d) / f"{name}.jsonl"
    return [json.loads(line) for line in p.read_text().split("\n") if line.strip()] if p.exists() else []


def clip(s, n):
    return s[:n] if isinstance(s, str) else None


def strs(xs, n=200, most=40):
    return [x[:n] for x in (xs or []) if isinstance(x, str) and x.strip()][:most]


def load(args):
    con = wa_import.connect(args.org)
    chats = {r["source_key"]: r["id"] for r in con.execute("select source_key, id from pulse_priv.wa_chat where org_id = pulse.current_org()")}
    keys = {(r["chat_id"], r["import_key"]): r["id"] for r in con.execute("select chat_id, import_key, id from pulse_priv.wa_message where org_id = pulse.current_org()")}
    files = {r["sha256"] for r in con.execute("select sha256 from pulse_priv.wa_file where org_id = pulse.current_org() and complete")}
    clients = {str(r["id"]) for r in con.execute("select id from pulse.client")}
    projects = {str(r["id"]) for r in con.execute("select id from pulse.project")}
    done, skipped = Counter(), Counter()
    ok_client = lambda x: x if x and str(x) in clients else None
    ok_project = lambda x: x if x and str(x) in projects else None
    with con.cursor() as cur:
        cur.execute("delete from pulse_priv.wa_creative where org_id = pulse.current_org()")
        cur.execute("delete from pulse_priv.wa_media_figure where org_id = pulse.current_org()")
        cur.execute("delete from pulse_priv.wa_media where org_id = pulse.current_org()")
        batch = []
        for r in rows(args.dir, "media"):
            if r["sha256"] not in files or r.get("kind") not in ("image", "video", "document", "audio") or not r.get("class"):
                skipped["media"] += 1; continue
            conf = r.get("confidence")
            batch.append((r["sha256"], r["kind"], r["class"][:40], clip(r.get("subclass"), 160), clip(r.get("alt_text"), 400), clip(r.get("summary"), 2000),
                          clip(r.get("visible_text"), 20000), strs(r.get("languages"), 12, 8), Jsonb(r.get("facts") or {}), strs(r.get("quality_issues"), 300, 20),
                          strs(r.get("sensitive"), 40, 12), conf if isinstance(conf, (int, float)) and 0 <= conf <= 1 else None, (r.get("model") or "unknown")[:80],
                          (r.get("version") or "unknown")[:40], r.get("analysed_at")))
        cur.executemany("""insert into pulse_priv.wa_media (org_id, sha256, kind, class, subclass, alt_text, summary, visible_text, languages, facts, quality_issues,
                             sensitive, confidence, model, version, analysed_at)
                           values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, coalesce(%s::timestamptz, now()))""", batch)
        done["media"] = len(batch)
        batch = []
        for r in rows(args.dir, "figures"):
            c = chats.get(r.get("group"))
            if not c or r["sha256"] not in files or r.get("kind") not in FIGURE_KINDS or r.get("amount") is None or r.get("unit") not in ("inr", "count", "pct"):
                skipped["figures"] += 1; continue
            if abs(float(r["amount"])) >= 1e14:
                skipped["figures"] += 1; continue
            batch.append((r["sha256"], c, keys.get((c, r.get("key"))), ok_client(r.get("client")), ok_project(r.get("project")), r["kind"], r["amount"], r["unit"],
                          r["at"], bool(r.get("stated_date")), clip(r.get("period"), 80), clip(r.get("label"), 200),
                          r.get("status") if r.get("status") in ("success", "pending", "failed") else None, clip(r.get("method"), 30),
                          r.get("source") if r.get("source") in ("image", "document", "video") else "image"))
        cur.executemany("""insert into pulse_priv.wa_media_figure (org_id, sha256, chat_id, message_id, client_id, project_id, kind, amount, unit, at, stated_date, period,
                             label, status, method, source)
                           values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""", batch)
        done["figures"] = len(batch)
        batch = []
        for r in rows(args.dir, "creatives"):
            c = chats.get(r.get("group")); m = keys.get((c, r.get("key"))) if c else None
            if not m or r["sha256"] not in files or r.get("kind") not in ("image", "video", "document") or not r.get("class") \
                    or r.get("status") not in ("approved", "changes_requested", "discussed", "no_response"):
                skipped["creatives"] += 1; continue
            fb = [keys[(c, k)] for k in r.get("feedback") or [] if (c, k) in keys]
            batch.append((c, m, r["sha256"], ok_client(r.get("client")), ok_project(r.get("project")), r["sent_at"],
                          r.get("sender_side") if r.get("sender_side") in ("team", "client") else "unknown", r["kind"], r["class"][:40], clip(r.get("format"), 40),
                          clip(r.get("headline"), 400), clip(r.get("offer"), 400), clip(r.get("cta"), 160), clip(r.get("language"), 40), clip(r.get("series"), 64),
                          r.get("version_no"), r.get("versions"), r["status"], int(r.get("approvals") or 0), int(r.get("changes") or 0), int(r.get("client_replies") or 0),
                          r.get("first_reply_minutes"), fb, strs(r.get("change_notes"), 300, 12)))
        cur.executemany("""insert into pulse_priv.wa_creative (org_id, chat_id, message_id, sha256, client_id, project_id, sent_at, sender_side, kind, class, format,
                             headline, offer, cta, language, series, version_no, versions, status, approvals, changes, client_replies, first_reply_minutes, feedback,
                             change_notes)
                           values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                           on conflict (org_id, chat_id, sha256) do nothing""", batch)
        done["creatives"] = cur.rowcount if cur.rowcount >= 0 else len(batch)
    con.commit()
    print(json.dumps({"loaded": dict(done), "skipped": dict(skipped)}))


def status(args):
    con = wa_import.connect(args.org)
    out = {}
    for t in ("wa_media", "wa_media_figure", "wa_creative"):
        out[t] = con.execute(f"select count(*) n from pulse_priv.{t} where org_id = pulse.current_org()").fetchone()["n"]
    out["media_by_kind"] = {r["kind"]: r["n"] for r in con.execute("select kind, count(*) n from pulse_priv.wa_media where org_id = pulse.current_org() group by 1")}
    out["creatives_by_status"] = {r["status"]: r["n"] for r in con.execute("select status, count(*) n from pulse_priv.wa_creative where org_id = pulse.current_org() group by 1")}
    print(json.dumps(out))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--org")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("load"); p.add_argument("dir")
    sub.add_parser("status")
    args = ap.parse_args()
    {"load": load, "status": status}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
