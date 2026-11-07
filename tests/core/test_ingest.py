"""Ingest protocol (05 §8.3): routing, signature, replay window, per-event checks, idempotency, privacy."""

from __future__ import annotations

import json
import time
import uuid

from fastapi.testclient import TestClient

from pulse_ingest.app import create_app
from pulse_ingest.core import ingest_device_batch
from pulse_sdk.db import set_tenant
from pulse_sdk.signing import generate_keypair, sign_headers
from pulse_sdk.ulid import new_ulid

from conftest import dsn
from helpers import build_world, event, md5_of


def render_event(w, device=None, **over):
    device = device or w.device
    ev = event(w.org, "agent.render.detected", "file:local:a.mp4",
               {"name": "a.mp4", "size": 10, "md5": md5_of("a"), "sha256": "0" * 64},
               source=f"/agent/{device}", actor=f"device:pulse:{device}", time=w.at(5))
    ev.update(over)
    return ev


def post(ingest, w, events, device=None, key=None, **sign):
    device = device or w.device
    body = json.dumps(events).encode()
    headers = sign_headers(key or w.device_keys[device], str(device), body, **sign)
    return ingest_device_batch(ingest, headers, body)


def test_accepts_and_dedupes(worker, owner, api, ingest):
    w = build_world(worker, owner, api)
    ev = render_event(w)
    first = post(ingest, w, [ev])
    assert first.status == 200 and first.body == [{"id": ev["id"], "status": "accepted"}]
    again = post(ingest, w, [ev])                         # a retry carries the same id and time
    assert again.status == 200 and again.body[0]["status"] == "duplicate"


def test_auth_failures(worker, owner, api, ingest):
    w = build_world(worker, owner, api)
    ev = render_event(w)
    other_key, _ = generate_keypair()
    assert post(ingest, w, [ev], key=other_key).status == 401                          # wrong key
    assert post(ingest, w, [ev], timestamp=int(time.time()) - 600).status == 401        # outside the window
    body = json.dumps([ev]).encode()
    headers = sign_headers(w.device_keys[w.device], str(w.device), body)
    assert ingest_device_batch(ingest, headers, body).status == 200
    assert ingest_device_batch(ingest, headers, body).status == 401                     # replayed nonce
    unknown = uuid.uuid4()
    assert post(ingest, w, [ev], device=unknown, key=other_key).status == 401          # unknown device
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.device set revoked_at = now() where id = %s", (w.device,))
    assert post(ingest, w, [render_event(w, id=new_ulid())]).status == 401             # revoked device
    assert ingest_device_batch(ingest, {}, b"[]").status == 401


def test_per_event_rules(worker, owner, api, ingest):
    w = build_world(worker, owner, api)
    other = build_world(worker, owner, api)
    cases = [
        render_event(w, orgid=str(other.org)),                                  # another tenant
        render_event(w, source=f"/agent/{w.device2}"),                          # another device's source
        render_event(w, actor=f"person:pulse:{w.editor2}"),                     # not the assigned person
        render_event(w, type="drive.file.created"),                             # agents may not emit Drive events
        event(w.org, "agent.usage.hourly", f"device:pulse:{w.device}",          # window titles cannot be sent
              {"hour_start": w.at(0).isoformat(), "active_s": 10, "idle_s": 0, "categories": {"editing": 10},
               "window_title": "Bank statement.pdf"}, source=f"/agent/{w.device}", time=w.at(0)),
        render_event(w, time="2099-01-01T00:00:00Z"),                           # far future
    ]
    good = render_event(w, id=new_ulid())
    res = post(ingest, w, cases + [good])
    assert res.status == 207
    assert [s["status"] for s in res.body] == ["rejected"] * len(cases) + ["accepted"]
    assert "additional" in res.body[4]["error"].lower() or "window_title" in res.body[4]["error"]


def test_privacy_coverage_at_ingest(worker, owner, api, ingest):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.person set tracking_excluded = true where id = %s", (w.editor2,))
    res = post(ingest, w, [render_event(w, device=w.device2)], device=w.device2)
    assert res.body[0]["status"] == "rejected" and "excluded" in res.body[0]["error"]
    # command counts are opt-in (consent basis): rejected without a consent, accepted after one
    ev = event(w.org, "agent.commands.hourly", f"device:pulse:{w.device}",
               {"hour_start": w.at(0).replace(minute=0, second=0, microsecond=0).isoformat(), "app": "premiere_pro",
                "source": "keyboard", "counts": {"cut_trim": 12}},
               source=f"/agent/{w.device}", actor=f"device:pulse:{w.device}", time=w.at(0))
    res = post(ingest, w, [ev])
    assert res.body[0]["status"] == "rejected" and "consent" in res.body[0]["error"], res.body
    with api.transaction():
        set_tenant(api, w.org)
        api.execute("""insert into privacy.consent (org_id, person_id, purpose, granted_at, channel)
                       values (%s, %s, 'command_counts', now() - interval '10 days', 'desktop')""", (w.org, w.editor))
    res = post(ingest, w, [ev])
    assert res.body[0]["status"] == "accepted", res.body


def test_http_service(worker, owner, api, database):
    w = build_world(worker, owner, api)
    app = create_app(dsn("ingest"))
    with TestClient(app) as client:
        assert client.get("/healthz").json() == {"ok": True, "db": "ok"}
        ev = render_event(w)
        body = json.dumps([ev]).encode()
        r = client.post("/v1/events", content=body, headers=sign_headers(w.device_keys[w.device], str(w.device), body))
        assert r.status_code == 200 and r.json()[0]["status"] == "accepted"
        assert client.post("/v1/events", content=b"[]").status_code == 401
