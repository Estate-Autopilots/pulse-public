"""POST /v1/connectors/batches (R52, contract connector.v1): a company plugin's signed batch.

1. Off unless PULSE_CONNECTORS=1 (404, as if absent).
2. resolve_route('connector', install) -> the company, which sets pulse.org_id for the transaction; unknown or revoked
   installs are 401. The company is the one whose admin installed the plugin: nothing in the body can name it (the
   batch schema has no such field and refuses unknown ones).
3. Timestamp within +-5 minutes, Ed25519 signature over the raw bytes with the install's public key (the device-batch
   message format with the install id), nonce unseen: else 401. Nothing in the body is parsed before this.
4. The batch against batch.v1.json (400); an install still in preview is 403.
5. The root: selected by this company's admin for this install and approved (404/403 otherwise), locked for the batch.
6. A batch id already accepted for the root is a replay: its stored result, nothing written.
7. A manifest version newer than the one granted waits for the admin's grant (409). cursor.from must be the root's
   checkpoint (409 with the checkpoint, so the plugin resumes from it).
8. Per record: an entity granted to the install and selected for the root, its data schema at a version Pulse supports
   and the manifest names, an event the registry accepts, the person (if any) covered; its key once per root, ever.
9. The records, the batch row, the root's checkpoint and counts commit together.
Response: {batch, status: accepted|replayed, accepted, duplicates, refused, records: [{key, status, error?}]}.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from pulse_sdk import connector
from pulse_sdk import registry as reg
from pulse_sdk.envelope import to_row
from pulse_sdk.privacy import Coverage
from pulse_sdk.signing import message, verify
from pulse_sdk.store import insert_event, notify
from pulse_sdk.validate import EventValidator

from .core import CLOCK_SKEW_S, MAX_BODY, NONCE_TTL_S, Result, _deny


def _version(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in v.split("."))


def ingest_connector_batch(conn: psycopg.Connection, headers: Mapping[str, str], body: bytes, *,
                           validator: EventValidator | None = None, registry: reg.Registry | None = None,
                           now: datetime | None = None) -> Result:
    """Handle one signed plugin batch on ``conn`` (autocommit connection; one transaction is opened here)."""
    if not connector.on():
        return Result(404, {"error": "not_found"})
    h = {k.lower(): v for k, v in headers.items()}
    install, ts, nonce, sig = (h.get("x-pulse-connector"), h.get("x-pulse-timestamp"), h.get("x-pulse-nonce"),
                               h.get("x-pulse-signature"))
    if not (install and ts and nonce and sig):
        return _deny("missing X-Pulse-Connector, X-Pulse-Timestamp, X-Pulse-Nonce or X-Pulse-Signature")
    try:
        install_id = uuid.UUID(install)
        ts_int = int(ts)
    except ValueError:
        return _deny("malformed connector id or timestamp")
    now = now or datetime.now(UTC)
    if abs(now.timestamp() - ts_int) > CLOCK_SKEW_S:
        return _deny("timestamp outside the 5-minute window")
    if len(body) > MAX_BODY:
        return Result(413, {"error": f"body larger than {MAX_BODY} bytes"})
    registry = registry or reg.default()
    validator = validator or EventValidator(registry)

    with conn.transaction():
        org = conn.execute("select pulse.resolve_route('connector', %s) as org", (str(install_id),)).fetchone()["org"]
        if org is None:
            return _deny("unknown or revoked connector")
        ins = conn.execute("""select status, public_key, manifest, granted_entities from pulse.connector_install
                               where id = %s""", (install_id,)).fetchone()
        if ins is None or ins["status"] == "revoked":
            return _deny("unknown or revoked connector")
        if not verify(ins["public_key"], sig, message(str(install_id), ts, nonce, body)):
            return _deny("bad signature")
        # Connector installs share the device nonce table: both are random UUIDs, so their keys never meet.
        conn.execute("delete from pulse.ingest_nonce where seen_at < now() - make_interval(secs => %s)", (NONCE_TTL_S,))
        if conn.execute("insert into pulse.ingest_nonce (device_id, nonce) values (%s, %s) on conflict do nothing "
                        "returning 1", (install_id, nonce)).fetchone() is None:
            return _deny("replayed nonce")
        try:
            batch = json.loads(body)
        except (ValueError, UnicodeDecodeError, RecursionError):
            return Result(400, {"error": "body is not valid JSON"})
        if isinstance(batch, dict) and batch.get("contract") != connector.CONTRACT:
            return Result(400, {"error": "contract_unsupported", "detail": f"this Pulse speaks {connector.CONTRACT}"})
        problems = connector.batch_problems(batch)
        if problems:
            return Result(400, {"error": "invalid_batch", "detail": problems[:20]})
        if ins["status"] != "active":
            return Result(403, {"error": "not_approved",
                                "detail": "the company's admin has not approved this connector"})
        src = conn.execute("""select id, status, entities, checkpoint from pulse.connector_source
                               where install_id = %s and external_ref = %s for update""",
                           (install_id, batch["source"])).fetchone()
        if src is None:
            return Result(404, {"error": "source_unknown", "detail": "no root of this connector has that reference"})
        if src["status"] != "approved":
            return Result(403, {"error": "source_not_approved",
                                "detail": "the company's admin has not approved this root"})
        seen = conn.execute("""select accepted, duplicates, refused from pulse.connector_batch
                                where source_id = %s and batch_id = %s""", (src["id"], batch["batch"])).fetchone()
        if seen is not None:
            return Result(200, {"batch": batch["batch"], "status": "replayed", **seen, "records": []})
        granted = ins["manifest"]
        if _version(batch["manifestVersion"]) > _version(granted["version"]):
            return Result(409, {"error": "manifest_not_granted",
                                "detail": f"version {batch['manifestVersion']} waits for the company admin's grant; "
                                          f"{granted['version']} is granted"})
        if batch["cursor"]["from"] != src["checkpoint"]:
            return Result(409, {"error": "cursor_conflict", "checkpoint": src["checkpoint"]})

        rights = set(ins["granted_entities"]) & set(src["entities"])
        schemas = {e["type"]: e["schema"] for e in granted["entities"]}
        coverage = Coverage(conn)
        statuses: list[dict[str, Any]] = []
        accepted = duplicates = refused = 0
        for record in batch["records"]:
            key = record["key"]
            if record["type"] not in rights:
                statuses.append({"key": key, "status": "refused", "error": "entity_not_granted"})
                refused += 1
                continue
            if record["schema"] not in connector.SUPPORTED_SCHEMAS or record["schema"] != schemas.get(record["type"]):
                statuses.append({"key": key, "status": "refused", "error": "schema_unsupported"})
                refused += 1
                continue
            event = connector.record_event(registry, org_id=org, install_id=install_id, source_id=src["id"],
                                           manifest_version=granted["version"], record=record)
            errors = validator.errors(event, now=now)
            reason = None if errors else coverage.reason_not_covered(to_row(event))
            if errors or reason:
                why = f"privacy: {reason}" if reason else "invalid_record: " + "; ".join(errors)[:300]
                statuses.append({"key": key, "status": "refused", "error": why})
                refused += 1
                continue
            if conn.execute("select 1 from pulse.connector_record where source_id = %s and record_key = %s",
                            (src["id"], key)).fetchone() is not None:
                statuses.append({"key": key, "status": "duplicate"})
                duplicates += 1
                continue
            stored = insert_event(conn, to_row(event), registry)
            if stored.status == "rejected":
                statuses.append({"key": key, "status": "refused", "error": stored.error or "rejected"})
                refused += 1
                continue
            conn.execute(
                """insert into pulse.connector_record (org_id, source_id, record_key, entity, item, record_time,
                                                       event_id, batch_id, provenance)
                   values (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (org, src["id"], key, record["type"], record["item"], connector.parse_time(record["time"]), event["id"],
                 batch["batch"], Jsonb(record["provenance"])))
            statuses.append({"key": key, "status": stored.status})
            accepted += stored.status == "accepted"
            duplicates += stored.status == "duplicate"
        conn.execute(
            """insert into pulse.connector_batch (org_id, source_id, batch_id, manifest_version, cursor_from_hash,
                                                  cursor_to_hash, records, accepted, duplicates, refused)
               values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (org, src["id"], batch["batch"], batch["manifestVersion"], connector.cursor_hash(batch["cursor"]["from"]),
             connector.cursor_hash(batch["cursor"]["to"]), len(batch["records"]), accepted, duplicates, refused))
        conn.execute(
            """update pulse.connector_source set checkpoint = %s, checkpoint_at = %s, last_batch_at = %s,
                      records = records + %s, duplicates = duplicates + %s, refused = refused + %s where id = %s""",
            (batch["cursor"]["to"], now, now, accepted, duplicates, refused, src["id"]))
        conn.execute("update pulse.connector_install set last_batch_at = %s where id = %s", (now, install_id))
        if accepted:
            notify(conn, org)
    return Result(207 if refused else 200, {"batch": batch["batch"], "status": "accepted", "accepted": accepted,
                                            "duplicates": duplicates, "refused": refused, "records": statuses})
