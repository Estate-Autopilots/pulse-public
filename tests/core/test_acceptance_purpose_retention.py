"""Acceptance: events without a purpose are rejected on every path, and expired data is removed on schedule."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import psycopg
import pytest
from psycopg.types.json import Jsonb

from pulse_ingest.core import ingest_device_batch
from pulse_sdk.db import set_tenant
from pulse_sdk.envelope import to_row
from pulse_sdk.signing import sign_headers
from pulse_sdk.store import insert_event
from pulse_sdk.ulid import new_ulid
from pulse_workers.maintenance import run_retention
from pulse_workers.scheduler import DAILY, State, due_jobs

from helpers import VALIDATOR, build_world, event, md5_of, read_as


def _render_event(w, purpose):
    ev = event(w.org, "agent.render.detected", "file:local:x.mp4",
               {"name": "x.mp4", "size": 1, "md5": md5_of("x"), "sha256": "0" * 64},
               source=f"/agent/{w.device}", actor=f"device:pulse:{w.device}", time=w.at(5))
    if purpose is None:
        ev.pop("purpose")
    else:
        ev["purpose"] = purpose
    return ev


# ------------------------------------------------------------------------------------------- purpose is required
@pytest.mark.parametrize("purpose", [None, "", "marketing", "delivery,surveillance", "outcomes"])
def test_validator_rejects_missing_or_wrong_purpose(worker, owner, api, purpose):
    w = build_world(worker, owner, api)
    errors = VALIDATOR.errors(_render_event(w, purpose))
    assert any(e.startswith("purpose") for e in errors), errors


def test_ingest_rejects_events_without_purpose(worker, owner, api, ingest):
    w = build_world(worker, owner, api)
    good, bad = _render_event(w, "delivery"), _render_event(w, None)
    body = json.dumps([good, bad]).encode()
    headers = sign_headers(w.device_keys[w.device], str(w.device), body)
    res = ingest_device_batch(ingest, headers, body)
    assert res.status == 207
    assert [s["status"] for s in res.body] == ["accepted", "rejected"]
    assert "purpose" in res.body[1]["error"]


@pytest.mark.parametrize("role", ["api", "worker", "ingest"])
@pytest.mark.parametrize("purpose,reason", [([], "no purpose"), (["marketing"], "not allowed"),
                                            (["delivery", "outcomes"], "not allowed")])
def test_database_rejects_events_without_allowed_purpose(worker, owner, api, ingest, role, purpose, reason):
    """Defence in depth: even a writer that skips validation cannot store an event without an allowed purpose."""
    w = build_world(worker, owner, api)
    conn = {"api": api, "worker": worker, "ingest": ingest}[role]
    row = to_row(_render_event(w, "delivery"))
    if role == "api":            # the API may only emit /api events: use a declared type
        row = to_row(event(w.org, "attribution.confirmed", "event:pulse:1", {"person_ref": f"person:pulse:{w.editor}"},
                           source="/api/web", time=w.at(5)))
    row["purpose"] = purpose
    with conn.transaction():
        set_tenant(conn, w.org)
        result = insert_event(conn, row)
    assert result.status == "rejected" and reason in result.error, result


def test_database_enforces_the_registry_floors(worker, owner, api):
    w = build_world(worker, owner, api)
    base = to_row(_render_event(w, "delivery"))
    cases = {
        "visibility": dict(base, visibility="org"),                    # looser than the floor (team)
        "sensitivity": dict(base, sensitivity=0),                      # below the floor (1)
        "source": dict(base, source="/collectors/gdrive_audit/1/x"),   # emitter not allowed for agent.render
        "subject": dict(base, subject="device:pulse:x"),               # subject format
        "data lacks": dict(base, data={"name": "x.mp4"}),              # required data fields
        "unknown type": dict(base, type="agent.keystrokes.logged"),
    }
    for reason, row in cases.items():
        row = dict(row, id=new_ulid(w.at(5)))
        with worker.transaction():
            set_tenant(worker, w.org)
            result = insert_event(worker, row)
        assert result.status == "rejected" and reason in result.error, (reason, result)


# ------------------------------------------------------------------------------------------------- retention
def _old_event(worker, owner, w, days_ago: int, type_="drive.file.created"):
    when = datetime.now(timezone.utc) - timedelta(days=days_ago)     # the log accepts at most 210 days back
    fid = uuid.uuid4().hex
    ev = event(w.org, type_, f"file:gdrive:{fid}", {"name": "old.mp4", "mime": "video/mp4", "parents": [w.root]},
               source=w.collector, actor=f"account:google:{w.shared_handle}", time=when)
    with worker.transaction():
        set_tenant(worker, w.org)
        assert insert_event(worker, to_row(ev)).status == "accepted"
    return ev["id"]


def _ephemeral(worker, owner, w, days_ago: int):
    day = (datetime.now(timezone.utc) - timedelta(days=days_ago)).replace(minute=0, second=0, microsecond=0)
    with owner.transaction():
        owner.execute("select pulse.ensure_ephemeral_partitions(%s::date, 1)", (day.date(),))
    ev = event(w.org, "agent.usage.hourly", f"device:pulse:{w.device}",
               {"hour_start": day.isoformat(), "active_s": 3000, "idle_s": 600, "categories": {"editing": 2700}},
               source=f"/agent/{w.device}", actor=f"device:pulse:{w.device}", time=day)
    with worker.transaction():
        set_tenant(worker, w.org)
        assert insert_event(worker, to_row(ev)).status == "accepted"
    return "event_eph_" + day.strftime("%Y_%m_%d")


def test_expired_data_is_removed_on_schedule(worker, owner, api, privacy, admin):
    w = build_world(worker, owner, api)
    with worker.transaction():                                      # this tenant keeps work records for 30 days
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.tenant_config (org_id, doc_kind, doc_key, version, body, is_active)
                          values (%s, 'retention_policy', 'default', 1, %s, true)""",
                       (w.org, Jsonb({"work_record": 30})))
    old_id = _old_event(worker, owner, w, days_ago=45)              # expired
    fresh_id = _old_event(worker, owner, w, days_ago=10)            # kept
    expired_partition = _ephemeral(worker, owner, w, days_ago=75)   # activity_raw keeps 60 days
    kept_partition = _ephemeral(worker, owner, w, days_ago=3)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.raw_inbox (org_id, source, source_ref, payload, received_at)
                          values (%s, %s, 'old-page', %s, now() - interval '31 days'),
                                 (%s, %s, 'new-page', %s, now() - interval '1 day')""",
                       (w.org, w.collector, Jsonb({"k": 1}), w.org, w.collector, Jsonb({"k": 2})))

    # The schedule: retention is due once per UTC day after its slot, and not again the same day.
    state = State(path=__import__("pathlib").Path("/nonexistent/never-written"))
    state.data = {}
    now = datetime.now(timezone.utc)
    assert "retention" in due_jobs(now, state)
    report = run_retention(privacy, orgs=[w.org])
    state.data["retention"] = now.isoformat()
    assert "retention" not in due_jobs(now, state)
    assert any(j.name == "retention" for j in DAILY)

    assert expired_partition in report.dropped_partitions and kept_partition not in report.dropped_partitions
    assert report.redacted[str(w.org)]["work_record"] >= 1
    assert report.raw_purged[str(w.org)] == 1
    rows = {r["id"]: r for r in read_as(
        admin, w.org, "select id, data, actor, redacted_at, redaction_hash from pulse.event where org_id = %s "
        "and id = any(%s)", (w.org, [old_id, fresh_id]))}
    assert rows[old_id]["data"] == {} and rows[old_id]["actor"] is None and len(rows[old_id]["redaction_hash"]) == 64
    assert rows[fresh_id]["redacted_at"] is None and rows[fresh_id]["data"]["name"] == "old.mp4"
    assert admin.execute("select to_regclass(%s) as t", (f"pulse.{expired_partition}",)).fetchone()["t"] is None
    assert admin.execute("select to_regclass(%s) as t", (f"pulse.{kept_partition}",)).fetchone()["t"] is not None
    logged = read_as(admin, w.org, """select data from pulse.event where org_id = %s
                                       and type = 'privacy.event.redacted'
                                       and subject = 'event:pulse:retention:work_record'""", (w.org,))[0]
    assert logged and logged["data"]["reason"] == "retention" and logged["data"]["count"] >= 1
    again = run_retention(privacy, orgs=[w.org])                    # idempotent: nothing more to remove
    assert str(w.org) not in again.redacted and expired_partition not in again.dropped_partitions


def test_tenant_retention_overrides_stay_between_floor_and_ceiling(worker, owner, api, privacy, admin):
    w = build_world(worker, owner, api)
    policy = {"work_record": 5000, "work_metadata": 30, "security_log": 100, "voice_raw": 0, "outcome": -5,
              "office_aggregate": "forever", "activity_raw": 12.5}
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.tenant_config (org_id, doc_kind, doc_key, version, body, is_active)
                          values (%s, 'retention_policy', 'default', 1, %s, true)""", (w.org, Jsonb(policy)))
    with privacy.transaction():
        set_tenant(privacy, w.org)
        days = {c: privacy.execute("select privacy.retention_days(%s) as d", (c,)).fetchone()["d"]
                for c in list(policy) + ["legal"]}
    assert days == {"work_record": 730,        # above the ceiling: ignored, default
                    "work_metadata": 30,       # shorter, allowed
                    "security_log": 395,       # below the legal floor (365): ignored
                    "voice_raw": 7, "outcome": 1125, "office_aggregate": 395, "activity_raw": 60,   # invalid: default
                    "legal": 2555}
    with privacy.transaction():                # a bad value never aborts the tenant's retention run
        set_tenant(privacy, w.org)
        assert isinstance(privacy.execute("select privacy.redact_expired() as r").fetchone()["r"], dict)


def test_privacy_role_cannot_delete_unexpired_data(worker, owner, api, privacy):
    w = build_world(worker, owner, api)
    _old_event(worker, owner, w, days_ago=10)
    for sql in ("delete from pulse.event", "update pulse.event set data = '{}'", "drop table pulse.event_default",
                "select pulse.ensure_event_partitions('2020-01-01', 1)"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with privacy.transaction():
                set_tenant(privacy, w.org)
                privacy.execute(sql)
    with privacy.transaction():
        set_tenant(privacy, w.org)
        assert privacy.execute("select privacy.redact_expired() as r").fetchone()["r"] == {}
