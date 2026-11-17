#!/usr/bin/env python3
"""Goals, projects and tasks told apart in one organisation at the Pulse server's terminal (PERSONAL-WORKSPACE, owner,
6 Nov 2026): "Many items imported into HQ as projects or tasks are really GOALS. Goals must be separate from projects
and tasks."

    python3 tools/admin/reclassify-work.py --manifest reorg.json --approver "Owner Name (owner)" --words "..." [--apply]

The manifest (JSON) names the organisation, the admin to act for, and what to change. Ids are the organisation's own:

    {"org": "<handle>", "as": "<@handle>",
     "projectKinds": [{"project": "<uuid>", "kind": "internal"}],
     "goals": [{"title": "Consulting at Rs 2,500+ an hour", "why": "...", "status": "active", "targetOn": "2027-10-29",
                "measure": {"label": "Rate (Rs/hour)", "start": 0, "target": 2500, "current": 0},
                "fromTask": "<uuid>", "projects": ["<uuid>"], "tasks": ["<uuid>"]}],
     "relink": [{"task": "<uuid>", "project": "<uuid>"}]}

  * A goal is a person goal of the admin (pulse.goal, level 'person', as Goals → New goal stores it), found again by its
    title, so a rerun adds nothing. Its links (pulse.goal_link) are added as Goals → Link does, once each.
  * Delete nothing. A task that IS the goal ("fromTask") is kept with its history: linked to the goal, tagged
    'became-goal' (pulse.task_save) and moved to Cancelled with the note "Became the goal …" (pulse.task_move), so its
    events say what happened. A relinked task moves project through pulse.task_save (its 'edited' event).
  * A project's kind (work_project.kind: internal, fulfilment, or personal once the database knows it; pulse.project.kind
    follows: client_work for fulfilment, else internal) has no API route for an existing project, so it is changed
    directly as the database's admin role, inside the organisation (its own Audit records the row change).
  * Goals, links, tags and moves go through the API's own grants and functions as that admin, in that organisation, as
    pulse_api: row security and the functions' own checks still apply. No sign-in is made.
  * Nobody is told: any notice the changes made about these tasks, projects or goals is taken back before commit.
  * One transaction: a dry run (the default) does all of it and rolls back, so it shows exactly what --apply would do;
    the dry run is written to the ledger as its own committed row (admin.reclassify_dry_run). With --apply it commits and
    writes the platform audit log (admin.reclassify) and, through platform_log, the organisation's own Audit.
  * It runs only on the Pulse server (PULSE_ADMIN_TOOL_HOSTS, default host-49a12d.internal.example). There is no web route for it.

Exit codes: 0 done (or the dry run worked); 2 refused (arguments, host, manifest, organisation, admin); 1 the database failed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import socket
import subprocess
import sys
from pathlib import Path

APP = "pulse-reclassify-work"
SCRIPT = "tools/admin/reclassify-work.py"
HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,62}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DEFAULT_HOSTS = "host-49a12d.internal.example"
KINDS = {"internal", "fulfilment", "personal"}
STATUSES = {"active", "done"}
TAG = "became-goal"


class Refused(Exception):
    pass


def lit(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def num(value: object) -> str:
    return "null" if value is None else repr(float(value))


def psql_argv(runner: str, user: str, database: str) -> list[str]:
    argv = shlex.split(runner)
    if argv[:2] == ["docker", "exec"]:
        argv[2:2] = ["-e", f"PGAPPNAME={APP}"]
    conn = ["-U", user, "-d", database] if user else ["-d", database]
    return [*argv, "psql", *conn, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"]


def _id(value: object, what: str) -> str:
    s = str(value or "").strip().lower()
    if not UUID_RE.match(s):
        raise Refused(f"{what} is an id (uuid), not {value!r}")
    return s


def load_manifest(path: Path) -> dict:
    try:
        m = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise Refused(f"the manifest cannot be read: {e}") from e
    org, as_handle = str(m.get("org", "")).strip().lower(), str(m.get("as", "")).strip().lstrip("@").lower()
    if not HANDLE_RE.match(org) or not HANDLE_RE.match(as_handle):
        raise Refused('the manifest needs "org" and "as" (handles)')
    kinds = []
    for k in m.get("projectKinds", []):
        if k.get("kind") not in KINDS:
            raise Refused(f"projectKinds: kind is one of {', '.join(sorted(KINDS))}")
        kinds.append({"project": _id(k.get("project"), "projectKinds.project"), "kind": k["kind"]})
    goals, titles = [], set()
    for i, g in enumerate(m.get("goals", [])):
        title = re.sub(r"\s+", " ", str(g.get("title") or "")).strip()
        if not title or len(title) > 160:
            raise Refused(f"goal {i + 1}: a title of up to 160 characters")
        if title.lower() in titles:
            raise Refused(f"goal {title}: two goals with the same title")
        titles.add(title.lower())
        why = str(g.get("why") or "").strip()
        if len(why) > 2000:
            raise Refused(f"goal {title}: why up to 2,000 characters")
        status = g.get("status", "active")
        if status not in STATUSES:
            raise Refused(f"goal {title}: status is active or done")
        target_on = g.get("targetOn")
        if target_on is not None and not DATE_RE.match(str(target_on)):
            raise Refused(f"goal {title}: targetOn is a date (YYYY-MM-DD)")
        measure = None
        if g.get("measure"):
            ms = g["measure"]
            label = str(ms.get("label") or "").strip()
            if not 1 <= len(label) <= 60:
                raise Refused(f"goal {title}: a measure needs a label of up to 60 characters")
            try:
                start, target = float(ms.get("start") or 0), float(ms["target"])
                current = None if ms.get("current") is None else float(ms["current"])
            except (KeyError, TypeError, ValueError) as e:
                raise Refused(f"goal {title}: a measure needs numbers (start, target, current)") from e
            if target == start:
                raise Refused(f"goal {title}: the target differs from the start")
            measure = {"label": label, "start": start, "target": target, "current": current}
        goals.append({"title": title, "why": why or None, "status": status, "targetOn": target_on, "measure": measure,
                      "fromTask": _id(g["fromTask"], f"goal {title}: fromTask") if g.get("fromTask") else None,
                      "projects": sorted({_id(p, f"goal {title}: projects") for p in g.get("projects", [])}),
                      "tasks": sorted({_id(t, f"goal {title}: tasks") for t in g.get("tasks", [])})})
    sources = [g["fromTask"] for g in goals if g["fromTask"]]
    if len(sources) != len(set(sources)):
        raise Refused("a task can become one goal only")
    relink = []
    for r in m.get("relink", []):
        relink.append({"task": _id(r.get("task"), "relink.task"), "project": _id(r.get("project"), "relink.project")})
    if not kinds and not goals and not relink:
        raise Refused("the manifest changes nothing")
    return {"org": org, "as": as_handle, "projectKinds": kinds, "goals": goals, "relink": relink}


def build_script(m: dict, actor: str, words: str, detail: dict, apply: bool) -> str:
    org, handle = m["org"], m["as"]
    task_ids = sorted({t for g in m["goals"] for t in g["tasks"]} | {g["fromTask"] for g in m["goals"] if g["fromTask"]}
                      | {r["task"] for r in m["relink"]})
    project_ids = sorted({p for g in m["goals"] for p in g["projects"]} | {k["project"] for k in m["projectKinds"]}
                         | {r["project"] for r in m["relink"]})
    arr = lambda ids: "array[" + ",".join(lit(i) for i in ids) + "]::uuid[]" if ids else "'{}'::uuid[]"  # noqa: E731
    out = [f"""\\set ON_ERROR_STOP on
set client_encoding = 'UTF8';
begin;
set local lock_timeout = '15s';
set local statement_timeout = '180s';
select set_config('rc.org', o.id::text, true), set_config('rc.person', m.person_id::text, true),
       set_config('rc.name', p.display_name, true), set_config('rc.org_name', o.name, true)
  from pulse.org o
  join pulse_priv.account_member m on m.member_org = o.id
  join pulse_priv.pulse_account a on a.id = m.account_id
  join pulse.person p on p.id = m.person_id and p.org_id = o.id
 where (o.handle = {lit(org)} or o.slug = {lit(org)}) and o.status = 'active' and a.handle = {lit(handle)} and p.status = 'active' and p.side = 'staff'
 limit 1;
do $c$ begin
  if coalesce(current_setting('rc.org', true), '') = '' then
    raise exception 'RECLASSIFY_REFUSED: no active organisation {org} with a staff seat for @{handle}' using errcode = '42501';
  end if;
  if not exists (select 1 from pulse.role_assignment r where r.person_id = current_setting('rc.person')::uuid and r.role_key in ('admin', 'leadership')
                   and (r.valid_to is null or r.valid_to >= current_date)) then
    raise exception 'RECLASSIFY_REFUSED: @{handle} is not an admin or leadership in {org}' using errcode = '42501';
  end if;
  -- Every id in the manifest is this organisation's own.
  if exists (select 1 from unnest({arr(task_ids)}) x where not exists (select 1 from pulse.task t where t.id = x and t.org_id = current_setting('rc.org')::uuid and t.deleted_at is null)) then
    raise exception 'RECLASSIFY_REFUSED: a task in the manifest is not in {org}' using errcode = '42501';
  end if;
  if exists (select 1 from unnest({arr(project_ids)}) x where not exists (select 1 from pulse.project p where p.id = x and p.org_id = current_setting('rc.org')::uuid and p.deleted_at is null)) then
    raise exception 'RECLASSIFY_REFUSED: a project in the manifest is not in {org}' using errcode = '42501';
  end if;
end $c$;
select set_config('rc.made_goals', '0', true), set_config('rc.made_links', '0', true), set_config('rc.converted', '0', true),
       set_config('rc.relinked', '0', true), set_config('rc.kinds', '0', true), set_config('rc.goal_ids', '', true);
"""]
    # Project kinds: no API route changes an existing project's kind, so as the admin role inside the organisation.
    for i, k in enumerate(m["projectKinds"]):
        pk = "client_work" if k["kind"] == "fulfilment" else "internal"
        out.append(f"""select set_config('pulse.org_id', current_setting('rc.org'), true);
with w as (update pulse.work_project set kind = {lit(k['kind'])}, updated_at = now(), updated_by = current_setting('rc.person')::uuid
            where org_id = current_setting('rc.org')::uuid and project_id = {lit(k['project'])} and kind <> {lit(k['kind'])} returning 1),
     p as (update pulse.project set kind = {lit(pk)}, updated_at = now()
            where org_id = current_setting('rc.org')::uuid and id = {lit(k['project'])} and kind <> {lit(pk)} returning 1)
select set_config('rc.kinds', (current_setting('rc.kinds')::int + (select count(*) from w))::text, true), (select count(*) from p);
""")
    out.append("""select set_config('pulse.org_id', current_setting('rc.org'), true), set_config('pulse.viewer_id', current_setting('rc.person'), true),
       set_config('pulse.actor_account', """ + lit(actor) + """, true), set_config('pulse.agent_session', '', true);
set local role pulse_api;
""")
    for i, g in enumerate(m["goals"]):
        k = f"rc.g{i}"
        ms = g["measure"] or {}
        out.append(f"""-- Goal: what Goals → New goal stores (a person goal of the admin), found again by its title.
select set_config('{k}', coalesce((select id::text from pulse.goal where org_id = pulse.current_org() and title = {lit(g['title'])} limit 1), ''), true),
       set_config('{k}.new', '', true);
with ins as (
  insert into pulse.goal (org_id, level, title, why, owner_person_id, target_on, measure_label, start_value, target_value, current_value, status, created_by)
  select pulse.current_org(), 'person', {lit(g['title'])}, {lit(g['why']) if g['why'] else 'null'}, pulse.current_viewer(),
         {lit(g['targetOn']) + '::date' if g['targetOn'] else 'null'}, {lit(ms['label']) if ms else 'null'}, {num(ms.get('start')) if ms else 'null'},
         {num(ms.get('target')) if ms else 'null'}, {num(ms.get('current')) if ms else 'null'}, {lit(g['status'])}, pulse.current_viewer()
   where current_setting('{k}') = ''
  returning id)
select set_config('{k}', id::text, true), set_config('{k}.new', '1', true),
       set_config('rc.made_goals', (current_setting('rc.made_goals')::int + 1)::text, true) from ins;
select set_config('rc.goal_ids', concat_ws(',', nullif(current_setting('rc.goal_ids'), ''), current_setting('{k}')), true);
""")
        links = [("project_id", p) for p in g["projects"]] + [("task_id", t) for t in sorted(set(g["tasks"]) | ({g["fromTask"]} if g["fromTask"] else set()))]
        for col, ref in links:
            out.append(f"""with ins as (insert into pulse.goal_link (org_id, goal_id, {col}, added_by)
  select pulse.current_org(), current_setting('{k}')::uuid, {lit(ref)}, pulse.current_viewer()
   where not exists (select 1 from pulse.goal_link l where l.goal_id = current_setting('{k}')::uuid and l.{col} = {lit(ref)}) returning 1)
select set_config('rc.made_links', (current_setting('rc.made_links')::int + (select count(*) from ins))::text, true);
""")
        if g["fromTask"]:
            t = lit(g["fromTask"])
            note = lit(f"Became the goal “{g['title']}”"[:1000])
            out.append(f"""-- The task that is this goal: kept, linked, tagged '{TAG}' and moved to Cancelled with a note (its history stays).
select set_config('{k}.conv', case when exists (select 1 from pulse.task where id = {t} and not ({lit(TAG)} = any(tags))) then '1' else '' end, true);
select pulse.task_save({t}, jsonb_build_object('tags', to_jsonb(array(select distinct x from unnest((select tags from pulse.task where id = {t}) || array[{lit(TAG)}]) x))))
 where current_setting('{k}.conv') = '1';
select pulse.task_move({t}, 'cancelled', {note}) where current_setting('{k}.conv') = '1' and (select status from pulse.task where id = {t}) <> 'cancelled';
select set_config('rc.converted', (current_setting('rc.converted')::int + 1)::text, true) where current_setting('{k}.conv') = '1';
""")
        out.append(f"""select json_build_object('goal', {lit(g['title'])}, 'id', current_setting('{k}'), 'made', current_setting('{k}.new') = '1', 'status', {lit(g['status'])},
  'links', (select count(*) from pulse.goal_link where goal_id = current_setting('{k}')::uuid), 'fromTask', {lit(g['fromTask']) if g['fromTask'] else 'null'})::text;
""")
    for i, r in enumerate(m["relink"]):
        t, p = lit(r["task"]), lit(r["project"])
        out.append(f"""-- Relink: what the task's Project field does.
select set_config('rc.r{i}', case when (select project_id from pulse.task where id = {t}) is distinct from {p}::uuid then '1' else '' end, true);
select pulse.task_save({t}, jsonb_build_object('projectId', {p})) where current_setting('rc.r{i}') = '1';
select set_config('rc.relinked', (current_setting('rc.relinked')::int + 1)::text, true) where current_setting('rc.r{i}') = '1';
select json_build_object('relink', {t}, 'project', {p}, 'moved', current_setting('rc.r{i}') = '1')::text;
""")
    touched = arr(task_ids + project_ids)
    out.append(f"""reset role;
-- Nobody is told: notices these changes made about these tasks, projects or goals are taken back before commit.
select set_config('rc.quiet_ids', coalesce((select string_agg(id::text, ',') from pulse.notification where created_at >= now()
  and (subject_id = any({touched}) or subject_id = any(string_to_array(nullif(current_setting('rc.goal_ids'), ''), ',')::uuid[]))), ''), true);
delete from pulse.notification_delivery where notification_id = any(string_to_array(nullif(current_setting('rc.quiet_ids'), ''), ',')::uuid[]);
delete from pulse.native_push_delivery where notification_id = any(string_to_array(nullif(current_setting('rc.quiet_ids'), ''), ',')::uuid[]);
delete from pulse.web_push_delivery where notification_id = any(string_to_array(nullif(current_setting('rc.quiet_ids'), ''), ',')::uuid[]);
delete from pulse.hr_mail_outbox where notification_id = any(string_to_array(nullif(current_setting('rc.quiet_ids'), ''), ',')::uuid[]);
delete from pulse.notification where id = any(string_to_array(nullif(current_setting('rc.quiet_ids'), ''), ',')::uuid[]);
""")
    dexpr = (f"""{lit(json.dumps(detail, ensure_ascii=False))}::jsonb || jsonb_build_object('onBehalfOf', current_setting('rc.person'),
    'madeGoals', current_setting('rc.made_goals')::int, 'madeLinks', current_setting('rc.made_links')::int,
    'convertedTasks', current_setting('rc.converted')::int, 'relinkedTasks', current_setting('rc.relinked')::int,
    'projectKindsChanged', current_setting('rc.kinds')::int,
    'quietedNotices', coalesce(array_length(string_to_array(nullif(current_setting('rc.quiet_ids'), ''), ','), 1), 0),
    'applied', {'true' if apply else 'false'})""")
    out.append(f"""-- The ledger: the platform audit log, and (platform_log enters the organisation) the organisation's own Audit.
select set_config('pulse.org_id', '', true), set_config('pulse.viewer_id', '', true), set_config('pulse.actor_account', {lit(actor)}, true);
select pulse.platform_log('admin.reclassify', current_setting('rc.org')::uuid, 'reclassify', null, current_setting('rc.org_name'),
  {lit(words)}, {dexpr}) where {'true' if apply else 'false'};
select current_setting('rc.org') as rc_org, current_setting('rc.org_name') as rc_org_name, ({dexpr})::text as rc_detail \\gset
select json_build_object('org', current_setting('rc.org'), 'orgName', current_setting('rc.org_name'), 'admin', current_setting('rc.name'),
  'madeGoals', current_setting('rc.made_goals')::int, 'madeLinks', current_setting('rc.made_links')::int,
  'convertedTasks', current_setting('rc.converted')::int, 'relinkedTasks', current_setting('rc.relinked')::int,
  'projectKindsChanged', current_setting('rc.kinds')::int,
  'quietedNotices', coalesce(array_length(string_to_array(nullif(current_setting('rc.quiet_ids'), ''), ','), 1), 0),
  'ledger', (select id::text from pulse_priv.platform_audit where action = 'admin.reclassify' and target_org = current_setting('rc.org')::uuid
              and {'true' if apply else 'false'} order by at desc limit 1),
  'applied', {'true' if apply else 'false'})::text;
{'commit' if apply else 'rollback'};
""")
    if not apply:
        out.append(f"""-- The dry run is in the ledger too (its own committed row, admin.reclassify_dry_run: what --apply would change).
begin;
select set_config('pulse.actor_account', {lit(actor)}, true);
select pulse.platform_log('admin.reclassify_dry_run', :'rc_org'::uuid, 'reclassify', null, :'rc_org_name', {lit(words)}, :'rc_detail'::jsonb);
select json_build_object('dryRunLedger', (select id::text from pulse_priv.platform_audit where action = 'admin.reclassify_dry_run'
  and target_org = :'rc_org'::uuid order by at desc limit 1))::text;
commit;
""")
    return "".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--manifest", required=True, type=Path, help="the JSON manifest")
    ap.add_argument("--approver", required=True, help='who approved this, e.g. "Owner Name (owner)"')
    ap.add_argument("--words", required=True, help="the approver's words, verbatim (they go in the audit log)")
    ap.add_argument("--apply", action="store_true", help="commit (without it: do everything, then roll back)")
    ap.add_argument("--exec", default="docker exec -i ea-postgres", help='how to reach psql ("" for a local psql)')
    ap.add_argument("--db-user", default="ea_admin", help='("" when --database is a connection string)')
    ap.add_argument("--database", default="pulse")
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
    except Refused as e:
        print(f"Refused: {e}", file=sys.stderr)
        return 2
    digest = hashlib.sha256(args.manifest.read_bytes()).hexdigest()
    actor = f"reclassify-work.py · approver: {approver}"[:120]
    detail = {"tool": SCRIPT, "host": host, "approver": approver[:120], "words": words[:380], "onBehalfOfHandle": m["as"],
              "manifestSha256": digest, "goals": [g["title"] for g in m["goals"]],
              "fromTasks": [g["fromTask"] for g in m["goals"] if g["fromTask"]], "relink": len(m["relink"]),
              "projectKinds": m["projectKinds"]}
    script = build_script(m, actor, words[:380], detail, args.apply)
    proc = subprocess.run(psql_argv(args.exec, args.db_user, args.database), input=script.encode("utf-8"),
                          capture_output=True, check=False)
    out, err = proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")
    if proc.returncode != 0:
        msg = (re.findall(r"ERROR:\s*(.*)", err) or [err.strip()[-400:]])[-1]
        if "RECLASSIFY_REFUSED" in msg or "denied" in msg or "42501" in err or "Only " in msg:
            print(f"Refused (nothing was written): {msg.replace('RECLASSIFY_REFUSED: ', '')}", file=sys.stderr)
            return 2
        print(f"The database failed; nothing was written: {msg}", file=sys.stderr)
        return 1
    rows = [json.loads(x) for x in out.splitlines() if x.startswith("{")]
    dry_ledger = rows.pop()["dryRunLedger"] if rows and "dryRunLedger" in rows[-1] else None
    for r in rows[:-1]:
        print(json.dumps(r, ensure_ascii=False))
    s = rows[-1]
    print(json.dumps(s, ensure_ascii=False))
    what = "Changed" if args.apply else "Dry run (rolled back), would change"
    ledger = f" Ledger row {s['ledger']} (admin.reclassify)." if args.apply else f" Dry run ledger row {dry_ledger}. Run again with --apply."
    print(f"{what} {s['orgName']} as {s['admin']} (@{m['as']}), approved by {approver}: {s['madeGoals']} goals made, {s['madeLinks']} links, "
          f"{s['convertedTasks']} tasks became goals, {s['relinkedTasks']} tasks relinked, {s['projectKindsChanged']} project kinds; "
          f"{s['quietedNotices']} notices taken back.{ledger}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
