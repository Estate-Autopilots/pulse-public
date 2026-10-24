"""The collector contract (05 §5.1).

A collector is a package with a manifest (manifest.yaml) and a class implementing ``Collector``. It only talks to
its provider and turns raw records into events; the runtime (pulse_sdk.runtime) does everything that must be
uniform: raw-first storage, cursors, deterministic ids, validation, consent filtering, retries, dead letters.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

import yaml

Cursor = dict[str, Any]


@dataclass(frozen=True)
class Manifest:
    name: str                               # e.g. gdrive_audit (underscores)
    version: str                            # semver; the major goes into the event source
    source_kind: str                        # pull | push | pull_and_push
    provider: str
    emits: tuple[str, ...]
    purposes: tuple[str, ...]
    sensitivity: int
    auth: str = "none"
    scopes: tuple[str, ...] = ()
    schedule: dict[str, str] = field(default_factory=dict)
    backfill: dict[str, Any] = field(default_factory=dict)
    consent: str = "notice"                 # notice | opt_in
    filters: dict[str, Any] = field(default_factory=dict)

    @property
    def major(self) -> str:
        return self.version.split(".")[0]

    def source(self, instance: str) -> str:
        return f"/collectors/{self.name}/{self.major}/{instance}"

    @classmethod
    def from_dict(cls, doc: dict[str, Any]) -> Manifest:
        if doc.get("source_kind") in ("push", "pull_and_push") and not doc.get("schedule", {}).get("reconcile"):
            raise ValueError(f"{doc.get('name')}: push collectors must declare a reconcile poll (05 §5.2)")
        return cls(
            name=doc["name"], version=str(doc["version"]), source_kind=doc["source_kind"], provider=doc["provider"],
            emits=tuple(doc["emits"]), purposes=tuple(doc["purposes"]), sensitivity=int(doc["sensitivity"]),
            auth=doc.get("auth", "none"), scopes=tuple(doc.get("scopes", ())), schedule=dict(doc.get("schedule", {})),
            backfill=dict(doc.get("backfill", {})), consent=doc.get("consent", "notice"),
            filters=dict(doc.get("filters", {})),
        )

    @classmethod
    def from_yaml(cls, path: Path | str) -> Manifest:
        return cls.from_dict(yaml.safe_load(Path(path).read_text(encoding="utf-8")))


@dataclass(frozen=True)
class TenantContext:
    org_id: uuid.UUID
    instance: str                            # e.g. ws-ea: one per connected workspace/account
    config: dict[str, Any] = field(default_factory=dict)
    secret: Callable[[str], str] | None = None   # fetched per run from the secrets broker; never logged


@dataclass(frozen=True)
class RawRecord:
    source_ref: str                          # provider id of the record (audit event id, change id, page token+n)
    payload: dict[str, Any]
    received_at: datetime | None = None


@dataclass(frozen=True)
class Scope:
    keys: tuple[str, ...]                    # impersonated users, folder ids, ad accounts …


@dataclass(frozen=True)
class AuthStatus:
    ok: bool
    detail: str = ""


@dataclass(frozen=True)
class Health:
    ok: bool
    last_success: datetime | None = None
    lag_seconds: float | None = None
    detail: str = ""


@dataclass(frozen=True)
class PushRequest:
    headers: dict[str, str]
    body: bytes


@dataclass(frozen=True)
class PushResult:
    accepted: bool
    records: tuple[RawRecord, ...] = ()
    detail: str = ""


@runtime_checkable
class Collector(Protocol):
    manifest: Manifest

    def authorize(self, ctx: TenantContext) -> AuthStatus:
        """Check or start auth. Never logs secrets."""

    def scope(self, ctx: TenantContext) -> Scope:
        """Accounts, folders, ad accounts in scope (the runtime intersects with consent and exclusions)."""

    def backfill(self, ctx: TenantContext, since: datetime,
                 cursor: Cursor | None) -> Iterator[tuple[list[RawRecord], Cursor]]:
        """Historical pages with the cursor after each page. Resumable and idempotent."""

    def poll(self, ctx: TenantContext, cursor: Cursor | None) -> tuple[list[RawRecord], Cursor]:
        """Incremental pull since the cursor; returns records and the new cursor. Overlap is fine (deduped)."""

    def handle_push(self, ctx: TenantContext, req: PushRequest) -> PushResult:
        """Verify the provider signature and return raw records. No business logic; answers fast."""

    def normalise(self, ctx: TenantContext, raw: RawRecord) -> list[dict[str, Any]]:
        """Pure function raw -> CloudEvents (registered types only). The runtime fills source, orgid,
        collectorver and a deterministic id when the collector leaves them out."""

    def health(self, ctx: TenantContext) -> Health:
        """Last success, lag, error rate, quota headroom, auth expiry."""
