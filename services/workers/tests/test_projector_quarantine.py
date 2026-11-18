"""ERROR-SWEEP (17 Nov 2026): a quarantined event is tried again, and a race between two projections no longer
quarantines one.

On production, one Drive event of 29 Oct (a media file in a delivery folder) was quarantined by indexed-deliveries with
"UniqueViolation: duplicate key value violates unique constraint file_org_id_store_store_id_key": the workgraph
projection had written the same pulse.file row (same id) in another transaction, and the deliveries insert only
handled a conflict on the id. The event's delivery was lost, and because the Drive refresh refuses to finish while any
projection error exists, every refresh since then (186 runs) was marked failed: "Synced" in the app said 29 Oct.
"""

from __future__ import annotations

import re
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime

import psycopg
import pytest

from pulse_workers import projector
from pulse_workers.consumer import Event
from pulse_workers.deliveries import Deliveries
from pulse_workers.projector import Projection, ProjectionRunner

ORG = uuid.UUID(int=7)


def ev(seq: int, subject: str = "file:gdrive:synthetic-1") -> Event:
    now = datetime(2026, 10, 29, 8, 50, tzinfo=UTC)
    return Event(seq=seq, tx=seq, id=f"e{seq}", source="/synthetic", type="drive.file.observed", time=now,
                 recorded_at=now, subject=subject, actor=None, actor_kind=None, project_id=None, data={}, purpose=[],
                 redacted=False)


class Rows:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class Conn:
    """The few statements retry_quarantined runs, over an in-memory quarantine and event log."""

    def __init__(self, quarantined: dict[int, str], log: list[Event]):
        self.quarantined = dict(quarantined)
        self.log = log
        self.statements: list[str] = []

    @contextmanager
    def transaction(self):
        yield

    def execute(self, sql, params=()):
        self.statements.append(sql)
        if "select event_seq from pulse.projection_error" in sql:
            return Rows([{"event_seq": s} for s in sorted(self.quarantined)])
        if "select distinct e.subject" in sql:
            seqs = set(params[0])
            subjects = {e.subject for e in self.log if e.seq in seqs}
            return Rows([{"subject": s} for s in subjects
                         if any(e.subject == s
                                and e.seq > min(q.seq for q in self.log if q.seq in seqs and q.subject == s)
                                for e in self.log)])
        if "delete from pulse.projection_error" in sql:
            self.quarantined.pop(params[2], None)
            return Rows([])
        if "insert into pulse.projection_error" in sql:
            self.quarantined[params[2]] = params[5]
            return Rows([])
        return Rows([])


class Recorder(Projection):
    name = "indexed-deliveries"

    def __init__(self, fail_on=()):
        self.fail_on = set(fail_on)
        self.applied: list[int] = []

    def apply(self, conn, event):
        if event.seq in self.fail_on:
            raise ValueError("still broken")
        self.applied.append(event.seq)


@pytest.fixture(autouse=True)
def no_tenant(monkeypatch):
    monkeypatch.setattr(projector, "set_tenant", lambda conn, org: None)


def runner(conn, p, monkeypatch):
    monkeypatch.setattr(projector, "read_events", lambda c, seqs: [e for e in conn.log if e.seq in set(seqs)])
    return ProjectionRunner(conn, p)


def test_a_quarantined_event_that_now_applies_leaves_the_quarantine(monkeypatch):
    conn = Conn({100: "UniqueViolation: file_org_id_store_store_id_key"}, [ev(100)])
    p = Recorder()
    assert runner(conn, p, monkeypatch).retry_quarantined(ORG) == {"applied": 1, "superseded": 0, "failed": 0}
    assert p.applied == [100] and conn.quarantined == {}


def test_one_that_fails_again_stays_with_its_new_error_and_the_others_still_clear(monkeypatch):
    conn = Conn({100: "old", 101: "old"}, [ev(100), ev(101, "file:gdrive:synthetic-2")])
    p = Recorder(fail_on={101})
    assert runner(conn, p, monkeypatch).retry_quarantined(ORG) == {"applied": 1, "superseded": 0, "failed": 1}
    assert conn.quarantined == {101: "ValueError: still broken"}


def test_an_event_with_a_later_one_for_the_same_file_is_superseded_not_applied(monkeypatch):
    # Applying the old snapshot would overwrite the newer state the later event already projected.
    conn = Conn({100: "old"}, [ev(100), ev(250)])
    p = Recorder()
    assert runner(conn, p, monkeypatch).retry_quarantined(ORG) == {"applied": 0, "superseded": 1, "failed": 0}
    assert p.applied == [] and conn.quarantined == {}


def test_nothing_quarantined_reads_nothing_else(monkeypatch):
    conn = Conn({}, [])
    assert runner(conn, Recorder(), monkeypatch).retry_quarantined(ORG) == {"applied": 0, "superseded": 0, "failed": 0}
    assert len(conn.statements) == 1


def test_a_database_failure_still_ends_the_retry(monkeypatch):
    class Broken(Recorder):
        def apply(self, conn, event):
            raise psycopg.OperationalError("server closed the connection")

    conn = Conn({100: "old"}, [ev(100)])
    with pytest.raises(psycopg.OperationalError):
        runner(conn, Broken(), monkeypatch).retry_quarantined(ORG)
    assert 100 in conn.quarantined


def test_the_deliveries_file_insert_yields_to_any_existing_row_for_the_same_drive_file():
    # The workgraph projection writes the same pulse.file row; whichever commits first, the other must not fail.
    import inspect

    src = inspect.getsource(Deliveries.apply)
    insert = re.search(r"insert into pulse\.file\(.*?\"\"\"", src, re.S)
    assert insert, "deliveries still writes pulse.file"
    clause = re.search(r"on conflict\s*(\([^)]*\))?\s*do nothing", insert.group(0))
    assert clause and clause.group(1) is None, "a conflict on any unique key (id or org/store/store_id) is a no-op"
