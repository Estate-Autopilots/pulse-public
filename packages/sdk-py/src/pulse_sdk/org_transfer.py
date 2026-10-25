"""Shared organisation-transfer catalogue, classifications and JSON UUID path checks (ADR-0033 §7)."""

from __future__ import annotations

import argparse
import json
import os
import re
from collections import Counter
from pathlib import Path

from psycopg import sql
from psycopg.rows import dict_row, tuple_row

from .db import connect, set_tenant
from .paths import repo_root

MANIFEST = repo_root() / "db/org-transfer/manifest.jsonl"
UUID = re.compile(r"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
# Reviewed global parents outside tenant transfer; import must resolve these before loading rows.
SHARED_FK_PARENTS = {
    "privacy.purpose": "Destination registry seed, resolved by code.",
    "privacy.retention_class": "Destination registry seed, resolved by code.",
    "pulse_priv.pulse_account": "Target account-link mapping required; never copy sign-in credentials.",
}
# Keep identical to test_acceptance_isolation.tenant_tables(), then include the org row itself.
TENANT_TABLES = """select n.nspname || '.' || c.relname as t
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
    where n.nspname in ('pulse', 'pulse_priv', 'privacy') and c.relkind in ('r', 'p') and not c.relispartition
    order by 1"""


def catalogue(conn) -> tuple[dict, list[tuple[str, str, str]]]:
    """Return tenant JSONB columns and FK edges together, including non-deferrable/nullable edges."""
    with conn.cursor(row_factory=dict_row) as cur:
        tables = {r["t"]: [] for r in cur.execute(TENANT_TABLES)}
        tables["pulse.org"] = []
        for r in cur.execute("""select n.nspname || '.' || c.relname as t, a.attname as col
            from pg_class c join pg_namespace n on n.oid=c.relnamespace
            join pg_attribute a on a.attrelid=c.oid
            where a.atttypid='jsonb'::regtype and a.attnum>0 and not a.attisdropped order by 1,2"""):
            if r["t"] in tables:
                tables[r["t"]].append(r["col"])
    with conn.cursor(row_factory=tuple_row) as cur:
        fks = list(cur.execute("""select cn.nspname || '.' || child.relname,
            pn.nspname || '.' || parent.relname, fk.conname from pg_constraint fk
            join pg_class child on child.oid=fk.conrelid join pg_namespace cn on cn.oid=child.relnamespace
            join pg_class parent on parent.oid=fk.confrelid join pg_namespace pn on pn.oid=parent.relnamespace
            where fk.contype='f' order by 1,2,3"""))
    return dict(sorted(tables.items())), fks


def load(path: Path = MANIFEST) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def refresh(tables: dict, entries: list[dict]) -> list[dict]:
    """Preserve every authored field/entry, including stale ones; require a decision for new tables."""
    entries = json.loads(json.dumps(entries))
    known = {e["table"] for e in entries}
    for table in tables:
        if table not in known:
            entries.append({"table": table, "class": "unclassified", "jsonb": {}})
    return sorted(entries, key=lambda e: e["table"])


def dump(entries: list[dict]) -> str:
    return "".join(json.dumps(e, sort_keys=True, separators=(",", ":")) + "\n"
                   for e in sorted(entries, key=lambda e: e["table"]))


def static_problems(catalog: tuple, entries: list[dict]) -> list[str]:
    tables, fks = catalog
    problems, seen = [], set()
    classes = {e["table"]: e.get("class") for e in entries}
    allowed = {"copy": {"copy"}, "rebuild": {"copy", "rebuild"}}
    for child, parent, constraint in fks:
        if parent not in tables and parent in SHARED_FK_PARENTS:
            continue
        if classes.get(child) in allowed and classes.get(parent) not in allowed[classes[child]]:
            problems.append(f"{child}: foreign key {constraint} references {classes.get(parent, 'unclassified')} "
                            f"table {parent} (invalid FK closure)")
    if [e["table"] for e in entries] != sorted(e["table"] for e in entries):
        problems.append("manifest: tables must be sorted")
    for e in entries:
        table = e["table"]
        if table in seen:
            problems.append(f"{table}: duplicate entry")
        seen.add(table)
        if table not in tables:
            problems.append(f"{table}: stale entry (remove explicitly after review)")
        if e.get("class") not in {"copy", "rebuild", "skip"}:
            problems.append(f"{table}: unclassified or invalid class")
        if e.get("class") == "skip":
            if not isinstance(e.get("reason"), str) or not e["reason"].strip():
                problems.append(f"{table}: skip requires a reason")
            continue
        declarations = e.get("jsonb", {})
        for col in sorted(set(tables.get(table, [])) - set(declarations)):
            problems.append(f"{table}.{col}: undeclared jsonb column")
        for col, paths in declarations.items():
            if col not in tables.get(table, []):
                problems.append(f"{table}.{col}: stale jsonb column")
            if not isinstance(paths, list) or any(
                not isinstance(p, str) or not (p == col or p.startswith((col + ".", col + "[]")))
                for p in paths
            ):
                problems.append(f"{table}.{col}: paths must be a list rooted at the column (or [])")
    problems += [f"{t}: unclassified table (missing entry)" for t in sorted(set(tables) - seen)]
    return sorted(problems)


def uuid_paths(value, path: str):
    if isinstance(value, dict):
        for key, child in value.items():
            yield from uuid_paths(child, f"{path}.{key}")
    elif isinstance(value, list):
        for child in value:
            yield from uuid_paths(child, path + "[]")
    elif isinstance(value, str) and UUID.fullmatch(value):
        yield path


def column_security_problems(columns: dict, entries: list[dict]) -> list[str]:
    """Metadata only: fail closed for known envelope layouts and credential column conventions."""
    special = {"pulse_priv.identity_document": "file", "pulse_priv.person_onboarding": "bank",
               "pulse_priv.acq_lead_media": "bytes"}
    problems = []
    for e in entries:
        table, sealed, credentials = e["table"], e.get("sealed", {}), e.get("credentials", {})
        for col in columns.get(table, []):
            if (col in {"s_data", "p_data", "r_data", special.get(table)} or col.endswith("_sealed")):
                if col not in sealed:
                    problems.append(f"{table}.{col}: missing sealed context")
            if col in {"token_hash", "password_hash", "signing_secret"} and col not in credentials:
                problems.append(f"{table}.{col}: missing credential decision")
        for col, s in sealed.items():
            refs = [col, str(s.get("key_id", "")).split(".")[0], str(s.get("data_key", "")).split(".")[0]]
            if (any(ref not in columns.get(table, []) for ref in refs)
                    or not s.get("context_kind") or "{org_id}" not in s.get("context", "")
                    or s.get("encoding") not in {"columns", "base64-json:k,w,d"}):
                problems.append(f"{table}.{col}: invalid sealed declaration")
        for col, decision in credentials.items():
            if (col not in columns.get(table, []) or decision.get("export") is not False
                    or decision.get("on_import") not in {"revoke", "rotate"}):
                problems.append(f"{table}.{col}: invalid credential decision")
    return sorted(problems)


def security_problems(conn, entries: list[dict]) -> list[str]:
    with conn.cursor(row_factory=tuple_row) as cur:
        rows = cur.execute("""select n.nspname || '.' || c.relname, array_agg(a.attname)
            from pg_class c join pg_namespace n on n.oid=c.relnamespace
            join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
            where n.nspname in ('pulse','pulse_priv','privacy') and c.relkind in ('r','p')
            group by n.nspname,c.relname""")
        return column_security_problems(dict(rows), entries)


def jsonb_problems(conn, entries: list[dict], org_id) -> list[str]:
    """Walk one tenant under its existing RLS; report paths, never values or row identifiers."""
    problems = set()
    with conn.transaction(), conn.cursor(row_factory=dict_row) as cur:
        set_tenant(conn, org_id)
        for e in entries:
            if e["class"] not in {"copy", "rebuild"}:
                continue
            for col, allowed in e.get("jsonb", {}).items():
                query = sql.SQL("select {} as value from {} where {}=%s").format(
                    sql.Identifier(col), sql.Identifier(*e["table"].split(".")),
                    sql.Identifier("id" if e["table"] == "pulse.org" else "org_id"))
                for row in cur.execute(query, (org_id,)):
                    for path in uuid_paths(row["value"], col):
                        if not any(re.fullmatch(re.escape(p).replace(r"\*", r"[^.\[\]]+"), path) for p in allowed):
                            problems.add(f"{e['table']}.{path}: undeclared UUID path")
    return sorted(problems)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["manifest"])
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    args = parser.parse_args()
    entries = load(args.manifest) if args.manifest.exists() else []
    with connect(os.environ.get("PULSE_CI_DATABASE_URL") or "migrate",
                 autocommit=True, options="-c default_transaction_read_only=on -c statement_timeout=60000") as conn:
        catalog = catalogue(conn)
        security = security_problems(conn, entries)
    if not args.check:
        entries = refresh(catalog[0], entries)
        args.manifest.parent.mkdir(parents=True, exist_ok=True)
        args.manifest.write_text(dump(entries))
    problems = static_problems(catalog, entries) + security
    for problem in problems:
        print(problem)
    print(json.dumps(dict(sorted(Counter(e.get("class", "unclassified") for e in entries).items()))))
    return int(bool(problems))


if __name__ == "__main__":
    raise SystemExit(main())
