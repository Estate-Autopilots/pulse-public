"""Pure identity attribution rules."""

from .aggregation import (
    AttributionAggregation,
    AttributionSignal,
    CandidatePrior,
    CandidateScore,
    GroupContribution,
    aggregate_signals,
)
from .resolver import AccountLink, AttributionResult, DriveEvent, Evidence, PersonDeclaration, resolve

__all__ = [
    "AccountLink",
    "AttributionAggregation",
    "AttributionResult",
    "AttributionSignal",
    "CandidatePrior",
    "CandidateScore",
    "DriveEvent",
    "Evidence",
    "GroupContribution",
    "PersonDeclaration",
    "aggregate_signals",
    "resolve",
]
