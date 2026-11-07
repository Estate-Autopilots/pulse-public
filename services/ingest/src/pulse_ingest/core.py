"""POST /v1/events for devices (05 §8.3): routing, replay window, signature, per-event checks, status array.

1. resolve_route('device', id) -> tenant (sets pulse.org_id for the transaction), else 401;
2. timestamp within +-5 minutes, else 401; 3. Ed25519 signature over the canonical message, else 401;
4. nonce unseen in the last 10 minutes (pulse.ingest_nonce), else 401;
5. per event: envelope + registry (pulse_sdk.validate), orgid = the device's tenant, source = /agent/<device>,
   actor (if any) = the device or its currently assigned person, the person covered by notice/consent and not
   excluded from tracking; then an idempotent insert (a resend of the same id and time is "duplicate").
Response: [{id, status: accepted|duplicate|rejected, error?}], HTTP 200 when nothing was rejected, 207 otherwise.
The service never calls other services inline; it answers from one database transaction.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import psycopg

from pulse_sdk import registry as reg
from pulse_sdk.envelope import to_row
from pulse_sdk.identity import IdentityMap
from pulse_sdk.privacy import Coverage
from pulse_sdk.signing import message, verify
from pulse_sdk.store import insert_event, notify
from pulse_sdk.validate import EventValidator

MAX_BATCH = 500
MAX_BODY = 1 << 20                     # 1 MiB: bigger bodies are refused before anything else (413)
CLOCK_SKEW_S = 300
NONCE_TTL_S = 2 * CLOCK_SKEW_S + 60    # a nonce outlives every timestamp the window can still accept


@dataclass
class Result:
    status: int
    body: Any


def _deny(reason: str) -> Result:
    return Result(401, {"error": "unauthorized", "detail": reason})


def ingest_device_batch(conn: psycopg.Connection, headers: Mapping[str, str], body: bytes, *,
                        validator: EventValidator | None = None, registry: reg.Registry | None = None,
                        now: datetime | None = None) -> Result:
    """Handle one signed batch on ``conn`` (autocommit connection; one transaction is opened here)."""
    h = {k.lower(): v for k, v in headers.items()}
    device, ts, nonce, sig = (h.get("x-pulse-device"), h.get("x-pulse-timestamp"), h.get("x-pulse-nonce"),
                              h.get("x-pulse-signature"))
    if not (device and ts and nonce and sig):
        return _deny("missing X-Pulse-Device, X-Pulse-Timestamp, X-Pulse-Nonce or X-Pulse-Signature")
    try:
        device_id = uuid.UUID(device)
        ts_int = int(ts)
    except ValueError:
        return _deny("malformed device id or timestamp")
    now = now or datetime.now(UTC)
    if abs(now.timestamp() - ts_int) > CLOCK_SKEW_S:
        return _deny("timestamp outside the 5-minute window")
    if len(body) > MAX_BODY:
        return Result(413, {"error": f"body larger than {MAX_BODY} bytes"})
    registry = registry or reg.default()
    validator = validator or EventValidator(registry)

    # Nothing in the body is parsed before the signature over the raw bytes has been verified.
    with conn.transaction():
        org = conn.execute("select pulse.resolve_route('device', %s) as org", (str(device_id),)).fetchone()["org"]
        if org is None:
            return _deny("unknown or revoked device")
        dev = conn.execute("select public_key, revoked_at from pulse.device where id = %s", (device_id,)).fetchone()
        if dev is None or dev["revoked_at"] is not None:
            return _deny("unknown or revoked device")
        if not verify(dev["public_key"], sig, message(str(device_id), ts, nonce, body)):
            return _deny("bad signature")
        conn.execute("delete from pulse.ingest_nonce where seen_at < now() - make_interval(secs => %s)",
                     (NONCE_TTL_S,))
        fresh = conn.execute("insert into pulse.ingest_nonce (device_id, nonce) values (%s, %s) "
                             "on conflict do nothing returning 1", (device_id, nonce)).fetchone()
        if fresh is None:
            return _deny("replayed nonce")
        try:
            events = json.loads(body)
        except (ValueError, UnicodeDecodeError, RecursionError):
            return Result(400, {"error": "body is not valid JSON"})
        if not isinstance(events, list):
            return Result(400, {"error": "body must be a JSON array of CloudEvents (structured mode)"})
        if len(events) > MAX_BATCH:
            return Result(413, {"error": f"at most {MAX_BATCH} events per batch"})

        assigned = IdentityMap(conn).device_person(device_id, now)
        allowed_actors = {f"device:pulse:{device_id}"} | ({f"person:pulse:{assigned}"} if assigned else set())
        coverage = Coverage(conn)
        statuses: list[dict[str, Any]] = []
        accepted = 0
        for event in events:
            eid = event.get("id") if isinstance(event, dict) else None
            errors = validator.errors(event, now=now)
            if isinstance(event, dict):
                if str(event.get("orgid")) != str(org):
                    errors.append("orgid: does not match the device's tenant")
                if event.get("source") != f"/agent/{device_id}":
                    errors.append(f"source: must be /agent/{device_id}")
                if event.get("actor") is not None and event.get("actor") not in allowed_actors:
                    errors.append("actor: must be this device or the person currently assigned to it")
                subject = event.get("subject")
                if isinstance(subject, str) and subject.startswith("device:") and \
                        subject != f"device:pulse:{device_id}":
                    errors.append("subject: a device subject must be the authenticated device")
            if errors:
                statuses.append({"id": eid, "status": "rejected", "error": "; ".join(errors)})
                continue
            row = to_row(event)
            reason = coverage.reason_not_covered(row)
            if reason:
                statuses.append({"id": eid, "status": "rejected", "error": f"privacy: {reason}"})
                continue
            stored = insert_event(conn, row, registry)
            entry = {"id": eid, "status": stored.status}
            if stored.error:
                entry["error"] = stored.error
            statuses.append(entry)
            accepted += stored.status == "accepted"
        if accepted:
            notify(conn, org)
    rejected = any(s["status"] == "rejected" for s in statuses)
    return Result(207 if rejected else 200, statuses)
