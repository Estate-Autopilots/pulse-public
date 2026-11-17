"""Bootstrap/refresh a deployed EA tenant without retaining migration credentials.

``--loop`` starts a refresh every PULSE_SYNC_INTERVAL seconds (default 600), measured start to start, and records
each run in ``pulse.sync_run``; the app's "Synced N min ago" badge reads the last run that finished without error.
"""
from __future__ import annotations

import argparse
import os
import signal
import sys
import threading
import time
import uuid
from dataclasses import asdict
from datetime import UTC, datetime

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from pulse_sdk.db import tenant_tx, url_for

from .backfill import run_backfill
from .team import EA_ORG, seed

SOURCE = "ea-drive-index"


class MissingIndexConfiguration(RuntimeError):
    """The refresh loop is enabled but its read-only Drive index URL is absent."""


class EAInstallConflict(RuntimeError):
    """The EA-only bootstrap cannot initialise or refresh a different company's install."""


def _has_sync_run(pulse) -> bool:
    return pulse.execute("select to_regclass('pulse.sync_run') is not null as ok").fetchone()["ok"]


def _initialise_ea(pulse):
    installed = pulse.execute("select pulse.install_org() as org_id").fetchone()["org_id"]
    if installed:
        org = uuid.UUID(str(installed))
    else:
        installed = pulse.execute("select pulse.install_ea(%s) as org_id", (EA_ORG,)).fetchone()["org_id"]
        if not installed:
            raise EAInstallConflict("Pulse already has a company; refusing EA bootstrap.")
        org = uuid.UUID(str(installed))
    with tenant_tx(pulse, org):
        row = pulse.execute("select code from pulse.org where id=%s", (org,)).fetchone()
    if not row or row["code"] != "EA":
        raise EAInstallConflict("Pulse install belongs to a non-EA organization; refusing EA bootstrap.")
    return org


def refresh() -> int:
    url = os.environ.get("EA_INDEX_DATABASE_URL")
    with psycopg.connect(url_for("worker"), autocommit=True, row_factory=dict_row) as pulse:
        org = _initialise_ea(pulse)
        started, run_id = datetime.now(UTC), None
        recorded = _has_sync_run(pulse)
        if recorded:
            with tenant_tx(pulse, org):
                pulse.execute("update pulse.sync_run set finished_at=now(),ok=false,error='interrupted' "
                              "where source=%s and finished_at is null", (SOURCE,))
                run_id = pulse.execute("insert into pulse.sync_run(org_id,source,started_at) values (%s,%s,%s) "
                                       "returning id", (org, SOURCE, started)).fetchone()["id"]
        try:
            pulse.execute("select pulse.maintain_partitions()")
            if not url:
                raise MissingIndexConfiguration("EA_INDEX_DATABASE_URL is not configured")
            with psycopg.connect(url, autocommit=True, row_factory=dict_row,
                                 options="-c default_transaction_read_only=on") as index:
                stats = seed(index, pulse, org)
                print("EA seed", stats, flush=True)
                counts = run_backfill(index, pulse, org, report=lambda message: print(message, flush=True))
                # When the Drive crawler itself last finished: Pulse cannot be fresher than that.
                upstream = index.execute("select max(finished) as at from sync_run where ok").fetchone()["at"]
            if run_id:
                with tenant_tx(pulse, org):
                    pulse.execute("update pulse.sync_run set finished_at=now(),ok=true,upstream_at=%s,stats=%s "
                                  "where id=%s", (upstream, Jsonb({**stats, **asdict(counts)}), run_id))
        except Exception as exc:
            if recorded:
                with tenant_tx(pulse, org):
                    if run_id:
                        pulse.execute("update pulse.sync_run set finished_at=now(),ok=false,error=%s where id=%s",
                                      (type(exc).__name__, run_id))
                    elif pulse.execute("select 1 from pulse.org where id=%s", (org,)).fetchone():
                        pulse.execute("insert into pulse.sync_run(org_id,source,started_at,finished_at,ok,error) "
                                      "values (%s,%s,%s,now(),false,%s)", (org, SOURCE, started, type(exc).__name__))
            raise
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--loop", action="store_true")
    args = parser.parse_args()
    interval = max(60, int(os.environ.get("PULSE_SYNC_INTERVAL", "600")))
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    while not stop.is_set():
        began = time.monotonic()
        try:
            refresh()
        except EAInstallConflict as exc:
            print(str(exc), file=sys.stderr, flush=True)
            return 1
        except Exception as exc:
            print(f"EA index refresh failed ({type(exc).__name__}); retrying next cycle", flush=True)
            if not args.loop:
                return 1
        if not args.loop:
            return 0
        stop.wait(max(5.0, interval - (time.monotonic() - began)))
    return 0
