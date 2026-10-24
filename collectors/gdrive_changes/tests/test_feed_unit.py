from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest

from pulse_gdrive_changes import drive, feed
from pulse_sdk import registry as reg
from pulse_sdk.collector import Manifest
from pulse_sdk.validate import EventValidator

ORG = uuid.UUID("39f1db08-1d2f-49c0-9a39-f5f0fb25defa")
SOURCE = uuid.UUID("0b8f1c51-7a7e-4d6c-9a43-3a52e4f0a001")
AT = datetime(2026, 10, 11, 9, 30, tzinfo=UTC)


def file(**overrides):
    return {"id": "synthetic-file", "name": "EA0584-cut-v2.mp4", "mimeType": "video/mp4", "parents": ["folder-1"],
            "trashed": False, "size": "2048", "md5Checksum": "b" * 32, "modifiedTime": "2026-10-11T09:29:00.000Z",
            "owners": [{"emailAddress": "Owner@Synthetic.Example"}],
            "lastModifyingUser": {"emailAddress": "editor@synthetic.example"}, **overrides}


@pytest.mark.parametrize(("status", "reason", "message", "listing", "expected"), [
    (429, "", "", True, drive.RateLimited),
    (403, "userRateLimitExceeded", "", True, drive.RateLimited),
    (403, "rateLimitExceeded", "", False, drive.RateLimited),
    (403, "insufficientFilePermissions", "", True, drive.AccessLost),
    (401, "authError", "", True, drive.AccessLost),
    (404, "notFound", "Shared drive not found: x", True, drive.AccessLost),
    (404, "teamDriveNotFound", "", True, drive.AccessLost),
    (400, "invalid", "Invalid Value pageToken", True, drive.CursorInvalid),
    (410, "", "", True, drive.CursorInvalid),
    (404, "notFound", "File not found", False, drive.AccessLost),
    (500, "backendError", "", True, drive.Unavailable),
    (400, "badRequest", "", False, drive.Unavailable),
])
def test_drive_errors_decide_what_the_worker_does(status, reason, message, listing, expected):
    error = drive.classify(status, reason, message, listing=listing)
    assert type(error) is expected
    assert error.code in {"rate_limited", "access_lost", "cursor_invalid", "provider_unavailable"}


def test_change_events_are_registered_deterministic_and_carry_no_content():
    meta = feed.file_meta(file())
    key = feed.change_key(SOURCE, "synthetic-file", AT, False, feed.meta_hash(meta))
    event = feed.drive_change_event(ORG, SOURCE, "synthetic-file", "created", meta, AT, key)
    assert event == feed.drive_change_event(ORG, SOURCE, "synthetic-file", "created", meta, AT, key)
    assert event["type"] == "drive.file.created" and event["source"] == f"/collectors/gdrive_changes/1/{SOURCE}"
    assert event["data"] == {"name": "EA0584-cut-v2.mp4", "mime": "video/mp4", "parents": ["gdrive:folder-1"],
                             "size": 2048, "md5": "b" * 32, "owner": "account:google:owner@synthetic.example",
                             "last_modifying_user": "account:google:editor@synthetic.example"}
    assert EventValidator(reg.default()).errors(event, now=AT) == []
    folder = feed.file_meta(file(mimeType=feed.FOLDER_MIME, size=None, md5Checksum=None))
    created = feed.drive_change_event(ORG, SOURCE, "f", "created", folder, AT, key)
    assert created["type"] == "drive.folder.created"
    for kind, expected in (("moved", "drive.file.moved"), ("renamed", "drive.file.renamed"),
                           ("trashed", "drive.file.trashed"), ("restored", "drive.file.updated")):
        event = feed.drive_change_event(ORG, SOURCE, "synthetic-file", kind, meta, AT, key)
        assert event["type"] == expected and EventValidator(reg.default()).errors(event, now=AT) == []


def test_a_change_key_moves_with_time_metadata_and_removal_only():
    meta = feed.file_meta(file())
    digest = feed.meta_hash(meta)
    key = feed.change_key(SOURCE, "f", AT, False, digest)
    assert key == feed.change_key(SOURCE, "f", AT, False, digest)
    assert key != feed.change_key(SOURCE, "f", AT.replace(second=1), False, digest)
    assert key != feed.change_key(SOURCE, "f", AT, True, digest)
    assert digest == feed.meta_hash(feed.file_meta(file(lastModifyingUser={"emailAddress": "other@x.example"})))
    assert digest != feed.meta_hash(feed.file_meta(file(md5Checksum="c" * 32)))


def test_classification_against_the_last_accepted_state():
    meta = feed.file_meta(file())
    prior = {"name": meta["name"], "parents": meta["parents"], "trashed": False, "meta_hash": feed.meta_hash(meta),
             "availability": "available"}
    assert feed.classify(None, meta) == "created"
    assert feed.classify(prior, meta) is None
    assert feed.classify(prior, feed.file_meta(file(trashed=True))) == "trashed"
    assert feed.classify({**prior, "trashed": True, "availability": "trashed"}, meta) == "restored"
    assert feed.classify({**prior, "availability": "removed"}, meta) == "restored"
    assert feed.classify(prior, feed.file_meta(file(parents=["folder-2"]))) == "moved"
    assert feed.classify(prior, feed.file_meta(file(name="EA0584-cut-v3.mp4"))) == "renamed"
    assert feed.classify(prior, feed.file_meta(file(md5Checksum="c" * 32))) == "updated"


def test_backoff_doubles_honours_retry_after_and_is_capped():
    assert 60 <= feed.backoff_seconds(0) <= 66
    assert 240 <= feed.backoff_seconds(2) <= 264
    assert feed.backoff_seconds(0, retry_after=900) >= 900
    assert feed.backoff_seconds(30) <= feed.BACKOFF_MAX_SECONDS * 1.1


def test_credentials_are_named_files_kept_private(tmp_path: Path):
    with pytest.raises(drive.CredentialUnavailable):
        drive.credential_file("synthetic-ea", base=str(tmp_path))
    key = tmp_path / "synthetic-ea.json"
    key.write_text("{}")
    os.chmod(key, 0o644)
    with pytest.raises(drive.CredentialUnavailable):
        drive.credential_file("synthetic-ea", base=str(tmp_path))
    os.chmod(key, 0o600)
    assert drive.credential_file("synthetic-ea", base=str(tmp_path)) == key


def test_manifest_emits_only_registered_drive_types_for_this_collector():
    manifest = Manifest.from_yaml(Path(__file__).resolve().parents[1] / "manifest.yaml")
    registry = reg.default()
    assert manifest.source("x") == "/collectors/gdrive_changes/1/x"
    assert manifest.scopes == (drive.METADATA_SCOPE,)
    for event_type in manifest.emits:
        assert "/collectors/gdrive_changes" in registry.get(event_type).emitters
