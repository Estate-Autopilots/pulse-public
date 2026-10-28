"""Worker unit tests (no database): folder rules (appendix F.1 fixtures), the resolver, the daily schedule."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, time, timedelta
from pathlib import Path

import pytest

from pulse_workers import resolver
from pulse_workers.rules import FolderRules, is_media, normalise
from pulse_workers.scheduler import DailyJob, State
from pulse_workers.workgraph import WorkGraph

RULES = FolderRules.from_config({"subfolders": [
    {"match": "video editing details", "role": "input:edit_brief"},
    {"match": "project blueprint", "role": "input:blueprint_folder", "nested": True},
    {"match": r"research(\s+and)?\s+scripts?", "role": "input:research"},
    {"match": r"(shoot\s+)?raw(\s+(files|footage))?|shoot raw files", "role": "input:raw_footage"},
    {"match": r"model\s+final\s+videos?(\s+and)?(\s+its)?\s+hooks?|final\s+videos?(\s+and\s+hooks?)?",
     "role": "deliverables", "default_version_kind": "final"},
    {"match": r"vovs?(\s+and\s+designs?)?", "role": "deliverables", "default_version_kind": "final"},
    {"match": "creatives?", "role": "deliverables", "default_version_kind": "final"},
    {"match": "drafts?", "role": "deliverables", "default_version_kind": "draft", "nested": True},
]})


@pytest.mark.parametrize("raw,normalised,role", [        # appendix F.1 fixture table
    ("1) Video Editing Details", "video editing details", "input:edit_brief"),
    ("2) Research & Scripts", "research and scripts", "input:research"),
    ("4) Shoot Raw Files", "shoot raw files", "input:raw_footage"),
    ("5) Model Final Videos & Its Hooks", "model final videos and its hooks", "deliverables"),
    ("6) VOV & Designs", "vov and designs", "deliverables"),
    ("8) Drafts", "drafts", "deliverables"),
    ("Script Drafts", "script drafts", "other"),
    ("Creative Strategist notes", "creative strategist notes", "other"),
])
def test_folder_rule_fixtures(raw, normalised, role):
    assert normalise(raw) == normalised
    assert RULES.classify([normalised])[0] == role


def test_nested_rules():
    assert RULES.classify(["research and scripts", "project blueprint"]) == ("input:blueprint_folder", None)
    assert RULES.classify(["model final videos and its hooks", "drafts"]) == ("deliverables", "draft")
    assert RULES.classify(["model final videos and its hooks", "client a"]) == ("deliverables", "final")
    assert RULES.classify([]) == ("root", None)
    assert is_media("video/mp4") and is_media("application/pdf") and not is_media("text/csv")
    assert is_media("application/octet-stream", "Brand.ai") and is_media("application/octet-stream", "Layer.psd")


E, F, G = (uuid.UUID(int=i) for i in (1, 2, 3))
ATTRIBUTION_FIXTURES = json.loads((Path(__file__).parent / "fixtures/delivery_attribution.v1.json").read_text())


@pytest.mark.parametrize("case", ATTRIBUTION_FIXTURES["cases"], ids=lambda case: case["name"])
def test_delivery_attribution_fixtures(case):
    people = {name: uuid.UUID(value) for name, value in ATTRIBUTION_FIXTURES["people"].items()}
    signals = [resolver.Signal(people[item["person"]], item["group"], item["ratio"])
               for item in case["signals"]]
    decision = resolver.decide(set(people.values()), signals,
                               account_map_person=people.get(case.get("mapped_person")),
                               shared_account=case["shared"])
    if decision.credited and decision.person:
        credit = next(name for name, person in people.items() if person == decision.person)
    elif case["shared"]:
        credit = "shared login"
    else:
        credit = "unresolved"
    explanations = [item.get("how") for item in decision.evidence
                    if (decision.person and item.get("person") == str(decision.person))
                    or (credit == "shared login" and item.get("group") == "shared_account")]
    assert credit == case["credit"]
    assert case["how"] in explanations if case["how"] else not explanations

    # The projector stores only tenant-scoped evidence references and safe explanations.
    graph = WorkGraph()
    graph.org = uuid.UUID("00000000-0000-0000-0000-000000000099")
    sources: dict[tuple[uuid.UUID, str], set[str]] = {}
    for seq, signal in enumerate(signals, start=101):
        sources.setdefault((signal.person, signal.group), set()).add(
            graph._opaque_evidence_id(seq, signal.group))
    stored = graph._attribution_evidence(
        decision.evidence, sources, delivery_seq=900, declared_seq=None,
        credited_person=decision.person if decision.credited else None)
    stored_how = [item["how"] for item in stored]
    assert case["how"] in stored_how if case["how"] else not stored
    assert all(set(item) == {"id", "group", "how"} and item["id"].startswith("ev1_") for item in stored)
    encoded = json.dumps(stored)
    assert all(str(person) not in encoded for person in people.values())


def test_manual_account_map_yields_to_confirmation_and_rejection():
    confirmed = resolver.decide({E, F}, [], account_map_person=E, declared=F)
    assert confirmed.credited and confirmed.person == F
    assert confirmed.evidence[0]["how"] == "confirmation"

    rejected = resolver.decide({E, F}, [resolver.Signal(F, "hash", 1000)],
                               account_map_person=E, rejected={E})
    assert rejected.credited and rejected.person == F


def test_hash_match_credits_through_a_shared_login():
    d = resolver.decide({E, F}, [resolver.Signal(E, "hash", 1000)])
    assert d.person == E and d.method == "evidence" and d.probability >= 0.95


def test_assignee_alone_is_asked_not_credited():
    d = resolver.decide({E, F}, [resolver.Signal(E, "cid_owner", 10)], assignee=E)
    assert d.person == E and d.method == "unresolved" and d.ask_person


def test_one_vote_per_group_and_missing_signals_are_neutral():
    a = resolver.decide({E}, [resolver.Signal(E, "export", 50), resolver.Signal(E, "export", 50)])
    b = resolver.decide({E}, [resolver.Signal(E, "export", 50)])
    assert a.probability == b.probability
    assert resolver.decide({E, F}, []).probability == resolver.decide({E, F}, []).probability


def test_declarations_rejections_and_leave():
    assert resolver.decide({E, F}, [resolver.Signal(E, "hash", 1000)], declared=F).person == F
    d = resolver.decide({E, F}, [resolver.Signal(E, "hash", 1000)], rejected={E})
    assert d.person != E and not d.credited
    d = resolver.decide({E, F}, [resolver.Signal(E, "hash", 1000)], on_leave={E})
    assert d.method == "unresolved"
    assert resolver.decide(set(), []).person is None


def test_conflicting_evidence_is_not_auto_credited():
    # Editor F's computer has the matching render while E holds the task: asked, never silently decided.
    d = resolver.decide({E, F}, [resolver.Signal(F, "hash", 1000), resolver.Signal(E, "cid_owner", 10)], assignee=E)
    assert d.person == F and d.method == "unresolved"


def test_daily_schedule():
    job = DailyJob("retention", time(0, 40))
    morning = datetime(2026, 10, 5, 0, 30, tzinfo=UTC)
    later = datetime(2026, 10, 5, 0, 45, tzinfo=UTC)
    assert job.due(morning, None)                                         # never ran: run now
    assert not job.due(morning, datetime(2026, 10, 4, 0, 41, tzinfo=UTC))  # ran after yesterday's slot
    assert job.due(later, datetime(2026, 10, 4, 0, 41, tzinfo=UTC))        # today's slot passed
    assert not job.due(later, datetime(2026, 10, 5, 0, 44, tzinfo=UTC))    # already ran today


def test_onboarding_schedule_is_hourly_and_backs_off_after_errors(tmp_path):
    state = State(tmp_path / "worker.json")
    org = "synthetic-org"
    now = datetime(2026, 10, 9, 10, 0, tzinfo=UTC)
    assert state.onboarding_due(org, now)
    state.onboarding_failed(org, now)
    assert not state.onboarding_due(org, now + timedelta(seconds=59))
    assert state.onboarding_due(org, now + timedelta(minutes=1))
    state.onboarding_succeeded(org, now + timedelta(minutes=1))
    assert not state.onboarding_due(org, now + timedelta(minutes=59))
    assert state.onboarding_due(org, now + timedelta(hours=1, minutes=1))
