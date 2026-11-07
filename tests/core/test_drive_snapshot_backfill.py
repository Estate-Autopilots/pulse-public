"""Synthetic EA Drive metadata snapshots use the Event Core's idempotent append path."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from helpers import build_world, read_as
from pulse_gdrive_snapshot.backfill import (
    FILES_SQL,
    FOLDER_MIME,
    FOLDER_SQL,
    SOURCE,
    SYNC_SOURCE,
    _recorded_run,
    _save_checkpoint,
    drive_event,
    drive_folder_event,
    run_backfill,
)
from pulse_sdk import registry as reg
from pulse_sdk.db import set_tenant
from pulse_sdk.envelope import to_row
from pulse_sdk.store import insert_event
from pulse_sdk.validate import EventValidator


def test_drive_snapshot_event_core_append_is_idempotent(worker, owner, api):
    world = build_world(worker, owner, api)
    observed = datetime(2026, 10, 5, 12, tzinfo=UTC)
    source_row = {
        "id": "synthetic-drive-file-123",
        "name": "EA0584-creative-v2.mp4",
        "mime": "video/mp4",
        "size": 12345,
        "owner": "synthetic-owner@example.test",
        "parents": ["synthetic-folder-1"],
        "modified": datetime(2026, 10, 4, 10, tzinfo=UTC),
        "modified_by": "synthetic-editor@example.test",
    }
    event = drive_event(source_row, world.org, observed)
    registry = reg.default()
    assert EventValidator(registry).errors(event, now=observed) == []
    row = to_row(event)

    with worker.transaction():
        set_tenant(worker, world.org)
        first = insert_event(worker, row, registry)
    with worker.transaction():
        set_tenant(worker, world.org)
        second = insert_event(worker, row, registry)

    assert first.status == "accepted"
    assert second.status == "duplicate"


class StubResult:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class StubIndex:
    def __init__(self, folders, rows):
        self.folders = folders
        self.rows = rows

    def execute(self, sql, params=()):
        if sql == FOLDER_SQL:
            assert params == (FOLDER_MIME,)
            return StubResult(self.folders)
        if sql == FILES_SQL:
            last_indexed_at, last_id, batch_size = params
            if isinstance(last_indexed_at, str):
                last_indexed_at = datetime.fromisoformat(last_indexed_at.replace("Z", "+00:00"))
            page = sorted(
                (row for row in self.rows if (row["indexed_at"], row["id"]) > (last_indexed_at, last_id)),
                key=lambda row: (row["indexed_at"], row["id"]),
            )
            return StubResult(page[:batch_size])
        if sql == "select max(finished) as at from sync_run where ok":
            return StubResult([{"at": datetime(2026, 10, 6, 12, tzinfo=UTC)}])
        raise AssertionError(f"unexpected index query: {sql}")


def test_run_backfill_emits_folders_skips_sensitive_tree_and_replays(worker, owner, api):
    world = build_world(worker, owner, api)
    observed = datetime.now(UTC)
    folders = [
        {"id": "001-root", "name": "My Drive", "mime": FOLDER_MIME, "parents": [], "path": "My Drive"},
        {"id": "002-creative", "name": "Creative", "mime": FOLDER_MIME,
         "parents": ["001-root"],
         "path": "My Drive/Client Video Shoot/2026/October/Synthetic Project/Creative"},
        {"id": "004-kyc", "name": "EA_Team_Member_Details", "mime": FOLDER_MIME,
         "parents": ["001-root"], "path": None},
    ]
    rows = [
        *folders[:2],
        {"id": "003-eligible", "name": "Synthetic deliverable.mp4", "mime": "video/mp4", "size": 23,
         "owner": None, "parents": ["002-creative"], "modified": observed, "modified_by": None, "path": None,
         "trashed": False},
        folders[2],
        {"id": "005-kyc-child", "name": "Synthetic record.pdf", "mime": "application/pdf", "size": 9,
         "owner": None, "parents": ["004-kyc"], "modified": observed, "modified_by": None, "path": None,
         "trashed": False},
    ]
    for row in rows:
        row["indexed_at"] = observed
    index = StubIndex(folders, rows)

    first = _recorded_run(index, worker, world.org, batch_size=2, now=lambda: observed)
    assert (first.scanned, first.inserted, first.skipped, first.batches) == (5, 2, 3, 3)

    sync = read_as(worker, world.org,
                   "select ok,finished_at,upstream_at from pulse.sync_run where source=%s", (SYNC_SOURCE,))
    assert len(sync) == 1 and sync[0]["ok"] and sync[0]["finished_at"] is not None
    assert sync[0]["upstream_at"] == datetime(2026, 10, 6, 12, tzinfo=UTC)

    events = read_as(worker, world.org,
                     "select subject, data->>'mime' as mime from pulse.event where source = %s order by subject",
                     (SOURCE,))
    assert {event["subject"] for event in events} == {
        "file:gdrive:002-creative", "file:gdrive:003-eligible",
    }
    assert sum(event["mime"] == FOLDER_MIME for event in events) == 1

    replay = run_backfill(index, worker, world.org, batch_size=2, now=lambda: observed, report=lambda _: None)
    assert (replay.scanned, replay.inserted, replay.duplicates) == (0, 0, 0)

    changed_row = next(row for row in index.rows if row["id"] == "003-eligible")
    changed_row["indexed_at"] = observed + timedelta(minutes=15)
    relisted = run_backfill(index, worker, world.org, batch_size=2,
                            now=lambda: observed + timedelta(minutes=15), report=lambda _: None)
    assert (relisted.scanned, relisted.inserted, relisted.duplicates) == (1, 0, 1)
    assert len(read_as(worker, world.org, "select id from pulse.event where source=%s", (SOURCE,))) == 2

    changed_row["name"] = "Synthetic deliverable revised.mp4"
    changed_row["indexed_at"] = observed + timedelta(minutes=30)
    changed = run_backfill(index, worker, world.org, batch_size=2,
                           now=lambda: observed + timedelta(minutes=30), report=lambda _: None)
    assert (changed.scanned, changed.inserted, changed.duplicates) == (1, 1, 0)

    events_after_change = read_as(worker, world.org,
                                  "select id, data->>'name' as name from pulse.event where source = %s",
                                  (SOURCE,))
    assert len(events_after_change) == 3
    assert sum(event["name"] == "Synthetic deliverable revised.mp4" for event in events_after_change) == 1

    replay_change = run_backfill(index, worker, world.org, batch_size=2,
                                 now=lambda: observed + timedelta(minutes=60), report=lambda _: None)
    assert (replay_change.scanned, replay_change.inserted, replay_change.duplicates) == (0, 0, 0)


def test_id_only_cursor_migration_reuses_anchor_and_seeds_revision_keys(worker, owner, api):
    world = build_world(worker, owner, api)
    anchor = datetime(2026, 10, 5, 12, tzinfo=UTC)
    indexed = anchor + timedelta(minutes=30)
    folder = {"id": "migration-folder", "name": "Creative", "mime": FOLDER_MIME,
              "parents": [], "path": "My Drive/Client Video Shoot/2026/October/Synthetic Project/Creative"}
    file = {"id": "migration-file", "name": "Synthetic deliverable.mp4", "mime": "video/mp4", "size": 23,
            "owner": None, "parents": [folder["id"]], "modified": anchor, "modified_by": None,
            "path": None, "trashed": False, "indexed_at": indexed}
    folder["indexed_at"] = indexed
    index = StubIndex([folder], [folder, file])

    legacy_file = {**file, "path": f"{folder['path']}/{file['name']}"}
    with worker.transaction():
        set_tenant(worker, world.org)
        for event in (drive_folder_event(folder, world.org, anchor), drive_event(legacy_file, world.org, anchor)):
            assert insert_event(worker, to_row(event), reg.default()).status == "accepted"
        _save_checkpoint(worker, world.org, {
            "status": "complete", "last_id": file["id"], "observed_at": anchor.isoformat().replace("+00:00", "Z")
        })

    migrated = run_backfill(index, worker, world.org, now=lambda: indexed, report=lambda _: None)
    assert (migrated.scanned, migrated.inserted, migrated.duplicates) == (2, 0, 2)
    assert len(read_as(worker, world.org, "select id from pulse.event where source=%s", (SOURCE,))) == 2
    emission_rows = read_as(worker, world.org,
                            "select file_id,source_ref from pulse.drive_backfill_emission order by file_id")
    assert {row["file_id"] for row in emission_rows} == {folder["id"], file["id"]}
    cursor = read_as(worker, world.org,
                     "select cursor from pulse.collector_cursor where collector='gdrive_snapshot' "
                     "and scope_key='ea-index-backfill-v0'")
    assert len(cursor) == 1 and "legacy_scan" not in cursor[0]["cursor"]
    assert "legacy_anchor" not in cursor[0]["cursor"]

    file["indexed_at"] = indexed + timedelta(minutes=15)
    relisted = run_backfill(index, worker, world.org, now=lambda: indexed + timedelta(minutes=15), report=lambda _: None)
    assert (relisted.scanned, relisted.inserted, relisted.duplicates) == (1, 0, 1)

    file["name"] = "Synthetic deliverable revised.mp4"
    file["indexed_at"] = indexed + timedelta(minutes=30)
    changed = run_backfill(index, worker, world.org, now=lambda: indexed + timedelta(minutes=30), report=lambda _: None)
    assert (changed.scanned, changed.inserted, changed.duplicates) == (1, 1, 0)
    events = read_as(worker, world.org, "select id from pulse.event where source=%s", (SOURCE,))
    assert len(events) == 3
