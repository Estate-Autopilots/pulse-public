"""The identity map (02 §4): which person an actor reference stands for at a point in time.

- ``person:pulse:<uuid>`` is the person.
- ``account:<provider>:<handle>``: an identity_link (entity_type person, source account, key provider:handle)
  valid at that time, else the account's holder. Shared accounts never resolve to a person (rule 2): their events
  are attributed per event by the resolver.
- ``device:pulse:<uuid>``: the device assignment valid at that time (shared-station switcher), else the device's
  default person.
Runs inside a tenant transaction; row-level security limits every lookup to that tenant.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

import psycopg

from .ids import parse_ref


@dataclass(frozen=True)
class Resolved:
    person_id: uuid.UUID | None
    kind: str            # person | account | device | other
    shared: bool = False


class IdentityMap:
    def __init__(self, conn: psycopg.Connection):
        self.conn = conn

    def account_is_shared(self, provider: str, handle: str) -> bool:
        row = self.conn.execute(
            "select is_shared from pulse.account where provider = %s and handle = %s",
            (provider, handle.lower()),
        ).fetchone()
        return bool(row and _v(row, "is_shared"))

    def account_id(self, provider: str, handle: str) -> uuid.UUID | None:
        row = self.conn.execute(
            "select id from pulse.account where provider = %s and handle = %s",
            (provider, handle.lower()),
        ).fetchone()
        return _v(row, "id") if row else None

    def account_person(self, provider: str, handle: str, at: datetime) -> uuid.UUID | None:
        """Return only a verified, non-shared account mapping."""
        handle = handle.lower()
        row = self.conn.execute(
            """select l.entity_id from pulse.identity_link l
                join pulse.account a on a.org_id = l.org_id
                  and a.provider = %s and a.handle = %s
                where l.entity_type = 'person' and l.source = 'account' and l.source_key = %s
                  and l.entity_id = a.holder_person_id
                  and l.valid_from <= %s and (l.valid_to is null or l.valid_to > %s)
                  and (l.confirmed_by is not null or (l.method = 'manual' and l.confidence = 1.0))
                  and not a.is_shared
                order by l.valid_from desc limit 1""",
            (provider, handle, f"{provider}:{handle}", at, at),
        ).fetchone()
        return _v(row, "entity_id") if row else None

    def person_for(self, ref: str | None, at: datetime) -> Resolved:
        parsed = parse_ref(ref)
        if not parsed:
            return Resolved(None, "other")
        kind, namespace, key = parsed
        if kind == "person" and namespace == "pulse":
            return Resolved(_uuid(key), "person")
        if kind == "account":
            return self._account(namespace, key, at)
        if kind == "device" and namespace == "pulse":
            return Resolved(self.device_person(_uuid(key), at), "device")
        return Resolved(None, kind)

    def _account(self, provider: str, handle: str, at: datetime) -> Resolved:
        handle = handle.lower()
        acct = self.conn.execute(
            "select holder_person_id, is_shared from pulse.account where provider = %s and handle = %s",
            (provider, handle),
        ).fetchone()
        if acct and _v(acct, "is_shared"):
            return Resolved(None, "account", shared=True)
        link = self.conn.execute(
            """select entity_id from pulse.identity_link
                where entity_type = 'person' and source = 'account' and source_key = %s
                  and valid_from <= %s and (valid_to is null or valid_to > %s)
                order by valid_from desc limit 1""",
            (f"{provider}:{handle}", at, at),
        ).fetchone()
        if link:
            return Resolved(_v(link, "entity_id"), "account")
        return Resolved(_v(acct, "holder_person_id") if acct else None, "account")

    def device_person(self, device_id: uuid.UUID | None, at: datetime) -> uuid.UUID | None:
        if device_id is None:
            return None
        row = self.conn.execute(
            """select person_id from pulse.device_assignment
                where device_id = %s and valid_from <= %s and (valid_to is null or valid_to > %s)
                order by valid_from desc limit 1""",
            (device_id, at, at),
        ).fetchone()
        if row:
            return _v(row, "person_id")
        row = self.conn.execute("select default_person_id from pulse.device where id = %s", (device_id,)).fetchone()
        return _v(row, "default_person_id") if row else None


def device_from_source(source: str | None) -> uuid.UUID | None:
    """The device id in an agent source ``/agent/<device-id>``."""
    if not source or not source.startswith("/agent/"):
        return None
    return _uuid(source.split("/")[2])


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


def _v(row, key):
    return row[key] if isinstance(row, dict) else row[0]
