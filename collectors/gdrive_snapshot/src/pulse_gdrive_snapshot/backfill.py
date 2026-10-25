"""Read-only import of the EA Drive metadata index (never reads drive_text)."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import sys
import threading
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any

import psycopg
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pulse_rules.folder_rules import load as load_folder_rules

from pulse_sdk import registry as reg
from pulse_sdk.db import tenant_tx, url_for
from pulse_sdk.envelope import make_event, to_row
from pulse_sdk.store import insert_event, notify
from pulse_sdk.ulid import deterministic_ulid
from pulse_sdk.validate import EventValidator

from .team import project_path

COLLECTOR = "gdrive_snapshot"
SCOPE = "ea-index-backfill-v0"
SOURCE = "/collectors/gdrive_snapshot/1/ea-index"
TYPE = "drive.file.observed"
SYNC_SOURCE = "ea-drive-index-incremental"
FOLDER_MIME = "application/vnd.google-apps.folder"
INDEX_DSN_ENV = "EA_INDEX_DATABASE_URL"
MAX_BATCH_SIZE = 1000
DEFAULT_BATCH_SIZE = 500
DEFAULT_INTERVAL_SECONDS = 1800

_SENSITIVE_SEGMENT = re.compile(
    r"(?<![a-z])(?:salary|salaries|payroll|finances?|financial|bank\s+statements?|compensation|remuneration|payslips?)(?![a-z])",
)
_KYC_FOLDER = "ea team member details"

FOLDER_SQL = """
select id, name, parents, path, owner
  from drive_file
 where mime = %s and not coalesce(trashed, false)
"""
FILES_SQL = """
select id, name, mime, size, owner, parents, created, modified, modified_by, path, indexed_at, trashed
  from drive_file
 where (indexed_at, id) > (%s::timestamptz, %s)
 order by indexed_at, id
 limit %s
"""
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


@dataclass(frozen=True)
class Counts:
    scanned: int = 0
    inserted: int = 0
    duplicates: int = 0
    skipped: int = 0
    batches: int = 0


class FolderPaths:
    """Resolve indexed parent ids to paths so sensitive folders and their children are skipped."""

    def __init__(self, rows: Sequence[Mapping[str, Any]]):
        self.rows = {str(row["id"]): row for row in rows}
        self.cache: dict[str, str] = {}

    def path(self, folder_id: str, visiting: frozenset[str] = frozenset()) -> str:
        if folder_id in self.cache:
            return self.cache[folder_id]
        row = self.rows.get(folder_id)
        if row is None or folder_id in visiting or len(visiting) >= 64:
            return ""
        stored = row.get("path")
        if stored:
            result = str(stored)
        else:
            parents = row.get("parents") or ()
            parent_path = self.path(str(parents[0]), visiting | {folder_id}) if parents else ""
            name = str(row.get("name") or "")
            result = f"{parent_path}/{name}" if parent_path else name
        self.cache[folder_id] = result
        return result

    def record_paths(self, row: Mapping[str, Any]) -> tuple[str, ...]:
        paths = [str(row["path"])] if row.get("path") else []
        parents = row.get("parents") or ()
        name = str(row.get("name") or "")
        for parent in parents:
            parent_path = self.path(str(parent))
            paths.append(f"{parent_path}/{name}" if parent_path else name)
        if not paths:
            paths.append(name)
        return tuple(dict.fromkeys(paths))


def is_sensitive_path(path: str) -> bool:
    parts = [
        re.sub(r"[\s_.\-]+", " ", part.strip().casefold())
        for part in re.split(r"[/\\]+", path)
        if part.strip()
    ]
    return any(_KYC_FOLDER in part or _SENSITIVE_SEGMENT.search(part) for part in parts)


def skip_record(row: Mapping[str, Any], folders: FolderPaths) -> bool:
    if row.get("trashed") is True:
        return True
    return any(is_sensitive_path(path) for path in folders.record_paths(row))


def _timestamp(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if not isinstance(value, datetime):
        return str(value)
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _observed_at(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("observation time must include a timezone")
    return value.astimezone(UTC)


def _safe_interval(value: Any, default: int = DEFAULT_INTERVAL_SECONDS) -> int:
    try:
        seconds = int(value)
    except (TypeError, ValueError, OverflowError):
        seconds = default
    return max(60, seconds)


def _account_ref(value: Any) -> str:
    account = str(value).strip()
    return account if account.startswith("account:google:") else f"account:google:{account.lower()}"


def _file_data(row: Mapping[str, Any]) -> dict[str, Any]:
    parents = [f"gdrive:{parent}" for parent in (row.get("parents") or ())[:10]]
    data: dict[str, Any] = {
        "name": str(row["name"]),
        "mime": str(row.get("mime") or "application/octet-stream"),
        "parents": parents,
    }
    if row.get("size") is not None:
        data["size"] = int(row["size"])
    if row.get("owner"):
        data["owner"] = _account_ref(row["owner"])
    if row.get("modified_by"):
        data["last_modifying_user"] = _account_ref(row["modified_by"])

    for key, source_key in (("index_path", "path"), ("index_created_at", "created"),
                            ("index_modified_at", "modified")):
        if row.get(source_key):
            data[key] = str(row[source_key]) if source_key == "path" else _timestamp(row[source_key])
    return data


def _folder_data(row: Mapping[str, Any]) -> dict[str, Any]:
    data: dict[str, Any] = {
        "name": str(row["name"]),
        "mime": FOLDER_MIME,
        "parents": [f"gdrive:{parent}" for parent in (row.get("parents") or ())[:10]],
    }
    if row.get("owner"):
        data["owner"] = _account_ref(row["owner"])
    return data


def _checksum(data: Mapping[str, Any]) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
                          .encode("utf-8")).hexdigest()


def drive_source_ref(row: Mapping[str, Any]) -> str:
    """Return the metadata revision key used to suppress indexer re-listing duplicates."""
    file_id = str(row["id"])
    if row.get("mime") == FOLDER_MIME:
        return f"folder|{file_id}|{_checksum(_folder_data(row))}"
    return f"{file_id}|{_timestamp(row.get('modified'))}|{_checksum(_file_data(row))}"


def drive_event(row: Mapping[str, Any], org_id: uuid.UUID | str, observed_at: datetime) -> dict[str, Any]:
    """Map an indexed file to a registered event with one timestamp for its id and time."""
    observed_at = _observed_at(observed_at)
    file_id = str(row["id"])
    data = _file_data(row)
    event_id = deterministic_ulid(observed_at, SOURCE, drive_source_ref(row), TYPE)
    return make_event(
        org_id=org_id,
        id=event_id,
        source=SOURCE,
        type=TYPE,
        time=observed_at,
        subject=f"file:gdrive:{file_id}",
        purpose="delivery",
        sensitivity=1,
        visibility="team",
        data=data,
        datacontenttype="application/json",
        dataschema="schema:drive.file.observed/1",
        collectorver="1.0.0",
    )


def drive_folder_event(row: Mapping[str, Any], org_id: uuid.UUID | str, observed_at: datetime) -> dict[str, Any]:
    """Observe only the folder metadata needed to attribute a deliverable to its configured folder owner."""
    observed_at = _observed_at(observed_at)
    file_id = str(row["id"])
    data = _folder_data(row)
    event_id = deterministic_ulid(observed_at, SOURCE, drive_source_ref(row), TYPE)
    return make_event(
        org_id=org_id,
        id=event_id,
        source=SOURCE,
        type=TYPE,
        time=observed_at,
        subject=f"file:gdrive:{file_id}",
        purpose="delivery",
        sensitivity=1,
        visibility="team",
        data=data,
        datacontenttype="application/json",
        dataschema="schema:drive.file.observed/1",
        collectorver="1.0.0",
    )


def _checkpoint(conn: psycopg.Connection, org_id: uuid.UUID, now: datetime) -> dict[str, Any]:
    with tenant_tx(conn, org_id):
        row = conn.execute(
            "select cursor from pulse.collector_cursor where org_id = %s and collector = %s and scope_key = %s",
            (org_id, COLLECTOR, SCOPE),
        ).fetchone()
        if row:
            state = dict(row["cursor"])
            # Older snapshots checkpointed only the file id and used observed_at as
            # the event anchor. Re-scan with that anchor while seeding revision keys.
            if "last_indexed_at" not in state:
                state["legacy_anchor"] = state.get("observed_at") or _timestamp(now)
                state["legacy_scan"] = True
                state["last_indexed_at"] = _timestamp(EPOCH)
                state["last_id"] = ""
            else:
                state.setdefault("last_id", "")
        else:
            state = {"last_indexed_at": _timestamp(EPOCH), "last_id": "", "observed_at": _timestamp(now)}
        state.setdefault("observed_at", _timestamp(now))
        state["observed_at"] = _timestamp(now)
        state["status"] = "running"
        _save_checkpoint(conn, org_id, state)
        return state


def _save_checkpoint(conn: psycopg.Connection, org_id: uuid.UUID, state: Mapping[str, Any]) -> None:
    conn.execute(
        """insert into pulse.collector_cursor (org_id, collector, scope_key, cursor)
           values (%s, %s, %s, %s)
           on conflict (org_id, collector, scope_key)
           do update set cursor = excluded.cursor, updated_at = now()""",
        (org_id, COLLECTOR, SCOPE, Jsonb(dict(state))),
    )


def run_backfill(
    index: psycopg.Connection,
    pulse: psycopg.Connection,
    org_id: uuid.UUID | str,
    *,
    batch_size: int = DEFAULT_BATCH_SIZE,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
    report: Callable[[str], None] = print,
) -> Counts:
    if not 1 <= batch_size <= MAX_BATCH_SIZE:
        raise ValueError(f"batch size must be between 1 and {MAX_BATCH_SIZE}")
    org = uuid.UUID(str(org_id))
    registry = reg.default()
    validator = EventValidator(registry)
    with tenant_tx(pulse, org):
        project_paths = load_folder_rules(pulse, org).project_paths
    folders = FolderPaths(index.execute(FOLDER_SQL, (FOLDER_MIME,)).fetchall())
    counts = Counts()

    # Serialize concurrent invocations. The lock is session-scoped and released when the connection closes.
    lock_key = f"{org}:{COLLECTOR}:{SCOPE}"
    pulse.execute("select pg_advisory_lock(hashtextextended(%s, 0))", (lock_key,))
    try:
        state = _checkpoint(pulse, org, _observed_at(now()))
        observed = datetime.fromisoformat(str(state["observed_at"]).replace("Z", "+00:00"))
        migration_anchor = None
        if state.get("legacy_scan"):
            migration_anchor = datetime.fromisoformat(str(state["legacy_anchor"]).replace("Z", "+00:00"))
        while True:
            last_indexed_at = str(state.get("last_indexed_at") or _timestamp(EPOCH))
            last_id = str(state.get("last_id") or "")
            rows = index.execute(FILES_SQL, (last_indexed_at, last_id, batch_size)).fetchall()
            if not rows:
                state = {**state, "status": "complete"}
                state.pop("legacy_scan", None)
                state.pop("legacy_anchor", None)
                with tenant_tx(pulse, org):
                    _save_checkpoint(pulse, org, state)
                break

            inserted = duplicates = skipped = 0
            with tenant_tx(pulse, org):
                for record in rows:
                    if skip_record(record, folders):
                        skipped += 1
                        continue
                    record = dict(record)
                    paths = folders.record_paths(record)
                    if record.get("mime") == FOLDER_MIME:
                        if not any(project_path(path, project_paths) for path in paths):
                            skipped += 1
                            continue
                    else:
                        record["path"] = paths[0]

                    file_id = str(record["id"])
                    source_ref = drive_source_ref(record)
                    existing = pulse.execute(
                        "select source_ref from pulse.drive_backfill_emission where org_id=%s and file_id=%s",
                        (org, file_id),
                    ).fetchone()
                    if existing and existing["source_ref"] == source_ref:
                        duplicates += 1
                        continue

                    event_at = migration_anchor or observed
                    if record.get("mime") == FOLDER_MIME:
                        event = drive_folder_event(record, org, event_at)
                    else:
                        event = drive_event(record, org, event_at)
                    if validator.errors(event, now=event_at):
                        raise ValueError("generated Drive event did not match the registered schema")
                    stored = insert_event(pulse, to_row(event), registry)
                    if stored.status == "accepted":
                        inserted += 1
                    elif stored.status == "duplicate":
                        duplicates += 1
                    else:
                        raise RuntimeError("Pulse Event Core rejected a Drive snapshot event")
                    pulse.execute(
                        """insert into pulse.drive_backfill_emission (org_id, file_id, source_ref)
                           values (%s, %s, %s)
                           on conflict (org_id, file_id) do update
                             set source_ref=excluded.source_ref, emitted_at=now()""",
                        (org, file_id, source_ref),
                    )
                state = {
                    **state,
                    "status": "running",
                    "last_indexed_at": _timestamp(rows[-1]["indexed_at"]),
                    "last_id": str(rows[-1]["id"]),
                    "observed_at": _timestamp(observed),
                }
                _save_checkpoint(pulse, org, state)
                if inserted:
                    notify(pulse, org)

            counts = Counts(counts.scanned + len(rows), counts.inserted + inserted,
                            counts.duplicates + duplicates, counts.skipped + skipped, counts.batches + 1)
            report(f"batch {counts.batches}: scanned={len(rows)} inserted={inserted} "
                   f"duplicates={duplicates} skipped={skipped}")
            if len(rows) < batch_size:
                state = {**state, "status": "complete"}
                state.pop("legacy_scan", None)
                state.pop("legacy_anchor", None)
                with tenant_tx(pulse, org):
                    _save_checkpoint(pulse, org, state)
                break

    finally:
        pulse.execute("select pg_advisory_unlock(hashtextextended(%s, 0))", (lock_key,))

    report(f"complete: scanned={counts.scanned} inserted={counts.inserted} "
           f"duplicates={counts.duplicates} skipped={counts.skipped} batches={counts.batches}")
    return counts


def _recorded_run(index: psycopg.Connection, pulse: psycopg.Connection, org_id: uuid.UUID | str,
                  batch_size: int, *, now: Callable[[], datetime] = lambda: datetime.now(UTC)) -> Counts:
    org = uuid.UUID(str(org_id))
    started = now()
    has_sync_run = pulse.execute("select to_regclass('pulse.sync_run') is not null as ok").fetchone()["ok"]
    run_id = None
    if has_sync_run:
        with tenant_tx(pulse, org):
            pulse.execute("update pulse.sync_run set finished_at=now(),ok=false,error='interrupted' "
                          "where org_id=%s and source=%s and finished_at is null", (org, SYNC_SOURCE))
            run_id = pulse.execute(
                "insert into pulse.sync_run(org_id,source,started_at) values (%s,%s,%s) returning id",
                (org, SYNC_SOURCE, started),
            ).fetchone()["id"]
    try:
        counts = run_backfill(index, pulse, org, batch_size=batch_size, now=now)
        upstream = index.execute("select max(finished) as at from sync_run where ok").fetchone()["at"]
        if run_id:
            with tenant_tx(pulse, org):
                pulse.execute("update pulse.sync_run set finished_at=now(),ok=true,upstream_at=%s,stats=%s where id=%s",
                              (upstream, Jsonb(asdict(counts)), run_id))
        return counts
    except Exception as exc:
        if run_id:
            with tenant_tx(pulse, org):
                pulse.execute("update pulse.sync_run set finished_at=now(),ok=false,error=%s where id=%s",
                              (type(exc).__name__, run_id))
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill eligible EA Drive metadata into Pulse's event log")
    parser.add_argument("--org-id", default=os.environ.get("PULSE_ORG_ID"),
                        help="Pulse tenant UUID (or PULSE_ORG_ID; defaults to the installed company)")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE,
                        help=f"rows per event transaction, 1-{MAX_BATCH_SIZE} (default {DEFAULT_BATCH_SIZE})")
    parser.add_argument("--loop", action="store_true", help="repeat incrementally until SIGTERM or Ctrl+C")
    parser.add_argument("--interval", type=_safe_interval,
                        default=_safe_interval(os.environ.get("PULSE_DRIVE_BACKFILL_INTERVAL")),
                        help="seconds between runs in --loop mode (default: 1800)")
    args = parser.parse_args()
    if not 1 <= args.batch_size <= MAX_BATCH_SIZE:
        parser.error(f"--batch-size must be between 1 and {MAX_BATCH_SIZE}")
    index_url = os.environ.get(INDEX_DSN_ENV)
    if not index_url:
        parser.error(f"{INDEX_DSN_ENV} is required; provide it through the approved staging environment")

    stop = threading.Event()
    if args.loop:
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        signal.signal(signal.SIGINT, lambda *_: stop.set())
    while not stop.is_set():
        began = time.monotonic()
        try:
            readonly_url = make_conninfo(index_url, options="-c default_transaction_read_only=on",
                                         application_name="pulse-drive-backfill-readonly")
            with psycopg.connect(readonly_url, autocommit=True, row_factory=dict_row) as index, \
                    psycopg.connect(url_for("worker"), autocommit=True, row_factory=dict_row,
                                    application_name="pulse-drive-backfill") as pulse:
                transaction_setting = index.execute("show default_transaction_read_only").fetchone()
                if transaction_setting["default_transaction_read_only"] != "on":
                    raise RuntimeError("EA index connection is not read-only")
                installed_org = pulse.execute("select pulse.install_org() as org_id").fetchone()["org_id"]
                if not installed_org:
                    parser.error("Pulse install is not initialised; initialise it before running Drive backfill")
                if args.org_id and str(args.org_id).lower() != str(installed_org).lower():
                    parser.error("--org-id or PULSE_ORG_ID does not match pulse.install.org_id")
                _recorded_run(index, pulse, args.org_id or installed_org, args.batch_size)
        except Exception as exc:
            # Database exceptions can contain connection details or provider metadata; keep logs count-only.
            print(f"pulse-drive-backfill failed ({type(exc).__name__}); check database access and event partitions.",
                  file=sys.stderr, flush=True)
            if not args.loop:
                return 1
        if not args.loop:
            return 0
        delay = max(5, args.interval - (time.monotonic() - began))
        if stop.wait(delay):
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
