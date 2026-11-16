"""Database helpers: connections and the per-transaction tenant context (05 §7)."""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager

import psycopg
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

ROLE_ENV = {
    "migrate": "PULSE_DATABASE_URL_MIGRATE",
    "api": "PULSE_DATABASE_URL_API",
    "worker": "PULSE_DATABASE_URL_WORKER",
    "ingest": "PULSE_DATABASE_URL_INGEST",
    "privacy": "PULSE_DATABASE_URL_PRIVACY",
}


def url_for(role: str) -> str:
    """The connection string for a service: PULSE_DATABASE_URL_<ROLE>; else, for env files with one app login that
    is a member of all four service roles, DATABASE_URL with SET ROLE pulse_<role> (and MIGRATE_DATABASE_URL for
    migrations)."""
    var = ROLE_ENV[role]
    url = os.environ.get(var)
    if url:
        return url
    if role == "migrate" and os.environ.get("MIGRATE_DATABASE_URL"):
        return os.environ["MIGRATE_DATABASE_URL"]
    if role != "migrate" and os.environ.get("DATABASE_URL"):
        return make_conninfo(os.environ["DATABASE_URL"], options=f"-c role=pulse_{role}")
    raise RuntimeError(f"{var} is not set (nor DATABASE_URL / MIGRATE_DATABASE_URL)")


def connect(url_or_role: str, **kwargs) -> psycopg.Connection:
    url = url_for(url_or_role) if url_or_role in ROLE_ENV else url_or_role
    kwargs.setdefault("row_factory", dict_row)
    kwargs.setdefault("application_name", "pulse")
    return psycopg.connect(url, **kwargs)


def set_tenant(conn: psycopg.Connection, org_id: uuid.UUID | str, viewer_id: uuid.UUID | str | None = None) -> None:
    """SET LOCAL pulse.org_id (and pulse.viewer_id) for the current transaction only."""
    conn.execute("select set_config('pulse.org_id', %s, true)", (str(org_id),))
    if viewer_id is not None:
        conn.execute("select set_config('pulse.viewer_id', %s, true)", (str(viewer_id),))


@contextmanager
def tenant_tx(conn: psycopg.Connection, org_id: uuid.UUID | str,
              viewer_id: uuid.UUID | str | None = None) -> Iterator[psycopg.Connection]:
    """One transaction scoped to one tenant: row-level security shows and accepts only that tenant's rows."""
    with conn.transaction():
        set_tenant(conn, org_id, viewer_id)
        yield conn


def active_orgs(conn: psycopg.Connection) -> list[uuid.UUID]:
    with conn.transaction():
        return [r["org"] if isinstance(r, dict) else r[0]
                for r in conn.execute("select pulse.list_active_orgs() as org").fetchall()]
