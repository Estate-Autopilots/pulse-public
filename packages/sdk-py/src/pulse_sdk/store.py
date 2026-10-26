"""Idempotent inserts into the log (02 §3.3): the right table per retention class, duplicates reported, each event
in its own savepoint so one rejection does not abort the batch."""

from __future__ import annotations

from dataclasses import dataclass

import psycopg
from psycopg.types.json import Jsonb

from . import registry as reg
from .envelope import ROW_COLUMNS

_PLACEHOLDERS = ", ".join(f"%({c})s" for c in ROW_COLUMNS)
_SQL = {
    table: (f"insert into pulse.{table} ({', '.join(ROW_COLUMNS)}) values ({_PLACEHOLDERS}) "
            "on conflict do nothing")   # the only possible conflict is the idempotency key (org, source, id, time)
    for table in ("event", "event_ephemeral")
}


@dataclass
class StoreResult:
    status: str                  # accepted | duplicate | rejected
    error: str | None = None


def insert_event(conn: psycopg.Connection, row: dict, registry: reg.Registry | None = None) -> StoreResult:
    """Insert one row (from envelope.to_row). Must run inside a transaction scoped to row['org_id']."""
    registry = registry or reg.default()
    et = registry.get(row["type"])
    table = "event_ephemeral" if et is not None and et.ephemeral else "event"
    params = dict(row)
    params["data"] = Jsonb(row.get("data") or {})
    try:
        with conn.transaction():          # savepoint
            inserted = conn.execute(_SQL[table], params).rowcount
    except psycopg.errors.CheckViolation as exc:
        return StoreResult("rejected", error=str(exc.diag.message_primary or exc))
    except psycopg.errors.InsufficientPrivilege as exc:
        return StoreResult("rejected", error=f"not allowed: {exc.diag.message_primary or exc}")
    except (psycopg.DataError, psycopg.IntegrityError, psycopg.errors.ProgramLimitExceeded) as exc:
        # NUL or untranslatable characters, values out of range, an oversized key: this event only, never the batch
        message = exc.diag.message_primary if getattr(exc, "diag", None) and exc.diag.message_primary else str(exc)
        return StoreResult("rejected", error=f"invalid data: {message}"[:500])
    # No RETURNING: service roles may insert into the log without being able to read it (05 §9).
    return StoreResult("accepted" if inserted == 1 else "duplicate")


def notify(conn: psycopg.Connection, org_id) -> None:
    """Wake consumers after commit (payload is only a hint; consumers also poll, 05 §6)."""
    conn.execute("select pg_notify('pulse_events', %s)", (str(org_id),))
