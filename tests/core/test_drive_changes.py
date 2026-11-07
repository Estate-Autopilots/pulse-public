"""R44 (migration 0270): the direct Drive changes feed for approved roots, against a synthetic Drive.

Each page commits its journal keys, events, file states and cursor together: a crash before the commit refetches the
page, a crash after it does not, and a replayed page adds nothing. Rate limits back off, a missed push notification is
caught by the scheduled poll, an expired channel is renewed, a refused cursor waits for a reviewed recovery that
records the gap, and deletion, lost access or a move out of the root are tombstones that keep accepted facts.
Every Drive here is the FakeDrive below: this is mock evidence, not a Google receipt."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import psycopg
import pytest
from helpers import build_world
from psycopg.types.json import Jsonb
from pulse_gdrive_changes import feed
from pulse_gdrive_changes.drive import (
    AccessLost,
    ChangePage,
    Channel,
    CursorInvalid,
    RateLimited,
)
from pulse_sdk.db import set_tenant

FOLDER = "application/vnd.google-apps.folder"
SECRET = "SyntheticPageTokenMustNotLeak"
HOOK = "https://pulse.example.test/api/v0/drive-changes/hook"
sha = lambda text: hashlib.sha256(text.encode()).hexdigest()


class Crash(Exception):
    pass


class FakeDrive:
    """One Google changes feed: tokens encode a position in an append-only log; folders answer files.get."""

    def __init__(self):
        self.log: list[dict] = []
        self.files: dict[str, dict] = {}
        self.refused: set[str] = set()
        self.raise_next: list[Exception | None] = []
        self.lists = self.gets = 0
        self.watches: list[dict] = []
        self.watch_error: Exception | None = None
        self.watch_calls = 0
        self.stopped: list[tuple[str, str]] = []
        self.clock = datetime.now(UTC) - timedelta(hours=1)

    def token(self, position: int) -> str:
        return f"{SECRET}-{position}"

    def tick(self) -> str:
        self.clock += timedelta(seconds=1)
        return self.clock.isoformat().replace("+00:00", "Z")

    def put(self, file_id, name, parents, *, mime="video/mp4", trashed=False, drive_id=None, md5="a" * 32):
        file = {"id": file_id, "name": name, "mimeType": mime, "parents": list(parents), "trashed": trashed,
                "modifiedTime": self.tick(), "size": "1024", "md5Checksum": md5,
                "lastModifyingUser": {"emailAddress": "editor@synthetic.example"}}
        if drive_id:
            file["driveId"] = drive_id
        if mime == FOLDER:
            file.pop("md5Checksum")
            file.pop("size")
        self.files[file_id] = file
        self.log.append({"changeType": "file", "time": self.tick(), "removed": False, "fileId": file_id,
                         "file": dict(file)})

    def remove(self, file_id):
        self.files.pop(file_id, None)
        self.log.append({"changeType": "file", "time": self.tick(), "removed": True, "fileId": file_id})

    def drive_removed(self, drive_id):
        self.log.append({"changeType": "drive", "time": self.tick(), "removed": True, "driveId": drive_id})

    def start_page_token(self, drive_id):
        return self.token(len(self.log))

    def list_changes(self, page_token, drive_id, page_size):
        self.lists += 1
        if self.raise_next:
            error = self.raise_next.pop(0)
            if error is not None:
                raise error
        if page_token in self.refused or not page_token.startswith(SECRET):
            raise CursorInvalid()
        position = int(page_token.rsplit("-", 1)[1])
        chunk = self.log[position:position + page_size]
        following = position + len(chunk)
        if following < len(self.log):
            return ChangePage([dict(c) for c in chunk], self.token(following), None)
        return ChangePage([dict(c) for c in chunk], None, self.token(following))

    def get_file(self, file_id):
        self.gets += 1
        found = self.files.get(file_id)
        return {"id": file_id, "name": found["name"], "parents": found["parents"]} if found else None

    def watch(self, page_token, drive_id, channel_id, address, token, expires_ms):
        self.watch_calls += 1
        if self.watch_error is not None:
            raise self.watch_error
        self.watches.append({"id": channel_id, "token": token, "address": address})
        return Channel(channel_id, f"resource-{channel_id[:8]}", expires_ms)

    def stop(self, channel_id, resource_id):
        self.stopped.append((channel_id, resource_id))


def q(conn, org, sql, args=(), viewer=None):
    with conn.transaction():
        set_tenant(conn, org, viewer)
        cur = conn.execute(sql, args)
        return cur.fetchall() if cur.description else None


def make_admin(worker, w):
    q(worker, w.org, "insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')",
      (w.org, w.manager))


def folder_root(worker, w, drive, root="root-folder"):
    drive.files[root] = {"id": root, "name": "Approved Projects", "parents": ["my-drive"]}
    source = feed.add_source(worker, w.org, kind="folder", root_id=root, label="Approved projects",
                             credential_ref="synthetic-ea", subject="collector@synthetic.example")
    feed.approve_source(worker, w.org, source, approved_by=w.manager, approval_ref="E13 synthetic approval")
    return source


def events(worker, w, source):
    return q(worker, w.org, "select id, type, subject, data from pulse.event where source=%s order by time, id",
             (feed.source_uri(source),))


def state(worker, w, source, file_id):
    rows = q(worker, w.org, "select name, availability, parents from pulse.drive_source_file where source_id=%s and file_id=%s",
             (source, file_id))
    return rows[0] if rows else None


def cursor(worker, w, source):
    return q(worker, w.org, "select cursor from pulse.collector_cursor where collector='gdrive_changes' and scope_key=%s",
             (str(source),))[0]["cursor"]["page_token"]


def source_row(worker, w, source):
    return q(worker, w.org, "select * from pulse.drive_source where id=%s", (source,))[0]


@pytest.fixture
def world(worker, owner, api):
    w = build_world(worker, owner, api)
    make_admin(worker, w)
    return w


def test_a_root_is_read_only_after_approval_and_starts_at_the_current_position(worker, world):
    w, drive = world, FakeDrive()
    drive.put("old-file", "before approval.mp4", ["root-folder"])
    source = feed.add_source(worker, w.org, kind="folder", root_id="root-folder", label="Approved projects",
                             credential_ref="synthetic-ea")
    assert feed.poll_source(worker, drive, w.org, source).status == "not_approved"
    assert drive.lists == 0
    with pytest.raises(PermissionError):
        feed.approve_source(worker, w.org, source, approved_by=w.editor, approval_ref="E13 synthetic approval")
    with pytest.raises(psycopg.errors.CheckViolation):     # enabling needs a recorded approval
        q(worker, w.org, "update pulse.drive_source set enabled=true where id=%s", (source,))
    feed.approve_source(worker, w.org, source, approved_by=w.manager, approval_ref="E13 synthetic approval")
    first = feed.poll_source(worker, drive, w.org, source)
    assert (first.status, first.pages, first.events) == ("ok", 0, 0)
    assert cursor(worker, w, source) == drive.token(1)      # history before approval is not replayed
    assert events(worker, w, source) == []


def test_selected_root_scope_sensitive_folders_and_page_replay(worker, world):
    w, drive = world, FakeDrive()
    drive.files["deep"] = {"id": "deep", "name": "Client A", "parents": ["root-folder"]}   # existed before approval
    source = folder_root(worker, w, drive)
    feed.poll_source(worker, drive, w.org, source)
    start = cursor(worker, w, source)
    drive.put("cuts", "Cuts", ["deep"], mime=FOLDER)
    drive.put("f1", "EA0584-cut-v1.mp4", ["cuts"])
    drive.put("outside", "Someone else.mp4", ["elsewhere"])
    drive.put("salary", "Salary 2026", ["root-folder"], mime=FOLDER)
    drive.put("payslip", "march.pdf", ["salary"])
    drive.put("named", "salary sheet.xlsx", ["cuts"])
    result = feed.poll_source(worker, drive, w.org, source, page_size=2)
    assert (result.status, result.pages, result.events, result.dropped) == ("ok", 3, 2, 4)
    got = events(worker, w, source)
    assert [(e["type"], e["subject"]) for e in got] == [("drive.folder.created", "file:gdrive:cuts"),
                                                       ("drive.file.created", "file:gdrive:f1")]
    assert got[1]["data"]["parents"] == ["gdrive:cuts"] and "last_modifying_user" in got[1]["data"]
    assert state(worker, w, source, "outside") is None and state(worker, w, source, "payslip") is None
    assert drive.gets == 3                                   # "deep", "elsewhere", "salary": each asked once per run

    # Replay: the cursor goes back (a restored checkpoint, an overlapping page) and nothing is added twice.
    q(worker, w.org, "update pulse.collector_cursor set cursor=%s where collector='gdrive_changes' and scope_key=%s",
      (Jsonb({"page_token": start}), str(source)))
    again = feed.poll_source(worker, drive, w.org, source, page_size=2)
    assert again.events == 0 and again.duplicates == 2
    assert len(events(worker, w, source)) == 2
    assert q(worker, w.org, "select count(*) n from pulse.drive_change where source_id=%s", (source,))[0]["n"] == 2


def test_crash_before_commit_refetches_and_after_commit_does_not(worker, world):
    w, drive = world, FakeDrive()
    source = folder_root(worker, w, drive)
    feed.poll_source(worker, drive, w.org, source)
    for n in range(3):
        drive.put(f"c{n}", f"cut {n}.mp4", ["root-folder"])

    def crash_before_page_two(point, page):
        if (point, page) == ("before_commit", 2):
            raise Crash()
    with pytest.raises(Crash):
        feed.poll_source(worker, drive, w.org, source, page_size=1, fault=crash_before_page_two)
    assert len(events(worker, w, source)) == 1               # page 1 committed, page 2 rolled back whole
    assert cursor(worker, w, source) == drive.token(1)
    assert state(worker, w, source, "c1") is None
    resumed = feed.poll_source(worker, drive, w.org, source, page_size=1)
    assert (resumed.pages, resumed.events) == (2, 2)

    drive.put("c3", "cut 3.mp4", ["root-folder"])

    def crash_after_commit(point, page):
        if point == "after_commit":
            raise Crash()
    with pytest.raises(Crash):
        feed.poll_source(worker, drive, w.org, source, fault=crash_after_commit)
    assert feed.poll_source(worker, drive, w.org, source).events == 0
    subjects = [e["subject"] for e in events(worker, w, source)]
    assert sorted(subjects) == [f"file:gdrive:c{n}" for n in range(4)]


def test_rate_limit_backs_off_and_resumes_from_the_last_checkpoint(worker, world):
    w, drive = world, FakeDrive()
    source = folder_root(worker, w, drive)
    feed.run_once(worker, w.org, lambda s: drive)
    for n in range(2):
        drive.put(f"r{n}", f"render {n}.mp4", ["root-folder"])
    drive.raise_next = [None, RateLimited(retry_after=120)]
    later = datetime.now(UTC) + timedelta(minutes=10)
    result = feed.run_once(worker, w.org, lambda s: drive, now=lambda: later, page_size=1)
    assert [(r.status, r.error_code, r.pages) for r in result] == [("rate_limited", "rate_limited", 1)]
    row = source_row(worker, w, source)
    assert row["failures"] == 1 and row["backoff_until"] >= later + timedelta(seconds=120)
    lists = drive.lists
    assert feed.run_once(worker, w.org, lambda s: drive, now=lambda: later + timedelta(seconds=30)) == []
    assert drive.lists == lists                               # backing off: Google is not called
    resumed = feed.run_once(worker, w.org, lambda s: drive, now=lambda: row["backoff_until"] + timedelta(seconds=1))
    assert [(r.status, r.events) for r in resumed] == [("ok", 1)]
    assert len(events(worker, w, source)) == 2 and source_row(worker, w, source)["failures"] == 0


def test_push_wakes_the_poller_a_missed_one_is_polled_and_channels_renew(worker, api, world):
    w, drive = world, FakeDrive()
    source = folder_root(worker, w, drive)
    feed.run_once(worker, w.org, lambda s: drive, address=HOOK)
    assert len(drive.watches) == 1
    channel = drive.watches[0]
    row = source_row(worker, w, source)
    assert str(row["channel_id"]) == channel["id"] and row["channel_token_hash"] == sha(channel["token"])
    assert channel["token"] not in json.dumps(row, default=str)

    def wake(token, channel_id=None, org=None, state="change"):
        return q(api, org or w.org, "select pulse.drive_changes_wake(%s,%s,%s) ok",
                 (channel_id or channel["id"], sha(token), state))[0]["ok"]
    drive.put("w1", "woken.mp4", ["root-folder"])
    assert wake("x" * 43) is False
    assert wake(channel["token"], state="sync") is True and source_row(worker, w, source)["wake_at"] is None
    assert wake(channel["token"]) is True
    woken = feed.run_once(worker, w.org, lambda s: drive, address=HOOK)
    assert [(r.status, r.events) for r in woken] == [("ok", 1)]

    # The notification for this edit never arrives: the scheduled poll still reads it.
    drive.put("w2", "missed.mp4", ["root-folder"])
    assert feed.run_once(worker, w.org, lambda s: drive, address=HOOK) == []
    due = datetime.now(UTC) + timedelta(seconds=feed.DEFAULT_POLL_SECONDS + 1)
    assert [r.events for r in feed.run_once(worker, w.org, lambda s: drive, now=lambda: due)] == [1]

    # The channel expires: its token stops waking anything, and the next run opens a new one and stops the old.
    q(worker, w.org, "update pulse.drive_source set channel_expires_at=now()-interval '1 minute' where id=%s", (source,))
    assert wake(channel["token"]) is False
    feed.run_once(worker, w.org, lambda s: drive, address=HOOK)
    assert len(drive.watches) == 2 and drive.stopped == [(channel["id"], f"resource-{channel['id'][:8]}")]
    assert wake(drive.watches[1]["token"], drive.watches[1]["id"]) is True
    assert {e["subject"] for e in events(worker, w, source)} == {"file:gdrive:w1", "file:gdrive:w2"}


def test_a_refused_watch_leaves_polling_on_and_waits_an_hour_before_trying_again(worker, world):
    w, drive = world, FakeDrive()
    source = folder_root(worker, w, drive)
    drive.watch_error = AccessLost()
    hold: dict = {}
    feed.run_once(worker, w.org, lambda s: drive, address=HOOK, channel_hold=hold)
    assert drive.watch_calls == 1 and source_row(worker, w, source)["channel_error"] == "watch_failed"
    drive.put("p1", "polled anyway.mp4", ["root-folder"])
    due = datetime.now(UTC) + timedelta(seconds=feed.DEFAULT_POLL_SECONDS + 1)
    assert [r.events for r in feed.run_once(worker, w.org, lambda s: drive, address=HOOK, now=lambda: due,
                                            channel_hold=hold)] == [1]
    assert drive.watch_calls == 1                           # no new watch within the hour
    drive.watch_error = None
    later = datetime.now(UTC) + feed.CHANNEL_RETRY + timedelta(minutes=1)
    feed.run_once(worker, w.org, lambda s: drive, address=HOOK, now=lambda: later, channel_hold=hold)
    assert drive.watch_calls == 2 and source_row(worker, w, source)["channel_error"] is None


def test_a_refused_cursor_waits_for_a_reviewed_recovery_that_records_the_gap(worker, world):
    w, drive = world, FakeDrive()
    source = folder_root(worker, w, drive)
    feed.poll_source(worker, drive, w.org, source)
    drive.put("k1", "kept.mp4", ["root-folder"])
    feed.poll_source(worker, drive, w.org, source)
    checkpoint = source_row(worker, w, source)["last_checkpoint_at"]
    stale = cursor(worker, w, source)
    drive.refused.add(stale)
    drive.put("k2", "during the gap.mp4", ["root-folder"])
    later = datetime.now(UTC) + timedelta(hours=1)
    refused = feed.run_once(worker, w.org, lambda s: drive, now=lambda: later)
    assert [(r.status, r.error_code) for r in refused] == [("cursor_invalid", "cursor_invalid")]
    assert cursor(worker, w, source) == stale                 # nothing reset
    lists = drive.lists
    assert feed.run_once(worker, w.org, lambda s: drive, now=lambda: later + timedelta(days=1)) == []
    assert drive.lists == lists
    with pytest.raises(PermissionError):
        feed.recover(worker, drive, w.org, source, reviewed_by=w.editor, note="Synthetic review")
    done = feed.recover(worker, drive, w.org, source, reviewed_by=w.manager, note="Synthetic review of the gap")
    gap = q(worker, w.org, "select * from pulse.drive_change_gap where source_id=%s", (source,))
    assert len(gap) == 1 and gap[0]["from_at"] == checkpoint and gap[0]["rescan"] == "open"
    assert gap[0]["old_cursor_hash"] == sha(stale) and str(gap[0]["id"]) == done["gap"]
    assert source_row(worker, w, source)["status"] == "ok" and cursor(worker, w, source) != stale
    assert state(worker, w, source, "k1")["availability"] == "available" and len(events(worker, w, source)) == 1
    with pytest.raises(ValueError):
        feed.recover(worker, drive, w.org, source, reviewed_by=w.manager, note="Second recovery")


def test_deletion_lost_access_and_moves_are_tombstones_that_keep_accepted_facts(worker, world):
    w, drive = world, FakeDrive()
    source = folder_root(worker, w, drive)
    feed.poll_source(worker, drive, w.org, source)
    drive.put("d1", "deliverable.mp4", ["root-folder"])
    drive.put("d2", "moved away.mp4", ["root-folder"])
    drive.put("d3", "binned.mp4", ["root-folder"])
    feed.poll_source(worker, drive, w.org, source)
    drive.remove("d1")                                      # deleted, or no longer shared with the reader
    drive.put("d2", "moved away.mp4", ["elsewhere"])
    drive.put("d3", "binned.mp4", ["root-folder"], trashed=True)
    result = feed.poll_source(worker, drive, w.org, source)
    assert (result.tombstones, result.events) == (2, 1)
    assert state(worker, w, source, "d1") == {"name": "deliverable.mp4", "availability": "removed", "parents": ["root-folder"]}
    assert state(worker, w, source, "d2")["availability"] == "out_of_scope"
    assert state(worker, w, source, "d2")["parents"] == ["root-folder"]  # nothing recorded about where it went
    assert state(worker, w, source, "d3")["availability"] == "trashed"
    kinds = [e["type"] for e in events(worker, w, source)]
    assert kinds == ["drive.file.created"] * 3 + ["drive.file.trashed"]
    drive.put("d1", "deliverable.mp4", ["root-folder"])     # shared again
    assert feed.poll_source(worker, drive, w.org, source).events == 1
    assert state(worker, w, source, "d1")["availability"] == "available"
    journal = [r["kind"] for r in q(worker, w.org, "select kind from pulse.drive_change where source_id=%s and file_id='d1' order by change_time", (source,))]
    assert journal == ["created", "removed", "restored"]


def test_shared_drive_access_loss_marks_the_root_and_keeps_its_files(worker, world):
    w, drive = world, FakeDrive()
    source = feed.add_source(worker, w.org, kind="shared_drive", drive_id="shared-1", label="Shared deliverables",
                             credential_ref="synthetic-ea")
    feed.approve_source(worker, w.org, source, approved_by=w.manager, approval_ref="E13 synthetic approval")
    feed.poll_source(worker, drive, w.org, source)
    drive.put("s1", "final.mp4", ["shared-1"], drive_id="shared-1")
    drive.put("other", "not ours.mp4", ["shared-2"], drive_id="shared-2")
    assert feed.poll_source(worker, drive, w.org, source).events == 1
    drive.drive_removed("shared-1")
    assert feed.poll_source(worker, drive, w.org, source).status == "access_lost"
    drive.raise_next = [AccessLost()]
    later = datetime.now(UTC) + timedelta(hours=2)
    lost = feed.run_once(worker, w.org, lambda s: drive, now=lambda: later)
    assert [(r.status, r.error_code) for r in lost] == [("access_lost", "access_lost")]
    row = source_row(worker, w, source)
    assert row["backoff_until"] == later + timedelta(seconds=feed.ACCESS_RECHECK_SECONDS)
    assert state(worker, w, source, "s1")["availability"] == "available" and len(events(worker, w, source)) == 1


def test_an_owner_update_reaches_only_its_approved_tenant_once(worker, owner, api, world):
    a, b = world, build_world(worker, owner, api)
    make_admin(worker, b)
    drive_a, drive_b = FakeDrive(), FakeDrive()
    src_a = feed.add_source(worker, a.org, kind="shared_drive", drive_id="team-a", label="Team A", credential_ref="a")
    src_b = feed.add_source(worker, b.org, kind="shared_drive", drive_id="team-a", label="Team A", credential_ref="b")
    feed.approve_source(worker, a.org, src_a, approved_by=a.manager, approval_ref="E13 synthetic approval")
    with pytest.raises(LookupError):                        # another tenant's root cannot be approved from here
        feed.approve_source(worker, b.org, src_a, approved_by=b.manager, approval_ref="E13 synthetic approval")
    drives = {src_a: drive_a, src_b: drive_b}
    for org in (a.org, b.org):
        feed.run_once(worker, org, lambda s: drives[s["id"]])
    drive_a.put("nonpersonal", "Synthetic brief v2.pdf", ["team-a"], drive_id="team-a", mime="application/pdf")
    due = datetime.now(UTC) + timedelta(hours=1)
    for _ in range(2):
        for org in (a.org, b.org):
            feed.run_once(worker, org, lambda s: drives[s["id"]], now=lambda: due)
    subject = "file:gdrive:nonpersonal"
    assert [e["subject"] for e in events(worker, a, src_a)] == [subject]
    assert q(worker, b.org, "select count(*) n from pulse.event where subject=%s", (subject,))[0]["n"] == 0
    assert q(worker, b.org, "select count(*) n from pulse.drive_source where id=%s", (src_a,))[0]["n"] == 0
    assert drive_b.lists == 0                               # B's root was never approved


def test_health_reports_carry_no_tokens_accounts_or_names(worker, api, world):
    w, drive = world, FakeDrive()
    source = folder_root(worker, w, drive)
    feed.run_once(worker, w.org, lambda s: drive, address=HOOK)
    drive.put("h1", "Secret Client Name.mp4", ["root-folder"])
    due = datetime.now(UTC) + timedelta(hours=1)
    results = feed.run_once(worker, w.org, lambda s: drive, address=HOOK, now=lambda: due)
    channel_token = drive.watches[0]["token"]
    reports = [json.dumps([r.summary() for r in results]), json.dumps(feed.status(worker, w.org), default=str),
               json.dumps(q(api, w.org, "select pulse.drive_changes_status() d", viewer=w.manager)[0]["d"])]
    for text in reports:
        for secret in (SECRET, channel_token, sha(channel_token), "collector@synthetic.example", "Secret Client Name",
                       "resource-"):
            assert secret not in text
    status = q(api, w.org, "select pulse.drive_changes_status() d", viewer=w.manager)[0]["d"]["sources"][0]
    assert (status["id"], status["status"], status["channel"], status["files"]) == (str(source), "ok", "active", 1)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(api, w.org, "select pulse.drive_changes_status() d", viewer=w.editor)
    for table in ("drive_source", "drive_source_file", "drive_change", "drive_change_gap"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            q(api, w.org, f"select 1 from pulse.{table}")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(worker, w.org, "delete from pulse.drive_source_file where source_id=%s", (source,))


def test_the_hook_and_the_settings_card_through_the_api(worker, api, world, tmp_path):
    """services/api/test/drive-changes-runner.mjs: the hook is 404 while off and for unknown channels, 204 for a live
    one; the admin's Connected sources card reports the root without tokens."""
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    from test_company import configure
    w, drive = world, FakeDrive()
    configure(worker, w)
    q(worker, w.org, "insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
      (w.org, f"admin-r44@{w.domain}", w.manager))
    source = folder_root(worker, w, drive)
    feed.run_once(worker, w.org, lambda s: drive, address=HOOK)
    channel = drive.watches[0]
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(config),
           "TEST_ADMIN_EMAIL": f"admin-r44@{w.domain}", "TEST_CHANNEL": channel["id"], "TEST_TOKEN": channel["token"],
           "TEST_SOURCE": str(source), "PULSE_R44_REPORT": str(tmp_path / "r44.json")}
    p = subprocess.run(["node", "test/drive-changes-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                       env=env, capture_output=True, text=True, timeout=300, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    report = json.loads((tmp_path / "r44.json").read_text())
    assert report["checks"] >= 8
    assert source_row(worker, w, source)["wake_at"] is not None
