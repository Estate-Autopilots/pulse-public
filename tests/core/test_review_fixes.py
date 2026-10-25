"""CTO review of EST-24 (2026-10-05): one bad event never stops the pipeline; system columns and the time window are
the database's; partitions are UTC whatever the session; data errors stay per event; ingest checks before parsing."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.types.json import Jsonb

from conftest import dsn
from helpers import build_world, drive_id, event, issue_asset, md5_of, read_as, render, upload
from pulse_ingest.app import create_app
from pulse_ingest.core import ingest_device_batch
from pulse_sdk.collector import Manifest, RawRecord, TenantContext
from pulse_sdk.db import set_tenant
from pulse_sdk.envelope import to_row
from pulse_sdk.runtime import MAX_ATTEMPTS, CollectorRuntime
from pulse_sdk.signing import sign_headers
from pulse_sdk.store import insert_event
from pulse_sdk.ulid import new_ulid
from pulse_workers.projector import ProjectionRunner, fingerprint
from pulse_workers.workgraph import WorkGraph


def raw_insert(conn, w, ev):
    """Store an event without the client-side validator (as a buggy or hostile writer would)."""
    with conn.transaction():
        set_tenant(conn, w.org)
        return insert_event(conn, to_row(ev))


# ------------------------------------------------------------------------------------------- 1. poison events
def test_poison_events_are_quarantined_and_everyone_else_still_projects(worker, owner, api):
    a = build_world(worker, owner, api)
    b = build_world(worker, owner, api)
    cid_a, cid_b = a.cid("HK", 3), b.cid("HK", 3)
    issue_asset(api, a, cid_a)
    issue_asset(api, b, cid_b)
    poison = [
        event(a.org, "agent.render.detected", "file:local:x.mp4",
              {"name": 7, "size": 1, "md5": md5_of("p"), "sha256": "0" * 64, "cid": 7},
              source=f"/agent/{a.device}", actor=f"device:pulse:{a.device}", time=a.at(5)),
        event(a.org, "task.created", f"task:pulse:{uuid.uuid4()}",
              {"project_ref": f"project:pulse:{a.project}", "title": "t", "assignee_ref": 5, "due_at": "soon"},
              source="/api/web", time=a.at(6)),
        event(a.org, "leave.declared", f"person:pulse:{a.editor}", {"from": "2026-02-31", "to": "never"},
              source="/api/web", time=a.at(7)),
    ]
    for ev in poison:
        assert raw_insert(worker, a, ev).status == "accepted"
    render(worker, a, a.device, f"{cid_a}-v1.mp4", "good-a", minutes=10)
    upload(worker, a, drive_id(), f"{cid_a}-v1.mp4", "good-a", folder=a.drafts, minutes=20)
    upload(worker, b, drive_id(), f"{cid_b}-v1.mp4", "good-b", folder=b.drafts, minutes=20)
    runner = ProjectionRunner(worker, WorkGraph())
    done = runner.run_all()
    assert done.get(a.org, 0) > 0 and done.get(b.org, 0) > 0
    got_a = read_as(worker, a.org, "select person_id, method from pulse.attribution")
    got_b = read_as(worker, b.org, "select person_id, method from pulse.attribution")
    assert [(g["person_id"], g["method"]) for g in got_a] == [(a.editor, "evidence")]   # later events still project
    assert len(got_b) == 1                                                                # the other tenant too
    # The numeric cid/name and the impossible leave dates are tolerated; the unparseable due date is quarantined.
    errors = read_as(worker, a.org, "select event_type, error from pulse.projection_error order by event_seq")
    assert [e["event_type"] for e in errors] == ["task.created"] and "soon" in errors[0]["error"]
    before = fingerprint(worker, a.org, WorkGraph.tables)
    runner.rebuild(a.org)                                           # replay meets the same poison, same result
    assert fingerprint(worker, a.org, WorkGraph.tables) == before


# ----------------------------------------------------------------------------- 7. system columns, time window
def test_writers_cannot_forge_system_columns_or_leave_the_window(worker, owner, api, admin):
    w = build_world(worker, owner, api)
    ev = event(w.org, "drive.file.created", f"file:gdrive:{drive_id()}",
               {"name": "f.mp4", "mime": "video/mp4", "parents": [w.root]}, source=w.collector, time=w.at(5))
    row = to_row(ev)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.event (org_id, id, source, type, time, subject, purpose, sensitivity,
                                                   visibility, retention, data, seq, tx_id, recorded_at, redacted_at,
                                                   redaction_hash)
                          values (%s, %s, %s, %s, %s, %s, %s, 1, 'team', 'legal', %s, 1, '1', '2000-01-01',
                                  '2000-01-01', 'forged')""",
                       (w.org, row["id"], row["source"], row["type"], row["time"], row["subject"], row["purpose"],
                        Jsonb(row["data"])))
    got = read_as(admin, w.org, """select seq, tx_id::text as tx, recorded_at, redacted_at, redaction_hash, retention
                                   from pulse.event where id = %s""", (row["id"],))[0]
    assert got["seq"] != 1 and got["tx"] != "1" and got["redacted_at"] is None and got["redaction_hash"] is None
    assert got["recorded_at"] > datetime.now(UTC) - timedelta(minutes=5) and got["retention"] == "work_record"
    for days in (-300, 2):                                          # 300 days back, 2 days ahead
        late = dict(row, id=new_ulid(), time=datetime.now(UTC) + timedelta(days=days))
        with worker.transaction():
            set_tenant(worker, w.org)
            result = insert_event(worker, late)
        assert result.status == "rejected" and "window" in result.error


# ------------------------------------------------------------------------------------------- 8. partitions UTC
def test_partitions_are_utc_whatever_the_session(owner, admin):
    day = (datetime.now(UTC) + timedelta(days=40)).date()
    name = "event_eph_" + day.strftime("%Y_%m_%d")
    with owner.transaction():
        owner.execute("set local timezone = 'America/New_York'")
        owner.execute("set local datestyle = 'SQL, DMY'")
        owner.execute("select pulse.ensure_ephemeral_partitions(%s, 1)", (day,))
    with admin.transaction():
        admin.execute("set local timezone = 'UTC'")
        bound = admin.execute("""select pg_get_expr(c.relpartbound, c.oid) as b from pg_class c
                                 where c.relname = %s""", (name,)).fetchone()["b"]
    nxt = day + timedelta(days=1)
    assert bound == f"FOR VALUES FROM ('{day} 00:00:00+00') TO ('{nxt} 00:00:00+00')", bound
    with owner.transaction():
        owner.execute("set local timezone = 'Asia/Kolkata'")
        result = owner.execute("select pulse.maintain_partitions() as r").fetchone()["r"]
    assert "event_error" not in result and "ephemeral_error" not in result


# ---------------------------------------------------------------------------------- 6. data errors per event
class _AcceptAll:
    def errors(self, event, now=None):
        return []


def test_database_data_errors_reject_one_event_not_the_batch(worker, owner, api, ingest):
    w = build_world(worker, owner, api)
    nul = event(w.org, "agent.render.detected", "file:local:n.mp4",
                {"name": "bad\u0000name.mp4", "size": 1, "md5": md5_of("n"), "sha256": "0" * 64},
                source=f"/agent/{w.device}", actor=f"device:pulse:{w.device}", time=w.at(5))
    good = event(w.org, "agent.render.detected", "file:local:g.mp4",
                 {"name": "g.mp4", "size": 1, "md5": md5_of("g"), "sha256": "0" * 64},
                 source=f"/agent/{w.device}", actor=f"device:pulse:{w.device}", time=w.at(6))
    body = json.dumps([nul, good]).encode()
    res = ingest_device_batch(ingest, sign_headers(w.device_keys[w.device], str(w.device), body), body,
                              validator=_AcceptAll())
    assert [s["status"] for s in res.body] == ["rejected", "accepted"], res.body
    assert "invalid data" in res.body[0]["error"]


def test_runtime_dead_letters_a_record_the_database_refuses(worker, owner, api):
    w = build_world(worker, owner, api)
    manifest = Manifest.from_dict({"name": "gdrive_audit", "version": "1.0.0", "source_kind": "pull",
                                   "provider": "google_workspace", "emits": ["drive.file.uploaded"],
                                   "purposes": ["delivery"], "sensitivity": 1})

    class OneRecord:
        def __init__(self):
            self.manifest = manifest

        def poll(self, ctx, cursor):
            t = w.at(5).isoformat()
            return [RawRecord("bad", {"t": t, "nul": True}), RawRecord("ok", {"t": t, "nul": False})], {}

        def normalise(self, ctx, raw):          # a normaliser bug produces a value PostgreSQL cannot store
            name = "x\u0000.mp4" if raw.payload["nul"] else "y.mp4"
            return [{"type": "drive.file.uploaded", "time": raw.payload["t"], "subject": f"file:gdrive:{raw.source_ref}",
                     "purpose": "delivery", "sensitivity": 1, "visibility": "team",
                     "data": {"name": name, "mime": "video/mp4", "parents": [w.drafts]}}]

    rt = CollectorRuntime(worker, OneRecord(), validator=_AcceptAll())
    ctx = TenantContext(w.org, w.instance)
    first = rt.poll(ctx)
    assert first.events_accepted == 1 and first.retried == 1
    for _ in range(MAX_ATTEMPTS - 1):
        last = rt.normalise_pending(ctx)
    assert last.dead_letters == 1
    rows = read_as(worker, w.org, "select source_ref, error from pulse.raw_inbox where error is not null")
    assert [r["source_ref"] for r in rows] == ["bad"] and "invalid data" in rows[0]["error"]


# ---------------------------------------------------------------------------------------- 3, 4. ingest order
def test_ingest_parses_nothing_before_the_signature_and_binds_device_subjects(worker, owner, api, ingest):
    w = build_world(worker, owner, api)
    key = w.device_keys[w.device]
    for body, status in ((b"{not json", 400), (b"[" * 100_000 + b"]" * 100_000, 400), (b'{"a": 1}', 400)):
        assert ingest_device_batch(ingest, sign_headers(key, str(w.device), body), body).status == status
    other = build_world(worker, owner, api)
    unsigned = b"{not json"
    assert ingest_device_batch(ingest, sign_headers(other.device_keys[other.device], str(w.device), unsigned),
                               unsigned).status == 401            # bad signature wins over bad JSON
    usage = event(w.org, "agent.usage.hourly", f"device:pulse:{w.device2}",
                  {"hour_start": w.at(0).replace(minute=0, second=0, microsecond=0).isoformat(), "active_s": 60,
                   "idle_s": 0, "categories": {"editing": 60}},
                  source=f"/agent/{w.device}", actor=f"device:pulse:{w.device}", time=w.at(0))
    body = json.dumps([usage]).encode()
    res = ingest_device_batch(ingest, sign_headers(key, str(w.device), body), body)
    assert res.body[0]["status"] == "rejected" and "authenticated device" in res.body[0]["error"]


def test_ingest_has_no_docs_routes(database):
    with TestClient(create_app(dsn("ingest"))) as client:
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert client.get(path).status_code == 404
        assert client.post("/v1/events", content=b"x" * ((1 << 20) + 1)).status_code == 413
