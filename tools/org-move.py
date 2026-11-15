#!/usr/bin/env python3
"""ORG (22 Oct 2026): plan moving one organisation from a separate Pulse into the shared Pulse (docs/ops/ORG-MOVE.md).

DRY RUN ONLY. It reads, never writes: the source and the target are opened read-only (default_transaction_read_only),
and nothing leaves this machine except the plan file you name.

    uv run --all-packages python tools/org-move.py --source "$SOURCE_URL" --target "$TARGET_URL" --org atlas-crest \
        --plan /tmp/ac-move-plan.json

What the plan says, table by table (every table with org_id in pulse, pulse_priv and privacy, as the isolation test
finds them): how many rows the organisation has; which identifiers keep their value (random UUIDs: an exact check
against the target proves none is taken) and which must be renumbered (sequence and identity columns get an offset
above the target's highest); every unique key that is global rather than per organisation (the organisation's slug,
code, handle and address, people's handles, e-mails) and whether the target already holds the same value; foreign keys
into tables that are not the organisation's (event types, purposes, the model registry) and whether the target has
every value they point at; and the migrations: the source must not be ahead of the target (update the source first).
The move itself (export, remap, import in one transaction, verify, switch the address) is the gated part in
ORG-MOVE.md: it runs only after the owner's yes.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict

import psycopg
import psycopg.sql
from psycopg.rows import dict_row

SCHEMAS = ("pulse", "pulse_priv", "privacy")


def connect(url: str, role: str | None) -> psycopg.Connection:
    conn = psycopg.connect(url, row_factory=dict_row, autocommit=True, options="-c default_transaction_read_only=on")
    conn.execute("set statement_timeout = '60s'")
    if role:
        conn.execute(psycopg.sql.SQL("set role {}").format(psycopg.sql.Identifier(role)))
    return conn


def tenant_tables(c) -> list[str]:
    return [r["t"] for r in c.execute(
        """select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
             join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
            where n.nspname = any(%s) and c.relkind in ('r', 'p') and not c.relispartition order by 1""", (list(SCHEMAS),)).fetchall()]


def q(table: str) -> str:
    return ".".join(f'"{p}"' for p in table.split("."))


def columns(c, table: str) -> list[dict]:
    s, t = table.split(".")
    return c.execute(
        """select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attidentity <> '' as identity,
                  coalesce(pg_get_expr(d.adbin, d.adrelid), '') as dflt
             from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
            where a.attrelid = %s::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum""", (f"{s}.{t}",)).fetchall()


def unique_keys(c, table: str) -> list[list[str]]:
    rows = c.execute(
        """select array_agg(a.attname order by k.ord) as cols from pg_index i
             cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
             join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
            where i.indrelid = %s::regclass and i.indisunique and i.indpred is null group by i.indexrelid""", (table,)).fetchall()
    return [r["cols"] for r in rows]


def foreign_keys(c, table: str) -> list[dict]:
    return c.execute(
        """select con.conname, (select array_agg(a.attname order by k.ord) from unnest(con.conkey) with ordinality k(n, ord)
                  join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n) as cols,
                  con.confrelid::regclass::text as ref,
                  (select array_agg(a.attname order by k.ord) from unnest(con.confkey) with ordinality k(n, ord)
                  join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n) as ref_cols
             from pg_constraint con where con.conrelid = %s::regclass and con.contype = 'f'""", (table,)).fetchall()


def as_owner(c, org: str):
    """Reads inside the organisation (the tables force row-level security, also for their owner)."""
    c.execute("select set_config('pulse.org_id', %s, false)", (org,))


def taken_in_target(dst, target_orgs: list[str], table: str, col: str, values: list) -> int:
    """How many of the values the target already uses, in any of its organisations (RLS is read one org at a time)."""
    taken = 0
    for org in target_orgs:
        as_owner(dst, org)
        for i in range(0, len(values), 5000):
            taken += dst.execute(f'select count(*) as n from {q(table)} where "{col}" = any(%s)', (values[i:i + 5000],)).fetchone()["n"]
    return taken


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--source", required=True, help="the separate Pulse's database (an owner-role login; read only)")
    ap.add_argument("--target", required=True, help="the shared Pulse's database (an owner-role login; read only)")
    ap.add_argument("--org", required=True, help="the organisation in the source: its id, slug or handle")
    ap.add_argument("--source-role", help="SET ROLE to the source database's owner role after connecting (e.g. pulse_owner)")
    ap.add_argument("--target-role", help="SET ROLE to the target database's owner role after connecting")
    ap.add_argument("--plan", help="write the full plan here (JSON)")
    ap.add_argument("--id-check-limit", type=int, default=200_000, help="exact UUID checks for tables up to this many rows")
    args = ap.parse_args()

    src, dst = connect(args.source, args.source_role), connect(args.target, args.target_role)
    org = src.execute("select id, name, slug, code, handle from pulse.org where id::text = %s or slug = %s or handle = %s",
                      (args.org, args.org, args.org)).fetchone() if src.execute(
        "select 1 from information_schema.columns where table_schema='pulse' and table_name='org' and column_name='handle'").fetchone() else \
        src.execute("select id, name, slug, code, null as handle from pulse.org where id::text = %s or slug = %s", (args.org, args.org)).fetchone()
    if not org:
        print(f"No organisation {args.org!r} in the source (read as its owner role: pulse.org's directory policy)."); return 2
    oid = str(org["id"])
    as_owner(src, oid)
    plan: dict = {"org": {k: (str(v) if v is not None else None) for k, v in org.items()}, "dry_run": True, "tables": [], "problems": [], "warnings": []}

    # Migrations: the source must not be ahead of the target.
    s_mig = {r["version"] for r in src.execute("select version from public.schema_migrations").fetchall()}
    d_mig = {r["version"] for r in dst.execute("select version from public.schema_migrations").fetchall()}
    plan["migrations"] = {"source": max(s_mig) if s_mig else None, "target": max(d_mig) if d_mig else None,
                          "source_only": sorted(s_mig - d_mig), "target_only": sorted(d_mig - s_mig)}
    if s_mig - d_mig:
        plan["problems"].append(f"The source has migrations the target does not: {sorted(s_mig - d_mig)[:5]}… update the target first")
    if d_mig - s_mig:
        plan["warnings"].append(f"{len(d_mig - s_mig)} target migrations are not on the source: update the source (pulse-update.sh) before exporting, so both have one schema")

    s_tables, d_tables = tenant_tables(src), set(tenant_tables(dst))
    target_orgs = [str(r["id"]) for r in dst.execute("select id from pulse.org").fetchall()]
    plan["target_orgs"] = len(target_orgs)
    if oid in target_orgs:
        plan["problems"].append("The target already has an organisation with this id")
    for missing in sorted(set(s_tables) - d_tables):
        plan["problems"].append(f"{missing} exists only in the source")
    global_tables = set()
    sequences: dict[str, list[str]] = defaultdict(list)
    for table in s_tables:
        n = src.execute(f"select count(*) as n from {q(table)} where org_id = %s", (oid,)).fetchone()["n"]
        entry: dict = {"table": table, "rows": n, "keep": [], "renumber": [], "global_unique": [], "foreign": []}
        if table not in d_tables:
            plan["tables"].append(entry); continue
        cols = columns(src, table)
        uniq = unique_keys(src, table)
        for col in cols:
            if col["identity"] or col["dflt"].startswith("nextval("):
                entry["renumber"].append(col["name"]); sequences[table].append(col["name"])
        # Global unique keys (not scoped by org_id): the same value in the target is a collision to resolve.
        for key in uniq:
            if "org_id" in key or not n:
                continue
            uuid_key = len(key) == 1 and next((c["type"] for c in cols if c["name"] == key[0]), "") == "uuid"
            if uuid_key:
                entry["keep"].append(key[0])
                if n <= args.id_check_limit:
                    ids = [r["v"] for r in src.execute(f'select "{key[0]}" as v from {q(table)} where org_id = %s', (oid,)).fetchall()]
                    taken = taken_in_target(dst, target_orgs, table, key[0], ids)
                    entry["uuid_taken"] = taken
                    if taken:
                        plan["problems"].append(f"{table}.{key[0]}: {taken} ids already used in the target (remap them)")
                continue
            if any(k in entry["renumber"] for k in key):
                continue
            vals = src.execute(f'select {", ".join(chr(34) + k + chr(34) for k in key)} from {q(table)} where org_id = %s', (oid,)).fetchall()
            item = {"key": key, "values": len(vals)}
            if len(key) == 1 and vals:
                item["taken_in_target"] = taken_in_target(dst, target_orgs, table, key[0], [v[key[0]] for v in vals if v[key[0]] is not None])
                if item["taken_in_target"]:
                    plan["problems"].append(f"{table}.{key[0]}: {item['taken_in_target']} values already used in the target (rename or remap)")
            else:
                item["note"] = "several columns: checked during the gated move"
            entry["global_unique"].append(item)
            global_tables.add(table)
        for fk in foreign_keys(src, table):
            if fk["ref"] in s_tables or fk["ref"] == "pulse.org":
                continue
            ref_vals = src.execute(f'select distinct {", ".join(chr(34) + k + chr(34) for k in fk["cols"])} from {q(table)} where org_id = %s and {" and ".join(chr(34) + k + chr(34) + " is not null" for k in fk["cols"])}', (oid,)).fetchall()
            missing = 0
            for v in ref_vals[:5000]:
                cond = " and ".join(f'"{rc}" = %s' for rc in fk["ref_cols"])
                if not dst.execute(f"select 1 from {fk['ref']} where {cond}", tuple(v.values())).fetchone():
                    missing += 1
            entry["foreign"].append({"to": fk["ref"], "values": len(ref_vals), "missing_in_target": missing})
            if missing:
                plan["problems"].append(f"{table} → {fk['ref']}: {missing} values the target does not have (deploy the same release first)")
        plan["tables"].append(entry)

    # The organisation's own global names.
    for col, label in (("slug", "short name"), ("code", "code"), ("handle", "handle")):
        v = org.get(col)
        if v and dst.execute(f"select 1 from pulse.org where {col} = %s and id::text <> %s", (v, oid)).fetchone():
            plan["problems"].append(f"The target already has an organisation with {label} {v!r}: choose another before the move")
    hosts = [r["host"] for r in src.execute("select host from pulse.org_domain where org_id = %s", (oid,)).fetchall()] if "pulse.org_domain" in s_tables else []
    for h in hosts:
        if dst.execute("select 1 from pulse.org_domain where host = %s", (h,)).fetchone():
            plan["problems"].append(f"The address {h} is already claimed in the target")
    plan["addresses"] = hosts
    plan["summary"] = {"tables": len(plan["tables"]), "rows": sum(t["rows"] for t in plan["tables"]),
                       "tables_with_rows": sum(1 for t in plan["tables"] if t["rows"]), "renumber_columns": sum(len(v) for v in sequences.values()),
                       "tables_with_global_keys": sorted(global_tables), "ready": not plan["problems"]}
    if args.plan:
        with open(args.plan, "w", encoding="utf-8") as f:
            json.dump(plan, f, indent=1, default=str)
    s = plan["summary"]
    print(f"{org['name']} ({org['code']}): {s['rows']} rows in {s['tables_with_rows']} of {s['tables']} tables; "
          f"{s['renumber_columns']} sequence columns to renumber; global keys in {len(s['tables_with_global_keys'])} tables.")
    print(f"migrations: source {plan['migrations']['source']}, target {plan['migrations']['target']}")
    for w in plan["warnings"]:
        print("warning:", w)
    for p in plan["problems"]:
        print("blocks the move:", p)
    print("READY for the gated move (owner's yes)" if s["ready"] else "NOT READY: resolve the lines above first", "· dry run, nothing written")
    return 0 if s["ready"] else 1


if __name__ == "__main__":
    sys.exit(main())
