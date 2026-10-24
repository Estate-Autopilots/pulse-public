"""The event type registry (packages/schemas/registry.yaml, spec appendix D)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import yaml

from .paths import schemas_dir

VISIBILITY_RANK = {"person": 0, "team": 1, "org": 2}
CANONICAL_PURPOSES = (
    "delivery", "quality", "coaching", "voice", "workload", "outcomes", "activity_context", "after_hours",
    "work_delta", "command_counts", "wellbeing", "presence", "office", "security", "privacy", "billing",
)
_PLACEHOLDER = re.compile(r"<[^<>]+>")


def subject_regex(template: str) -> str:
    """Anchored regex for a subject template: literal parts escaped, each <placeholder> one or more characters."""
    out, pos = [], 0
    for m in _PLACEHOLDER.finditer(template):
        out.append(re.escape(template[pos:m.start()]))
        out.append(".+")
        pos = m.end()
    out.append(re.escape(template[pos:]))
    return "^" + "".join(out) + "$"


@dataclass(frozen=True)
class EventType:
    type: str
    purposes: tuple[str, ...]
    sensitivity: int
    visibility: str
    retention: str
    emitters: tuple[str, ...]
    subject: str
    subject_re: str
    data_required: tuple[str, ...]
    data_optional: tuple[str, ...]
    # JSON Schema of `data`: declared fields typed from the registry's `fields`, nothing else allowed.
    data_schema: dict = field(default_factory=dict, compare=False)

    @property
    def ephemeral(self) -> bool:
        """Stored in pulse.event_ephemeral (daily partitions dropped after the activity_raw period)."""
        return self.retention == "activity_raw"

    def emitter_allowed(self, source: str) -> bool:
        return any(source == e or source.startswith(e + "/") for e in self.emitters)


@dataclass(frozen=True)
class Registry:
    version: int
    types: dict[str, EventType]

    def get(self, event_type: str) -> EventType | None:
        return self.types.get(event_type)

    def __contains__(self, event_type: str) -> bool:
        return event_type in self.types


def _event_type(name: str, spec: dict, field_types: dict[str, dict]) -> EventType:
    fields = [str(f) for f in spec.get("data", [])]
    purposes = tuple(spec["purposes"])
    unknown = [p for p in purposes if p not in CANONICAL_PURPOSES]
    if unknown:
        raise ValueError(f"{name}: unknown purposes {unknown}")
    if spec["visibility"] not in VISIBILITY_RANK:
        raise ValueError(f"{name}: bad visibility {spec['visibility']}")
    required = tuple(f for f in fields if not f.endswith("?"))
    optional = tuple(f[:-1] for f in fields if f.endswith("?"))
    overrides = spec.get("field_types") or {}
    props = {}
    for f in required + optional:
        schema = overrides.get(f) or field_types.get(f)
        if schema is None:
            raise ValueError(f"{name}: data field {f!r} has no type in the registry's `fields`")
        props[f] = schema
    data_schema = {"type": "object", "additionalProperties": False, "required": list(required), "properties": props}
    return EventType(
        type=name,
        purposes=purposes,
        sensitivity=int(spec["sensitivity"]),
        visibility=spec["visibility"],
        retention=spec["retention"],
        emitters=tuple(spec["emitters"]),
        subject=spec["subject"],
        subject_re=subject_regex(spec["subject"]),
        data_required=required,
        data_optional=optional,
        data_schema=data_schema,
    )


def load(path: Path | str | None = None) -> Registry:
    path = Path(path) if path else schemas_dir() / "registry.yaml"
    doc = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    field_types = doc.get("fields") or {}
    types = {name: _event_type(name, spec, field_types) for name, spec in (doc.get("types") or {}).items()}
    return Registry(version=int(doc["version"]), types=types)


@lru_cache(maxsize=1)
def default() -> Registry:
    return load()
