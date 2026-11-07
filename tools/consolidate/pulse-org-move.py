#!/usr/bin/env python3
"""Move one organisation from a separate Pulse install into the shared Pulse, in one transaction.

CONSOLIDATION (owner, 4 Nov 2026: every organisation on one Pulse at app.vitalsos.ai): the tool that moved Authority
Closers on 23 Oct 2026 (AUT-2207, then scripts/data-changes/pulse-org-move.py in the AC workbench), now in the repo
(docs/ops/CONSOLIDATION.md) and extended for Willow Lane and any other separate install:
  * idempotent: an import writes one audit record carrying the bundle's sha256; the same bundle again answers
    "already imported, nothing to do" (exit 0) and changes nothing;
  * staged: every row lands in a private stage schema first, so clashes are found and listed before anything is
    written; --remap-ids gives every id the target already uses a new one, everywhere in the staged rows (uuid and
    uuid[] columns, and ids inside text and jsonb values such as audit resources), and the organisation can take a new
    slug, code or handle (--as-slug, --as-code, --as-handle);
  * accounts: --carry-accounts (export) brings the members' Pulse accounts: a human whose proven e-mail already has an
    account on the target keeps that one and gains this seat (their old handle stays theirs, as a redirect, where free);
    anyone else keeps their account and handle (a new handle only if theirs is taken, listed);
  * the dry run writes the id remap and the account decisions (ids and handles only) next to the bundle.

Owner-approved data change (AGENTS.md, OWNER-APPROVED DATA CHANGES): dry run by default, before and after printed, one
transaction, audited with the approver, the issue and the owner's words; on apply, a pg_dump of the target first.

  export   (on the source server, root): one read-only snapshot of the organisation into a bundle directory:
           bundle.sql (COPY blocks) and manifest.json (migrations, each table's columns and row count, sha256).
  import   (on the target server, root): the bundle in one transaction. Dry run = rolled back.
  verify   (target, read-only): row counts and the isolation read as the API role, after an apply.
  census   (any Pulse, read-only): rows per organisation in every organisation table (for before/after diffs).

What moves: the organisation row and its handle, and every row with its org_id in every organisation table
(the tables with org_id and forced row-level security in pulse, pulse_priv and privacy, found from the
catalogue at run time): people, chats, tasks, projects, files and their metadata, audit history. What stays: the
install row, the source's copy of its licence (the target keeps the register), sessions, sign-in rate counters and
used sign-in links. Password records and two-step state (pulse.login_credential, pulse_priv.auth_account, and the
accounts' password hashes) move only with --carry-passwords: their hashes are copied as they are, never read, set or
printed.

How the rows load: with triggers paused (session_replication_role = replica, like pg_restore
--disable-triggers), so no notification, derived row or timestamp fires; unique keys stay enforced. Sequence and
identity columns (pulse.event.seq and tx_id, pulse.chat_event.seq, privacy.access_log.id) take fresh numbers from the
target, in their original order; the export refuses if a foreign key points at one of them. Projection cursors restart
at 0 (the events were renumbered). Then, with triggers on (Pulse's own audit records them): the accounts, the address
row, an account link, the licence register's hosting, and one audit_event. Before commit, table by table: the row count
must equal the manifest and every foreign key from the organisation's rows must resolve; otherwise it raises and
nothing stays.

Run (as root; it uses docker), e.g. for Willow Lane (docs/ops/CONSOLIDATION.md has the full order):
  python3 pulse-org-move.py export --exec "docker exec -i wl-pulse-postgres-1" --db-user pulse_admin \
      --org <wl handle> --out /root/wl-org-move/final --carry-passwords --carry-accounts
  python3 pulse-org-move.py import --bundle <dir> --exec "docker exec -i ea-postgres" --db-user ea_admin \
      --host pulse.wiselifee.com --remap-ids                                                      # dry run
  ... import ... --apply --approver "Savuzo Roberatano (owner)" --issue "<card>" --words "approve data change: ..."
On a scratch database without docker: --exec "" --db-user "" --database "<connection string>".
"""

# An operator's SQL tool: statements are built from catalogue names (qname/qcol) and quoted values (lit),
# and psql/docker are the operator's own binaries, so the SQL-injection and subprocess rules don't fit.
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

SCHEMAS = ("pulse", "pulse_priv", "privacy")
SCRIPT = "tools/consolidate/pulse-org-move.py"
APP = "pulse-org-move"
# Organisation tables that never move: install-level, the platform's register, and short-lived sign-in state.
EXCLUDE = {
    "pulse.install": "install row: the target keeps its own install company",
    "pulse_priv.pulse_licence": "licence register: kept by the platform organisation in the target",
    "pulse.login_session": "sessions: everyone signs in again at the new home",
    "pulse.auth_rate": "sign-in rate counters: short-lived",
    "pulse_priv.auth_link": "sign-in and reset links: used or expired; new ones come from the target",
}
CREDENTIALS = {
    "pulse.login_credential": "password records (bcrypt hashes)",
    "pulse_priv.auth_account": "two-step state",
}
# Columns the target fills itself although they are not sequences: the transaction id of an event.
FRESH_EXTRA = {"pulse.event": ("tx_id",)}
# Rows rewritten on the way: projection cursors restart, because event numbers change.
TRANSFORM = {
    "pulse.projection_cursor": {"last_tx": "'0'::xid8", "last_seq": "0", "status": "'building'"},
}
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")
HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9._]{2,29}$")


def now() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def lit(value: str) -> str:
    """A SQL string literal (standard_conforming_strings is on in every Pulse)."""
    return "'" + str(value).replace("'", "''") + "'"


def qname(table: str) -> str:
    return ".".join('"' + p.replace('"', '""') + '"' for p in table.split("."))


def qcol(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


class Pg:
    """psql inside a database container, SQL on stdin; nothing secret on argv."""

    def __init__(self, runner: str, user: str, database: str) -> None:
        self.runner = shlex.split(runner)
        self.user, self.database = user, database
        self.container = self.runner[-1] if self.runner and self.runner[0] == "docker" else ""

    def argv(self, *tool: str) -> list[str]:
        runner = list(self.runner)
        if runner[:2] == ["docker", "exec"]:
            runner[2:2] = ["-e", f"PGAPPNAME={APP}"]
        return [*runner, *tool]

    def conn(self) -> list[str]:
        """The connection arguments: a user and a database name, or (no user) a connection string as the database."""
        return ["-U", self.user, "-d", self.database] if self.user else ["-d", self.database]

    def psql(
        self,
        script: str,
        *,
        quiet: bool = True,
        check: bool = True,
        stdout=None,
        notices: list | None = None,
    ) -> str:
        flags = ["-X", "-v", "ON_ERROR_STOP=1"] + (["-q", "-A", "-t"] if quiet else [])
        proc = subprocess.run(
            self.argv("psql", *self.conn(), *flags),
            input=script.encode("utf-8"),
            stdout=stdout or subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        err = proc.stderr.decode("utf-8", "replace")
        if notices is not None:
            notices.extend(err.splitlines())
        elif err.strip():
            sys.stderr.write(err)
        if check and proc.returncode != 0:
            raise SystemExit(f"psql failed ({proc.returncode}): {err.strip()[-2000:]}")
        return proc.stdout.decode("utf-8", "replace") if stdout is None else ""

    def one_json(self, sql: str) -> object:
        out = self.psql(sql).strip().splitlines()
        return json.loads(out[-1]) if out else None

    def soften(self, seconds: float = 2.0) -> threading.Thread:
        """Best effort: lowest CPU and I/O priority for this tool's database backends (the heavy part runs there).

        The container cannot renice (no CAP_SYS_NICE), so the backend's pid inside the container is matched to its
        host pid through /proc/<pid>/status NSpid, and the host renices it."""

        def work() -> None:
            time.sleep(seconds)
            # Priority is a courtesy, never a failure.
            with contextlib.suppress(Exception):
                inner = set(
                    self.psql(
                        f"select pid from pg_stat_activity where application_name = {lit(APP)} "
                        "and pid <> pg_backend_pid();",
                        check=False,
                    ).split()
                )
                for proc in Path("/proc").iterdir():
                    if not proc.name.isdigit():
                        continue
                    try:
                        status = (proc / "status").read_text()
                        cmd = (proc / "cmdline").read_bytes().decode(errors="replace")
                    except OSError:
                        continue
                    ns = next(
                        (ln.split()[1:] for ln in status.splitlines() if ln.startswith("NSpid:")),
                        [],
                    )
                    if len(ns) > 1 and ns[-1] in inner and cmd.startswith("postgres:"):
                        subprocess.run(
                            ["renice", "-n", "19", "-p", proc.name],
                            capture_output=True,
                            check=False,
                        )
                        subprocess.run(
                            ["ionice", "-c3", "-p", proc.name], capture_output=True, check=False
                        )

        t = threading.Thread(target=work, daemon=True)
        t.start()
        return t


# --------------------------------------------------------------------------------------------- discovery
DISCOVER = """
begin isolation level repeatable read read only;
with o as (select * from pulse.org where id::text = :'org' or slug = :'org' or handle = :'org'),
tabs as (
  select c.oid, n.nspname || '.' || c.relname as t, c.relrowsecurity and c.relforcerowsecurity as forced
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = any(string_to_array(:'schemas', ',')) and c.relkind in ('r', 'p') and not c.relispartition
     and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped))
select json_build_object(
  'org', (select row_to_json(o) from o),
  'orgs', (select count(*) from pulse.org),
  'migrations', (select json_agg(version order by version) from public.schema_migrations),
  'handles', (select coalesce(json_agg(row_to_json(h)), '[]') from pulse_priv.handle_name h, o where h.kind = 'org' and h.ref = o.id),
  'tables', (select json_agg(json_build_object(
      't', t.t, 'forced', t.forced,
      'rows', case when (select id from o) is null then 0 else (xpath('/row/n/text()', query_to_xml(
                format('select count(*) as n from %s where org_id = %L', t.oid::regclass, (select id from o)), false, true, '')))[1]::text::bigint end,
      'columns', (select json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
                     'generated', a.attgenerated <> '',
                     'fresh', a.attidentity <> '' or coalesce(pg_get_expr(d.adbin, d.adrelid), '') like 'nextval(%%')
                     order by a.attnum)
                   from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                  where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped),
      'referenced', (select coalesce(json_agg(distinct a.attname), '[]') from pg_constraint con
                       cross join lateral unnest(con.confkey) k(n) join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n
                      where con.contype = 'f' and con.confrelid = t.oid)
    ) order by t.t) from tabs t));
rollback;
"""


def discover(pg: Pg, org: str) -> dict:
    sql = (f"\\set org {lit(org)}\n\\set schemas {lit(','.join(SCHEMAS))}\n" + DISCOVER).replace(
        "%%", "%"
    )
    return pg.one_json(sql)  # type: ignore[return-value]


def plan_tables(info: dict, carry_passwords: bool) -> tuple[list[dict], list[dict]]:
    """Which tables move, with which columns; and which stay behind, with why."""
    moving, staying = [], []
    exclude = dict(EXCLUDE)
    if not carry_passwords:
        exclude.update(
            {
                t: why + ": not carried (people get set-password links)"
                for t, why in CREDENTIALS.items()
            }
        )
    for t in info["tables"]:
        name, rows = t["t"], int(t["rows"])
        if not rows:
            continue
        if name in exclude:
            staying.append({"table": name, "rows": rows, "why": exclude[name]})
            continue
        if not t["forced"]:
            raise SystemExit(
                f"{name} has org_id but no forced row-level security: decide on it before a move ({rows} rows)"
            )
        fresh = [c["name"] for c in t["columns"] if c["fresh"]] + list(FRESH_EXTRA.get(name, ()))
        clash = sorted(set(fresh) & set(t["referenced"]))
        if clash:
            raise SystemExit(
                f"{name}.{clash}: a foreign key points at a column the target renumbers; extend the tool first"
            )
        columns = [c["name"] for c in t["columns"] if not c["generated"] and c["name"] not in fresh]
        moving.append(
            {
                "table": name,
                "rows": rows,
                "columns": columns,
                "fresh": fresh,
                "all_columns": [c["name"] for c in t["columns"] if not c["generated"]],
            }
        )
    return moving, staying


def select_for(entry: dict, org_id: str) -> str:
    cols = []
    for c in entry["columns"]:
        expr = TRANSFORM.get(entry["table"], {}).get(c)
        cols.append(f"{expr} as {qcol(c)}" if expr else qcol(c))
    order = (
        " order by " + ", ".join(qcol(c) for c in entry["fresh"] if c != "tx_id")
        if [c for c in entry["fresh"] if c != "tx_id"]
        else ""
    )
    return (
        f"select {', '.join(cols)} from {qname(entry['table'])} where org_id = {lit(org_id)}{order}"
    )


# --------------------------------------------------------------------------------------------- export
# CONSOLIDATION: the organisation's people's Pulse accounts (global tables) travel with --carry-accounts, so each human
# keeps the handle they chose on the separate install, or joins the account they already have on the shared one.
ACCOUNT_TABLES = {
    "pulse_priv.pulse_account": "id in (select account_id from pulse_priv.account_member where member_org = {oid})",
    "pulse_priv.account_member": "member_org = {oid}",
    "pulse_priv.account_profile": "account_id in (select account_id from pulse_priv.account_member where member_org = {oid})",
    "pulse_priv.account_share": "member_org = {oid}",
    "pulse_priv.handle_name": "kind = 'person' and ref in (select account_id from pulse_priv.account_member where member_org = {oid})",
}
ACCOUNT_COLUMNS = """
begin read only;
select json_object_agg(t, (select json_agg(a.attname order by a.attnum) from pg_attribute a
                            where a.attrelid = t::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''))
  from unnest(string_to_array(:'tables', ',')) t where to_regclass(t) is not null;
rollback;
"""


def account_columns(pg: Pg) -> dict:
    sql = f"\\set tables {lit(','.join(ACCOUNT_TABLES))}\n" + ACCOUNT_COLUMNS
    return pg.one_json(sql) or {}  # type: ignore[return-value]


def cmd_export(args: argparse.Namespace) -> int:
    pg = Pg(args.exec, args.db_user, args.database)
    info = discover(pg, args.org)
    org = info.get("org")
    if not org:
        raise SystemExit(f"No organisation {args.org!r} in the source")
    moving, staying = plan_tables(info, args.carry_passwords)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    os.chmod(out, 0o700)
    oid = org["id"]
    org_cols = list(org.keys())
    parts = ["\\set ON_ERROR_STOP on", "begin isolation level repeatable read read only;"]

    def block(table: str, cols: list[str], select: str) -> None:
        parts.append(
            f"select {lit('COPY ' + qname(table) + ' (' + ', '.join(qcol(c) for c in cols) + ') FROM stdin;')};"
        )
        parts.append(f"copy ({select}) to stdout;")
        parts.append("select '\\.';")

    block(
        "pulse.org",
        org_cols,
        f"select {', '.join(qcol(c) for c in org_cols)} from pulse.org where id = {lit(oid)}",
    )
    block(
        "pulse_priv.handle_name",
        ["handle", "kind", "ref", "created_at"],
        f"select handle, kind, ref, created_at from pulse_priv.handle_name where kind = 'org' and ref = {lit(oid)}",
    )
    for entry in moving:
        block(entry["table"], entry["columns"], select_for(entry, oid))
    accounts: list[dict] = []
    if args.carry_accounts:
        have = account_columns(pg)
        for table, where in ACCOUNT_TABLES.items():
            cols = have.get(table)
            if not cols:
                continue
            exprs = [
                ("null::text as password_hash" if c == "password_hash" and not args.carry_passwords else qcol(c))
                for c in cols
            ]
            # handle_name rows of the organisation itself are the block above
            block(
                "accounts." + table,
                cols,
                f"select {', '.join(exprs)} from {qname(table)} where {where.format(oid=lit(oid))}",
            )
            accounts.append({"table": table, "columns": cols})
    parts.append("rollback;")
    bundle = out / "bundle.sql"
    fd = os.open(bundle, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        pg.psql("\n".join(parts) + "\n", stdout=f)
    digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
    counts = bundle_counts(bundle.read_text(encoding="utf-8"))
    for a in accounts:
        a["rows"] = counts.get("accounts." + a["table"], 0)
    manifest = {
        "contract": "pulse-org-move.v2",
        "created_at": now(),
        "source": {"exec": args.exec, "database": args.database},
        "org": org,
        "handles": info["handles"],
        "migrations": info["migrations"],
        "carry_passwords": args.carry_passwords,
        "carry_accounts": args.carry_accounts,
        "tables": [
            {k: e[k] for k in ("table", "rows", "columns", "fresh", "all_columns")} for e in moving
        ],
        "accounts": accounts,
        "staying": staying,
        "rows": sum(e["rows"] for e in moving),
        "bundle_sha256": digest,
        "bundle_bytes": bundle.stat().st_size,
    }
    path = out / "manifest.json"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1, default=str)
    print(
        f"{org['name']} ({org['code']}, {oid}): {manifest['rows']} rows in {len(moving)} tables -> {out}"
    )
    print(f"  bundle {manifest['bundle_bytes']} bytes, sha256 {digest}")
    print(f"  migrations {len(info['migrations'])}, last {info['migrations'][-1]}")
    if accounts:
        print("  accounts: " + ", ".join(f"{a['table']} {a['rows']}" for a in accounts))
    for s in staying:
        print(f"  stays: {s['table']} ({s['rows']}): {s['why']}")
    return 0


COPY_RE = re.compile(r'^COPY ((?:"(?:[^"]|"")+")(?:\.(?:"(?:[^"]|"")+"))*) \(')


def bundle_blocks(text: str):
    """(table, start line, end line) of each COPY block: a COPY line, its rows, then a line with only \\."""
    lines = text.split("\n")
    expect_copy = True
    for i, line in enumerate(lines):
        if expect_copy:
            m = COPY_RE.match(line)
            if m:
                start, expect_copy = i, False
                name = ".".join(p.strip('"').replace('""', '"') for p in re.findall(r'"(?:[^"]|"")+"', m.group(1)))
            continue
        if line == "\\.":
            yield name, start, i
            expect_copy = True


def bundle_counts(text: str) -> dict:
    return {t: end - start - 1 for t, start, end in bundle_blocks(text)}


def stage_name(table: str) -> str:
    return table.replace(".", "__")


def staged_bundle(text: str, stage: str) -> str:
    """The bundle with every COPY loading into the stage schema instead of the live tables."""
    lines = text.split("\n")
    for table, start, _ in bundle_blocks(text):
        rest = lines[start][COPY_RE.match(lines[start]).end() - 1 :]
        lines[start] = f"COPY {qcol(stage)}.{qcol(stage_name(table))} {rest}"
    return "\n".join(lines)


# --------------------------------------------------------------------------------------------- import
TARGET_INFO = """
begin read only;
select json_build_object(
  'migrations', (select json_agg(version order by version) from public.schema_migrations),
  'org_id_taken', exists (select 1 from pulse.org where id::text = :'oid'),
  'slug_taken', exists (select 1 from pulse.org where slug = :'slug'),
  'code_taken', exists (select 1 from pulse.org where code = :'code'),
  'handle_taken', exists (select 1 from pulse.org where handle = :'handle') or exists (select 1 from pulse_priv.handle_name where handle = :'handle'),
  'host_taken', (select org_id from pulse.org_domain where host = :'host'),
  'imported', (select json_build_object('org', org_id, 'at', at) from pulse.audit_event where resource = 'org' and action = 'import'
                 and source = 'data-change' and changes ->> 'bundle_sha256' = :'sha' order by at limit 1),
  'imported_before', (select json_build_object('org', org_id, 'at', at, 'sha', left(changes ->> 'bundle_sha256', 16)) from pulse.audit_event
                 where resource = 'org' and action = 'import' and source = 'data-change' and changes ->> 'source_org' = :'oid'
                   and changes ->> 'bundle_sha256' is distinct from :'sha' order by at limit 1),
  'account', (select json_build_object('id', id, 'handle', handle) from pulse_priv.pulse_account where handle = :'link_handle'),
  'licence', (select json_build_object('id', id, 'hosting', hosting, 'address', address) from pulse_priv.pulse_licence where org_id::text = :'oid'),
  'columns', (select json_object_agg(n.nspname || '.' || c.relname,
       (select json_agg(a.attname order by a.attnum) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''))
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = any(string_to_array(:'schemas', ',')) and c.relkind in ('r', 'p') and not c.relispartition),
  'orgs', (select json_agg(json_build_object('id', id, 'handle', handle) order by created_at) from pulse.org));
rollback;
"""


def check_target(
    pg: Pg, m: dict, host: str, link_handle: str, renames: dict, remap: bool
) -> tuple[dict, list[str]]:
    org = m["org"]
    sql = (
        "\n".join(
            f"\\set {k} {lit(v)}"
            for k, v in {
                "oid": org["id"],
                "slug": renames.get("slug") or org["slug"],
                "code": renames.get("code") or org["code"],
                "handle": renames.get("handle") or org.get("handle") or "",
                "host": host or "",
                "link_handle": link_handle or "",
                "sha": m["bundle_sha256"],
                "schemas": ",".join(SCHEMAS),
            }.items()
        )
        + "\n"
        + TARGET_INFO
    )
    t = pg.one_json(sql)
    problems = []
    if t["imported"]:
        return t, problems
    if t.get("imported_before"):
        b = t["imported_before"]
        # Idempotent across bundles too: a newer export of an organisation already moved here would be a second copy.
        problems.append(
            f"this organisation ({org['id']}) was already imported into {b['org']} at {b['at']} from another bundle "
            f"(sha256 {b['sha']}…): a second copy would duplicate it; roll the first one back (CONSOLIDATION.md §3) first"
        )
    if t["migrations"] != m["migrations"]:
        src, dst = set(m["migrations"]), set(t["migrations"])
        problems.append(
            f"migrations differ: only in source {sorted(src - dst)[:5]}, only in target {sorted(dst - src)[:5]}"
        )
    if t["org_id_taken"] and not remap:
        problems.append(
            "the target already has an organisation with this id (and no import record of this bundle): "
            "--remap-ids gives the moved one new ids"
        )
    for k in ("slug", "code", "handle"):
        if t[f"{k}_taken"]:
            problems.append(f"the {k} {renames.get(k) or org.get(k)!r} is taken in the target: --as-{k} <new>")
    if host and t["host_taken"]:
        problems.append(f"the address {host} is already claimed by {t['host_taken']}")
    if link_handle and not t["account"]:
        problems.append(f"no Pulse account @{link_handle} in the target")
    for e in m["tables"]:
        have = t["columns"].get(e["table"])
        if have is None:
            problems.append(f"{e['table']} does not exist in the target")
        elif set(have) != set(e["all_columns"]):
            problems.append(
                f"{e['table']}: columns differ (only in source {sorted(set(e['all_columns']) - set(have))}, "
                f"only in target {sorted(set(have) - set(e['all_columns']))})"
            )
    return t, problems


# The load, in one transaction (dry run = rolled back): every COPY lands in a private stage schema first; there the
# organisation is renamed if asked, every id the target already uses is given a new one (--remap-ids: the new id
# replaces the old everywhere in the staged rows, in uuid and uuid[] columns and inside text and jsonb values), every
# unique key is checked against the target, and only then are the rows inserted, triggers paused, in their original
# order. The stage is dropped before commit.
STAGE_SQL = """
create temp table move_tables(stage text, target text, cols text[], kind text) on commit drop;
create temp table remap(old uuid primary key, new uuid not null, why text not null) on commit drop;
create temp table move_org(id uuid, src uuid) on commit drop;
create function pg_temp.remap_text(t text) returns text language plpgsql stable as $f$
declare m text; r uuid; o text := t;
begin
  if t is null or t !~ '[0-9a-f]{8}-[0-9a-f]{4}-' then return t; end if;
  for m in select distinct (regexp_matches(t, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g'))[1] loop
    select new into r from pg_temp.remap where old = m::uuid;
    if found then o := replace(o, m, r::text); end if;
  end loop;
  return o;
end $f$;
"""


def import_script(
    m: dict,
    bundle: str,
    t: dict,
    *,
    actor: str,
    host: str,
    link: tuple[str, str] | None,
    licence_central: bool,
    licence_note: str,
    renames: dict,
    remap: bool,
    apply: bool,
) -> str:
    org = m["org"]
    src_oid = org["id"]
    stage = "pulse_move_" + m["bundle_sha256"][:12]
    expected = {e["table"]: e["rows"] for e in m["tables"]}
    expected["pulse.org"] = 1
    summary = {
        "moved_rows": m["rows"],
        "tables": len(m["tables"]),
        "bundle_sha256": m["bundle_sha256"],
        "from": m["source"],
        "source_org": src_oid,
        "staying": {s["table"]: s["rows"] for s in m["staying"]},
        "carry_passwords": m["carry_passwords"],
        "carry_accounts": bool(m.get("carry_accounts")),
        "renamed": renames,
        "renumbered": {e["table"]: e["fresh"] for e in m["tables"] if e["fresh"]},
    }
    loaded = [("pulse.org", list(org.keys()), "org"), ("pulse_priv.handle_name", ["handle", "kind", "ref", "created_at"], "orghandle")]
    loaded += [(e["table"], e["columns"], "table") for e in m["tables"]]
    loaded += [("accounts." + a["table"], a["columns"], "account") for a in m.get("accounts", [])]
    creates = []
    for table, cols, kind in loaded:
        real = table.removeprefix("accounts.")
        have = set(t["columns"].get(real) or cols)
        tcols = [c for c in cols if c in have]
        creates.append(
            f"create table {qcol(stage)}.{qcol(stage_name(table))} as select {', '.join(qcol(c) for c in cols)} "
            f"from {qname(real)} with no data;"
            if set(cols) <= have
            else f"create table {qcol(stage)}.{qcol(stage_name(table))} as select "
            + ", ".join(qcol(c) if c in have else f"null::text as {qcol(c)}" for c in cols)
            + f" from {qname(real)} with no data;"
        )
        creates.append(
            f"insert into pg_temp.move_tables values ({lit(stage_name(table))}, {lit(real)}, "
            f"array[{', '.join(lit(c) for c in tcols)}]::text[], {lit(kind)});"
        )
    head = f"""\\set ON_ERROR_STOP on
\\set QUIET on
begin;
set local lock_timeout = '15s';
set local statement_timeout = '30min';
do $guard$ begin
  perform set_config('pulse.actor_account', {lit(actor)}, true);
  if (select json_agg(version order by version)::jsonb from public.schema_migrations) <> {lit(json.dumps(m["migrations"]))}::jsonb then
    raise exception 'pulse-org-move: the target''s migrations changed since the check';
  end if;
  if exists (select 1 from pulse.audit_event where resource = 'org' and action = 'import' and source = 'data-change'
             and changes ->> 'bundle_sha256' = {lit(m["bundle_sha256"])}) then
    raise exception 'pulse-org-move: this bundle is already imported';
  end if;
end $guard$;
{STAGE_SQL}
create schema {qcol(stage)};
{chr(10).join(creates)}
\\echo == staging {org["name"]} ({org["code"]}): {m["rows"]} rows in {len(m["tables"])} tables
"""
    rename_sql = []
    if renames.get("slug"):
        rename_sql.append(f"update {qcol(stage)}.pulse__org set slug = {lit(renames['slug'])};")
    if renames.get("code"):
        rename_sql.append(f"update {qcol(stage)}.pulse__org set code = {lit(renames['code'])};")
    if renames.get("handle"):
        rename_sql.append(f"update {qcol(stage)}.pulse__org set handle = {lit(renames['handle'])};")
        rename_sql.append(f"update {qcol(stage)}.pulse_priv__handle_name set handle = {lit(renames['handle'])};")
    prepare = f"""
-- Ids the target already uses: a new id each (only with --remap-ids; otherwise they are listed and the move stops).
do $remap$
declare r record; ix record; n bigint; clashes text[] := '{{}}'; c record;
begin
  for r in select * from pg_temp.move_tables where kind in ('org', 'table') loop
    for ix in select (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey) with ordinality k(n, ord)
                        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.n) cols, i.indexrelid::regclass::text iname
                from pg_index i where i.indrelid = r.target::regclass and i.indisunique and i.indexprs is null loop
      if cardinality(ix.cols) <> 1 or not ix.cols[1] = any(r.cols) then continue; end if;
      if (select format_type(a.atttypid, a.atttypmod) from pg_attribute a where a.attrelid = r.target::regclass and a.attname = ix.cols[1]) <> 'uuid' then continue; end if;
      execute format('insert into pg_temp.remap(old, new, why) select distinct s.%1$I, gen_random_uuid(), %2$L from {qcol(stage)}.%3$I s
                       where s.%1$I is not null and exists (select 1 from %4$s t where t.%1$I = s.%1$I) on conflict do nothing',
                     ix.cols[1], r.target || '.' || ix.cols[1], r.stage, r.target);
      get diagnostics n = row_count;
      if n > 0 then clashes := clashes || format('%s.%s: %s', r.target, ix.cols[1], n); end if;
    end loop;
  end loop;
  if cardinality(clashes) > 0 then
    raise notice 'pulse-org-move: ids already used in the target: %', array_to_string(clashes, '; ');
    if not {"true" if remap else "false"} then
      raise exception 'pulse-org-move: % table(s) hold ids the target already uses (%); run with --remap-ids', cardinality(clashes), array_to_string(clashes, '; ');
    end if;
  end if;
  -- the new ids replace the old ones everywhere in the staged rows
  if exists (select 1 from pg_temp.remap) then
    for c in select mt.stage, a.attname::text col, format_type(a.atttypid, a.atttypmod) typ
               from pg_temp.move_tables mt join pg_attribute a on a.attrelid = ({lit(stage)} || '.' || quote_ident(mt.stage))::regclass
              where a.attnum > 0 and not a.attisdropped and a.attname::text = any(mt.cols)
                and format_type(a.atttypid, a.atttypmod) in ('uuid', 'uuid[]', 'text', 'jsonb', 'json') loop
      if c.typ = 'uuid' then
        execute format('update {qcol(stage)}.%I s set %I = r.new from pg_temp.remap r where s.%I = r.old', c.stage, c.col, c.col);
      elsif c.typ = 'uuid[]' then
        execute format('update {qcol(stage)}.%1$I s set %2$I = (select array_agg(coalesce(r.new, u) order by o) from unnest(s.%2$I) with ordinality x(u, o)
                         left join pg_temp.remap r on r.old = x.u) where s.%2$I && (select array_agg(old) from pg_temp.remap)', c.stage, c.col);
      else
        execute format('update {qcol(stage)}.%1$I s set %2$I = pg_temp.remap_text(s.%2$I::text)::%3$s where s.%2$I::text ~ ''[0-9a-f]{{8}}-[0-9a-f]{{4}}-''',
                       c.stage, c.col, c.typ);
      end if;
    end loop;
  end if;
  insert into pg_temp.move_org select id, {lit(src_oid)}::uuid from {qcol(stage)}.pulse__org;
  raise notice 'pulse-org-move: % id(s) remapped; the organisation is %', (select count(*) from pg_temp.remap), (select id from pg_temp.move_org);
end $remap$;
-- The operator's new slug, code or handle, after the remap (so a new id never rewrites them).
{chr(10).join(rename_sql)}
-- Every unique key of the moved rows, against the target (after the new ids): any clash stops the move, all listed.
do $unique$
declare r record; ix record; n bigint; bad text[] := '{{}}';
begin
  for r in select * from pg_temp.move_tables where kind in ('org', 'orghandle', 'table') loop
    for ix in select (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey) with ordinality k(n, ord)
                        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.n) cols, i.indexrelid::regclass::text iname
                from pg_index i where i.indrelid = r.target::regclass and i.indisunique and i.indexprs is null and i.indpred is null loop
      if not ix.cols <@ r.cols then continue; end if;
      execute format('select count(*) from {qcol(stage)}.%I s where exists (select 1 from %s t where %s)', r.stage, r.target,
                     (select string_agg(format('t.%1$I = s.%1$I', x), ' and ') from unnest(ix.cols) x)) into n;
      if n > 0 then bad := bad || format('%s (%s): %s row(s)', ix.iname, array_to_string(ix.cols, ', '), n); end if;
    end loop;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'pulse-org-move: % unique key(s) already taken in the target: %', cardinality(bad), array_to_string(bad, '; ');
  end if;
  raise notice 'pulse-org-move: unique keys checked, none taken';
end $unique$;
\\echo == loading, triggers paused
set local session_replication_role = replica;
do $load$
declare r record; n bigint;
begin
  for r in select * from pg_temp.move_tables where kind in ('org', 'orghandle', 'table') order by (kind <> 'org'), target loop
    execute format('insert into %s (%s) select %s from {qcol(stage)}.%I order by ctid', r.target,
                   (select string_agg(quote_ident(c), ', ') from unnest(r.cols) c), (select string_agg(quote_ident(c), ', ') from unnest(r.cols) c), r.stage);
  end loop;
end $load$;
set local session_replication_role = origin;
do $o$ begin perform set_config('pulse.org_id', (select id::text from pg_temp.move_org), true); end $o$;
"""
    accounts_sql = ""
    if m.get("accounts"):
        accounts_sql = f"""
-- Accounts: the same human already on the target (same id and e-mail, or the same proven e-mail) keeps that account
-- and gains this seat; anyone else gets their account as it was, with a new handle only if theirs is taken here.
create temp table acct_map(src uuid primary key, dst uuid not null, how text not null, handle text) on commit drop;
do $acct$
declare a record; dst uuid; h text; v_how text; cols text[] := (select cols from pg_temp.move_tables where stage = 'accounts__pulse_priv__pulse_account');
begin
  if cols is null then return; end if;
  for a in execute format('select * from {qcol(stage)}.accounts__pulse_priv__pulse_account order by created_at') loop
    dst := null; v_how := null;
    select t.id into dst from pulse_priv.pulse_account t where t.id = a.id and lower(t.email) is not distinct from lower(a.email);
    if dst is not null then v_how := 'same account'; end if;
    if dst is null and a.email is not null then
      select t.id into dst from pulse_priv.pulse_account t where lower(t.email) = lower(a.email)
         and (coalesce(t.email_verified_at, t.email_confirmed_at) is not null or coalesce(a.email_verified_at, a.email_confirmed_at) is not null);
      if dst is not null then v_how := 'joined by proven e-mail'; end if;
    end if;
    if dst is not null then
      insert into pg_temp.acct_map values (a.id, dst, v_how, (select handle from pulse_priv.pulse_account where id = dst));
      continue;
    end if;
    dst := case when exists (select 1 from pulse_priv.pulse_account where id = a.id) then gen_random_uuid() else a.id end;
    h := case when exists (select 1 from pulse_priv.handle_name where handle = a.handle) or exists (select 1 from pulse.org where handle = a.handle)
                or exists (select 1 from pulse_priv.pulse_account where handle = a.handle) then pulse.handle_suggest(a.handle) else a.handle end;
    execute format('insert into pulse_priv.pulse_account (%s) select %s from {qcol(stage)}.accounts__pulse_priv__pulse_account s where s.id = $1',
      (select string_agg(quote_ident(c), ', ') from unnest(cols) c),
      (select string_agg(case c when 'id' then quote_literal(dst) || '::uuid' when 'handle' then quote_literal(h)
                                when 'email' then 'case when exists (select 1 from pulse_priv.pulse_account x where lower(x.email) = lower(s.email)) then null else s.email end'
                                else 's.' || quote_ident(c) end, ', ') from unnest(cols) c)) using a.id;
    insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', dst) on conflict do nothing;
    insert into pg_temp.acct_map values (a.id, dst, case when h = a.handle then 'new account' else 'new account, handle renamed from @' || a.handle end, h);
  end loop;
  -- the handles they had on the separate install keep meaning them, where nobody here has them
  if to_regclass({lit(stage + '.accounts__pulse_priv__handle_name')}) is not null then
    execute format('insert into pulse_priv.handle_name(handle, kind, ref, created_at) select s.handle, ''person'', m.dst, s.created_at
                      from {qcol(stage)}.accounts__pulse_priv__handle_name s join pg_temp.acct_map m on m.src = s.ref
                     where not exists (select 1 from pulse.org o where o.handle = s.handle) on conflict do nothing');
  end if;
  if to_regclass({lit(stage + '.accounts__pulse_priv__account_member')}) is not null then
    execute format('insert into pulse_priv.account_member(account_id, member_org, person_id, kind, joined_at, last_used_at)
                      select m.dst, (select id from pg_temp.move_org), coalesce(r.new, s.person_id), s.kind, s.joined_at, s.last_used_at
                        from {qcol(stage)}.accounts__pulse_priv__account_member s join pg_temp.acct_map m on m.src = s.account_id
                        left join pg_temp.remap r on r.old = s.person_id
                      on conflict do nothing');
  end if;
  if to_regclass({lit(stage + '.accounts__pulse_priv__account_profile')}) is not null then
    execute format('insert into pulse_priv.account_profile select (jsonb_populate_record(null::pulse_priv.account_profile, to_jsonb(s) || jsonb_build_object(''account_id'', m.dst))).*
                      from {qcol(stage)}.accounts__pulse_priv__account_profile s join pg_temp.acct_map m on m.src = s.account_id and m.how like ''new account%%''
                      on conflict do nothing');
  end if;
  if to_regclass({lit(stage + '.accounts__pulse_priv__account_share')}) is not null then
    execute format('insert into pulse_priv.account_share select (jsonb_populate_record(null::pulse_priv.account_share, to_jsonb(s) || jsonb_build_object(''account_id'', m.dst, ''member_org'', (select id from pg_temp.move_org)))).*
                      from {qcol(stage)}.accounts__pulse_priv__account_share s join pg_temp.acct_map m on m.src = s.account_id
                      on conflict do nothing');
  end if;
  raise notice 'pulse-org-move: accounts: %', (select coalesce(json_object_agg(how, n), '{{}}') from (select how, count(*) n from pg_temp.acct_map group by how) x);
end $acct$;
"""
    live = []
    if host:
        live.append(
            f"insert into pulse.org_domain(host, org_id, sign_in, is_primary, added_by) select {lit(host)}, id, 'password', true, {lit(actor[:200])} from pg_temp.move_org;"
        )
    if link:
        handle, person = link
        live.append(f"""insert into pulse_priv.account_member(account_id, member_org, person_id, kind)
select a.id, (select id from pg_temp.move_org), coalesce((select new from pg_temp.remap where old = {lit(person)}), {lit(person)}::uuid), 'staff'
  from pulse_priv.pulse_account a where a.handle = {lit(handle)}
on conflict do nothing;""")
    if licence_central and t.get("licence"):
        live.append(f"""update pulse_priv.pulse_licence set hosting = 'central', note = {lit(licence_note)}
 where org_id = (select id from pg_temp.move_org) and hosting = 'self-hosted';""")
    live.append(f"""insert into pulse.audit_event(org_id, id, actor_id, actor_account, action, resource, resource_id, source, at, changes)
select id, gen_random_uuid(), null, {lit(actor)}, 'import', 'org', id::text, 'data-change', now(),
       {lit(json.dumps(summary))}::jsonb || jsonb_build_object('remapped', (select count(*) from pg_temp.remap),
         'accounts', (select coalesce(jsonb_object_agg(how, n), '{{}}') from (select how, count(*) n from pg_temp.acct_map group by how) x))
  from pg_temp.move_org;""" if m.get("accounts") else f"""insert into pulse.audit_event(org_id, id, actor_id, actor_account, action, resource, resource_id, source, at, changes)
select id, gen_random_uuid(), null, {lit(actor)}, 'import', 'org', id::text, 'data-change', now(),
       {lit(json.dumps(summary))}::jsonb || jsonb_build_object('remapped', (select count(*) from pg_temp.remap))
  from pg_temp.move_org;""")
    counts = f"""
do $counts$
declare exp jsonb := {lit(json.dumps(expected))}::jsonb; k text; n bigint; bad text[] := '{{}}'; oid uuid := (select id from pg_temp.move_org);
begin
  for k in select jsonb_object_keys(exp) loop
    if k = 'pulse.org' then select count(*) into n from pulse.org where id = oid;
    else execute format('select count(*) from %s where org_id = %L', k::regclass, oid) into n; end if;
    if n <> (exp ->> k)::bigint then bad := bad || format('%s: %s rows, expected %s', k, n, exp ->> k); end if;
  end loop;
  if array_length(bad, 1) > 0 then raise exception 'pulse-org-move: % table(s) differ from the manifest: %', array_length(bad, 1), array_to_string(bad, '; '); end if;
  raise notice 'pulse-org-move: % tables match the manifest', (select count(*) from jsonb_object_keys(exp));
end $counts$;
"""
    verify = f"""
do $verify$
declare exp jsonb := {lit(json.dumps(expected))}::jsonb; bad text[] := '{{}}'; fk record; orphans bigint; checked int := 0; oid uuid := (select id from pg_temp.move_org);
begin
  for fk in
    select con.conname, cn.nspname || '.' || cc.relname as child, pn.nspname || '.' || pc.relname as parent,
           (select array_agg(a.attname order by x.ord) from unnest(con.conkey) with ordinality x(n, ord) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = x.n) as ccols,
           (select array_agg(a.attname order by x.ord) from unnest(con.confkey) with ordinality x(n, ord) join pg_attribute a on a.attrelid = con.confrelid and a.attnum = x.n) as pcols
      from pg_constraint con
      join pg_class cc on cc.oid = con.conrelid join pg_namespace cn on cn.oid = cc.relnamespace
      join pg_class pc on pc.oid = con.confrelid join pg_namespace pn on pn.oid = pc.relnamespace
     where con.contype = 'f' and con.conparentid = 0 and exp ? (cn.nspname || '.' || cc.relname) and cn.nspname || '.' || cc.relname <> 'pulse.org'
  loop
    execute format('select count(*) from %s c where c.org_id = %L and %s and not exists (select 1 from %s p where %s)',
      fk.child::regclass, oid,
      (select string_agg(format('c.%I is not null', c), ' and ') from unnest(fk.ccols) c),
      fk.parent::regclass,
      (select string_agg(format('p.%I = c.%I', fk.pcols[i], fk.ccols[i]), ' and ') from generate_subscripts(fk.ccols, 1) i)) into orphans;
    checked := checked + 1;
    if orphans > 0 then bad := bad || format('%s (%s -> %s): %s rows point at nothing', fk.conname, fk.child, fk.parent, orphans); end if;
  end loop;
  if {"true" if host else "false"} and not exists (select 1 from pulse.org_domain where org_id = oid and host = {lit(host)}) then bad := bad || 'address row missing'::text; end if;
  if array_length(bad, 1) > 0 then raise exception 'pulse-org-move: % problem(s): %', array_length(bad, 1), array_to_string(bad, '; '); end if;
  raise notice 'pulse-org-move: % foreign keys checked, none broken; live rows in place', checked;
end $verify$;
"""
    report = f"""\\pset tuples_only on
\\pset format unaligned
select 'REMAP' || chr(9) || old || chr(9) || new || chr(9) || why from pg_temp.remap order by why, old;
{"select 'ACCOUNT' || chr(9) || src || chr(9) || dst || chr(9) || how || chr(9) || coalesce(handle, '') from pg_temp.acct_map order by how;" if m.get("accounts") else ""}
select 'after: organisations ' || string_agg(coalesce(handle, slug) || '=' || id, ', ' order by created_at) from pulse.org;
select 'after: moved organisation ' || id || case when id <> src then ' (new id; was ' || src || ')' else '' end from pg_temp.move_org;
select 'after: address ' || host || ' -> ' || org_id || ' (' || sign_in || ')' from pulse.org_domain where org_id = (select id from pg_temp.move_org);
select 'after: account seats in the moved organisation ' || count(*) from pulse_priv.account_member where member_org = (select id from pg_temp.move_org);
select 'after: licence ' || licence_key || ' hosting ' || hosting from pulse_priv.pulse_licence where org_id = (select id from pg_temp.move_org);
drop schema {qcol(stage)} cascade;
\\echo {"== APPLIED (committed)" if apply else "== DRY RUN: rolled back, nothing changed"}
{"commit;" if apply else "rollback;"}
"""
    return (
        head
        + staged_bundle(bundle, stage)
        + "\n"
        + prepare
        + accounts_sql
        + counts
        + "\n".join(live)
        + "\n"
        + verify
        + report
    )


def snapshot(pg: Pg, backups: Path, label: str) -> Path:
    backups.mkdir(parents=True, exist_ok=True)
    path = backups / f"{Path(pg.database).name if '/' not in pg.database else 'scratch'}-before-{label}-{now()}.dump"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as out:
        proc = subprocess.Popen(pg.argv("pg_dump", *pg.conn(), "-Fc"), stdout=out)
        pg.soften()
        code = proc.wait()
    if code != 0 or path.stat().st_size < 100_000:
        raise SystemExit(f"Snapshot failed ({code}); nothing was changed: {path}")
    return path


def cmd_import(args: argparse.Namespace) -> int:
    bundle_dir = Path(args.bundle)
    m = json.loads((bundle_dir / "manifest.json").read_text(encoding="utf-8"))
    bundle_bytes = (bundle_dir / "bundle.sql").read_bytes()
    if hashlib.sha256(bundle_bytes).hexdigest() != m["bundle_sha256"]:
        raise SystemExit("bundle.sql does not match its manifest's sha256")
    if args.apply and not (args.approver.strip() and args.words.strip() and args.issue.strip()):
        raise SystemExit("--apply needs --approver, --words (verbatim) and --issue")
    host = (args.host or "").strip().lower()
    if host and not HOST_RE.match(host):
        raise SystemExit(f"--host {host!r} is not a hostname")
    renames = {k: v.strip().lower() if k != "code" else v.strip() for k, v in (("slug", args.as_slug), ("code", args.as_code), ("handle", args.as_handle)) if v and v.strip()}
    if renames.get("handle") and not HANDLE_RE.match(renames["handle"]):
        raise SystemExit("--as-handle is 3 to 30 lower-case letters, digits, dots or underscores")
    link = None
    if args.link:
        handle, _, person = args.link.partition("=")
        if not HANDLE_RE.match(handle) or not UUID_RE.match(person):
            raise SystemExit("--link is <account handle>=<person uuid in the moved organisation>")
        link = (handle, person)
    pg = Pg(args.exec, args.db_user, args.database)
    t, problems = check_target(pg, m, host, link[0] if link else "", renames, args.remap_ids)
    org = m["org"]
    if t["imported"]:
        # Idempotent: the same bundle twice is one move.
        print(f"{org['name']} ({org['code']}): this bundle (sha256 {m['bundle_sha256'][:16]}…) is already imported "
              f"into organisation {t['imported']['org']} at {t['imported']['at']}; nothing to do")
        return 0
    if link and link[1] not in bundle_bytes.decode("utf-8", "replace"):
        problems.append(f"person {link[1]} is not in the bundle")
    print(f"{org['name']} ({org['code']}, {org['id']}) -> {args.database} via {args.exec or 'psql'}")
    print(f"  target organisations now: {', '.join(o['handle'] or o['id'] for o in t['orgs'] or [])}")
    print(
        f"  {m['rows']} rows in {len(m['tables'])} tables; passwords {'carried' if m['carry_passwords'] else 'not carried'}; "
        f"accounts {'carried' if m.get('accounts') else 'not carried'}; ids {'remapped where taken' if args.remap_ids else 'kept'}"
        + (f"; renamed {renames}" if renames else "")
    )
    for p in problems:
        print("  blocks the move:", p)
    if problems:
        return 2
    actor = (
        f"Data change {SCRIPT} · approver: {args.approver or 'dry run'} · issue: {args.issue or 'none'} · "
        f"words: {args.words or 'none'}"
    )[:500]
    note = args.licence_note or f"Moved onto the shared Pulse on {datetime.now(UTC):%d %b %Y}."
    script = import_script(
        m,
        bundle_bytes.decode("utf-8"),
        t,
        actor=actor,
        host=host,
        link=link,
        licence_central=args.licence_central,
        licence_note=note[:400],
        renames=renames,
        remap=args.remap_ids,
        apply=args.apply,
    )
    if args.print_sql:
        print(script[:4000])
        return 0
    if args.apply and args.no_snapshot:
        if args.database == "pulse":
            raise SystemExit(
                "--no-snapshot is for scratch copies only; the production database always gets a snapshot"
            )
        print("  snapshot: skipped (scratch copy)")
    elif args.apply:
        print(f"  snapshot: {snapshot(pg, Path(args.backups), 'org-move-' + org['slug'])}")
    started = time.time()
    notices: list[str] = []
    out = pg.psql(script, quiet=False, notices=notices)
    remaps = [ln.split("\t") for ln in out.splitlines() if ln.startswith("REMAP\t")]
    accts = [ln.split("\t") for ln in out.splitlines() if ln.startswith("ACCOUNT\t")]
    for ln in notices:
        if "pulse-org-move" in ln or "ERROR" in ln:
            print("  " + ln.split("NOTICE:  ")[-1])
    sys.stdout.write("".join(ln + "\n" for ln in out.splitlines() if not ln.startswith(("REMAP\t", "ACCOUNT\t"))))
    run = bundle_dir / f"import-{'apply' if args.apply else 'dryrun'}-{now()}.json"
    fd = os.open(run, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"applied": args.apply, "remap": [{"old": r[1], "new": r[2], "why": r[3]} for r in remaps],
                   "accounts": [{"source": a[1], "target": a[2], "how": a[3], "handle": a[4]} for a in accts]}, f, indent=1)
    by_why: dict[str, int] = {}
    for r in remaps:
        by_why[r[3]] = by_why.get(r[3], 0) + 1
    print(f"  remapped ids: {len(remaps)}" + (" (" + ", ".join(f"{k} {v}" for k, v in sorted(by_why.items())) + ")" if by_why else ""))
    if accts:
        hows: dict[str, int] = {}
        for a in accts:
            hows[a[3].split(",")[0]] = hows.get(a[3].split(",")[0], 0) + 1
        print("  accounts: " + ", ".join(f"{k} {v}" for k, v in sorted(hows.items()))
              + f"; renamed handles {sum(1 for a in accts if 'renamed' in a[3])}")
    print(f"  {'applied' if args.apply else 'dry run'} in {time.time() - started:.1f} s; details (ids only) in {run}")
    return 0


# --------------------------------------------------------------------------------------------- verify / census
def cmd_verify(args: argparse.Namespace) -> int:
    """After an apply: counts against the manifest, and what the API role sees inside and outside the organisation."""
    m = json.loads((Path(args.bundle) / "manifest.json").read_text(encoding="utf-8"))
    pg = Pg(args.exec, args.db_user, args.database)
    # The organisation may have a new id (--remap-ids): the import record of this bundle names it.
    oid = (
        pg.one_json(
            f"select to_json(org_id) from pulse.audit_event where resource = 'org' and action = 'import' and source = 'data-change' "
            f"and changes ->> 'bundle_sha256' = {lit(m['bundle_sha256'])} order by at limit 1;"
        )
        or m["org"]["id"]
    )
    expected = {e["table"]: e["rows"] for e in m["tables"]}
    # The import of this bundle writes one audit_event of its own, on top of the organisation's history (which may
    # already carry the record of an earlier move): count only records of this bundle.
    moves = (
        pg.one_json(
            f"select count(*) from pulse.audit_event where org_id = {lit(oid)} and resource = 'org' "
            f"and action = 'import' and actor_account like {lit('Data change ' + SCRIPT + '%')} "
            f"and changes ->> 'bundle_sha256' = {lit(m['bundle_sha256'])};"
        )
        or 0
    )
    expected["pulse.audit_event"] = expected.get("pulse.audit_event", 0) + int(moves)
    # Each organisation's viewer: an admin (the API's policies read as a signed-in person, never as nobody).
    admins = (
        pg.one_json("""select json_object_agg(o.id, (select r.person_id from pulse.role_assignment r join pulse.person p on p.id = r.person_id
        where r.org_id = o.id and r.role_key = 'admin' and p.status = 'active' and (r.valid_to is null or r.valid_to > current_date)
        order by r.valid_from nulls first, r.person_id limit 1)) from pulse.org o;""")
        or {}
    )
    viewer = args.viewer or admins.get(oid)
    others = {k: v for k, v in admins.items() if k != oid}

    def as_viewer(org: str, person: str | None) -> str:
        return (
            f"perform set_config('pulse.org_id', {lit(org)}, true); "
            f"perform set_config('pulse.viewer_id', {lit(person or '')}, true);"
        )

    sql = f"""begin read only;
do $v$
declare exp jsonb := {lit(json.dumps(expected))}::jsonb; k text; n bigint;
begin
  for k in select jsonb_object_keys(exp) order by 1 loop
    execute format('select count(*) from %s where org_id = %L', k::regclass, {lit(oid)}) into n;
    raise notice 'V%', json_build_object('t', k, 'expected', (exp ->> k)::bigint, 'rows', n);
  end loop;
end $v$;
set local role {qcol(args.api_role)};
do $v$
declare exp jsonb := {lit(json.dumps(expected))}::jsonb; k text; n bigint; f bigint;
begin
  {as_viewer(oid, viewer)}
  for k in select jsonb_object_keys(exp) order by 1 loop
    if not has_table_privilege(current_user, k::regclass, 'select') then
      raise notice 'V%', json_build_object('t', k, 'api', 'no select grant'); continue;
    end if;
    execute format('select count(*), count(*) filter (where org_id <> %L) from %s', {lit(oid)}, k::regclass) into n, f;
    raise notice 'V%', json_build_object('t', k, 'api_inside', n, 'api_foreign_inside', f);
  end loop;
end $v$;
"""
    for other, person in others.items():
        sql += f"""do $v$
declare exp jsonb := {lit(json.dumps(expected))}::jsonb; k text; n bigint; total bigint;
begin
  {as_viewer(other, person)}
  for k in select jsonb_object_keys(exp) order by 1 loop
    if not has_table_privilege(current_user, k::regclass, 'select') then continue; end if;
    execute format('select count(*) filter (where org_id = %L), count(*) from %s', {lit(oid)}, k::regclass) into n, total;
    raise notice 'V%', json_build_object('t', k, 'from', {lit(other)}, 'sees_moved', n, 'sees_own', total - n);
  end loop;
end $v$;
"""
    sql += "rollback;\n"
    notices: list[str] = []
    pg.psql(sql, notices=notices)
    bad, limited = 0, []
    for line in notices:
        if "V{" not in line:
            if line.strip() and "NOTICE" not in line:
                print(line)
            continue
        r = json.loads(line[line.index("V{") + 1 :])
        if "expected" in r and r["rows"] != r["expected"]:
            bad += 1
            print("MISMATCH", r)
        if r.get("api_foreign_inside") or r.get("sees_moved"):
            bad += 1
            print("ISOLATION", r)
        if "api_inside" in r and r["api_inside"] != expected[r["t"]]:
            limited.append(f"{r['t']} {r['api_inside']}/{expected[r['t']]}")
        if r.get("api") == "no select grant":
            limited.append(f"{r['t']} (API role has no select grant)")
    print(
        f"verify: {len(expected)} tables, counts {'match' if not bad else 'see above'} (audit includes {moves} move record); "
        f"read as {args.api_role} with an admin viewer inside, and from {len(others)} other organisation(s) as their admin: "
        f"{'none of the moved rows visible' if not bad else 'see above'}"
    )
    if limited:
        print(
            "  narrower API view (policies beyond org_id, e.g. private chats; expected):",
            "; ".join(limited),
        )
    return 1 if bad else 0


def cmd_census(args: argparse.Namespace) -> int:
    """Rows per organisation in every organisation table, as JSON lines (for a before/after diff)."""
    pg = Pg(args.exec, args.db_user, args.database)
    sql = f"""begin read only;
select format('select json_build_object(''t'', %L, ''by_org'', (select coalesce(json_object_agg(coalesce(org_id::text, ''-''), n), ''{{}}'') from (select org_id, count(*) n from %s group by 1) x));', n.nspname || '.' || c.relname, c.oid::regclass)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = any(string_to_array({lit(",".join(SCHEMAS))}, ',')) and c.relkind in ('r', 'p') and not c.relispartition
   and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped)
 order by 1 \\gexec
rollback;
"""
    proc = subprocess.Popen(
        pg.argv(
            "psql",
            *pg.conn(),
            "-X",
            "-q",
            "-A",
            "-t",
            "-v",
            "ON_ERROR_STOP=1",
        ),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
    )
    pg.soften()
    out, _ = proc.communicate(sql.encode())
    rows = [json.loads(x) for x in out.decode().splitlines() if x.startswith("{")]
    Path(args.out).write_text(json.dumps(rows, indent=0), encoding="utf-8")
    print(f"census: {len(rows)} tables -> {args.out}")
    return 0 if proc.returncode == 0 else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p: argparse.ArgumentParser, exec_: str, user: str) -> None:
        p.add_argument("--exec", default=exec_, help=f"how to reach psql (default: {exec_})")
        p.add_argument("--db-user", default=user)
        p.add_argument("--database", default="pulse")

    e = sub.add_parser("export", help="the organisation into a bundle (read only)")
    common(e, "docker exec -i pulse-postgres-1", "pulse_admin")
    e.add_argument("--org", required=True, help="id, slug or handle")
    e.add_argument("--out", required=True, help="a new directory (mode 700)")
    e.add_argument(
        "--carry-passwords",
        action="store_true",
        help="also carry password records and two-step state",
    )
    e.add_argument(
        "--carry-accounts",
        action="store_true",
        help="also carry the members' Pulse accounts (handles, profiles); the same human on the target joins theirs",
    )
    e.set_defaults(fn=cmd_export)

    i = sub.add_parser(
        "import", help="the bundle into the target, one transaction (dry run unless --apply)"
    )
    common(i, "docker exec -i ea-postgres", "ea_admin")
    i.add_argument("--bundle", required=True)
    i.add_argument(
        "--host",
        default="",
        help="the organisation's own address, password sign-in (pulse.org_domain)",
    )
    i.add_argument(
        "--link",
        default="",
        help="<account handle>=<person uuid>: link a target Pulse account to a moved person",
    )
    i.add_argument(
        "--licence-central",
        action="store_true",
        help="the licence register: hosting self-hosted -> central",
    )
    i.add_argument("--licence-note", default="")
    i.add_argument(
        "--remap-ids",
        action="store_true",
        help="give every id the target already uses a new one (in every staged row, uuid, uuid[], text and jsonb)",
    )
    i.add_argument("--as-slug", default="", help="the organisation's slug in the target, if its own is taken")
    i.add_argument("--as-code", default="", help="the organisation's code in the target, if its own is taken")
    i.add_argument("--as-handle", default="", help="the organisation's @handle in the target, if its own is taken")
    i.add_argument("--apply", action="store_true")
    i.add_argument("--approver", default="")
    i.add_argument("--words", default="")
    i.add_argument("--issue", default="")
    i.add_argument("--backups", default="/var/backups/pulse")
    i.add_argument(
        "--no-snapshot",
        action="store_true",
        help="scratch copies only: apply without a pg_dump first",
    )
    i.add_argument("--print-sql", action="store_true")
    i.set_defaults(fn=cmd_import)

    v = sub.add_parser("verify", help="after an apply: counts and the isolation read (read only)")
    common(v, "docker exec -i ea-postgres", "ea_admin")
    v.add_argument("--bundle", required=True)
    v.add_argument("--api-role", default="pulse_api")
    v.add_argument(
        "--viewer",
        default="",
        help="person uuid to read as inside the organisation (default: its first admin)",
    )
    v.set_defaults(fn=cmd_verify)

    c = sub.add_parser(
        "census", help="rows per organisation in every organisation table (read only)"
    )
    common(c, "docker exec -i ea-postgres", "ea_admin")
    c.add_argument("--out", required=True)
    c.set_defaults(fn=cmd_census)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
