#!/usr/bin/env python3
"""PR-PIPELINE backfill: load a PR harvest (schema pr-harvest/v1) into companies' PR pipelines, once, through the audited
admin path. It writes an SQL script for psql as the database's admin (tools/pr-pipeline/backfill.sh runs it after a
pg_dump of the pr_* tables, as root on the Pulse server); nothing here connects to a database.

    backfill.py --harvest FILE.json --map MAP.json --approver "Name (role)" --words "their words" [--apply] > script.sql

  * achievements -> work events (source 'harvest', one per achievement, its proof text kept, proof link
    report:<harvest file>.md) through pulse.pr_work_ingest as the worker role, so row security and the privacy filter
    apply; the pipeline's tick then makes them milestones and ideas;
  * contentIdeas -> idea briefs (hook, format, proof) of the mapped brand, written by 'person' (the approver), found
    again by their title so a rerun adds nothing;
  * one platform audit line per company (pulse.platform_log 'admin.import', as tools/admin/import-meetings.py): who
    approved, their words verbatim, what was added. Without --apply the script rolls back (a dry run).
MAP: {"source": "PR-HARVEST-2026-11-06", "companies": {"<harvest company text>": [{"org": uuid, "brand": uuid|null,
      "person": uuid|null}, ...]}, "default": [...]|null, "ideas": {"org": uuid, "brand": uuid|null}|null}
      (one achievement may go to several companies: the person's own company and the company it was for)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
FORMATS = {"thread": "thread", "carousel": "carousel", "case study": "case_study", "release note": "release_note", "customer story": "customer_story"}


def lit(v) -> str:
    return "'" + str(v).replace("'", "''") + "'"


def end_date(when: str, fallback: date) -> date:
    """The last day named in "4 Oct - 6 Nov 2026" (or the harvest's date)."""
    days = re.findall(r"(\d{1,2})\s+([A-Za-z]{3})[a-z]*(?:\s+(\d{4}))?", when or "")
    year = re.findall(r"\b(20\d\d)\b", when or "")
    if not days:
        return fallback
    d, mon, y = days[-1]
    try:
        return date(int(y or (year[-1] if year else fallback.year)), MONTHS[mon.lower()], int(d))
    except (KeyError, ValueError):
        return fallback


def plan(h: dict, m: dict) -> dict:
    if h.get("schema") != "pr-harvest/v1":
        raise SystemExit("Not a pr-harvest/v1 file")
    src = m.get("source") or f"PR-HARVEST-{h.get('generated', 'unknown')}"
    made = date.fromisoformat(h.get("generated") or "2026-01-01")
    per_org: dict[str, dict] = {}
    for a in h.get("achievements") or []:
        targets = (m.get("companies") or {}).get(a.get("company")) or m.get("default") or []
        for target in targets if isinstance(targets, list) else [targets]:
          o = per_org.setdefault(target["org"], {"events": [], "ideas": []})
          o["events"].append({"source": "harvest", "key": f"harvest:{src}:{a['id']}", "at": f"{end_date(a.get('when', ''), made).isoformat()}T12:00:00Z",
                            "title": str(a.get("title", ""))[:240], "detail": (f"{a.get('proof', '')}\nWhy it matters: {a.get('why', '')}")[:2000],
                            "proof": f"report:{src}.md", "topic": f"harvest:{a['id']}", "person": target.get("person"), "brand": target.get("brand")})
    ideas = m.get("ideas")
    if ideas:
        o = per_org.setdefault(ideas["org"], {"events": [], "ideas": []})
        for c in h.get("contentIdeas") or []:
            fmt = next((v for k, v in FORMATS.items() if k in str(c.get("format", "")).lower()), "single")
            o["ideas"].append({"title": f"Idea {c.get('id')}: {str(c.get('hook', ''))[:140]}", "hook": str(c.get("hook", ""))[:280], "format": fmt,
                               "body": f"{c.get('hook', '')}\n\nProof: {c.get('proof', '')}\nFor: {c.get('audience', '')}\nFrom {src}.",
                               "proof": [{"label": str(c.get("proof", ""))[:120], "url": f"report:{src}.md"}], "brand": ideas.get("brand")})
    return {"source": src, "day": made.isoformat(), "orgs": per_org}


def script(p: dict, approver: str, words: str, apply: bool) -> str:
    out = ["\\set ON_ERROR_STOP on", "begin;"]
    actor = f"pr-pipeline backfill.py · approver: {approver}"[:120]
    for org, o in p["orgs"].items():
        out.append(f"set local role pulse_worker;\nselect set_config('pulse.org_id', {lit(org)}, true), set_config('pulse.viewer_id', '', true);")
        out.append(f"select json_build_object('org', {lit(org)}, 'events', pulse.pr_work_ingest({lit(json.dumps(o['events']))}::jsonb))::text;")
        out.append("reset role;")
        for i in o["ideas"]:
            out.append(f"""insert into pulse.pr_brief (org_id, kind, day, title, body, written_by, brand_id, hook, format, proof)
select {lit(org)}, 'idea', {lit(p['day'])}, {lit(i['title'][:160])}, {lit(i['body'][:8000])}, 'person', {lit(i['brand']) + '::uuid' if i['brand'] else 'null'},
  {lit(i['hook'])}, {lit(i['format'])}, {lit(json.dumps(i['proof']))}::jsonb
where not exists (select 1 from pulse.pr_brief where org_id = {lit(org)} and kind = 'idea' and title = {lit(i['title'][:160])});""")
        detail = {"tool": "tools/pr-pipeline/backfill.py", "source": p["source"], "approver": approver, "words": words,
                  "events": len(o["events"]), "ideas": len(o["ideas"]), "applied": apply}
        out.append(f"""select set_config('pulse.org_id', '', true), set_config('pulse.viewer_id', '', true), set_config('pulse.actor_account', {lit(actor)}, true);
select pulse.platform_log('admin.import', {lit(org)}::uuid, 'import', null, (select name from pulse.org where id = {lit(org)}::uuid), {lit(words)}, {lit(json.dumps(detail))}::jsonb) where {'true' if apply else 'false'};""")
    out.append("commit;" if apply else "rollback;")
    return "\n".join(out) + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="PR-PIPELINE backfill from a PR harvest")
    ap.add_argument("--harvest", required=True)
    ap.add_argument("--map", required=True)
    ap.add_argument("--approver", required=True)
    ap.add_argument("--words", required=True)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--summary", action="store_true", help="print what would be loaded, no SQL")
    a = ap.parse_args(argv)
    if len(a.approver.strip()) < 3 or len(a.words.strip()) < 4:
        print("Refused: --approver and --words (verbatim) are both needed.", file=sys.stderr)
        return 2
    p = plan(json.loads(Path(a.harvest).read_text(encoding="utf-8")), json.loads(Path(a.map).read_text(encoding="utf-8")))
    if a.summary:
        print(json.dumps({org: {"events": len(o["events"]), "ideas": len(o["ideas"])} for org, o in p["orgs"].items()}))
        return 0
    sys.stdout.write(script(p, a.approver.strip()[:120], a.words.strip()[:380], a.apply))
    return 0


if __name__ == "__main__":
    sys.exit(main())
