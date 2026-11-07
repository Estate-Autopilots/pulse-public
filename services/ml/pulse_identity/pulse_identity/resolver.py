"""Identity attribution v0: verified account links and explicit event declarations only."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

DeclarationClaim = Literal["owns", "not_mine"]
AttributionMethod = Literal["individual_account", "declaration", "unresolved"]


@dataclass(frozen=True)
class DriveEvent:
    event_id: str
    occurred_at: datetime
    actor_account_id: str | None


@dataclass(frozen=True)
class AccountLink:
    evidence_id: str
    account_id: str
    person_id: str | None
    is_shared: bool
    verified: bool
    valid_from: datetime
    valid_to: datetime | None = None


@dataclass(frozen=True)
class PersonDeclaration:
    evidence_id: str
    event_id: str
    person_id: str
    claim: DeclarationClaim


@dataclass(frozen=True)
class Evidence:
    evidence_id: str
    kind: str
    person_id: str | None = None


@dataclass(frozen=True)
class AttributionResult:
    person_id: str | None
    method: AttributionMethod
    confidence: float | None
    reason: str | None
    evidence: tuple[Evidence, ...]


def _require_aware(value: datetime, field: str) -> None:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{field} must be timezone-aware")


def _link_is_active(link: AccountLink, at: datetime) -> bool:
    return link.valid_from <= at and (link.valid_to is None or at < link.valid_to)


def resolve(
    event: DriveEvent,
    account_links: Sequence[AccountLink],
    declarations: Sequence[PersonDeclaration],
) -> AttributionResult:
    """Resolve one event without fuzzy matching or delivery-fingerprint evidence.

    A unique verified individual link wins only when active account links and declarations agree. Contradictions
    remain unresolved. If there is no usable individual link, exactly one non-contradictory event declaration may
    resolve a shared, unverified, or missing actor.
    """
    _require_aware(event.occurred_at, "event.occurred_at")
    if not event.event_id:
        raise ValueError("event.event_id must be non-empty")

    matching_links = [link for link in account_links if event.actor_account_id is not None
                      and link.account_id == event.actor_account_id]
    for link in matching_links:
        _require_aware(link.valid_from, "account_link.valid_from")
        if link.valid_to is not None:
            _require_aware(link.valid_to, "account_link.valid_to")
            if link.valid_to <= link.valid_from:
                raise ValueError("account_link.valid_to must be later than valid_from")
    active_links = [link for link in matching_links if _link_is_active(link, event.occurred_at)]
    event_declarations = [item for item in declarations if item.event_id == event.event_id]

    for declaration in event_declarations:
        if declaration.claim not in ("owns", "not_mine"):
            raise ValueError(f"unsupported declaration claim: {declaration.claim}")

    evidence_items = [Evidence(event.event_id, "drive_event")]
    for link in matching_links:
        active = link in active_links
        kind = "shared_account_link" if link.is_shared else "individual_account_link"
        if not active:
            kind = "inactive_" + kind
        evidence_items.append(Evidence(link.evidence_id, kind, link.person_id))
    evidence_items.extend(
        Evidence(item.evidence_id, f"declaration_{item.claim}", item.person_id) for item in event_declarations
    )
    evidence = tuple(sorted(evidence_items, key=lambda item: (item.kind, item.evidence_id, item.person_id or "")))

    owners = {item.person_id for item in event_declarations if item.claim == "owns"}
    rejected = {item.person_id for item in event_declarations if item.claim == "not_mine"}
    if len(owners) > 1 or owners & rejected:
        return AttributionResult(None, "unresolved", None, "conflicting_declarations", evidence)

    verified_individual_links = [
        link for link in active_links
        if not link.is_shared and link.verified and link.person_id is not None
    ]
    direct_people = {link.person_id for link in verified_individual_links}
    if len(direct_people) > 1:
        return AttributionResult(None, "unresolved", None, "conflicting_individual_account_links", evidence)

    if any(link.is_shared for link in active_links) and verified_individual_links:
        return AttributionResult(None, "unresolved", None, "conflicting_account_links", evidence)

    active_individual_people = {
        link.person_id for link in active_links if not link.is_shared and link.person_id is not None
    }
    if active_individual_people & rejected or any(
        owner != linked_person for owner in owners for linked_person in active_individual_people
    ):
        return AttributionResult(None, "unresolved", None, "account_declaration_conflict", evidence)

    if direct_people:
        person_id = next(iter(direct_people))
        return AttributionResult(person_id, "individual_account", 1.0, None, evidence)

    if owners:
        return AttributionResult(next(iter(owners)), "declaration", 1.0, None, evidence)

    if event.actor_account_id is None:
        reason = "actor_missing"
    elif not matching_links:
        reason = "actor_unlinked"
    elif not active_links:
        reason = "no_active_account_link"
    elif any(link.is_shared for link in active_links):
        reason = "shared_account_requires_declaration"
    elif any(not link.verified or link.person_id is None for link in active_links):
        reason = "individual_account_unverified"
    else:
        reason = "no_usable_account_link"
    return AttributionResult(None, "unresolved", None, reason, evidence)
