"""Pure confidence-weighted aggregation for delivery attribution evidence (v1)."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from math import exp, isfinite, log
from typing import Literal

SignalKind = Literal["render_hash", "export", "work_delta", "chain_match"]
AttributionStatus = Literal[
    "automatic", "confirmation_required", "claim_required", "conflict", "missing_evidence"
]

_SIGNALS: dict[str, tuple[str, float]] = {
    "render_hash": ("hash", 1000.0),
    "export": ("export", 50.0),
    "work_delta": ("project_work", 10.0),
    "chain_match": ("project_work", 30.0),
}
_AUTO_THRESHOLD = 0.95
_CONFIRM_THRESHOLD = 0.60


@dataclass(frozen=True)
class CandidatePrior:
    candidate_id: str
    prior_odds: float = 1.0


@dataclass(frozen=True)
class AttributionSignal:
    candidate_id: str
    evidence_id: str
    kind: SignalKind


@dataclass(frozen=True)
class GroupContribution:
    group: str
    likelihood_ratio: float
    evidence_ids: tuple[str, ...]
    used_evidence_ids: tuple[str, ...]
    ignored_evidence_ids: tuple[str, ...]
    signal_kinds: tuple[str, ...]


@dataclass(frozen=True)
class CandidateScore:
    candidate_id: str
    prior_odds: float
    posterior_probability: float
    evidence_ids: tuple[str, ...]
    groups: tuple[GroupContribution, ...]


@dataclass(frozen=True)
class AttributionAggregation:
    status: AttributionStatus
    person_id: str | None
    proposed_person_id: str | None
    confidence: float | None
    reason: str
    evidence_ids: tuple[str, ...]
    candidates: tuple[CandidateScore, ...]


def aggregate_signals(
    candidates: Sequence[CandidatePrior], signals: Sequence[AttributionSignal]
) -> AttributionAggregation:
    """Aggregate normalized signals without reading collectors or writing persistence.

    Candidate probabilities use prior odds times one likelihood ratio per evidence group, with a
    unit-mass "nobody in the candidate set" alternative. Evidence supporting multiple candidates
    is never resolved by score magnitude; callers must send that case for human resolution.
    """
    priors: dict[str, float] = {}
    for candidate in candidates:
        if not candidate.candidate_id:
            raise ValueError("candidate_id must be non-empty")
        if candidate.candidate_id in priors:
            raise ValueError(f"duplicate candidate_id: {candidate.candidate_id}")
        if not isfinite(candidate.prior_odds) or candidate.prior_odds <= 0:
            raise ValueError("prior_odds must be finite and positive")
        priors[candidate.candidate_id] = candidate.prior_odds
    if not priors:
        raise ValueError("at least one candidate is required")

    # Evidence IDs are stable identities: exact replay duplicates count once, conflicting reuse is invalid.
    unique_signals: dict[str, AttributionSignal] = {}
    for signal in signals:
        if not signal.candidate_id or signal.candidate_id not in priors:
            raise ValueError(f"signal references unknown candidate: {signal.candidate_id}")
        if not signal.evidence_id:
            raise ValueError("evidence_id must be non-empty")
        if signal.kind not in _SIGNALS:
            raise ValueError(f"unsupported signal kind: {signal.kind}")
        previous = unique_signals.get(signal.evidence_id)
        if previous is not None and previous != signal:
            raise ValueError(f"evidence_id reused with different signal: {signal.evidence_id}")
        unique_signals[signal.evidence_id] = signal

    by_candidate_group: dict[str, dict[str, list[AttributionSignal]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for signal in unique_signals.values():
        group, _ = _SIGNALS[signal.kind]
        by_candidate_group[signal.candidate_id][group].append(signal)

    group_ratios: dict[str, dict[str, float]] = {}
    group_details: dict[str, tuple[GroupContribution, ...]] = {}
    evidence_by_candidate: dict[str, tuple[str, ...]] = {}
    log_odds: dict[str, float] = {}
    for candidate_id in sorted(priors):
        contributions: list[GroupContribution] = []
        for group in sorted(by_candidate_group[candidate_id]):
            items = by_candidate_group[candidate_id][group]
            max_lr = max(_SIGNALS[item.kind][1] for item in items)
            selected = [item for item in items if _SIGNALS[item.kind][1] == max_lr]
            selected_ids = {item.evidence_id for item in selected}
            contributions.append(
                GroupContribution(
                    group=group,
                    likelihood_ratio=max_lr,
                    evidence_ids=tuple(sorted(item.evidence_id for item in items)),
                    used_evidence_ids=tuple(sorted(selected_ids)),
                    ignored_evidence_ids=tuple(sorted(
                        item.evidence_id for item in items if item.evidence_id not in selected_ids
                    )),
                    signal_kinds=tuple(sorted({item.kind for item in items})),
                )
            )
        group_details[candidate_id] = tuple(contributions)
        group_ratios[candidate_id] = {item.group: item.likelihood_ratio for item in contributions}
        evidence_by_candidate[candidate_id] = tuple(
            sorted(item.evidence_id for group_items in by_candidate_group[candidate_id].values()
                   for item in group_items)
        )
        log_odds[candidate_id] = log(priors[candidate_id]) + sum(
            log(group_ratios[candidate_id][group]) for group in sorted(group_ratios[candidate_id])
        )

    # Stable normalization includes the "nobody" alternative at log-odds zero.
    max_log_odds = max(0.0, *log_odds.values())
    denominator = exp(-max_log_odds) + sum(
        exp(value - max_log_odds) for value in log_odds.values()
    )
    scores = tuple(
        CandidateScore(
            candidate_id=candidate_id,
            prior_odds=priors[candidate_id],
            posterior_probability=exp(log_odds[candidate_id] - max_log_odds) / denominator,
            evidence_ids=evidence_by_candidate[candidate_id],
            groups=group_details[candidate_id],
        )
        for candidate_id in sorted(priors)
    )
    all_evidence_ids = tuple(sorted(unique_signals))
    supported = [candidate_id for candidate_id in sorted(priors) if evidence_by_candidate[candidate_id]]

    if not all_evidence_ids:
        return AttributionAggregation(
            "missing_evidence", None, None, None,
            "No attribution signals were supplied; candidate priors are not evidence.",
            (), scores,
        )
    if len(supported) > 1:
        return AttributionAggregation(
            "conflict", None, None, None,
            "Signals support multiple candidates; no candidate is selected regardless of score.",
            all_evidence_ids, scores,
        )

    # A single supported candidate is the only possible recommendation; candidates without evidence
    # remain in the denominator as prior alternatives but cannot be recommended over it.
    proposed_id = supported[0]
    confidence = next(score.posterior_probability for score in scores if score.candidate_id == proposed_id)
    group_explanations = tuple(
        f"{item.group} contributes LR {item.likelihood_ratio:g} from evidence "
        f"{', '.join(item.used_evidence_ids)}."
        + (f" Correlated evidence {', '.join(item.ignored_evidence_ids)} is retained but not multiplied."
           if item.ignored_evidence_ids else "")
        for item in group_details[proposed_id]
    )
    if confidence >= _AUTO_THRESHOLD:
        return AttributionAggregation(
            "automatic", proposed_id, proposed_id, confidence,
            f"Posterior {confidence:.6f} meets the automatic threshold ({_AUTO_THRESHOLD:.2f}). "
            + " ".join(group_explanations),
            all_evidence_ids, scores,
        )
    if confidence >= _CONFIRM_THRESHOLD:
        return AttributionAggregation(
            "confirmation_required", None, proposed_id, confidence,
            f"Posterior {confidence:.6f} requires confirmation ({_CONFIRM_THRESHOLD:.2f} to "
            f"{_AUTO_THRESHOLD:.2f}). " + " ".join(group_explanations),
            all_evidence_ids, scores,
        )
    return AttributionAggregation(
        "claim_required", None, proposed_id, confidence,
        f"Posterior {confidence:.6f} is below the confirmation threshold ({_CONFIRM_THRESHOLD:.2f}); "
        "ask the person to claim it. " + " ".join(group_explanations),
        all_evidence_ids, scores,
    )
