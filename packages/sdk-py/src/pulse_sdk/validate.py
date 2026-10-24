"""Envelope and registry validation (02 §3.2-§3.4, appendix B and D).

The same rules are enforced again by the database trigger pulse.event_check(); checking here first gives the
emitter a precise, per-event reason and keeps bad events out of the transaction.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

from . import registry as reg
from .paths import schemas_dir

MAX_FUTURE = timedelta(hours=24)          # ingest rejects time more than 24 h ahead (02 §3.3)
MAX_AGE = timedelta(days=210)             # older rows would have no log partition (7 months are pre-created)


@lru_cache(maxsize=1)
def envelope_schema(path: str | None = None) -> dict:
    p = Path(path) if path else schemas_dir() / "envelope.schema.json"
    return json.loads(p.read_text(encoding="utf-8"))


def parse_time(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        when = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return when if when.tzinfo else None


def _has_nul(value: object, depth: int = 0) -> bool:
    if depth > 32:
        return False
    if isinstance(value, str):
        return "\x00" in value
    if isinstance(value, dict):
        return any(_has_nul(k, depth + 1) or _has_nul(v, depth + 1) for k, v in value.items())
    if isinstance(value, list):
        return any(_has_nul(v, depth + 1) for v in value)
    return False


class EventValidator:
    def __init__(self, registry: reg.Registry | None = None, schema: dict | None = None,
                 max_future: timedelta = MAX_FUTURE, max_age: timedelta | None = MAX_AGE):
        self.registry = registry or reg.default()
        self.schema = Draft202012Validator(schema or envelope_schema(), format_checker=FormatChecker())
        self._data = {t: Draft202012Validator(et.data_schema, format_checker=FormatChecker())
                      for t, et in self.registry.types.items()}
        self.max_future = max_future
        self.max_age = max_age

    def errors(self, event: object, *, now: datetime | None = None) -> list[str]:
        """Every reason this event would be rejected; empty when it is acceptable."""
        if not isinstance(event, dict):
            return ["event is not a JSON object"]
        out: list[str] = []
        if not event.get("purpose"):
            out.append("purpose: missing (every event needs at least one purpose)")
        for err in sorted(self.schema.iter_errors(event), key=lambda e: list(e.absolute_path)):
            where = ".".join(str(p) for p in err.absolute_path) or "(envelope)"
            out.append(f"{where}: {err.message}")
        when = parse_time(event.get("time"))
        if event.get("time") is not None and when is None:
            out.append("time: not an RFC 3339 timestamp with a time zone")
        try:
            uuid.UUID(str(event.get("orgid")))
        except ValueError:
            out.append("orgid: not a uuid")
        now = now or datetime.now(UTC)
        if when is not None:
            if when > now + self.max_future:
                out.append("time: more than 24 h in the future")
            if self.max_age is not None and when < now - self.max_age:
                out.append(f"time: older than {self.max_age.days} days (no log partition)")
        et = self.registry.get(str(event.get("type")))
        if et is None:
            out.append(f"type: {event.get('type')!r} is not in the event registry")
            return out
        purposes = [p for p in str(event.get("purpose") or "").split(",") if p]
        outside = [p for p in purposes if p not in et.purposes]
        if outside:
            out.append(f"purpose: {','.join(outside)} not allowed for {et.type} (allowed: {','.join(et.purposes)})")
        sens = event.get("sensitivity")
        if isinstance(sens, int) and sens < et.sensitivity:
            out.append(f"sensitivity: {sens} is below the floor {et.sensitivity} of {et.type}")
        vis = event.get("visibility")
        if vis in reg.VISIBILITY_RANK and reg.VISIBILITY_RANK[vis] > reg.VISIBILITY_RANK[et.visibility]:
            out.append(f"visibility: {vis} is looser than the floor {et.visibility} of {et.type}")
        source = str(event.get("source") or "")
        if not et.emitter_allowed(source):
            out.append(f"source: {source} may not emit {et.type} (allowed: {', '.join(et.emitters)})")
        subject = str(event.get("subject") or "")
        if not re.fullmatch(et.subject_re[1:-1], subject):
            out.append(f"subject: {subject!r} does not match {et.subject}")
        data = event.get("data")
        if isinstance(data, dict):
            missing = [f for f in et.data_required if f not in data]
            if missing:
                out.append(f"data: missing required field(s) {', '.join(missing)} for {et.type}")
            undeclared = sorted(set(data) - set(et.data_required) - set(et.data_optional))
            if undeclared:
                out.append(f"data: undeclared field(s) {', '.join(undeclared)} for {et.type} (registry)")
            for err in sorted(self._data[et.type].iter_errors(data), key=lambda e: list(e.absolute_path)):
                if err.validator in ("required", "additionalProperties"):
                    continue                     # reported above with the registry's wording
                where = ".".join(str(p) for p in err.absolute_path)
                out.append(f"data.{where}: {err.message}" if where else f"data: {err.message}")
        if len(str(event.get("subject") or "")) > 512:
            out.append("subject: longer than 512 characters")
        if _has_nul(event):
            out.append("event: contains a NUL character (not storable)")
        return list(dict.fromkeys(out))            # the envelope's own data schemas can repeat a finding

    def is_valid(self, event: object, *, now: datetime | None = None) -> bool:
        return not self.errors(event, now=now)
