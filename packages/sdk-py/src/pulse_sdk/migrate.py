"""pulse-migrate: apply db/migrations and sync the event registry into pulse.event_type.

    pulse-migrate                      # PULSE_DATABASE_URL_MIGRATE: apply pending migrations, then sync the registry
    pulse-migrate --owner pulse_staging_owner   # owner role (default: $PULSE_DB_OWNER, else the database's owner)
    pulse-migrate --status             # list applied and pending migrations
    pulse-migrate --bootstrap-scratch  # scratch/CI databases only (superuser): roles, extensions, ownership

File format and bookkeeping follow dbmate (``-- migrate:up`` / ``-- migrate:down`` sections; applied versions in
``public.schema_migrations``), so dbmate and this runner are interchangeable. Each migration runs in one
transaction under SET LOCAL ROLE <owner>, so every object belongs to the database's owner group role (never to
the login). The registry sync runs the same way after every run (and with --sync-registry alone).
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

import psycopg

from . import registry as reg
from .paths import migrations_dir, repo_root

_FILE = re.compile(r"^(\d+)_[A-Za-z0-9_.-]+\.sql$")
LOCK_KEY = 0x50554C5345   # "PULSE": one migrator at a time per database (two containers may start together)
SERVICE_ROLES = ("pulse_api", "pulse_worker", "pulse_ingest", "pulse_privacy")


def migration_files(directory: Path | None = None) -> list[tuple[str, Path]]:
    directory = directory or migrations_dir()
    out = []
    for path in sorted(directory.glob("*.sql")):
        m = _FILE.match(path.name)
        if m:
            out.append((m.group(1), path))
    versions = [v for v, _ in out]
    if len(set(versions)) != len(versions):
        raise SystemExit(f"duplicate migration versions in {directory}")
    return out


def up_section(sql: str) -> str:
    m = re.search(r"^--\s*migrate:up[^\n]*\n(.*?)(^--\s*migrate:down|\Z)", sql, re.DOTALL | re.MULTILINE)
    if not m:
        raise ValueError("migration has no '-- migrate:up' section")
    return m.group(1)


def _can_set_role(conn: psycopg.Connection, role: str) -> bool:
    row = conn.execute(
        "select exists (select 1 from pg_roles where rolname = %s) and pg_has_role(current_user, %s, 'SET')",
        (role, role),
    ).fetchone()
    return bool(row[0])


def applied(conn: psycopg.Connection) -> set[str]:
    row = conn.execute("select to_regclass('public.schema_migrations')").fetchone()
    if row[0] is None:
        return set()
    return {r[0] for r in conn.execute("select version from public.schema_migrations").fetchall()}


def default_owner(conn: psycopg.Connection | None = None) -> str:
    """PULSE_DB_OWNER, else the current database's owner role (pulse_owner for production, pulse_<env>_owner for
    staging, dev and CI), else pulse_owner."""
    if os.environ.get("PULSE_DB_OWNER"):
        return os.environ["PULSE_DB_OWNER"]
    if conn is not None:
        row = conn.execute("select pg_get_userbyid(datdba) from pg_database where datname = current_database()"
                           ).fetchone()
        if row and row[0] and not conn.execute("select rolsuper from pg_roles where rolname = %s",
                                               (row[0],)).fetchone()[0]:
            return row[0]
    return "pulse_owner"


def _as_owner(conn: psycopg.Connection, owner: str) -> None:
    if not re.fullmatch(r"[a-z_][a-z0-9_]*", owner):
        raise SystemExit(f"bad owner role name {owner!r}")
    if not _can_set_role(conn, owner):
        raise SystemExit(f"this login cannot SET ROLE {owner} (is it a member of the owner role?)")
    conn.execute(f"set local role {owner}")


def migrate(conn: psycopg.Connection, directory: Path | None = None, *, owner: str | None = None,
            verbose: bool = True) -> list[str]:
    """Apply pending migrations in version order (connection in autocommit mode; one transaction each)."""
    owner = owner or default_owner(conn)
    done: list[str] = []
    conn.execute("select pg_advisory_lock(%s)", (LOCK_KEY,))
    try:
        with conn.transaction():
            _as_owner(conn, owner)
            conn.execute("create table if not exists public.schema_migrations (version varchar(128) primary key)")
        have = applied(conn)
        for version, path in migration_files(directory):
            if version in have:
                continue
            if verbose:
                print(f"applying {path.name}")
            with conn.transaction():
                _as_owner(conn, owner)
                conn.execute(up_section(path.read_text(encoding="utf-8")))
                conn.execute("insert into public.schema_migrations (version) values (%s)", (version,))
            done.append(version)
    finally:
        conn.execute("select pg_advisory_unlock(%s)", (LOCK_KEY,))
    return done


def sync_registry(conn: psycopg.Connection, registry: reg.Registry | None = None, *, owner: str | None = None) -> int:
    """Upsert every registered type into pulse.event_type and remove types no longer registered."""
    registry = registry or reg.load()
    with conn.transaction():
        conn.execute("select pg_advisory_xact_lock(%s)", (LOCK_KEY,))
        _as_owner(conn, owner or default_owner(conn))
        for et in registry.types.values():
            conn.execute(
                """insert into pulse.event_type (type, purposes, sensitivity, visibility, retention, emitters,
                                                 subject_re, data_required, data_allowed, registry_version, synced_at)
                   values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                   on conflict (type) do update set purposes = excluded.purposes, sensitivity = excluded.sensitivity,
                     visibility = excluded.visibility, retention = excluded.retention, emitters = excluded.emitters,
                     subject_re = excluded.subject_re, data_required = excluded.data_required,
                     data_allowed = excluded.data_allowed,
                     registry_version = excluded.registry_version, synced_at = now()""",
                (et.type, list(et.purposes), et.sensitivity, et.visibility, et.retention, list(et.emitters),
                 et.subject_re, list(et.data_required), list(et.data_required) + list(et.data_optional),
                 registry.version),
            )
        conn.execute("delete from pulse.event_type where not (type = any(%s))", (list(registry.types),))
    return len(registry.types)


def bootstrap_scratch(conn: psycopg.Connection) -> None:
    """For throwaway databases only (CI service container, tools/pg-scratch.sh): needs a superuser.

    Creates the A0 group roles and one login per service (same names as production: pulse_<svc>_login, no
    password: scratch and CI databases use trust authentication on localhost), the extensions, and makes
    pulse_owner own the database so the public schema works as in production.
    """
    if not conn.execute("select rolsuper from pg_roles where rolname = current_user").fetchone()[0]:
        raise SystemExit("--bootstrap-scratch needs a superuser connection (scratch or CI databases only)")
    name = conn.execute("select current_database()").fetchone()[0]
    if not re.fullmatch(r"pulse_ci(_[a-z0-9_]+)?", name):
        raise SystemExit(f"--bootstrap-scratch refuses database {name!r}: only pulse_ci or pulse_ci_*")
    roles_sql = (repo_root() / "db" / "roles.sql").read_text(encoding="utf-8")
    for stmt in re.findall(r"^create role (\w+)\s+nologin;", roles_sql, re.MULTILINE):
        conn.execute(f"do $$ begin create role {stmt} nologin; exception when duplicate_object then null; end $$")
    for svc, group in (("migrator", "pulse_owner"), ("api", "pulse_api"), ("worker", "pulse_worker"),
                       ("ingest", "pulse_ingest"), ("privacy", "pulse_privacy")):
        login = f"pulse_{svc}_login"
        conn.execute(f"""do $$ begin
            create role {login} login nosuperuser nocreatedb nocreaterole nobypassrls;
          exception when duplicate_object then null; end $$""")
        conn.execute(f"grant {group} to {login}")
    for ext in ("vector", "pg_trgm", "pgcrypto"):
        conn.execute(f"create extension if not exists {ext}")
    db = conn.execute("select current_database()").fetchone()[0]
    conn.execute(f'alter database "{db}" owner to pulse_owner')
    conn.execute("alter schema public owner to pg_database_owner")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pulse-migrate", description=__doc__.split("\n\n")[0])
    ap.add_argument("--url",
                    default=os.environ.get("PULSE_DATABASE_URL_MIGRATE") or os.environ.get("MIGRATE_DATABASE_URL"),
                    help="migration login URL (default: $PULSE_DATABASE_URL_MIGRATE, else $MIGRATE_DATABASE_URL); "
                         "never printed")
    ap.add_argument("--dir", type=Path, default=None, help="migrations directory (default: db/migrations)")
    ap.add_argument("--owner", default=None,
                    help="owner group role (default: $PULSE_DB_OWNER, else the database's owner role)")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--sync-registry", action="store_true", help="only sync the registry")
    ap.add_argument("--bootstrap-scratch", action="store_true",
                    help="superuser on a throwaway database: roles, logins, extensions, ownership")
    args = ap.parse_args(argv)
    if not args.url:
        print("no database URL (set PULSE_DATABASE_URL_MIGRATE or pass --url)", file=sys.stderr)
        return 2
    with psycopg.connect(args.url, autocommit=True, application_name="pulse-migrate") as conn:
        if args.bootstrap_scratch:
            bootstrap_scratch(conn)
            print("scratch bootstrap done (roles, logins, extensions, ownership)")
            return 0
        if args.status:
            have = applied(conn)
            for version, path in migration_files(args.dir):
                print(f"{'applied' if version in have else 'PENDING'}  {path.name}")
            return 0
        if not args.sync_registry:
            done = migrate(conn, args.dir, owner=args.owner)
            print(f"{len(done)} migration(s) applied" if done else "no pending migrations")
        n = sync_registry(conn, owner=args.owner)
        print(f"event registry synced: {n} types")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
