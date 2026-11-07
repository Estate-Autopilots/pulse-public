"""WA-AUDIO: load a transcript review set into Pulse (migration 1112) and read back what reviewers heard.
Company-neutral: the set is built outside this repository from the company's own imported files, keyed by file
SHA-256; this tool only writes rows for files Pulse already holds and reads the reviews back. Prints counts only.

  Load file (JSON lines, one clip each):
    {"sha256", "label", "kind": voice|audio|video, "duration_s", "draft", "draft_source", "alternatives": [{"label", "text"}]}

    PULSE_DATABASE_URL_MIGRATE=... uv run --all-packages python tools/wa-audio-review.py load <set> <items.jsonl>
    PULSE_DATABASE_URL_MIGRATE=... uv run --all-packages python tools/wa-audio-review.py export <set> <out.jsonl>

load replaces the set's clips (drafts and versions) and keeps every review already made for a clip still in it; a clip
dropped from the set loses its reviews. export writes one line per review (the reviewer as a person id).
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


def load(args):
    con = wa_import.connect(args.org)
    files = {r["sha256"] for r in con.execute("select sha256 from pulse_priv.wa_file where org_id = pulse.current_org() and complete")}
    rows = [json.loads(l) for l in Path(args.file).read_text().split("\n") if l.strip()]
    done, skipped = Counter(), Counter()
    keep = []
    for pos, r in enumerate(rows):
        if r.get("sha256") not in files:
            skipped["file not in Pulse"] += 1; continue
        if r.get("kind") not in ("voice", "audio", "video"):
            skipped["kind"] += 1; continue
        keep.append((r["sha256"], pos, str(r.get("label") or f"c{pos + 1:03d}")[:20], r["kind"], r.get("duration_s"), (r.get("draft") or "")[:20000],
                     str(r.get("draft_source") or "machine")[:200], Jsonb([{"label": str(a.get("label") or "")[:40], "text": (a.get("text") or "")[:8000]}
                                                                       for a in (r.get("alternatives") or [])][:8])))
    with con.cursor() as cur:
        cur.execute("delete from pulse_priv.wa_transcript_review_item where org_id = pulse.current_org() and set_key = %s and not (sha256 = any(%s))",
                    (args.set, [k[0] for k in keep]))
        done["dropped"] = cur.rowcount
        cur.executemany("""insert into pulse_priv.wa_transcript_review_item (org_id, set_key, sha256, position, label, kind, duration_s, draft, draft_source, alternatives)
                           values (pulse.current_org(), %s, %s, %s, %s, %s, %s, %s, %s, %s)
                           on conflict (org_id, set_key, sha256) do update set position = excluded.position, label = excluded.label, kind = excluded.kind,
                           duration_s = excluded.duration_s, draft = excluded.draft, draft_source = excluded.draft_source, alternatives = excluded.alternatives""",
                        [(args.set, *k) for k in keep])
        done["clips"] = len(keep)
    con.commit()
    print(json.dumps({"set": args.set, "loaded": dict(done), "skipped": dict(skipped)}))


def export(args):
    con = wa_import.connect(args.org)
    rows = con.execute("""select r.sha256, i.label, r.reviewer, r.text, r.languages, r.speakers, r.audio, r.note, r.status, r.seconds, r.updated_at
                          from pulse_priv.wa_transcript_review r join pulse_priv.wa_transcript_review_item i
                            on i.org_id = r.org_id and i.set_key = r.set_key and i.sha256 = r.sha256
                          where r.org_id = pulse.current_org() and r.set_key = %s order by i.position, r.updated_at""", (args.set,)).fetchall()
    out = Path(args.file)
    out.write_text("".join(json.dumps({k: (str(v) if k in ("reviewer", "updated_at") else v) for k, v in r.items()}, ensure_ascii=False) + "\n" for r in rows))
    out.chmod(0o600)
    print(json.dumps({"set": args.set, "reviews": len(rows), "done": sum(r["status"] == "done" for r in rows),
                      "reviewers": len({r["reviewer"] for r in rows})}))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("load", "export"):
        p = sub.add_parser(name); p.add_argument("set"); p.add_argument("file"); p.add_argument("--org")
    args = ap.parse_args()
    if not (3 <= len(args.set) <= 40) or not all(ch.isdigit() or ch.islower() or ch == "-" for ch in args.set):
        sys.exit("set: 3-40 lower-case letters, digits or '-'")
    (load if args.cmd == "load" else export)(args)


if __name__ == "__main__":
    main()
