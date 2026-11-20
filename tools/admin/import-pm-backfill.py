#!/usr/bin/env python3
"""Historical project-management backfill for one organisation: the PGS (project lead), the pod and the project team, mined
from the organisation's own records (EA-DATA-PATTERNS, owner 7 Nov 2026: "for all the hundreds of projects, check who was
the PGS ... assign, align everything").

    python3 tools/admin/import-pm-backfill.py --manifest manifest.json --approver "Name (owner)" --words "..." \
        [--apply] [--dump-dir DIR] [--exec "docker exec -i ea-postgres"] [--database pulse]

The manifest (JSON, built on the server from the analysis; ids only):

    {"org_id": "<uuid>", "as_person_id": "<uuid of the admin acting>", "source": "...",
     "pgs":     [{"project_id": "<uuid>", "person_id": "<uuid>", "confidence": "high", "source_key": "pgs:<project>", "evidence": "..."}],
     "pods":    [{"project_id": "<uuid>", "pod": "Pod 1", "confidence": "high", "source_key": "pod:<project>", ...}],
     "members": [{"project_id": "<uuid>", "person_id": "<uuid>", "from": "2025-03-12", "to": null | "2026-01-05",
                  "confidence": "high", "source_key": "member:<project>:<person>", ...}]}

What it writes, and only where the field is empty (a value a person entered is never changed; a different value is
reported as a conflict and kept):
  * pulse.project.lead_person_id (the PGS) and pulse.work_project.owner_id (kept in step, as pulse.project_plan_set does),
    only for active staff of the organisation;
  * pulse.work_project.pod;
  * pulse.project_member rows (role 'member'; added_at = first seen; a past membership gets left_at = last seen). A person
    who already has any membership row in the project is skipped.
Only items marked "confidence": "high" are written; anything else is refused by the manifest check, because suggestions
are for a person to confirm and stay staged outside the database.

Safety:
  * One transaction. A dry run (the default) does everything, prints the verification report and rolls back; the dry run
    itself is written to the ledger (admin.import_dry_run, its own committed row).
  * --apply first takes a pg_dump (data only) of the touched tables into --dump-dir (0600) and refuses without it.
  * Nobody is told: none of the touched tables raise notices; the run refuses to commit if any notice, notice delivery or
    workflow run was created in its transaction.
  * The ledger: pulse.platform_log('admin.import', ...) in the same transaction: approver, their words verbatim, manifest
    sha256, the counts.
  * Idempotent: a rerun finds every field filled and every membership present, and changes nothing.
  * Runs only on the Pulse server (PULSE_ADMIN_TOOL_HOSTS, default host-49a12d.internal.example).

Exit codes: 0 done (or the dry run worked); 2 refused; 1 the database failed.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shlex
import socket
import subprocess
import sys
from pathlib import Path

APP = "pulse-import-pm-backfill"
SCRIPT = "tools/admin/import-pm-backfill.py"
DEFAULT_HOSTS = "host-49a12d.internal.example"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
POD_RE = re.compile(r"^[A-Za-z0-9 _-]{1,40}$")
TOUCHED = ["pulse.project", "pulse.work_project", "pulse.project_member"]


class Refused(Exception):
    pass


def lit(v: object) -> str:
    return "'" + str(v).replace("'", "''") + "'"


def psql_argv(runner: str, user: str, database: str, tool: str = "psql") -> list[str]:
    argv = shlex.split(runner)
    if "exec" in argv:
        i = argv.index("exec") + 1
        argv[i:i] = ["-e", f"PGAPPNAME={APP}"]
    conn = ["-U", user, "-d", database] if user else ["-d", database]
    if tool == "psql":
        return [*argv, "psql", *conn, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"]
    return [*argv, tool, *conn]


def load_manifest(path: Path) -> dict:
    try:
        m = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise Refused(f"the manifest cannot be read: {e}") from e
    for k in ("org_id", "as_person_id"):
        if not UUID_RE.match(str(m.get(k, ""))):
            raise Refused(f'the manifest needs "{k}" (a uuid)')
    seen: set[str] = set()

    def check(kind: str, it: dict, *ids: str) -> None:
        for k in ids:
            if not UUID_RE.match(str(it.get(k, ""))):
                raise Refused(f"{kind} {it.get('source_key')}: {k} is not a uuid")
        if it.get("confidence") != "high":
            raise Refused(f"{kind} {it.get('source_key')}: only confidence 'high' is written; suggestions stay staged")
        sk = str(it.get("source_key") or "")
        if not sk or sk in seen:
            raise Refused(f"{kind}: a missing or repeated source_key {sk!r}")
        seen.add(sk)

    for it in m.get("pgs", []):
        check("pgs", it, "project_id", "person_id")
    for it in m.get("pods", []):
        check("pod", it, "project_id")
        if not POD_RE.match(str(it.get("pod", ""))):
            raise Refused(f"pod {it.get('source_key')}: a pod name of letters, digits and spaces")
    for it in m.get("members", []):
        check("member", it, "project_id", "person_id")
        if not DATE_RE.match(str(it.get("from", ""))) or (it.get("to") is not None and not DATE_RE.match(str(it["to"]))):
            raise Refused(f"member {it.get('source_key')}: from/to are dates (to may be null)")
    if len({i["project_id"] for i in m.get("pgs", [])}) != len(m.get("pgs", [])):
        raise Refused("one PGS per project")
    return m


def values(rows: list[str]) -> str:
    return ",\n".join(rows) if rows else None


def build_script(m: dict, actor: str) -> str:
    org, me = m["org_id"], m["as_person_id"]
    pgs = values([f"({lit(i['project_id'])}::uuid,{lit(i['person_id'])}::uuid,{lit(i['source_key'])})" for i in m.get("pgs", [])])
    pods = values([f"({lit(i['project_id'])}::uuid,{lit(i['pod'])},{lit(i['source_key'])})" for i in m.get("pods", [])])
    mem = values([f"({lit(i['project_id'])}::uuid,{lit(i['person_id'])}::uuid,{lit(i['from'])}::date,"
                  f"{lit(i['to']) + '::date' if i.get('to') else 'null::date'},{lit(i['source_key'])})" for i in m.get("members", [])])
    s = [f"""begin;
select set_config('pulse.org_id', {lit(org)}, true), set_config('pulse.viewer_id', {lit(me)}, true),
       set_config('pulse.actor_account', {lit(actor)}, true), set_config('pulse.agent_session', '', true);
do $q$ begin
  if not exists(select 1 from pulse.org where id = {lit(org)}::uuid) then raise exception 'IMPORT_REFUSED: no such organisation'; end if;
  if not exists(select 1 from pulse.person where id = {lit(me)}::uuid and org_id = {lit(org)}::uuid and side = 'staff' and status = 'active')
    then raise exception 'IMPORT_REFUSED: the acting admin is not active staff of the organisation'; end if;
end $q$;
create temp table bf_pgs(project_id uuid, person_id uuid, source_key text) on commit drop;
create temp table bf_pod(project_id uuid, pod text, source_key text) on commit drop;
create temp table bf_mem(project_id uuid, person_id uuid, d_from date, d_to date, source_key text) on commit drop;
create temp table bf_out(k text primary key, n int) on commit drop;
"""]
    if pgs:
        s.append(f"insert into bf_pgs values\n{pgs};\n")
    if pods:
        s.append(f"insert into bf_pod values\n{pods};\n")
    if mem:
        s.append(f"insert into bf_mem values\n{mem};\n")
    s.append(f"""
-- before: what is there already
insert into bf_out select 'pgs_items', count(*) from bf_pgs;
insert into bf_out select 'pgs_project_missing', count(*) from bf_pgs b where not exists(select 1 from pulse.project p where p.id = b.project_id and p.org_id = {lit(org)}::uuid and p.deleted_at is null);
insert into bf_out select 'pgs_person_not_active_staff', count(*) from bf_pgs b where not exists(select 1 from pulse.person s where s.id = b.person_id and s.org_id = {lit(org)}::uuid and s.side = 'staff' and s.status = 'active');
insert into bf_out select 'pgs_already_same', count(*) from bf_pgs b join pulse.project p on p.id = b.project_id where p.lead_person_id = b.person_id;
insert into bf_out select 'pgs_conflict_kept', count(*) from bf_pgs b join pulse.project p on p.id = b.project_id where p.lead_person_id is not null and p.lead_person_id <> b.person_id;
insert into bf_out select 'pod_items', count(*) from bf_pod;
insert into bf_out select 'pod_conflict_kept', count(*) from bf_pod b join pulse.work_project w on w.project_id = b.project_id where w.pod is not null and w.pod <> b.pod;
insert into bf_out select 'pod_no_work_project', count(*) from bf_pod b where not exists(select 1 from pulse.work_project w where w.project_id = b.project_id);
insert into bf_out select 'member_items', count(*) from bf_mem;
insert into bf_out select 'member_already_there', count(*) from bf_mem b where exists(select 1 from pulse.project_member m where m.project_id = b.project_id and m.person_id = b.person_id);
create temp table bf_ok on commit drop as
  select b.* from bf_pgs b join pulse.project p on p.id = b.project_id and p.org_id = {lit(org)}::uuid and p.deleted_at is null
  join pulse.person s on s.id = b.person_id and s.org_id = {lit(org)}::uuid and s.side = 'staff' and s.status = 'active';
-- writes: only empty fields
with u as (update pulse.project p set lead_person_id = ok.person_id, updated_at = now() from bf_ok ok
           where p.id = ok.project_id and p.lead_person_id is null returning 1)
insert into bf_out select 'pgs_set', count(*) from u;
with u as (update pulse.work_project w set owner_id = ok.person_id, updated_at = now(), updated_by = {lit(me)}::uuid from bf_ok ok
           where w.project_id = ok.project_id and w.owner_id is null and w.deleted_at is null returning 1)
insert into bf_out select 'owner_set', count(*) from u;
with u as (update pulse.work_project w set pod = b.pod, updated_at = now(), updated_by = {lit(me)}::uuid from bf_pod b
           join pulse.project p on p.id = b.project_id and p.org_id = {lit(org)}::uuid and p.deleted_at is null
           where w.project_id = b.project_id and w.pod is null returning 1)
insert into bf_out select 'pod_set', count(*) from u;
with i as (insert into pulse.project_member(org_id, project_id, person_id, role, added_by, added_at, left_at)
           select {lit(org)}::uuid, b.project_id, b.person_id, 'member', {lit(me)}::uuid, b.d_from::timestamptz,
                  case when b.d_to is null then null else (b.d_to + 1)::timestamptz end
           from bf_mem b join pulse.project p on p.id = b.project_id and p.org_id = {lit(org)}::uuid and p.deleted_at is null
           join pulse.person s on s.id = b.person_id and s.org_id = {lit(org)}::uuid and s.side = 'staff'
           where not exists(select 1 from pulse.project_member m where m.project_id = b.project_id and m.person_id = b.person_id)
           returning left_at)
insert into bf_out select 'members_added', count(*) from i union all select 'members_added_current', count(*) filter (where left_at is null) from i;
-- nobody is told: refuse if this transaction made any notice, delivery or workflow run
do $q$ declare x xid := (pg_current_xact_id()::text::bigint % 4294967296)::text::xid; n int; begin
  select (select count(*) from pulse.notification where xmin = x) + (select count(*) from pulse.notification_delivery where xmin = x)
       + (select count(*) from pulse.workflow_run where xmin = x) into n;
  if n > 0 then raise exception 'IMPORT_REFUSED: % notices or workflow runs would have been made; nothing was written', n; end if;
end $q$;
-- verification report (after)
select json_build_object('report', (select json_object_agg(k, n) from bf_out),
  'after', json_build_object(
     'projects_with_lead', (select count(*) from pulse.project where org_id = {lit(org)}::uuid and deleted_at is null and lead_person_id is not null),
     'work_projects_with_pod', (select count(*) from pulse.work_project where org_id = {lit(org)}::uuid and deleted_at is null and pod is not null),
     'members_current', (select count(*) from pulse.project_member where org_id = {lit(org)}::uuid and left_at is null),
     'members_all', (select count(*) from pulse.project_member where org_id = {lit(org)}::uuid)),
  'lead_load_active', (select json_object_agg(n, c) from (select s.display_name n, count(*) c from pulse.project p join pulse.person s on s.id = p.lead_person_id
       where p.org_id = {lit(org)}::uuid and p.deleted_at is null group by 1) z),
  'spot_checks', (select json_agg(z) from (select p.id, coalesce(p.title, p.name) project, s.display_name pgs, w.pod,
       (select count(*) from pulse.project_member m where m.project_id = p.id) members
       from bf_ok b join pulse.project p on p.id = b.project_id left join pulse.person s on s.id = p.lead_person_id
       left join pulse.work_project w on w.project_id = p.id order by md5(p.id::text) limit 8) z))::jsonb::text;
""")
    return "".join(s)


def run(argv: list[str], data: bytes | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(argv, input=data, capture_output=True, check=False)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--manifest", required=True, type=Path)
    ap.add_argument("--approver", required=True, help='who approved this, e.g. "Owner Name (owner)"')
    ap.add_argument("--words", required=True, help="the approver's words, verbatim (they go in the audit log)")
    ap.add_argument("--apply", action="store_true", help="commit (without it: do everything, report, roll back)")
    ap.add_argument("--dump-dir", type=Path, help="where the pg_dump of the touched tables goes before --apply")
    ap.add_argument("--exec", default="docker exec -i ea-postgres", help='how to reach psql ("" for a local psql)')
    ap.add_argument("--db-user", default="ea_admin")
    ap.add_argument("--database", default="pulse")
    ap.add_argument("--report", type=Path, help="write the verification report (JSON) here")
    a = ap.parse_args(argv)
    approver, words = a.approver.strip(), a.words.strip()
    if len(approver) < 3 or len(words) < 4:
        print("Refused: --approver and --words are both needed.", file=sys.stderr)
        return 2
    host = socket.gethostname()
    allowed = {h.strip() for h in os.environ.get("PULSE_ADMIN_TOOL_HOSTS", DEFAULT_HOSTS).split(",") if h.strip()}
    if host not in allowed:
        print(f"Refused: this tool runs only on the Pulse server ({', '.join(sorted(allowed))}), not on {host}.", file=sys.stderr)
        return 2
    try:
        m = load_manifest(a.manifest)
    except Refused as e:
        print(f"Refused: {e}", file=sys.stderr)
        return 2
    digest = hashlib.sha256(a.manifest.read_bytes()).hexdigest()
    actor = f"import-pm-backfill.py · approver: {approver}"[:120]
    dump_file = None
    if a.apply:
        if not a.dump_dir:
            print("Refused: --apply needs --dump-dir (the touched tables are dumped first).", file=sys.stderr)
            return 2
        a.dump_dir.mkdir(parents=True, exist_ok=True)
        dump_file = a.dump_dir / f"pm-backfill-{a.database}-{dt.datetime.now(dt.timezone.utc):%Y%m%dT%H%M%SZ}.sql"
        argv_d = psql_argv(a.exec, a.db_user, a.database, "pg_dump") + ["--data-only"] + [x for t in TOUCHED for x in ("-t", t)]
        p = run(argv_d)
        if p.returncode != 0 or not p.stdout:
            print(f"Refused: the dump failed, nothing was written: {p.stderr.decode()[-300:]}", file=sys.stderr)
            return 2
        dump_file.write_bytes(p.stdout)
        os.chmod(dump_file, 0o600)
    script = build_script(m, actor)
    detail_static = {"tool": SCRIPT, "host": host, "approver": approver, "words": words, "manifestSha256": digest,
                     "source": m.get("source"), "database": a.database, "dump": str(dump_file) if dump_file else None,
                     "items": {"pgs": len(m.get("pgs", [])), "pods": len(m.get("pods", [])), "members": len(m.get("members", []))}}
    tail = (f"""select set_config('pulse.org_id', '', true), set_config('pulse.viewer_id', '', true);
select pulse.platform_log('admin.import', {lit(m['org_id'])}::uuid, 'import', null,
  (select name from pulse.org where id = {lit(m['org_id'])}::uuid), {lit(words[:380])},
  {lit(json.dumps(detail_static, ensure_ascii=False))}::jsonb || jsonb_build_object('kind', 'pm-backfill', 'applied', true,
  'counts', (select jsonb_object_agg(k, n) from bf_out)));
commit;
""" if a.apply else "rollback;\n")
    p = run(psql_argv(a.exec, a.db_user, a.database), (script + tail).encode())
    out, err = p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")
    if p.returncode != 0:
        msg = (re.findall(r"ERROR:\s*(.*)", err) or [err.strip()[-400:]])[-1]
        print(("Refused (nothing was written): " if "IMPORT_REFUSED" in msg else "The database failed; nothing was written: ")
              + msg.replace("IMPORT_REFUSED: ", ""), file=sys.stderr)
        return 2 if "IMPORT_REFUSED" in msg else 1
    rep = [json.loads(x) for x in out.splitlines() if x.startswith("{")][-1]
    rep.update({"applied": a.apply, "manifestSha256": digest, "database": a.database, "dump": str(dump_file) if dump_file else None})
    if not a.apply:  # the dry run in the ledger, its own committed row
        led = f"""begin; select set_config('pulse.actor_account', {lit(actor)}, true);
select pulse.platform_log('admin.import_dry_run', {lit(m['org_id'])}::uuid, 'import', null,
  (select name from pulse.org where id = {lit(m['org_id'])}::uuid), {lit(words[:380])},
  {lit(json.dumps({**detail_static, 'kind': 'pm-backfill', 'applied': False, 'counts': rep['report']}, ensure_ascii=False))}::jsonb);
commit;"""
        q = run(psql_argv(a.exec, a.db_user, a.database), led.encode())
        rep["ledger"] = "dry run logged" if q.returncode == 0 else "dry-run ledger row failed: " + q.stderr.decode()[-200:]
    if a.report:
        a.report.write_text(json.dumps(rep, indent=1, ensure_ascii=False))
        os.chmod(a.report, 0o600)
    print(json.dumps(rep, ensure_ascii=False))
    print(("Applied" if a.apply else "Dry run (rolled back)") + f" on {a.database}: " + json.dumps(rep["report"]), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
