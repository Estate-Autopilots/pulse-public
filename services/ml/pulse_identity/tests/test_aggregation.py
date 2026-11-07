from __future__ import annotations

from typing import Literal

import pytest

from pulse_identity import AttributionSignal, CandidatePrior, aggregate_signals


@pytest.mark.parametrize(
    ("kind", "likelihood_ratio"),
    [("render_hash", 1000.0), ("export", 50.0), ("work_delta", 10.0), ("chain_match", 30.0)],
)
def test_each_signal_uses_its_starting_likelihood_ratio(
    kind: Literal["render_hash", "export", "work_delta", "chain_match"], likelihood_ratio: float
) -> None:
    result = aggregate_signals(
        [CandidatePrior("person-a")], [AttributionSignal("person-a", f"e-{kind}", kind)]
    )

    assert result.proposed_person_id == "person-a"
    assert result.status == ("confirmation_required" if kind == "work_delta" else "automatic")
    assert result.person_id == ("person-a" if result.status == "automatic" else None)
    assert result.confidence == pytest.approx(likelihood_ratio / (1 + likelihood_ratio))
    assert result.evidence_ids == (f"e-{kind}",)
    assert kind in result.reason


def test_correlated_project_work_signals_contribute_only_the_largest_ratio() -> None:
    result = aggregate_signals(
        [CandidatePrior("person-a")],
        [
            AttributionSignal("person-a", "delta-1", "work_delta"),
            AttributionSignal("person-a", "chain-1", "chain_match"),
            AttributionSignal("person-a", "hash-1", "render_hash"),
            AttributionSignal("person-a", "export-1", "export"),
        ],
    )

    score = result.candidates[0]
    assert result.status == "automatic"
    assert result.confidence == pytest.approx(1_500_000 / 1_500_001)
    assert [(group.group, group.likelihood_ratio) for group in score.groups] == [
        ("export", 50.0), ("hash", 1000.0), ("project_work", 30.0)
    ]
    assert score.groups[-1].evidence_ids == ("chain-1", "delta-1")
    assert score.groups[-1].used_evidence_ids == ("chain-1",)
    assert score.groups[-1].ignored_evidence_ids == ("delta-1",)
    assert "delta-1 is retained but not multiplied" in result.reason
    assert result.evidence_ids == ("chain-1", "delta-1", "export-1", "hash-1")


def test_conflicting_candidate_evidence_stays_unresolved_even_when_scores_differ() -> None:
    result = aggregate_signals(
        [CandidatePrior("person-a"), CandidatePrior("person-b")],
        [
            AttributionSignal("person-a", "hash-a", "render_hash"),
            AttributionSignal("person-b", "export-b", "export"),
        ],
    )

    assert result.status == "conflict"
    assert result.person_id is None
    assert result.proposed_person_id is None
    assert result.confidence is None
    assert result.evidence_ids == ("export-b", "hash-a")
    assert "multiple candidates" in result.reason
    assert {score.candidate_id for score in result.candidates} == {"person-a", "person-b"}


def test_missing_evidence_does_not_turn_candidate_prior_into_attribution() -> None:
    result = aggregate_signals([CandidatePrior("person-a"), CandidatePrior("person-b", 0.1)], [])

    assert result.status == "missing_evidence"
    assert result.person_id is None
    assert result.proposed_person_id is None
    assert result.confidence is None
    assert result.evidence_ids == ()
    assert "priors are not evidence" in result.reason


def test_low_posterior_requests_a_claim() -> None:
    result = aggregate_signals(
        [CandidatePrior("person-a", 0.01)], [AttributionSignal("person-a", "delta-1", "work_delta")]
    )

    assert result.status == "claim_required"
    assert result.person_id is None
    assert result.proposed_person_id == "person-a"
    assert result.confidence == pytest.approx(0.1 / 1.1)


def test_grouping_scoring_and_explanation_are_independent_of_input_order_and_replay() -> None:
    candidates = [CandidatePrior("person-b", 0.1), CandidatePrior("person-a")]
    signals = [
        AttributionSignal("person-a", "delta-1", "work_delta"),
        AttributionSignal("person-a", "chain-1", "chain_match"),
        AttributionSignal("person-a", "hash-1", "render_hash"),
    ]

    first = aggregate_signals(candidates, signals)
    replayed = aggregate_signals(list(reversed(candidates)), list(reversed(signals)) + [signals[0]])

    assert replayed == first


def test_signal_cannot_reference_candidate_outside_the_candidate_set() -> None:
    with pytest.raises(ValueError, match="unknown candidate"):
        aggregate_signals(
            [CandidatePrior("person-a")], [AttributionSignal("person-b", "e-1", "render_hash")]
        )
