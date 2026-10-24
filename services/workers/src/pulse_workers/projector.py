"""Projections (02 §5): tables built only from the log plus configuration, each with a per-tenant cursor and a
deterministic ``apply``. Rebuilding replays the whole log in one transaction (with foreign keys into projection
tables deferred) and, because projection ids are deterministic and ``apply`` never reads the clock, gives exactly
the rows the incremental run produced.
"""

from __future__ import annotations

import hashlib
import logging
import uuid
from collections.abc import Callable

import psycopg

from pulse_sdk.db import active_orgs, set_tenant

from .consumer import Event, read_batch

log = logging.getLogger("pulse.projector")


class Projection:
    name: str = ""
    version: int = 1
    # Tables owned by this projection, children first (the order rows are deleted in on rebuild). Each has org_id.
    tables: tuple[str, ...] = ()

    def begin(self, conn: psycopg.Connection, org_id: uuid.UUID) -> None:
        """Called once per batch inside the tenant transaction (load the active configuration here)."""

    def apply(self, conn: psycopg.Connection, event: Event) -> None:
        raise NotImplementedError


# Connection-level failures end the run (the caller reconnects); everything else is about one event or one tenant.
FATAL = (psycopg.OperationalError, psycopg.InterfaceError)


class ProjectionRunner:
    def __init__(self, conn: psycopg.Connection, projection: Projection, batch: int = 500,
                 on_error: Callable[[str], None] | None = None):
        self.conn = conn
        self.p = projection
        self.batch = batch
        self.on_error = on_error

    # ------------------------------------------------------------------------------------------------- cursor
    def _cursor(self) -> tuple[int, int]:
        row = self.conn.execute(
            """insert into pulse.projection_cursor (org_id, name, version) values (pulse.current_org(), %s, %s)
               on conflict (org_id, name, version) do update set name = excluded.name
               returning last_tx::text as tx, last_seq""",
            (self.p.name, self.p.version),
        ).fetchone()
        return int(row["tx"]), row["last_seq"]

    def _save(self, tx: int, seq: int, status: str = "live") -> None:
        self.conn.execute(
            """update pulse.projection_cursor set last_tx = %s::xid8, last_seq = %s, status = %s, updated_at = now()
                where org_id = pulse.current_org() and name = %s and version = %s""",
            (str(tx), seq, status, self.p.name, self.p.version),
        )

    # ------------------------------------------------------------------------------------------------ running
    def _apply_batch(self, events: list[Event]) -> None:
        """Each event in its own savepoint: one that cannot be applied is quarantined and the cursor moves on."""
        for ev in events:
            try:
                with self.conn.transaction():
                    self.p.apply(self.conn, ev)
            except FATAL:
                raise
            except Exception as exc:  # noqa: BLE001 - a bad event must never stop the pipeline
                self._quarantine(ev, exc)

    def _quarantine(self, ev: Event, exc: Exception) -> None:
        error = f"{type(exc).__name__}: {exc}"[:1000]
        self.conn.execute(
            """insert into pulse.projection_error (org_id, name, version, event_seq, event_time, event_type, error)
               values (pulse.current_org(), %s, %s, %s, %s, %s, %s)
               on conflict (org_id, name, version, event_seq) do update set error = excluded.error""",
            (self.p.name, self.p.version, ev.seq, ev.time, ev.type, error))
        message = f"{self.p.name} v{self.p.version}: event {ev.seq} ({ev.type}) quarantined: {error}"
        log.error(message)
        if self.on_error:
            self.on_error(message)

    def run_once(self, org_id: uuid.UUID) -> int:
        """Apply the next batch of committed events for one tenant; returns how many were applied."""
        with self.conn.transaction():
            set_tenant(self.conn, org_id)
            last_tx, last_seq = self._cursor()
            events = read_batch(self.conn, last_tx, last_seq, self.batch)
            if not events:
                return 0
            self.p.begin(self.conn, org_id)
            self._apply_batch(events)
            self._save(*events[-1].position)
            return len(events)

    def catch_up(self, org_id: uuid.UUID) -> int:
        total = 0
        while n := self.run_once(org_id):
            total += n
        return total

    def run_all(self) -> dict[uuid.UUID, int]:
        """Catch up every tenant; a failure in one tenant is logged and the others still run."""
        done: dict[uuid.UUID, int] = {}
        for org in active_orgs(self.conn):
            try:
                done[org] = self.catch_up(org)
            except FATAL:
                raise
            except Exception as exc:  # noqa: BLE001
                message = f"{self.p.name}: tenant {org} failed: {type(exc).__name__}: {exc}"[:1000]
                log.error(message)
                if self.on_error:
                    self.on_error(message)
                done[org] = -1
        return done

    def rebuild(self, org_id: uuid.UUID) -> int:
        """Delete this tenant's projection rows and replay its whole log, atomically (readers see the old rows
        until commit)."""
        total = 0
        with self.conn.transaction():
            set_tenant(self.conn, org_id)
            self.conn.execute("set constraints all deferred")
            for table in self.p.tables:
                if table == "pulse.task":
                    # Company imports and manually corrected tasks are records, not disposable event projections.
                    self.conn.execute("delete from pulse.task where org_id = pulse.current_org() "
                                      "and source_key is null and edited_by is null")
                else:
                    self.conn.execute(f"delete from {table} where org_id = pulse.current_org()")
            self.conn.execute("delete from pulse.projection_error where org_id = pulse.current_org() "
                              "and name = %s and version = %s", (self.p.name, self.p.version))
            self._cursor()
            self._save(0, 0, "building")
            last = (0, 0)
            while True:
                events = read_batch(self.conn, last[0], last[1], self.batch)
                if not events:
                    break
                self.p.begin(self.conn, org_id)
                self._apply_batch(events)
                last = events[-1].position
                total += len(events)
            self._save(*last, "live")
        return total


def fingerprint(conn: psycopg.Connection, org_id: uuid.UUID, tables: tuple[str, ...]) -> dict[str, str]:
    """A content hash per projection table for one tenant (every column, rows in primary-key order)."""
    out = {}
    with conn.transaction():
        set_tenant(conn, org_id)
        for table in tables:
            schema, name = table.split(".")
            pk = conn.execute(
                """select string_agg(quote_ident(a.attname), ', ' order by array_position(i.indkey, a.attnum))
                     from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
                    where i.indrelid = %s::regclass and i.indisprimary""",
                (table,),
            ).fetchone()["string_agg"]
            rows = conn.execute(
                f"select t::text as r from {schema}.{name} t where org_id = pulse.current_org() order by {pk}"
            ).fetchall()
            digest = hashlib.sha256("\n".join(r["r"] for r in rows).encode()).hexdigest()
            out[table] = f"{len(rows)}:{digest[:16]}"
    return out
