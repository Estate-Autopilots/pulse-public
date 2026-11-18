#!/usr/bin/env python3
"""Every Pulse account gets its own private workspace, at the Pulse server's terminal (PERSONAL-WORKSPACE, owner,
6 Nov 2026): "EVERY person has their own personal workspace ... separate from the companies they work in."

    python3 tools/admin/personal-workspaces.py --approver "Owner Name (owner)" --words "..." \\
        [--adopt suyashhq:savuzo] [--only <account-handle>] [--apply]

  * New accounts get theirs when they are made (migration 1640's trigger). This tool backfills the accounts made before:
    for each account it calls pulse.personal_workspace_ensure(account), which makes a private workspace (org kind
    'personal') owned by that account, with only that person in it, and returns the existing one when there is one, so
    a rerun makes nothing new.
  * --adopt <org handle or slug>:<account handle> marks an organisation the person already uses as their own workspace
    instead of making a new one (Savuzo HQ for @savuzo), through pulse.personal_workspace_adopt(org, account): the org
    becomes kind 'personal' and its projects personal projects. Adopting runs before the backfill, so that account gets
    no second workspace.
  * Nobody is told: any notice made inside the new or adopted workspaces is taken back before commit; nothing is sent.
  * One transaction: a dry run (the default) does all of it and rolls back, and is written to the ledger as its own
    committed row (admin.personal_workspaces_dry_run). With --apply it commits and writes the platform audit log
    (admin.personal_workspaces; an adopted organisation also gets the row in its own Audit).
  * Refused when the database does not have migration 1640 yet (the functions are missing), on any other host, and
    without the approver's words. There is no web route for it.

Exit codes: 0 done (or the dry run worked); 2 refused; 1 the database failed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import socket
import subprocess
import sys

APP = "pulse-personal-workspaces"
SCRIPT = "tools/admin/personal-workspaces.py"
HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,62}$")
DEFAULT_HOSTS = "host-49a12d.internal.example"


def lit(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def psql_argv(runner: str, user: str, database: str) -> list[str]:
    argv = shlex.split(runner)
    if argv[:2] == ["docker", "exec"]:
        argv[2:2] = ["-e", f"PGAPPNAME={APP}"]
    conn = ["-U", user, "-d", database] if user else ["-d", database]
    return [*argv, "psql", *conn, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"]


def build_script(adopt: list[tuple[str, str]], only: list[str], actor: str, words: str, detail: dict, apply: bool) -> str:
    out = [f"""\\set ON_ERROR_STOP on
set client_encoding = 'UTF8';
begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';
do $c$ begin
  if to_regprocedure('pulse.personal_workspace_ensure(uuid)') is null or to_regprocedure('pulse.personal_workspace_adopt(uuid,uuid)') is null then
    raise exception 'PW_REFUSED: this database does not have migration 1640 (personal workspaces) yet' using errcode = '42501';
  end if;
end $c$;
select set_config('pulse.actor_account', {lit(actor)}, true);
create temp table pw_done (handle text, account uuid, org uuid, how text) on commit drop;
select set_config('pw.before', (select count(*) from pulse.org where kind = 'personal')::text, true);
"""]
    for i, (org, handle) in enumerate(adopt):
        out.append(f"""-- Adopt: an organisation the person already uses becomes their own workspace.
select set_config('pw.o{i}', coalesce((select id::text from pulse.org where (handle = {lit(org)} or slug = {lit(org)}) and status = 'active' limit 1), ''), true),
       set_config('pw.a{i}', coalesce((select id::text from pulse_priv.pulse_account where handle = {lit(handle)}), ''), true);
do $c$ begin
  if current_setting('pw.o{i}') = '' or current_setting('pw.a{i}') = '' then
    raise exception 'PW_REFUSED: no active organisation {org} or no account @{handle}' using errcode = '42501';
  end if;
  if not exists (select 1 from pulse_priv.account_member m where m.member_org = current_setting('pw.o{i}')::uuid and m.account_id = current_setting('pw.a{i}')::uuid) then
    raise exception 'PW_REFUSED: @{handle} has no seat in {org}' using errcode = '42501';
  end if;
end $c$;
select set_config('pw.o{i}.kinds', coalesce((select jsonb_object_agg(kind, n)::text from (select kind, count(*) n from pulse.work_project
  where org_id = current_setting('pw.o{i}')::uuid group by kind) k), '{{}}'), true);
select pulse.personal_workspace_adopt(current_setting('pw.o{i}')::uuid, current_setting('pw.a{i}')::uuid);
insert into pw_done values ({lit(handle)}, current_setting('pw.a{i}')::uuid, current_setting('pw.o{i}')::uuid, 'adopted');
select json_build_object('adopted', {lit(org)}, 'account', {lit(handle)}, 'org', current_setting('pw.o{i}'),
  'kind', (select kind from pulse.org where id = current_setting('pw.o{i}')::uuid),
  'projectKindsBefore', current_setting('pw.o{i}.kinds')::jsonb,
  'projectKindsAfter', coalesce((select jsonb_object_agg(kind, n) from (select kind, count(*) n from pulse.work_project
     where org_id = current_setting('pw.o{i}')::uuid group by kind) k), '{{}}'::jsonb))::text;
""")
    flt = f"where a.handle = any(array[{','.join(lit(h) for h in only)}]::text[])" if only else ""
    out.append(f"""-- Everyone else: their own workspace, made once (the function returns the one there is).
insert into pw_done select a.handle, a.id, pulse.personal_workspace_ensure(a.id), 'ensured'
  from (select * from pulse_priv.pulse_account a {flt} order by a.created_at, a.id) a
 where not exists (select 1 from pw_done d where d.account = a.id);
-- Nobody is told: notices made inside these workspaces in this transaction are taken back.
select set_config('pw.quiet_ids', coalesce((select string_agg(id::text, ',') from pulse.notification where created_at >= now()
  and org_id in (select org from pw_done)), ''), true);
delete from pulse.notification_delivery where notification_id = any(string_to_array(nullif(current_setting('pw.quiet_ids'), ''), ',')::uuid[]);
delete from pulse.native_push_delivery where notification_id = any(string_to_array(nullif(current_setting('pw.quiet_ids'), ''), ',')::uuid[]);
delete from pulse.web_push_delivery where notification_id = any(string_to_array(nullif(current_setting('pw.quiet_ids'), ''), ',')::uuid[]);
delete from pulse.hr_mail_outbox where notification_id = any(string_to_array(nullif(current_setting('pw.quiet_ids'), ''), ',')::uuid[]);
delete from pulse.notification where id = any(string_to_array(nullif(current_setting('pw.quiet_ids'), ''), ',')::uuid[]);
do $c$ begin
  if exists (select 1 from pw_done d join pulse.org o on o.id = d.org where o.kind <> 'personal') then
    raise exception 'PW_REFUSED: a workspace is not personal after the run; nothing was written' using errcode = '42501';
  end if;
  if exists (select 1 from pw_done d where not exists (select 1 from pulse_priv.account_member m where m.account_id = d.account and m.member_org = d.org)) then
    raise exception 'PW_REFUSED: an account has no seat in its own workspace; nothing was written' using errcode = '42501';
  end if;
end $c$;
select set_config('pw.made', ((select count(*) from pulse.org where kind = 'personal') - current_setting('pw.before')::int
  - (select count(*) from pw_done where how = 'adopted'))::text, true);
""")
    dexpr = (f"""{lit(json.dumps(detail, ensure_ascii=False))}::jsonb || jsonb_build_object(
    'accounts', (select count(*) from pw_done), 'made', current_setting('pw.made')::int,
    'adopted', (select coalesce(jsonb_agg(jsonb_build_object('account', handle, 'org', org)), '[]') from pw_done where how = 'adopted'),
    'workspaces', (select coalesce(jsonb_object_agg(handle, org), '{{}}') from pw_done),
    'quietedNotices', coalesce(array_length(string_to_array(nullif(current_setting('pw.quiet_ids'), ''), ','), 1), 0),
    'applied', {'true' if apply else 'false'})""")
    out.append(f"""select set_config('pulse.org_id', '', true), set_config('pulse.viewer_id', '', true), set_config('pulse.actor_account', {lit(actor)}, true);
select pulse.platform_log('admin.personal_workspaces', (select org from pw_done where how = 'adopted' limit 1), 'org', null, 'Personal workspaces',
  {lit(words)}, {dexpr}) where {'true' if apply else 'false'};
select ({dexpr})::text as pw_detail \\gset
select json_build_object('accounts', (select count(*) from pw_done), 'made', current_setting('pw.made')::int,
  'adopted', (select count(*) from pw_done where how = 'adopted'),
  'personalAfter', (select count(*) from pulse.org where kind = 'personal'),
  'quietedNotices', coalesce(array_length(string_to_array(nullif(current_setting('pw.quiet_ids'), ''), ','), 1), 0),
  'ledger', (select id::text from pulse_priv.platform_audit where action = 'admin.personal_workspaces' and {'true' if apply else 'false'} order by at desc limit 1),
  'applied', {'true' if apply else 'false'})::text;
{'commit' if apply else 'rollback'};
""")
    if not apply:
        out.append(f"""begin;
select set_config('pulse.actor_account', {lit(actor)}, true);
select pulse.platform_log('admin.personal_workspaces_dry_run', null, 'org', null, 'Personal workspaces', {lit(words)}, :'pw_detail'::jsonb);
select json_build_object('dryRunLedger', (select id::text from pulse_priv.platform_audit where action = 'admin.personal_workspaces_dry_run' order by at desc limit 1))::text;
commit;
""")
    return "".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--approver", required=True, help='who approved this, e.g. "Owner Name (owner)"')
    ap.add_argument("--words", required=True, help="the approver's words, verbatim (they go in the audit log)")
    ap.add_argument("--adopt", action="append", default=[], help="<org handle or slug>:<account handle>, an organisation that becomes that person's workspace")
    ap.add_argument("--only", action="append", default=[], help="only these account handles (default: every account)")
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
    adopt = []
    for a in args.adopt:
        org, _, handle = a.partition(":")
        org, handle = org.strip().lower(), handle.strip().lstrip("@").lower()
        if not HANDLE_RE.match(org) or not HANDLE_RE.match(handle):
            print(f"Refused: --adopt is <org handle or slug>:<account handle>, not {a!r}", file=sys.stderr)
            return 2
        adopt.append((org, handle))
    only = [h.strip().lstrip("@").lower() for h in args.only]
    if any(not HANDLE_RE.match(h) for h in only):
        print("Refused: --only takes account handles", file=sys.stderr)
        return 2
    actor = f"personal-workspaces.py · approver: {approver}"[:120]
    detail = {"tool": SCRIPT, "host": host, "approver": approver[:120], "words": words[:380], "adopt": [f"{o}:{h}" for o, h in adopt], "only": only}
    script = build_script(adopt, only, actor, words[:380], detail, args.apply)
    proc = subprocess.run(psql_argv(args.exec, args.db_user, args.database), input=script.encode("utf-8"), capture_output=True, check=False)
    out, err = proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")
    if proc.returncode != 0:
        msg = (re.findall(r"ERROR:\s*(.*)", err) or [err.strip()[-400:]])[-1]
        if "PW_REFUSED" in msg or "denied" in msg or "42501" in err:
            print(f"Refused (nothing was written): {msg.replace('PW_REFUSED: ', '')}", file=sys.stderr)
            return 2
        print(f"The database failed; nothing was written: {msg}", file=sys.stderr)
        return 1
    rows = [json.loads(x) for x in out.splitlines() if x.startswith("{")]
    dry_ledger = rows.pop()["dryRunLedger"] if rows and "dryRunLedger" in rows[-1] else None
    for r in rows:
        print(json.dumps(r, ensure_ascii=False))
    s = rows[-1]
    what = "Done" if args.apply else "Dry run (rolled back), would do"
    ledger = f" Ledger row {s['ledger']} (admin.personal_workspaces)." if args.apply else f" Dry run ledger row {dry_ledger}. Run again with --apply."
    print(f"{what}: {s['accounts']} accounts, {s['made']} workspaces made, {s['adopted']} adopted, {s['personalAfter']} personal workspaces in all; "
          f"{s['quietedNotices']} notices taken back; approved by {approver}.{ledger}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
