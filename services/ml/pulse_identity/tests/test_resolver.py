from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import pytest

from pulse_identity import AccountLink, DriveEvent, PersonDeclaration, resolve

FIXTURE_PATH = Path(__file__).parents[1] / "fixtures" / "identity_attribution.v0.json"
FIXTURES = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _time(value: str) -> datetime:
    return datetime.fromisoformat(value)


def _optional_time(value: str | None) -> datetime | None:
    return _time(value) if value else None


def _resolve_case(case: dict):
    event_data = case["event"]
    event = DriveEvent(
        event_id=event_data["event_id"],
        occurred_at=_time(event_data["occurred_at"]),
        actor_account_id=event_data["actor_account_id"],
    )
    links = [
        AccountLink(
            evidence_id=item["evidence_id"],
            account_id=item["account_id"],
            person_id=item["person_id"],
            is_shared=item["is_shared"],
            verified=item["verified"],
            valid_from=_time(item["valid_from"]),
            valid_to=_optional_time(item["valid_to"]),
        )
        for item in case["account_links"]
    ]
    declarations = [PersonDeclaration(**item) for item in case["declarations"]]
    return resolve(event, links, declarations)


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=lambda case: case["name"])
def test_identity_attribution_fixtures(case: dict) -> None:
    result = _resolve_case(case)
    expected = case["expected"]

    assert result.person_id == expected["person_id"]
    assert result.method == expected["method"]
    assert result.confidence == expected["confidence"]
    assert result.reason == expected["reason"]
    assert sorted(item.evidence_id for item in result.evidence) == sorted(expected["evidence_ids"])

    if result.person_id is not None:
        assert result.confidence is not None
        assert result.evidence
        assert result.reason is None
    else:
        assert result.method == "unresolved"
        assert result.confidence is None
        assert result.reason
        assert result.evidence


def test_agreeing_declaration_is_evidence_but_individual_link_has_precedence() -> None:
    case = next(item for item in FIXTURES["cases"] if item["name"] == "verified individual account")
    case = json.loads(json.dumps(case))
    case["declarations"] = [
        {"evidence_id": "decl-agree", "event_id": "event-001", "person_id": "person-a", "claim": "owns"}
    ]

    result = _resolve_case(case)

    assert result.person_id == "person-a"
    assert result.method == "individual_account"
    assert {item.evidence_id for item in result.evidence} == {"event-001", "link-001", "decl-agree"}


def test_unrelated_declaration_does_not_cross_event_boundary() -> None:
    case = next(item for item in FIXTURES["cases"] if item["name"] == "unlinked actor")
    case = json.loads(json.dumps(case))
    case["declarations"] = [
        {"evidence_id": "decl-other-event", "event_id": "event-other", "person_id": "person-a", "claim": "owns"}
    ]

    result = _resolve_case(case)

    assert result.person_id is None
    assert result.reason == "actor_unlinked"
    assert {item.evidence_id for item in result.evidence} == {"event-005"}


def test_naive_timestamps_are_rejected() -> None:
    event = DriveEvent("event-naive", datetime.fromisoformat("2026-10-01T12:00:00"), "acct")

    with pytest.raises(ValueError, match="timezone-aware"):
        resolve(event, [], [])
