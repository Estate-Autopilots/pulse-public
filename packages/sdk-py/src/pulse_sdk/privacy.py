"""Notice and consent coverage (05 §5.2 consent check, 05 §9, 06).

Before an event is stored, the person it concerns must be covered for every purpose it carries:
- a person with ``tracking_excluded`` (e.g. under 18) produces no person-level events at all;
- purposes on the employment basis need an acknowledged notice that lists the purpose;
- purposes on the consent basis need a consent that was active at the event's time and is still active now.
Events that concern no identifiable person (shared logins, system events) are not person-level and pass; the
attribution resolver decides later and never credits an excluded person.
"""

from __future__ import annotations

import uuid
from datetime import datetime

import psycopg

from .identity import IdentityMap, device_from_source
from .ids import ref_uuid


class Coverage:
    """Per-transaction checker for one tenant (caches lookups for the batch)."""

    def __init__(self, conn: psycopg.Connection, identity: IdentityMap | None = None):
        self.conn = conn
        self.identity = identity or IdentityMap(conn)
        self._basis = {r["code"]: r["basis_in"] for r in _dicts(conn.execute(
            "select code, basis_in from privacy.purpose").fetchall(), ("code", "basis_in"))}
        self._person: dict[uuid.UUID, tuple[bool, str]] = {}

    def person_of(self, row: dict) -> uuid.UUID | None:
        """The person an event concerns: its actor, else its device, else a person subject."""
        when: datetime = row["time"]
        person = self.identity.person_for(row.get("actor"), when).person_id
        if person is None:
            device = device_from_source(row.get("source"))
            if device is not None:
                person = self.identity.device_person(device, when)
        if person is None:
            person = ref_uuid(row.get("subject"), "person")
        return person

    def reason_not_covered(self, row: dict) -> str | None:
        person = self.person_of(row)
        if person is None:
            return None
        excluded, status = self._person_flags(person)
        if excluded:
            return "person is excluded from tracking"
        if status == "unknown":
            return "person is not known in this tenant"
        for purpose in row["purpose"]:
            basis = self._basis.get(purpose)
            if basis == "employment" and not self._notice_acknowledged(person, purpose):
                return f"no acknowledged notice covers purpose {purpose}"
            if basis == "consent" and not self._consented(person, purpose, row["time"]):
                return f"no active consent for purpose {purpose}"
        return None

    def _person_flags(self, person: uuid.UUID) -> tuple[bool, str]:
        if person not in self._person:
            row = self.conn.execute("select tracking_excluded, status from pulse.person where id = %s",
                                    (person,)).fetchone()
            if row is None:
                self._person[person] = (False, "unknown")
            else:
                self._person[person] = (_get(row, "tracking_excluded", 0), _get(row, "status", 1))
        return self._person[person]

    def _notice_acknowledged(self, person: uuid.UUID, purpose: str) -> bool:
        return self.conn.execute(
            """select 1 from privacy.notice_ack a
                 join privacy.notice n on n.org_id = a.org_id and n.id = a.notice_id and n.language = a.language
                where a.person_id = %s and %s = any(n.purposes) limit 1""",
            (person, purpose),
        ).fetchone() is not None

    def _consented(self, person: uuid.UUID, purpose: str, at: datetime) -> bool:
        return self.conn.execute(
            """select 1 from privacy.consent
                where person_id = %s and purpose = %s and granted_at <= %s and withdrawn_at is null limit 1""",
            (person, purpose, at),
        ).fetchone() is not None


def _get(row, key, idx):
    return row[key] if isinstance(row, dict) else row[idx]


def _dicts(rows, keys):
    return [r if isinstance(r, dict) else dict(zip(keys, r, strict=True)) for r in rows]
