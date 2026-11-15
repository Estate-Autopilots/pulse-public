"""Daily jobs: log partitions ahead of time (worker role) and retention (privacy role) (05 §9, 06 §8).

Retention, per run:
- drop ephemeral day partitions older than the activity_raw period (all tenants; the cutoff is fixed in SQL);
- for every tenant: redact expired events of every 'redact' class (data and actor blanked, SHA-256 of the original
  row kept, one privacy.event.redacted summary per class), and purge raw_inbox payloads older than 30 days.
The SQL functions compute every cutoff from now(), so no caller can delete unexpired data.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field

import psycopg

from pulse_sdk.db import active_orgs, set_tenant

log = logging.getLogger("pulse.maintenance")
FATAL = (psycopg.OperationalError, psycopg.InterfaceError)
RAW_INBOX_DAYS = 30


@dataclass
class RetentionReport:
    dropped_partitions: list[str] = field(default_factory=list)
    redacted: dict[str, dict[str, int]] = field(default_factory=dict)     # org -> class -> rows
    raw_purged: dict[str, int] = field(default_factory=dict)
    failed: dict[str, str] = field(default_factory=dict)                  # org (or "partitions") -> error

    @property
    def total_redacted(self) -> int:
        return sum(sum(v.values()) for v in self.redacted.values())


def maintain_partitions(worker_conn: psycopg.Connection) -> dict:
    with worker_conn.transaction():
        row = worker_conn.execute("select pulse.maintain_partitions() as r").fetchone()
    result = row["r"] if isinstance(row, dict) else row[0]
    if result.get("event_default_rows") or result.get("ephemeral_default_rows"):
        log.error("rows in a default log partition: %s", result)
    return result


def run_retention(privacy_conn: psycopg.Connection, orgs: list[uuid.UUID] | None = None) -> RetentionReport:
    report = RetentionReport()
    try:
        with privacy_conn.transaction():
            row = privacy_conn.execute("select privacy.drop_expired_ephemeral() as d").fetchone()
            report.dropped_partitions = list((row["d"] if isinstance(row, dict) else row[0]) or [])
    except FATAL:
        raise
    except psycopg.Error as exc:
        report.failed["partitions"] = str(exc)[:500]
        log.error("retention: dropping expired partitions failed: %s", exc)
    for org in orgs if orgs is not None else active_orgs(privacy_conn):
        try:                                             # one tenant's failure never stops the others
            with privacy_conn.transaction():
                set_tenant(privacy_conn, org)
                row = privacy_conn.execute("select privacy.redact_expired() as r").fetchone()
                redacted = row["r"] if isinstance(row, dict) else row[0]
                purged = privacy_conn.execute(
                    "delete from pulse.raw_inbox where org_id = pulse.current_org() "
                    "and received_at < now() - make_interval(days => %s)", (RAW_INBOX_DAYS,)).rowcount
        except FATAL:
            raise
        except psycopg.Error as exc:
            report.failed[str(org)] = str(exc)[:500]
            log.error("retention for tenant %s failed: %s", org, exc)
            continue
        if redacted:
            report.redacted[str(org)] = {k: int(v) for k, v in redacted.items()}
        if purged:
            report.raw_purged[str(org)] = purged
    log.info("retention: dropped %d partitions, redacted %d events, purged %d raw records",
             len(report.dropped_partitions), report.total_redacted, sum(report.raw_purged.values()))
    return report
