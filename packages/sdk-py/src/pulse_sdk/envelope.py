"""CloudEvents envelope <-> pulse.event row (02 §3.2-§3.3)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from .ids import ref_uuid
from .validate import parse_time

# Envelope attribute -> log column (attributes not listed map to a column of the same name).
_COLUMNS = {
    "orgid": "org_id",
    "actorkind": "actor_kind",
    "consentref": "consent_ref",
    "causationid": "causation_id",
    "correlationid": "correlation_id",
    "dataschema": "data_schema",
    "collectorver": "collector_ver",
}

ROW_COLUMNS = (
    "org_id", "id", "source", "type", "time", "subject", "actor", "actor_kind", "project_id", "confidence", "purpose",
    "consent_ref", "sensitivity", "visibility", "causation_id", "correlation_id", "supersedes", "data", "data_schema",
    "collector_ver",
)


def to_row(event: dict[str, Any]) -> dict[str, Any]:
    """Map a validated CloudEvent to the columns of pulse.event / pulse.event_ephemeral."""
    row: dict[str, Any] = {c: None for c in ROW_COLUMNS}
    for key, value in event.items():
        col = _COLUMNS.get(key, key)
        if col in row:
            row[col] = value
    row["org_id"] = uuid.UUID(str(event["orgid"]))
    row["time"] = parse_time(event["time"])
    row["purpose"] = [p for p in str(event["purpose"]).split(",") if p]
    row["project_id"] = ref_uuid(event.get("project"), "project")
    row["confidence"] = float(event.get("confidence", 1.0))
    row["data"] = event.get("data") or {}
    return row


def make_event(*, org_id: uuid.UUID | str, id: str, source: str, type: str, time: datetime, subject: str,
               purpose: str | list[str], sensitivity: int, visibility: str, data: dict | None = None,
               **extensions: Any) -> dict[str, Any]:
    """Build a structured-mode CloudEvent (helper for collectors, the API and tests)."""
    if isinstance(purpose, (list, tuple)):
        purpose = ",".join(purpose)
    event: dict[str, Any] = {
        "specversion": "1.0",
        "id": id,
        "source": source,
        "type": type,
        "time": time.isoformat().replace("+00:00", "Z"),
        "subject": subject,
        "orgid": str(org_id),
        "purpose": purpose,
        "sensitivity": sensitivity,
        "visibility": visibility,
        "data": data or {},
    }
    event.update({k: v for k, v in extensions.items() if v is not None})
    return event
