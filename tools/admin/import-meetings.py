#!/usr/bin/env python3
"""Projects, tasks and their files put into one organisation at the Pulse server's terminal (MEETINGS-INTO-PULSE, owner,
6 Nov 2026): "There is data that needs to be stored." Meeting transcripts, recordings and the tasks agreed in them.

    python3 tools/admin/import-meetings.py --manifest meetings.json --approver "Owner Name (owner)" --words "..." [--apply]

The manifest (JSON) names the organisation, the admin to act for, and what to add:

    {"org": "<handle>", "as": "<@handle>",
     "projects": [{"title": "Meetings"}, {"title": "Partner", "visibility": "leadership"}],
     "tasks": [{"project": "Meetings", "title": "...", "notes": "...", "dueOn": "2026-11-05", "priority": "high",
                "leadershipOnly": false,
                "attachments": [{"file": "transcript.txt", "mime": "text/plain", "label": "Transcript"},
                                {"url": "https://...", "label": "Link"}]}]}

  * Every write goes through the functions the API calls for the same screens: pulse.company_create_project (Work →
    Projects → New), pulse.project_visibility_set, pulse.task_save (New task), pulse.task_leadership_only_set and
    pulse.task_attachment_add (a task's files), as that admin, in that organisation, as pulse_api. The functions still
    check the person may do each step. No sign-in is made: no session, no token, nothing in the sign-in tables.
  * Tasks are given to nobody else: with no assignee, task_save makes the admin the assignee, so nobody is told.
  * WA-ROUTE (owner, 6 Nov 2026: "send those details in respective people's vitals"): a task may name
    "assignee": "@handle", a staff seat in the same organisation; task_save gives it to them (its own checks apply). The
    notices that would tell them ("A task was assigned to you", in the app, by push, Telegram or e-mail) are taken back in
    the same transaction before anything is committed, so nobody is told; they find the task when they next sign in.
    The run refuses to commit if any notice for someone other than the admin is still there.
  * WA-ROUTE: "bugs": [{"title": "...", "words": "steps and screen", "route": "/login", "kind": "bug", "severity": "high"}]
    go on the organisation's bug and feature board (pulse.reported_bug, as POST /api/v0/bug-reports stores one), reported
    by the admin; found again by their title, so a rerun adds nothing.
  * It can run again: a project is found by its title, a task by its title in its project; what is there is kept.
  * One transaction: a dry run (the default) does all of it and rolls back, so it shows exactly what --apply would do.
    With --apply it commits, and in the same transaction writes the platform audit log (pulse_priv.platform_audit) and,
    through platform_log, the organisation's own Audit: who approved, their words verbatim, which admin, what was added.
  * A file goes in as the API takes it (up to 5 MB, the types a task's files take); a bigger one is refused here.
  * It runs only on the Pulse server (PULSE_ADMIN_TOOL_HOSTS, default host-49a12d.internal.example) with the database's admin role there
    (docker exec into ea-postgres, as tools/runner/pair-code.py). There is no web route for it.

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

APP = "pulse-import-meetings"
SCRIPT = "tools/admin/import-meetings.py"
HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,62}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DEFAULT_HOSTS = "host-49a12d.internal.example"
MAX_FILE = 5_250_000            # services/api/src/tasks.ts: base64 up to 7,000,000 characters
PRIORITIES = {"low", "normal", "high", "urgent"}
VISIBILITY = {"org", "members", "leadership"}
BUG_KINDS = {"bug", "feature", "tool_needed"}
SEVERITIES = {"blocker", "high", "medium", "low"}


class Refused(Exception):
    pass


def lit(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def title_of(text: object) -> str:
    """As task_save stores it: whitespace runs made one space, trimmed."""
    return re.sub(r"\s+", " ", str(text or "")).strip()


def psql_argv(runner: str, user: str, database: str) -> list[str]:
    argv = shlex.split(runner)
    if argv[:2] == ["docker", "exec"]:
        argv[2:2] = ["-e", f"PGAPPNAME={APP}"]
    conn = ["-U", user, "-d", database] if user else ["-d", database]
    return [*argv, "psql", *conn, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"]


def load_manifest(path: Path) -> dict:
    """Reads and checks the manifest; files are read here (relative to the manifest) and carried as base64."""
    try:
        m = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise Refused(f"the manifest cannot be read: {e}") from e
    org, as_handle = str(m.get("org", "")).strip().lower(), str(m.get("as", "")).strip().lstrip("@").lower()
    if not HANDLE_RE.match(org) or not HANDLE_RE.match(as_handle):
        raise Refused('the manifest needs "org" and "as" (handles)')
    projects = []
    for p in m.get("projects", []):
        t = title_of(p.get("title"))
        if not t or len(t) > 160:
            raise Refused("a project needs a title of up to 160 characters")
        vis = p.get("visibility")
        if vis is not None and vis not in VISIBILITY:
            raise Refused(f"project {t}: visibility is one of {', '.join(sorted(VISIBILITY))}")
        projects.append({"title": t, "visibility": vis})
    known = {p["title"].lower() for p in projects}
    tasks = []
    for i, t in enumerate(m.get("tasks", [])):
        title = title_of(t.get("title"))
        if not title or len(title) > 300:
            raise Refused(f"task {i + 1}: a title of up to 300 characters")
        project = title_of(t.get("project"))
        if project.lower() not in known:
            raise Refused(f"task {title}: its project {project!r} is not in the manifest's projects")
        fields: dict[str, object] = {"title": title}
        if t.get("notes"):
            if len(str(t["notes"])) > 20000:
                raise Refused(f"task {title}: notes up to 20,000 characters")
            fields["notes"] = str(t["notes"])
        if t.get("dueOn"):
            if not DATE_RE.match(str(t["dueOn"])):
                raise Refused(f"task {title}: dueOn is a date (YYYY-MM-DD)")
            fields["dueOn"] = str(t["dueOn"])
        if t.get("priority"):
            if t["priority"] not in PRIORITIES:
                raise Refused(f"task {title}: priority is one of {', '.join(sorted(PRIORITIES))}")
            fields["priority"] = t["priority"]
        if "assigneeId" in t or "ownerId" in t or "pool" in t:
            raise Refused(f"task {title}: name a person as \"assignee\": \"@handle\" (no ids, no pool)")
        assignee = None
        if t.get("assignee"):
            assignee = str(t["assignee"]).strip().lstrip("@").lower()
            if not HANDLE_RE.match(assignee):
                raise Refused(f"task {title}: assignee is a handle (@name)")
        files = []
        for a in t.get("attachments", []):
            label = str(a.get("label", "")).strip()[:200]
            if a.get("file"):
                f = (path.parent / a["file"]).resolve()
                try:
                    data = f.read_bytes()
                except OSError as e:
                    raise Refused(f"task {title}: cannot read {a['file']}: {e}") from e
                if not data or len(data) > MAX_FILE:
                    raise Refused(f"task {title}: {f.name} must be 1 byte to 5 MB (it is {len(data)} bytes)")
                files.append({"label": label or f.name, "name": str(a.get("name") or f.name)[:200],
                              "mime": str(a.get("mime", "")).lower(), "b64": base64.b64encode(data).decode(),
                              "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)})
            elif a.get("url"):
                files.append({"label": label, "url": str(a["url"])})
            else:
                raise Refused(f"task {title}: an attachment is a file or a url")
        if len(files) > 20:
            raise Refused(f"task {title}: a task keeps up to 20 attachments")
        tasks.append({"project": project, "fields": fields, "leadershipOnly": bool(t.get("leadershipOnly")), "files": files,
                      "assignee": assignee})
    bugs = []
    for i, b in enumerate(m.get("bugs", [])):
        title = title_of(b.get("title"))
        words = str(b.get("words") or "").strip()
        route = str(b.get("route") or "/").strip()
        if not title or len(title) > 200 or not words or len(words) > 4000:
            raise Refused(f"bug {i + 1}: a title (up to 200 characters) and words (up to 4,000)")
        if not route.startswith("/") or len(route) > 512:
            raise Refused(f"bug {title}: route is a path such as /login")
        kind = b.get("kind") or "bug"
        if kind not in BUG_KINDS:
            raise Refused(f"bug {title}: kind is one of {', '.join(sorted(BUG_KINDS))}")
        sev = b.get("severity")
        if sev is not None and sev not in SEVERITIES:
            raise Refused(f"bug {title}: severity is one of {', '.join(sorted(SEVERITIES))}")
        key = hashlib.sha256(title.lower().encode("utf-8")).hexdigest()
        bugs.append({"title": title, "words": words, "route": route, "kind": kind, "severity": sev,
                     "command": "import-" + key[:32], "fingerprint": hashlib.sha256(f"{route}\n{title}".encode("utf-8")).hexdigest()})
    if not projects and not tasks and not bugs:
        raise Refused("the manifest adds nothing")
    return {"org": org, "as": as_handle, "projects": projects, "tasks": tasks, "bugs": bugs}


def build_script(m: dict, actor: str, approver: str, words: str, host: str, digest: str, apply: bool) -> str:
    """One transaction: the admin's seat; then, as that admin in that organisation as pulse_api, each project and task
    through the API's functions; then the ledger as the operator. Commit only with --apply."""
    org, handle = m["org"], m["as"]
    akey: dict[str, str] = {}
    assignee_sql = ""
    for i, a in enumerate(sorted({t["assignee"] for t in m["tasks"] if t["assignee"]})):
        k = akey[a] = f"imp.a{i}"
        assignee_sql += f"""-- The person a task is for: a staff seat in this organisation, by their account's handle.
select set_config('{k}', coalesce((select p.id::text from pulse_priv.account_member m join pulse_priv.pulse_account a on a.id = m.account_id
  join pulse.person p on p.id = m.person_id and p.org_id = m.member_org
 where m.member_org = current_setting('imp.org')::uuid and a.handle = {lit(a)} and p.status = 'active' and p.side = 'staff' limit 1), ''), true),
       set_config('imp.assignees', concat_ws(',', nullif(current_setting('imp.assignees'), ''), nullif((select p.id::text from pulse_priv.account_member m
  join pulse_priv.pulse_account a on a.id = m.account_id join pulse.person p on p.id = m.person_id and p.org_id = m.member_org
 where m.member_org = current_setting('imp.org')::uuid and a.handle = {lit(a)} and p.status = 'active' and p.side = 'staff' limit 1), current_setting('imp.person'))), true);
do $c$ begin
  if current_setting('{k}') = '' then
    raise exception 'IMPORT_REFUSED: @{a} has no active staff seat in {org}' using errcode = '42501';
  end if;
end $c$;
"""
    out = [f"""\\set ON_ERROR_STOP on
set client_encoding = 'UTF8';
begin;
set local lock_timeout = '15s';
set local statement_timeout = '120s';
select set_config('imp.org', o.id::text, true), set_config('imp.person', m.person_id::text, true),
       set_config('imp.name', p.display_name, true), set_config('imp.org_name', o.name, true)
  from pulse.org o
  join pulse_priv.account_member m on m.member_org = o.id
  join pulse_priv.pulse_account a on a.id = m.account_id
  join pulse.person p on p.id = m.person_id and p.org_id = o.id
 where o.handle = {lit(org)} and o.status = 'active' and a.handle = {lit(handle)} and p.status = 'active' and p.side = 'staff'
 limit 1;
do $c$ begin
  if coalesce(current_setting('imp.org', true), '') = '' then
    raise exception 'IMPORT_REFUSED: no active organisation {org} with a staff seat for @{handle}' using errcode = '42501';
  end if;
end $c$;
select set_config('imp.made_projects', '0', true), set_config('imp.made_tasks', '0', true), set_config('imp.made_files', '0', true),
       set_config('imp.made_bugs', '0', true), set_config('imp.new_tasks', '', true), set_config('imp.assignees', '', true);
{assignee_sql}select set_config('pulse.org_id', current_setting('imp.org'), true), set_config('pulse.viewer_id', current_setting('imp.person'), true),
       set_config('pulse.actor_account', {lit(actor)}, true), set_config('pulse.agent_session', '', true);
set local role pulse_api;
"""]
    pkey = {}
    for i, p in enumerate(m["projects"]):
        k = f"imp.p{i}"
        pkey[p["title"].lower()] = k
        t = lit(p["title"])
        out.append(f"""-- Project: what Work → Projects → New does.
select set_config('{k}', coalesce((select id::text from pulse.project where org_id = pulse.current_org() and deleted_at is null
  and lower(coalesce(title, name)) = lower({t}) order by registry_no limit 1), ''), true), set_config('{k}.new', '', true);
select set_config('{k}', pulse.company_create_project({t}, null, null, null)::text, true), set_config('{k}.new', '1', true),
       set_config('imp.made_projects', (current_setting('imp.made_projects')::int + 1)::text, true)
 where current_setting('{k}') = '';
""")
        if p["visibility"]:
            out.append(f"select pulse.project_visibility_set(current_setting('{k}')::uuid, {lit(p['visibility'])});\n")
        out.append(f"""select json_build_object('project', {t}, 'id', current_setting('{k}'), 'made', current_setting('{k}.new') = '1',
  'visibility', (select visibility from pulse.project where id = current_setting('{k}')::uuid))::text;
""")
    for i, t in enumerate(m["tasks"]):
        k, pk = f"imp.t{i}", pkey[t["project"].lower()]
        title = lit(t["fields"]["title"])
        who = (f" || jsonb_build_object('assigneeId', current_setting('{akey[t['assignee']]}'))" if t["assignee"] else "")
        out.append(f"""-- Task: what New task does (with no assignee: the admin it acts for).
select set_config('{k}', coalesce((select id::text from pulse.task where org_id = pulse.current_org() and deleted_at is null
  and project_id = current_setting('{pk}')::uuid and title = {title} order by created_at limit 1), ''), true), set_config('{k}.new', '', true);
select set_config('{k}', pulse.task_save(null, {lit(json.dumps(t['fields'], ensure_ascii=False))}::jsonb
         || jsonb_build_object('projectId', current_setting('{pk}')){who})::text, true), set_config('{k}.new', '1', true),
       set_config('imp.made_tasks', (current_setting('imp.made_tasks')::int + 1)::text, true)
 where current_setting('{k}') = '';
select set_config('imp.new_tasks', concat_ws(',', nullif(current_setting('imp.new_tasks'), ''), current_setting('{k}')), true)
 where current_setting('{k}.new') = '1';
""")
        if t["leadershipOnly"]:
            out.append(f"select pulse.task_leadership_only_set(current_setting('{k}')::uuid, true) where current_setting('{k}.new') = '1';\n")
        for f in t["files"]:
            if "b64" in f:
                call = (f"pulse.task_attachment_add(current_setting('{k}')::uuid, {lit(f['label'])}, null, "
                        f"decode({lit(f['b64'])}, 'base64'), {lit(f['name'])}, {lit(f['mime'])})")
            else:
                call = f"pulse.task_attachment_add(current_setting('{k}')::uuid, {lit(f['label'])}, {lit(f['url'])})"
            out.append(f"select {call}, set_config('imp.made_files', (current_setting('imp.made_files')::int + 1)::text, true)"
                       f" where current_setting('{k}.new') = '1';\n")
        out.append(f"""select json_build_object('task', {title}, 'id', current_setting('{k}'), 'made', current_setting('{k}.new') = '1',
  'files', case when current_setting('{k}.new') = '1' then {len(t['files'])} else 0 end,
  'assignee', (select display_name from pulse.person where id = (select assignee_person_id from pulse.task where id = current_setting('{k}')::uuid)))::text;
""")
    for i, b in enumerate(m["bugs"]):
        k = f"imp.b{i}"
        out.append(f"""-- Bug board: what POST /api/v0/bug-reports stores (reported by the admin; found again by its title's key).
select set_config('{k}', coalesce((select id::text from pulse.reported_bug where org_id = pulse.current_org()
  and person_id = current_setting('imp.person')::uuid and command_id = {lit(b['command'])}), ''), true), set_config('{k}.new', '', true);
select pg_advisory_xact_lock(hashtext('pulse.reported_bug:' || pulse.current_org()::text)) where current_setting('{k}') = '';
with ins as (
  insert into pulse.reported_bug (org_id, number, person_id, command_id, words, route, fingerprint, platform, kind, title, severity, context)
  select pulse.current_org(), x.n, current_setting('imp.person')::uuid, {lit(b['command'])}, {lit(b['words'])}, {lit(b['route'])},
         {lit(b['fingerprint'])}, 'web', {lit(b['kind'])}, {lit(b['title'])}, {lit(b['severity']) if b['severity'] else 'null'},
         jsonb_build_object('source', 'import', 'tool', {lit(SCRIPT)})
    from (select coalesce(max(number), 0) + 1 n from pulse.reported_bug) x
   where current_setting('{k}') = ''
  returning id)
select set_config('{k}', id::text, true), set_config('{k}.new', '1', true),
       set_config('imp.made_bugs', (current_setting('imp.made_bugs')::int + 1)::text, true) from ins;
select json_build_object('bug', {lit(b['title'])}, 'id', current_setting('{k}'), 'made', current_setting('{k}.new') = '1',
  'number', (select number from pulse.reported_bug where id = current_setting('{k}')::uuid))::text;
""")
    out.append("""reset role;
-- WA-ROUTE: nobody is told. The notices the new tasks made for anyone (task.assigned and the like: in the app, push,
-- Telegram, e-mail) are taken back before commit, with what would have carried them; nothing has left the database yet.
select set_config('imp.quiet_ids', coalesce((select string_agg(id::text, ',') from pulse.notification where subject_type = 'task'
  and subject_id = any(string_to_array(nullif(current_setting('imp.new_tasks'), ''), ',')::uuid[])), ''), true);
delete from pulse.notification_delivery where notification_id = any(string_to_array(nullif(current_setting('imp.quiet_ids'), ''), ',')::uuid[]);
delete from pulse.native_push_delivery where notification_id = any(string_to_array(nullif(current_setting('imp.quiet_ids'), ''), ',')::uuid[]);
delete from pulse.web_push_delivery where notification_id = any(string_to_array(nullif(current_setting('imp.quiet_ids'), ''), ',')::uuid[]);
delete from pulse.hr_mail_outbox where notification_id = any(string_to_array(nullif(current_setting('imp.quiet_ids'), ''), ',')::uuid[]);
delete from pulse.notification where id = any(string_to_array(nullif(current_setting('imp.quiet_ids'), ''), ',')::uuid[]);
do $q$ begin
  if exists(select 1 from pulse.notification where created_at >= now()
     and person_id = any(string_to_array(nullif(current_setting('imp.assignees'), ''), ',')::uuid[])) then
    raise exception 'IMPORT_REFUSED: a notice to a person given a task is still there; nothing was written' using errcode = '42501';
  end if;
end $q$;
""")
    detail = {"tool": SCRIPT, "host": host, "approver": approver, "words": words, "onBehalfOfHandle": handle,
              "assignees": sorted({t["assignee"] for t in m["tasks"] if t["assignee"]}), "bugs": [b["title"] for b in m["bugs"]],
              "manifestSha256": digest, "projects": [p["title"] for p in m["projects"]], "tasks": len(m["tasks"]),
              "files": [{"name": f["name"], "sha256": f["sha256"], "size": f["size"]} for t in m["tasks"] for f in t["files"] if "b64" in f]}
    dexpr = (f"""{lit(json.dumps(detail, ensure_ascii=False))}::jsonb || jsonb_build_object('onBehalfOf', current_setting('imp.person'),
    'madeProjects', current_setting('imp.made_projects')::int, 'madeTasks', current_setting('imp.made_tasks')::int,
    'madeFiles', current_setting('imp.made_files')::int, 'madeBugs', current_setting('imp.made_bugs')::int,
    'quietedNotices', coalesce(array_length(string_to_array(nullif(current_setting('imp.quiet_ids'), ''), ','), 1), 0),
    'applied', {'true' if apply else 'false'})""")
    out.append(f"""reset role;
-- The ledger: the platform audit log, and (platform_log enters the organisation) the organisation's own Audit.
select set_config('pulse.org_id', '', true), set_config('pulse.viewer_id', '', true), set_config('pulse.actor_account', {lit(actor)}, true);
select pulse.platform_log('admin.import', current_setting('imp.org')::uuid, 'import', null, current_setting('imp.org_name'),
  {lit(words)}, {dexpr}) where {'true' if apply else 'false'};
select current_setting('imp.org') as imp_org, current_setting('imp.org_name') as imp_org_name, ({dexpr})::text as imp_detail \\gset
select json_build_object('org', current_setting('imp.org'), 'orgName', current_setting('imp.org_name'), 'admin', current_setting('imp.name'),
  'madeProjects', current_setting('imp.made_projects')::int, 'madeTasks', current_setting('imp.made_tasks')::int,
  'madeFiles', current_setting('imp.made_files')::int, 'madeBugs', current_setting('imp.made_bugs')::int,
  'quietedNotices', coalesce(array_length(string_to_array(nullif(current_setting('imp.quiet_ids'), ''), ','), 1), 0),
  'applied', {'true' if apply else 'false'})::text;
{'commit' if apply else 'rollback'};
""")
    if not apply:
        out.append(f"""-- WA-ROUTE: the dry run is in the ledger too (its own committed row, admin.import_dry_run: what --apply would add).
begin;
select set_config('pulse.actor_account', {lit(actor)}, true);
select pulse.platform_log('admin.import_dry_run', :'imp_org'::uuid, 'import', null, :'imp_org_name', {lit(words)}, :'imp_detail'::jsonb);
commit;
""")
    return "".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--manifest", required=True, type=Path, help="the JSON manifest (files are relative to it)")
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
    actor = f"import-meetings.py · approver: {approver}"[:120]
    script = build_script(m, actor, approver[:120], words[:380], host, digest, args.apply)
    proc = subprocess.run(psql_argv(args.exec, args.db_user, args.database), input=script.encode("utf-8"),
                          capture_output=True, check=False)
    out, err = proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")
    if proc.returncode != 0:
        msg = (re.findall(r"ERROR:\s*(.*)", err) or [err.strip()[-400:]])[-1]
        if "IMPORT_REFUSED" in msg or "denied" in msg or "42501" in err or "Only " in msg:
            print(f"Refused (nothing was written): {msg.replace('IMPORT_REFUSED: ', '')}", file=sys.stderr)
            return 2
        print(f"The database failed; nothing was written: {msg}", file=sys.stderr)
        return 1
    rows = [json.loads(x) for x in out.splitlines() if x.startswith("{")]
    for r in rows[:-1]:
        print(json.dumps(r, ensure_ascii=False))
    s = rows[-1]
    what = "Added" if args.apply else "Dry run (rolled back), would add"
    print(f"{what} to {s['orgName']} as {s['admin']} (@{m['as']}), approved by {approver}: {s['madeProjects']} projects, "
          f"{s['madeTasks']} tasks, {s['madeFiles']} files, {s['madeBugs']} bugs; {s['quietedNotices']} notices taken back." + (" Written to the platform audit log and the organisation's Audit."
                                                                    if args.apply else " Run again with --apply."), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
