#!/usr/bin/env python3
"""A brand's PR Studio put into one organisation at the Pulse server's terminal (PR-STUDIO-2, owner, 7 Nov 2026: "I
expected to see my PR system inside Vitals OS"): the brand, its strategy, its creatives (images and PDFs kept in Pulse)
and its calendar of posts.

    python3 tools/admin/import-pr-studio.py --manifest brand.json --approver "Owner Name (owner)" --words "..." [--apply]

The manifest (JSON) names the organisation, the admin to act for, and the brands (files are relative to the manifest):

    {"org": "<handle>", "as": "<@handle>",
     "brands": [{"name": "...", "kind": "personal|company", "byline": "...", "industry": "creator", "on": true,
                 "strategy": {"positioning": "...", "audiences": [], "pillars": [], "channels": [], "kpis": [], "months": [],
                              "weeks": [], "rules": [], "timeZone": "Asia/Kolkata"},
                 "files": [{"key": "k1-01", "path": "png/k1-01.png", "mime": "image/png"}],
                 "assets": [{"key": "k1", "title": "...", "collection": "...", "kind": "carousel", "size": "1080 × 1350",
                             "pillar": "...", "channel": "linkedin", "format": "...", "caption": "...", "captionSafe": "",
                             "hashtags": ["#Tag"], "why": "...", "hooks": {}, "brief": {}, "okState": "ready|check|needs_ok",
                             "okWho": "", "okNote": "", "pdf": "<file key>", "pdfSafe": "<file key>",
                             "slides": [{"file": "<file key>", "thumb": "<file key>", "name": "k1-01", "alt": "...", "variant": null}]}],
                 "posts": [{"key": "w1-1", "asset": "k1", "title": "...", "stage": "scheduled", "channel": "linkedin",
                            "pillar": "...", "format": "...", "day": "2026-11-10", "time": "08:30", "note": ""}]}]}

  * Every write is what PR Studio's screens write (services/api/src/pr-flow.ts), as that admin, in that organisation, as
    pulse_api, so row security and the gates still decide each step (a brand of another company, a post already
    posted, an approved item from someone who does not manage the brand are all refused). The brand is switched on
    through pulse.pr_brand_switch only when the manifest says "on"; otherwise it stays a draft.
  * Nobody is told: nothing here writes a notice, and the run refuses to commit if any notice was written in it.
  * It can run again: a brand is found by its name, a file by its checksum, a creative and a post by their key.
  * One transaction: a dry run (the default) does all of it and rolls back; the dry run is written to the ledger too
    (admin.import_dry_run). With --apply it commits and writes the platform audit log and the organisation's own Audit
    (admin.import): who approved, their words verbatim, which admin, what was added.
  * It runs only on the Pulse server (PULSE_ADMIN_TOOL_HOSTS, default host-49a12d.internal.example) with the database's admin role there.

Exit codes: 0 done (or the dry run worked); 2 refused (arguments, host, manifest, organisation, admin); 1 the database failed.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shlex
import socket
import subprocess
import sys
from pathlib import Path

SCRIPT = "tools/admin/import-pr-studio.py"
HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,62}$")
KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
DEFAULT_HOSTS = "host-49a12d.internal.example"
MIMES = {"image/png", "image/jpeg", "image/webp", "application/pdf"}
MAX_FILE = 15 * 1024 * 1024
STAGES = {"idea", "draft", "design", "review", "approved", "scheduled"}
CHANNELS = {"linkedin", "x", "instagram", "whatsapp_status", "newsletter"}


class Refused(Exception):
    pass


def lit(v) -> str:
    return "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"


def jlit(v) -> str:
    return lit(json.dumps(v, ensure_ascii=False)) + "::jsonb"


def load_manifest(path: Path) -> dict:
    try:
        m = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise Refused(f"the manifest does not read as JSON ({e})")
    if not HANDLE_RE.match(str(m.get("org", ""))):
        raise Refused("name the organisation by its handle")
    if not HANDLE_RE.match(str(m.get("as", "")).lstrip("@")):
        raise Refused("name the admin to act for by their handle (as)")
    m["as"] = m["as"].lstrip("@")
    brands = m.get("brands") or []
    if not brands:
        raise Refused("the manifest adds nothing")
    for b in brands:
        if not str(b.get("name", "")).strip() or b.get("kind") not in ("personal", "company"):
            raise Refused("each brand has a name and a kind (personal or company)")
        files = {}
        for f in b.get("files", []):
            if not KEY_RE.match(str(f.get("key", ""))) or f.get("mime") not in MIMES:
                raise Refused(f"file {f.get('key')!r}: a key and an image or PDF type")
            p = (path.parent / f["path"]).resolve()
            data = p.read_bytes()
            if not 0 < len(data) <= MAX_FILE:
                raise Refused(f"file {f['key']}: up to 15 MB")
            files[f["key"]] = {"name": Path(f["path"]).name[:200], "mime": f["mime"], "b64": base64.b64encode(data).decode(),
                               "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
        b["_files"] = files
        keys = set()
        for a in b.get("assets", []):
            if not KEY_RE.match(str(a.get("key", ""))) or not str(a.get("title", "")).strip():
                raise Refused("each creative has a key and a title")
            for s in a.get("slides", []):
                if s.get("file") not in files or (s.get("thumb") and s["thumb"] not in files):
                    raise Refused(f"creative {a['key']}: a slide names a file the manifest does not have")
            for k in ("pdf", "pdfSafe"):
                if a.get(k) and a[k] not in files:
                    raise Refused(f"creative {a['key']}: its {k} is not in the files")
            keys.add(a["key"])
        for p in b.get("posts", []):
            if not KEY_RE.match(str(p.get("key", ""))) or p.get("stage") not in STAGES or p.get("channel") not in CHANNELS:
                raise Refused(f"post {p.get('key')!r}: a key, a stage before posted and a channel")
            if p.get("asset") and p["asset"] not in keys:
                raise Refused(f"post {p['key']}: its creative is not in the manifest")
            if p.get("day") and (not DAY_RE.match(p["day"]) or not TIME_RE.match(p.get("time", ""))):
                raise Refused(f"post {p['key']}: a day (YYYY-MM-DD) and a time (HH:MM)")
    return m


def count_sql(counter: str, insert: str) -> str:
    return f"""with ins as ({insert} returning 1)
select set_config('{counter}', (current_setting('{counter}')::int + (select count(*) from ins))::text, true);
"""


def build_script(m: dict, actor: str, approver: str, words: str, host: str, digest: str, apply: bool) -> str:
    out = [f"""\\set ON_ERROR_STOP on
set client_encoding = 'UTF8';
begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';
select set_config('imp.org', o.id::text, true), set_config('imp.person', m.person_id::text, true),
       set_config('imp.name', p.display_name, true), set_config('imp.org_name', o.name, true)
  from pulse.org o
  join pulse_priv.account_member m on m.member_org = o.id
  join pulse_priv.pulse_account a on a.id = m.account_id
  join pulse.person p on p.id = m.person_id and p.org_id = o.id
 where o.handle = {lit(m['org'])} and o.status = 'active' and a.handle = {lit(m['as'])} and p.status = 'active' and p.side = 'staff'
 limit 1;
do $c$ begin
  if coalesce(current_setting('imp.org', true), '') = '' then
    raise exception 'IMPORT_REFUSED: no active organisation {m['org']} with a staff seat for @{m['as']}' using errcode = '42501';
  end if;
end $c$;
select set_config('imp.brands', '0', true), set_config('imp.files', '0', true), set_config('imp.assets', '0', true),
       set_config('imp.posts', '0', true), set_config('imp.switched', '', true), set_config('imp.notices', (select count(*) from pulse.notification)::text, true);
select set_config('pulse.org_id', current_setting('imp.org'), true), set_config('pulse.viewer_id', current_setting('imp.person'), true),
       set_config('pulse.actor_account', {lit(actor)}, true), set_config('pulse.agent_session', '', true);
set local role pulse_api;
"""]
    for bi, b in enumerate(m["brands"]):
        bk = f"imp.b{bi}"
        B = f"current_setting('{bk}')::uuid"
        out.append(f"-- Brand: {b['name']}\n" + count_sql("imp.brands", f"""insert into pulse.pr_brand (org_id, kind, name, byline, industry, owner_person_id, created_by)
select pulse.current_org(), {lit(b['kind'])}, {lit(b['name'])}, {lit(b.get('byline', ''))}, {lit(b.get('industry', 'other'))},
  {'pulse.current_viewer()' if b['kind'] == 'personal' else 'null'}, pulse.current_viewer()
 where not exists (select 1 from pulse.pr_brand where org_id = pulse.current_org() and lower(name) = lower({lit(b['name'])}))"""))
        out.append(f"select set_config('{bk}', (select id::text from pulse.pr_brand where org_id = pulse.current_org() and lower(name) = lower({lit(b['name'])})), true);\n")
        s = b.get("strategy") or {}
        cols = {"positioning": lit(s.get("positioning", "")), "audiences": jlit(s.get("audiences", [])), "pillars": jlit(s.get("pillars", [])),
                "channels": jlit(s.get("channels", [])), "kpis": jlit(s.get("kpis", [])), "months": jlit(s.get("months", [])),
                "weeks": jlit(s.get("weeks", [])), "rules": jlit(s.get("rules", [])), "time_zone": lit(s.get("timeZone", "Asia/Kolkata"))}
        out.append(f"""insert into pulse.pr_strategy (org_id, brand_id, {', '.join(cols)}, updated_by)
values (pulse.current_org(), {B}, {', '.join(cols.values())}, pulse.current_viewer())
on conflict (brand_id) do update set {', '.join(f'{c} = excluded.{c}' for c in cols)}, updated_by = excluded.updated_by;
""")
        fk = {}
        for fi, (key, f) in enumerate(b["_files"].items()):
            fk[key] = f"imp.b{bi}f{fi}"
            out.append(count_sql("imp.files", f"""insert into pulse.pr_file (org_id, brand_id, name, mime, bytes, sha256, added_by)
select pulse.current_org(), {B}, {lit(f['name'])}, {lit(f['mime'])}, decode({lit(f['b64'])}, 'base64'), {lit(f['sha256'])}, pulse.current_viewer()
 where not exists (select 1 from pulse.pr_file where org_id = pulse.current_org() and brand_id = {B} and sha256 = {lit(f['sha256'])})"""))
            out.append(f"select set_config('{fk[key]}', (select id::text from pulse.pr_file where org_id = pulse.current_org() and brand_id = {B} and sha256 = {lit(f['sha256'])}), true);\n")
        ak = {}
        for ai, a in enumerate(b.get("assets", [])):
            ak[a["key"]] = f"imp.b{bi}a{ai}"
            def slide(s: dict) -> str:
                thumb = "current_setting('" + fk[s["thumb"]] + "')" if s.get("thumb") else "null"
                return (f"jsonb_build_object('file', current_setting('{fk[s['file']]}'), 'thumb', {thumb}, "
                        f"'name', {lit(s.get('name', ''))}, 'alt', {lit(s.get('alt', ''))}, 'variant', {lit(s.get('variant'))})")
            slides = "jsonb_build_array(" + ", ".join(slide(s) for s in a.get("slides", [])) + ")"
            pdf = lambda k: f"current_setting('{fk[a[k]]}')::uuid" if a.get(k) else "null"  # noqa: E731
            tags = "array[" + ", ".join(lit(t) for t in a.get("hashtags", [])[:30]) + "]::text[]"
            out.append(count_sql("imp.assets", f"""insert into pulse.pr_asset (org_id, brand_id, source_key, title, collection, kind, size, pillar, channel, format, caption, caption_safe,
  hashtags, why, hooks, brief, slides, pdf_file_id, pdf_safe_file_id, ok_state, ok_who, ok_note, created_by)
values (pulse.current_org(), {B}, {lit(a['key'])}, {lit(a['title'][:200])}, {lit(a.get('collection', '')[:80])}, {lit(a.get('kind', 'single'))}, {lit(a.get('size', '')[:40])},
  {lit(a.get('pillar', '')[:40])}, {lit(a.get('channel'))}, {lit(a.get('format', '')[:60])}, {lit(a.get('caption', ''))}, {lit(a.get('captionSafe', ''))}, {tags},
  {lit(a.get('why', ''))}, {jlit(a.get('hooks', {}))}, {jlit(a.get('brief', {}))}, {slides}, {pdf('pdf')}, {pdf('pdfSafe')}, {lit(a.get('okState', 'ready'))},
  {lit(a.get('okWho', '')[:120])}, {lit(a.get('okNote', '')[:800])}, pulse.current_viewer())
on conflict (org_id, brand_id, source_key) where source_key is not null do nothing"""))
            out.append(f"select set_config('{ak[a['key']]}', (select id::text from pulse.pr_asset where org_id = pulse.current_org() and brand_id = {B} and source_key = {lit(a['key'])}), true);\n")
        for p in b.get("posts", []):
            slot = (f"(({lit(p['day'])}::date + {lit(p['time'])}::time) at time zone {lit(s.get('timeZone', 'Asia/Kolkata'))})" if p.get("day") else "null")
            out.append(count_sql("imp.posts", f"""insert into pulse.pr_post (org_id, brand_id, asset_id, source_key, title, stage, channel, pillar, format, slot_at, caption, note, created_by)
values (pulse.current_org(), {B}, {f"current_setting('{ak[p['asset']]}')::uuid" if p.get('asset') else 'null'}, {lit(p['key'])}, {lit(p['title'][:200])}, {lit(p['stage'])},
  {lit(p['channel'])}, {lit(p.get('pillar', '')[:40])}, {lit(p.get('format', '')[:60])}, {slot}, {lit(p.get('caption', ''))}, {lit(p.get('note', '')[:1000])}, pulse.current_viewer())
on conflict (org_id, brand_id, source_key) where source_key is not null do nothing"""))
        if b.get("on"):
            out.append(f"""select set_config('imp.switched', concat_ws(',', nullif(current_setting('imp.switched'), ''), pulse.pr_brand_switch({B}, true)), true)
 where coalesce((select status from pulse.pr_strategy where brand_id = {B}), 'draft') <> 'on';
""")
    detail = {"tool": SCRIPT, "host": host, "approver": approver, "words": words, "onBehalfOfHandle": m["as"], "manifestSha256": digest,
              "brands": [{"name": b["name"], "kind": b["kind"], "on": bool(b.get("on")), "files": len(b["_files"]), "assets": len(b.get("assets", [])),
                          "posts": len(b.get("posts", []))} for b in m["brands"]]}
    dexpr = (f"""{jlit(detail)} || jsonb_build_object('onBehalfOf', current_setting('imp.person'), 'madeBrands', current_setting('imp.brands')::int,
    'madeFiles', current_setting('imp.files')::int, 'madeCreatives', current_setting('imp.assets')::int, 'madePosts', current_setting('imp.posts')::int,
    'switchedOn', current_setting('imp.switched'), 'applied', {'true' if apply else 'false'})""")
    out.append(f"""reset role;
do $q$ begin
  if (select count(*) from pulse.notification) <> current_setting('imp.notices')::bigint then
    raise exception 'IMPORT_REFUSED: a notice was written; nothing was written' using errcode = '42501';
  end if;
end $q$;
-- The ledger: the platform audit log, and (platform_log enters the organisation) the organisation's own Audit.
select set_config('pulse.org_id', '', true), set_config('pulse.viewer_id', '', true), set_config('pulse.actor_account', {lit(actor)}, true);
select pulse.platform_log('admin.import', current_setting('imp.org')::uuid, 'import', null, current_setting('imp.org_name'), {lit(words)}, {dexpr}) where {'true' if apply else 'false'};
select current_setting('imp.org') as imp_org, current_setting('imp.org_name') as imp_org_name, ({dexpr})::text as imp_detail \\gset
select json_build_object('org', current_setting('imp.org'), 'orgName', current_setting('imp.org_name'), 'admin', current_setting('imp.name'),
  'brands', current_setting('imp.brands')::int, 'files', current_setting('imp.files')::int, 'creatives', current_setting('imp.assets')::int,
  'posts', current_setting('imp.posts')::int, 'switchedOn', current_setting('imp.switched'), 'applied', {'true' if apply else 'false'})::text;
{'commit' if apply else 'rollback'};
""")
    if not apply:
        out.append(f"""-- The dry run is in the ledger too (its own committed row, admin.import_dry_run: what --apply would add).
begin;
select set_config('pulse.actor_account', {lit(actor)}, true);
select pulse.platform_log('admin.import_dry_run', :'imp_org'::uuid, 'import', null, :'imp_org_name', {lit(words)}, :'imp_detail'::jsonb);
commit;
""")
    return "".join(out)


def psql_argv(exec_: str, user: str, database: str) -> list[str]:
    argv = shlex.split(exec_) + ["psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"]
    if user:
        argv += ["-U", user]
    return argv + ["-d", database]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--manifest", required=True, type=Path)
    ap.add_argument("--approver", required=True, help='who approved this, e.g. "Owner Name (owner)"')
    ap.add_argument("--words", required=True, help="the approver's words, verbatim (they go in the audit log)")
    ap.add_argument("--apply", action="store_true", help="commit (without it: do everything, then roll back)")
    ap.add_argument("--exec", default="docker exec -i ea-postgres", help='how to reach psql ("" for a local psql)')
    ap.add_argument("--db-user", default="ea_admin")
    ap.add_argument("--database", default="pulse")
    ap.add_argument("--print-sql", action="store_true", help="print the script instead of running it (files elided)")
    args = ap.parse_args(argv)
    approver, words = args.approver.strip(), args.words.strip()
    if len(approver) < 3 or len(words) < 4:
        print("Refused: --approver (a name) and --words (the approval, verbatim) are both needed.", file=sys.stderr)
        return 2
    host = socket.gethostname()
    allowed = {h.strip() for h in os.environ.get("PULSE_ADMIN_TOOL_HOSTS", DEFAULT_HOSTS).split(",") if h.strip()}
    if host not in allowed:
        print(f"Refused: this tool runs only on the Pulse server ({', '.join(sorted(allowed))}), not on {host}.", file=sys.stderr)
        return 2
    try:
        m = load_manifest(args.manifest)
    except (Refused, OSError) as e:
        print(f"Refused: {e}", file=sys.stderr)
        return 2
    digest = hashlib.sha256(args.manifest.read_bytes()).hexdigest()
    actor = f"import-pr-studio.py · approver: {approver}"[:120]
    script = build_script(m, actor, approver[:120], words[:380], host, digest, args.apply)
    if args.print_sql:
        print(re.sub(r"decode\('[A-Za-z0-9+/=]{200,}'", "decode('…'", script))
        return 0
    proc = subprocess.run(psql_argv(args.exec, args.db_user, args.database), input=script.encode("utf-8"), capture_output=True, check=False)
    out, err = proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")
    if proc.returncode != 0:
        msg = (re.findall(r"ERROR:\s*(.*)", err) or [err.strip()[-400:]])[-1]
        if "IMPORT_REFUSED" in msg or "denied" in msg or "42501" in err:
            print(f"Refused (nothing was written): {msg.replace('IMPORT_REFUSED: ', '')}", file=sys.stderr)
            return 2
        print(f"The database failed; nothing was written: {msg}", file=sys.stderr)
        return 1
    rows = [json.loads(x) for x in out.splitlines() if x.startswith("{")]
    s = rows[-1]
    what = "Added" if args.apply else "Dry run (rolled back), would add"
    print(f"{what} to {s['orgName']} as {s['admin']} (@{m['as']}), approved by {approver}: {s['brands']} brands, {s['files']} files, "
          f"{s['creatives']} creatives, {s['posts']} posts; switched on: {s['switchedOn'] or 'none'}."
          + (" Written to the platform audit log and the organisation's Audit." if args.apply else " Run again with --apply."), file=sys.stderr)
    print(json.dumps(s, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
