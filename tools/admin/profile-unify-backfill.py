#!/usr/bin/env python3
"""One profile per person across every company (PROFILE-UNIFY, owner, 6 Nov 2026): "his Willow Lane profile is empty
although his Estate Autopilots profile has a photo and data ... store photo, contact, bio, skills ONCE on the person's
main account and show them in every company."

    python3 tools/admin/profile-unify-backfill.py --approver "Owner Name (owner)" --words "the owner's words" \\
        [--account savuzo] [--all-accounts] [--apply] [--dump-dir DIR]

For each Pulse account with seats in two or more companies (--all-accounts: every account; --account: one), the best
existing photo and fields from any of its seats are unified:
  * photo: the most recently updated seat photo;
  * pronouns and about: from the most complete seat record (then the most recently updated);
  * skills and languages: from all its seats together.
Only the person's own fields move; a company's work record (role, team, reports to, employment, pay, attendance, HR,
documents) is never read or written.

  * With migration 1683 on the database: pulse.account_profile_backfill(account) per account (the account profile takes
    what it lacks, then every seat inherits it, as the app does from then on).
  * Before 1683 is released (seat mode): the same choice written straight into every seat's people_profile and
    person_photo, so every company shows the same photo and details today; run again after the release to fill the
    account profile itself.
  * One transaction; a dry run (the default) does it all and rolls back. --apply first takes a pg_dump (custom format)
    into --dump-dir, then commits, writing one row per changed seat into that company's own Audit (pulse.audit_event,
    action profile_unify) and one row per company into the platform audit log (pulse.platform_log): approver, words
    verbatim, counts. Nothing is sent to anyone.
  * Runs only on the Pulse server (PULSE_ADMIN_TOOL_HOSTS, default host-49a12d.internal.example), with the database's admin role there.
Prints counts per company (photos and fields unified), never a photo or a personal value.

Exit codes: 0 done (or the dry run worked); 2 refused; 1 the database or the dump failed.
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
from datetime import UTC, datetime
from pathlib import Path

APP = "pulse-profile-unify"
SCRIPT = "tools/admin/profile-unify-backfill.py"
DEFAULT_HOSTS = "host-49a12d.internal.example"
HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9._]{2,29}$")


def lit(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def runner(exec_: str, *tool: str) -> list[str]:
    argv = shlex.split(exec_)
    if "exec" in argv:
        i = argv.index("exec") + 1
        argv[i:i] = ["-e", f"PGAPPNAME={APP}"]
    return [*argv, *tool]


# The accounts to unify, as a temp table (the handle or the seat count picks them).
PICK = """create temp table pu_acct on commit drop as
select a.id, a.handle from pulse_priv.pulse_account a
 where {where} and (select count(*) from pulse_priv.account_member m join pulse.org o on o.id = m.member_org and o.status = 'active' where m.account_id = a.id) >= {min_seats};
create temp table pu_out (org uuid, org_handle text, org_name text, person uuid, handle text, photo boolean, fields boolean) on commit drop;
"""

# With 1683: the app's own function per account; its answer says per company handle what changed.
WITH_1683 = """do $b$ declare a record; r jsonb; k text; v jsonb; g record; begin
  for a in select * from pu_acct order by handle loop
    r := pulse.account_profile_backfill(a.id);
    for k, v in select * from jsonb_each(r -> 'seats') loop
      select o.id, o.name, m.person_id into g from pulse.org o join pulse_priv.account_member m on m.member_org = o.id and m.account_id = a.id where coalesce(o.handle, o.slug) = k;
      insert into pu_out values (g.id, k, g.name, g.person_id, a.handle, (v ->> 'photo')::boolean, (v ->> 'fields')::boolean);
    end loop;
  end loop;
end $b$;
"""

# Before 1683 (seat mode): the same choice, written into each seat.
SEAT_MODE = """do $b$ declare a record; m record; bp record; bf record; v_skills text[]; v_langs text[]; n_photo int; n_fields int; begin
  for a in select * from pu_acct order by handle loop
    select x.mime, x.bytes, x.updated_at into bp from pulse_priv.account_member am join pulse.org o on o.id = am.member_org and o.status = 'active'
      join pulse.person_photo x on x.person_id = am.person_id where am.account_id = a.id order by x.updated_at desc limit 1;
    select pp.pronouns, pp.about into bf from pulse_priv.account_member am join pulse.org o on o.id = am.member_org and o.status = 'active'
      join pulse.people_profile pp on pp.person_id = am.person_id where am.account_id = a.id
     order by (pp.pronouns is not null)::int + (pp.about is not null)::int + (cardinality(pp.languages) > 0)::int + (cardinality(pp.skills) > 0)::int desc, pp.updated_at desc limit 1;
    select coalesce(array_agg(distinct left(btrim(s), 60)) filter (where btrim(s) <> ''), '{}') into v_skills from pulse_priv.account_member am
      join pulse.org o on o.id = am.member_org and o.status = 'active' join pulse.people_profile pp on pp.person_id = am.person_id, unnest(pp.skills) s where am.account_id = a.id;
    select coalesce(array_agg(distinct left(btrim(s), 40)) filter (where btrim(s) <> ''), '{}') into v_langs from pulse_priv.account_member am
      join pulse.org o on o.id = am.member_org and o.status = 'active' join pulse.people_profile pp on pp.person_id = am.person_id, unnest(pp.languages) s where am.account_id = a.id;
    v_skills := v_skills[1:40]; v_langs := v_langs[1:8];
    for m in select am.member_org, am.person_id, o.name, coalesce(o.handle, o.slug) h from pulse_priv.account_member am join pulse.org o on o.id = am.member_org and o.status = 'active' where am.account_id = a.id loop
      perform set_config('pulse.org_id', m.member_org::text, true);
      perform set_config('pulse.viewer_id', '', true);
      n_photo := 0; n_fields := 0;
      if bp.bytes is not null then
        insert into pulse.person_photo(org_id, person_id, mime, bytes, updated_by) values (m.member_org, m.person_id, bp.mime, bp.bytes, m.person_id)
        on conflict (person_id) do update set mime = excluded.mime, bytes = excluded.bytes, updated_by = excluded.updated_by, updated_at = now()
          where person_photo.bytes is distinct from excluded.bytes;
        get diagnostics n_photo = row_count;
      end if;
      update pulse.people_profile set pronouns = coalesce(bf.pronouns, pronouns), about = coalesce(left(bf.about, 400), about),
          languages = case when cardinality(v_langs) > 0 then v_langs else languages end, skills = case when cardinality(v_skills) > 0 then v_skills else skills end, updated_at = now()
        where person_id = m.person_id and (pronouns, about, languages, skills) is distinct from (coalesce(bf.pronouns, pronouns), coalesce(left(bf.about, 400), about),
          case when cardinality(v_langs) > 0 then v_langs else languages end, case when cardinality(v_skills) > 0 then v_skills else skills end);
      get diagnostics n_fields = row_count;
      insert into pu_out values (m.member_org, m.h, m.name, m.person_id, a.handle, n_photo > 0, n_fields > 0);
    end loop;
    perform set_config('pulse.org_id', '', true);
  end loop;
end $b$;
"""

AUDIT = """insert into pulse.audit_event(org_id, actor_account, action, resource, resource_id, source, changes)
select org, {actor}, 'profile_unify', 'person', person::text, 'data-change',
       jsonb_build_object('account', handle, 'photo', photo, 'fields', fields, 'why', 'owner_profile_unify', 'tool', {tool})
  from pu_out where photo or fields;
select set_config('pulse.actor_account', {actor}, true);
select pulse.platform_log('admin.profile_unify', org, 'org', org::text, max(org_name), {words},
       jsonb_build_object('tool', {tool}, 'approver', {approver}, 'mode', {mode}, 'seats', count(*), 'photos', count(*) filter (where photo), 'fields', count(*) filter (where fields)))
  from pu_out group by org having bool_or(photo or fields);
"""

REPORT = """select json_build_object('org', org_handle, 'seats', count(*), 'photos', count(*) filter (where photo), 'fields', count(*) filter (where fields),
  'accounts', json_agg(handle order by handle))::text from pu_out group by org_handle order by org_handle;
select json_build_object('total', json_build_object('accounts', (select count(*) from pu_acct), 'seats', count(*), 'photos', count(*) filter (where photo),
  'fields', count(*) filter (where fields)))::text from pu_out;
"""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--approver", required=True, help='who approved this, e.g. "Owner Name (owner)"')
    ap.add_argument("--words", required=True, help="the approver's words, verbatim (they go in the audit log)")
    ap.add_argument("--account", help="only this Pulse account (@handle)")
    ap.add_argument("--all-accounts", action="store_true", help="every account with a seat, not only those in two or more companies")
    ap.add_argument("--apply", action="store_true", help="pg_dump, then commit (without it: do everything, then roll back)")
    ap.add_argument("--dump-dir", type=Path, default=Path.home() / "backups" / "profile-unify")
    ap.add_argument("--exec", default="docker exec -i ea-postgres", help='how to reach psql and pg_dump ("" for local tools)')
    ap.add_argument("--db-user", default="ea_admin")
    ap.add_argument("--database", default="pulse")
    args = ap.parse_args(argv)

    approver, words = args.approver.strip()[:120], args.words.strip()[:380]
    if len(approver) < 3 or len(words) < 4:
        print("Refused: --approver (a name) and --words (the approval, verbatim) are both needed.", file=sys.stderr)
        return 2
    host = socket.gethostname()
    allowed = {h.strip() for h in os.environ.get("PULSE_ADMIN_TOOL_HOSTS", DEFAULT_HOSTS).split(",") if h.strip()}
    if host not in allowed:
        print(f"Refused: this tool runs only on the Pulse server ({', '.join(sorted(allowed))}), not on {host}.", file=sys.stderr)
        return 2
    where = "true"
    if args.account:
        h = args.account.strip().lstrip("@").lower()
        if not HANDLE_RE.match(h):
            print("Refused: --account takes a Pulse handle.", file=sys.stderr)
            return 2
        where = f"a.handle = {lit(h)}"
    conn = ["-U", args.db_user, "-d", args.database] if args.db_user else ["-d", args.database]
    psql = runner(args.exec, "psql", *conn, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1")
    probe = subprocess.run(psql, input=b"select exists (select 1 from pg_proc where proname = 'account_profile_backfill')::text;", capture_output=True, check=False)
    if probe.returncode != 0:
        print(f"The database failed: {probe.stderr.decode('utf-8', 'replace').strip()[-300:]}", file=sys.stderr)
        return 1
    mode = "account" if probe.stdout.decode().strip().endswith("true") else "seat"
    actor = f"profile-unify-backfill.py · approver: {approver}"[:120]

    if args.apply:
        args.dump_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        dump = args.dump_dir / f"{args.database}-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}.dump"
        print(f"pg_dump of {args.database} to {dump} …", file=sys.stderr)
        with open(dump, "wb") as f:
            d = subprocess.run(runner(args.exec, "pg_dump", *conn, "-Fc"), stdout=f, stderr=subprocess.PIPE, check=False)
        if d.returncode != 0 or dump.stat().st_size < 1024:
            print(f"The pg_dump failed; nothing was written: {d.stderr.decode('utf-8', 'replace').strip()[-300:]}", file=sys.stderr)
            return 1
        os.chmod(dump, 0o600)
        print(f"pg_dump done ({dump.stat().st_size // 1_048_576} MB).", file=sys.stderr)

    script = "\\set ON_ERROR_STOP on\nset client_encoding = 'UTF8';\nbegin;\nset local lock_timeout = '15s';\nset local statement_timeout = '600s';\n"
    script += PICK.format(where=where, min_seats=1 if (args.all_accounts or args.account) else 2)
    script += WITH_1683 if mode == "account" else SEAT_MODE
    if args.apply:
        script += AUDIT.format(actor=lit(actor), tool=lit(SCRIPT), words=lit(words), approver=lit(approver), mode=lit(mode))
    script += REPORT + ("commit;\n" if args.apply else "rollback;\n")
    proc = subprocess.run(psql, input=script.encode("utf-8"), capture_output=True, check=False)
    out, err = proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")
    if proc.returncode != 0:
        msg = (re.findall(r"ERROR:\s*(.*)", err) or [err.strip()[-400:]])[-1]
        print(f"The database failed; nothing was written: {msg}", file=sys.stderr)
        return 1
    for line in out.splitlines():
        if line.startswith("{"):
            print(json.dumps(json.loads(line), ensure_ascii=False))
    print(f"Mode: {mode}. " + ("Applied. Written to each company's Audit and the platform audit log." if args.apply
                               else "Dry run (rolled back). Run again with --apply."), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
