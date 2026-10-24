from __future__ import annotations

import uuid
from datetime import UTC, datetime

from pulse_gdrive_snapshot.backfill import (
    FolderPaths,
    _safe_interval,
    drive_event,
    drive_folder_event,
    is_sensitive_path,
    skip_record,
)
from pulse_sdk import registry as reg
from pulse_sdk.validate import EventValidator

ORG = uuid.UUID("39f1db08-1d2f-49c0-9a39-f5f0fb25defa")
OBSERVED = datetime(2026, 10, 5, 12, tzinfo=UTC)


def file_row(**overrides):
    return {
        "id": "synthetic-file-123",
        "name": "EA0584-creative-v2.mp4",
        "mime": "video/mp4",
        "size": 12345,
        "owner": "synthetic-owner@example.test",
        "parents": ["synthetic-folder-1"],
        "modified": datetime(2026, 10, 4, 10, tzinfo=UTC),
        "modified_by": "synthetic-editor@example.test",
        "path": None,
        "trashed": False,
        **overrides,
    }


def test_snapshot_event_matches_registered_envelope_and_is_deterministic():
    row = file_row()
    first = drive_event(row, ORG, OBSERVED)
    replay = drive_event(row, ORG, OBSERVED)

    assert first == replay
    assert first["type"] == "drive.file.observed"
    assert first["source"] == "/collectors/gdrive_snapshot/1/ea-index"
    assert first["data"]["owner"] == "account:google:synthetic-owner@example.test"
    assert first["data"]["last_modifying_user"] == "account:google:synthetic-editor@example.test"
    assert EventValidator(reg.default()).errors(first, now=OBSERVED) == []


def test_event_time_is_the_same_anchor_used_for_its_id():
    row = file_row()
    first = drive_event(row, ORG, OBSERVED)
    replay = drive_event(row, ORG, OBSERVED.replace(minute=30))

    assert replay["id"] != first["id"]
    assert replay["time"] != first["time"]
    time_anchor = datetime.fromisoformat(first["time"].replace("Z", "+00:00"))
    assert drive_event(row, ORG, time_anchor) == first


def test_event_id_changes_when_indexed_file_revision_changes():
    baseline = drive_event(file_row(), ORG, OBSERVED)
    changed = drive_event(file_row(name="EA0584-creative-v3.mp4"), ORG, OBSERVED)
    later = drive_event(file_row(modified=datetime(2026, 10, 5, 10, tzinfo=UTC)), ORG, OBSERVED)

    assert changed["id"] != baseline["id"]
    assert later["id"] != baseline["id"]


def test_bad_worker_interval_uses_safe_minimum_or_default():
    assert _safe_interval("30") == 60
    assert _safe_interval("invalid") == 1800
    assert _safe_interval(None) == 1800


def test_folder_owner_event_matches_registered_envelope_and_is_deterministic():
    row = {"id": "synthetic-folder-123", "name": "Deliverables", "parents": ["synthetic-project"],
           "owner": "synthetic-editor@example.test"}
    first = drive_folder_event(row, ORG, OBSERVED)
    replay = drive_folder_event(row, ORG, OBSERVED)

    assert first == replay
    assert first["type"] == "drive.file.observed"
    assert first["data"] == {"name": "Deliverables", "mime": "application/vnd.google-apps.folder",
                             "parents": ["gdrive:synthetic-project"],
                             "owner": "account:google:synthetic-editor@example.test"}
    assert EventValidator(reg.default()).errors(first, now=OBSERVED) == []


def test_sensitive_folder_paths_and_finance_file_names_are_skipped():
    folders = FolderPaths([
        {"id": "synthetic-root", "name": "My Drive", "parents": [], "path": "My Drive"},
        {"id": "synthetic-kyc", "name": "EA Team Member Details", "parents": ["synthetic-root"], "path": None},
        {"id": "synthetic-child", "name": "2026", "parents": ["synthetic-kyc"], "path": None},
        {"id": "synthetic-finance", "name": "Finance", "parents": ["synthetic-root"], "path": None},
    ])

    assert skip_record(file_row(parents=["synthetic-child"]), folders)
    assert skip_record(file_row(parents=["synthetic-finance"]), folders)
    assert skip_record(file_row(parents=["synthetic-finance"], path="My Drive/Creative/item.mp4"), folders)
    assert skip_record(file_row(name="synthetic-salary.xlsx"), folders)
    assert not skip_record(file_row(), folders)


def test_sensitive_path_match_is_case_insensitive_and_segment_scoped():
    assert is_sensitive_path("My Drive/Finances/2026")
    assert is_sensitive_path("Shared drives/EA Team Member Details/People")
    assert is_sensitive_path("My Drive/Salary_Oct.xlsx")
    assert is_sensitive_path("My Drive/EA_Finance_2026/Synthetic.xlsx")
    assert is_sensitive_path("My Drive/payroll2026.xlsx")
    assert is_sensitive_path("My Drive/EA_Team_Member_Details/Synthetic.xlsx")
    assert not is_sensitive_path("My Drive/Financially Creative Campaigns")
