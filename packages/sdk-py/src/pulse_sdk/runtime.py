"""The collector runtime (05 §5.2): what every collector gets for free and cannot forget.

- raw first: every fetched page goes to pulse.raw_inbox, in the same transaction as the cursor that produced it;
- the normaliser runs over raw_inbox (re-runnable: deterministic event ids make a re-run a no-op);
- every event is validated (envelope, registry, the manifest's ``emits``) and consent-checked before storage;
  uncovered events are dropped and counted, never stored;
- a raw record whose events fail validation is retried, then dead-lettered (raw_inbox.error) with an alert;
- backfills commit at most ``batch_events`` (<= 1,000) events per transaction, so consumers are not held back.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from . import registry as reg
from .collector import Collector, Cursor, RawRecord, TenantContext
from .db import set_tenant
from .envelope import to_row
from .privacy import Coverage
from .store import insert_event, notify
from .ulid import deterministic_ulid
from .validate import EventValidator, parse_time

log = logging.getLogger("pulse.collector")

MAX_ATTEMPTS = 3
MAX_BATCH_EVENTS = 1000


@dataclass
class RunReport:
    raw_stored: int = 0
    raw_processed: int = 0
    events_accepted: int = 0
    events_duplicate: int = 0
    events_dropped: int = 0                  # consent/notice/exclusion: counted, not stored
    dead_letters: int = 0
    retried: int = 0
    reasons: dict[str, int] = field(default_factory=dict)

    def count(self, reason: str) -> None:
        self.reasons[reason] = self.reasons.get(reason, 0) + 1


class CollectorRuntime:
    def __init__(self, conn: psycopg.Connection, collector: Collector, *,
                 registry: reg.Registry | None = None, validator: EventValidator | None = None,
                 batch_events: int = MAX_BATCH_EVENTS, on_dead_letter: Callable[[str, str], None] | None = None,
                 now: Callable[[], datetime] | None = None):
        if batch_events > MAX_BATCH_EVENTS:
            raise ValueError("batch_events must be <= 1000 (05 §6: long transactions stall every consumer)")
        self.conn = conn
        self.collector = collector
        self.manifest = collector.manifest
        self.registry = registry or reg.default()
        self.validator = validator or EventValidator(self.registry)
        self.batch_events = batch_events
        self.on_dead_letter = on_dead_letter
        self.now = now or (lambda: datetime.now(UTC))
        unknown = [t for t in self.manifest.emits if t not in self.registry]
        if unknown:
            raise ValueError(f"{self.manifest.name} emits unregistered types: {unknown}")

    # ------------------------------------------------------------------------------------------------ fetching
    def poll(self, ctx: TenantContext, scope_key: str = "default") -> RunReport:
        """One incremental pull: raw records and the new cursor in one transaction, then normalise."""
        report = RunReport()
        with self.conn.transaction():
            set_tenant(self.conn, ctx.org_id)
            cursor = self._cursor(scope_key)
            records, new_cursor = self.collector.poll(ctx, cursor)
            report.raw_stored += self._store_raw(ctx, records)
            self._save_cursor(scope_key, new_cursor)
        self.normalise_pending(ctx, report)
        return report

    def backfill(self, ctx: TenantContext, since: datetime, scope_key: str = "backfill") -> RunReport:
        report = RunReport()
        with self.conn.transaction():
            set_tenant(self.conn, ctx.org_id)
            cursor = self._cursor(scope_key)
        for records, new_cursor in self.collector.backfill(ctx, since, cursor):
            with self.conn.transaction():
                set_tenant(self.conn, ctx.org_id)
                report.raw_stored += self._store_raw(ctx, records)
                self._save_cursor(scope_key, new_cursor)
            self.normalise_pending(ctx, report)
        return report

    def push(self, ctx: TenantContext, records: list[RawRecord]) -> RunReport:
        report = RunReport()
        with self.conn.transaction():
            set_tenant(self.conn, ctx.org_id)
            report.raw_stored += self._store_raw(ctx, records)
        self.normalise_pending(ctx, report)
        return report

    # --------------------------------------------------------------------------------------------- normalising
    def normalise_pending(self, ctx: TenantContext, report: RunReport | None = None, limit: int = 10_000) -> RunReport:
        """Turn unprocessed raw records into events, at most batch_events events per transaction."""
        report = report or RunReport()
        source = self.manifest.source(ctx.instance)
        done, after = 0, 0          # each record is tried at most once per run; retries happen on later runs
        while done < limit:
            with self.conn.transaction():
                set_tenant(self.conn, ctx.org_id)
                pending = self.conn.execute(
                    """select id, source_ref, payload, received_at, attempts from pulse.raw_inbox
                        where source = %s and processed_at is null and attempts < %s and id > %s
                        order by id limit 200""",
                    (source, MAX_ATTEMPTS, after),
                ).fetchall()
                if not pending:
                    break
                coverage = Coverage(self.conn)
                in_tx = 0
                for raw in pending:
                    if in_tx >= self.batch_events:
                        break
                    in_tx += self._normalise_one(ctx, source, raw, coverage, report)
                    after = raw["id"]
                    done += 1
                notify(self.conn, ctx.org_id)
        return report

    def _normalise_one(self, ctx: TenantContext, source: str, raw: dict, coverage: Coverage,
                       report: RunReport) -> int:
        record = RawRecord(raw["source_ref"], raw["payload"], raw["received_at"])
        problems: list[str] = []
        rows: list[dict[str, Any]] = []
        try:
            events = self.collector.normalise(ctx, record)
        except Exception as exc:  # a collector bug must not stop the other records
            events, problems = [], [f"normalise failed: {type(exc).__name__}: {exc}"]
        for ordinal, event in enumerate(events):
            event = self._complete(ctx, source, record, event, ordinal)
            errs = self.validator.errors(event, now=self.now())
            if event.get("type") not in self.manifest.emits:
                errs.append(f"type {event.get('type')} is not in {self.manifest.name}'s manifest")
            if errs:
                problems.append(f"{event.get('type')}: {'; '.join(errs)}")
            else:
                rows.append(to_row(event))
        if problems:
            self._fail(raw, "; ".join(problems)[:2000], report)
            return 0
        accepted = duplicate = 0
        dropped: list[str] = []
        try:
            with self.conn.transaction():        # savepoint: a record's events land together or not at all
                for row in rows:
                    reason = coverage.reason_not_covered(row)
                    if reason:
                        dropped.append(reason)
                        continue
                    result = insert_event(self.conn, row, self.registry)
                    if result.status == "accepted":
                        accepted += 1
                    elif result.status == "duplicate":
                        duplicate += 1
                    else:
                        raise _Rejected(result.error or "rejected by the database")
                self.conn.execute("update pulse.raw_inbox set processed_at = now(), error = null where id = %s",
                                  (raw["id"],))
        except _Rejected as exc:
            self._fail(raw, str(exc)[:2000], report)
            return 0
        report.events_accepted += accepted
        report.events_duplicate += duplicate
        report.events_dropped += len(dropped)
        for reason in dropped:
            report.count(reason)
        report.raw_processed += 1
        return accepted

    def _complete(self, ctx: TenantContext, source: str, record: RawRecord, event: dict, ordinal: int) -> dict:
        event = dict(event)
        event.setdefault("specversion", "1.0")
        event.setdefault("source", source)
        event.setdefault("orgid", str(ctx.org_id))
        event.setdefault("collectorver", self.manifest.version)
        if "id" not in event and parse_time(event.get("time")) is not None:
            event["id"] = deterministic_ulid(parse_time(event["time"]), event["source"], record.source_ref,
                                             str(event.get("type")), ordinal)
        return event

    def _fail(self, raw: dict, error: str, report: RunReport) -> None:
        attempts = raw["attempts"] + 1
        self.conn.execute("update pulse.raw_inbox set attempts = %s, error = %s where id = %s",
                          (attempts, error, raw["id"]))
        if attempts >= MAX_ATTEMPTS:
            report.dead_letters += 1
            log.warning("dead letter %s/%s: %s", self.manifest.name, raw["source_ref"], error)
            if self.on_dead_letter:
                self.on_dead_letter(self.manifest.name, f"{raw['source_ref']}: {error}")
        else:
            report.retried += 1

    # ----------------------------------------------------------------------------------------------- storage
    def _store_raw(self, ctx: TenantContext, records: list[RawRecord]) -> int:
        source = self.manifest.source(ctx.instance)
        stored = 0
        for rec in records:
            try:
                with self.conn.transaction():    # savepoint: a payload PostgreSQL cannot store skips only itself
                    got = self.conn.execute(
                        """insert into pulse.raw_inbox (org_id, source, source_ref, payload, received_at)
                           values (%s, %s, %s, %s, coalesce(%s, now()))
                           on conflict (org_id, source, source_ref) do nothing returning id""",
                        (ctx.org_id, source, rec.source_ref, Jsonb(rec.payload), rec.received_at),
                    ).fetchone()
            except (psycopg.DataError, psycopg.errors.ProgramLimitExceeded) as exc:
                log.warning("raw record %s/%s refused by the database: %s", self.manifest.name, rec.source_ref, exc)
                if self.on_dead_letter:
                    self.on_dead_letter(self.manifest.name, f"{rec.source_ref}: raw payload refused: {exc}"[:500])
                continue
            stored += got is not None
        return stored

    def _cursor(self, scope_key: str) -> Cursor | None:
        row = self.conn.execute(
            "select cursor from pulse.collector_cursor where collector = %s and scope_key = %s",
            (self.manifest.name, scope_key),
        ).fetchone()
        return (row["cursor"] if isinstance(row, dict) else row[0]) if row else None

    def _save_cursor(self, scope_key: str, cursor: Cursor) -> None:
        self.conn.execute(
            """insert into pulse.collector_cursor (org_id, collector, scope_key, cursor)
               values (pulse.current_org(), %s, %s, %s)
               on conflict (org_id, collector, scope_key) do update set cursor = excluded.cursor, updated_at = now()""",
            (self.manifest.name, scope_key, Jsonb(cursor)),
        )


class _Rejected(Exception):
    pass
