"""Aggregate-only checks for the staging Editors weekly API."""
from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from typing import Any


EDITOR_WEEK_TYPES = (
    "model_video",
    "vov",
    "founder_video",
    "testimonial",
    "walkthrough",
    "other",
)
_PERSON_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def aggregate_editor_week(
    accounts: Iterable[dict[str, Any]],
    week: str,
    load_week: Callable[[str], dict[str, Any]],
) -> dict[str, Any]:
    """Compare each verified, non-shared account total to weekly type counts.

    The returned receipt contains totals only. Account handles and holder IDs are
    consumed in memory to request the per-person weekly API, then discarded.
    """
    rows = [
        row for row in accounts
        if row.get("identityVerified") is True
        and row.get("sharedLogin") is False
        and row.get("holder_person_id")
    ]
    if not rows:
        raise ValueError("no identified non-shared editor rows")

    totals = {
        kind: {"target": 0, "target_rows": 0, "drafts": 0, "finals": 0, "gap": 0, "gap_rows": 0}
        for kind in EDITOR_WEEK_TYPES
    }
    matched = 0
    accounts_delivered = 0
    for row in rows:
        person_id = row.get("holder_person_id")
        if not isinstance(person_id, str) or not _PERSON_ID.fullmatch(person_id):
            raise ValueError("identified editor row has an invalid holder ID")
        weekly = load_week(person_id)
        if not isinstance(weekly, dict) or weekly.get("week") != week:
            raise ValueError("editor weekly API returned the wrong week")
        types = weekly.get("types")
        if not isinstance(types, dict) or any(kind not in types for kind in EDITOR_WEEK_TYPES):
            raise ValueError("editor weekly API is missing creative types")

        row_count = row.get("thisWeek")
        if not _count(row_count):
            raise ValueError("editor account list is missing a weekly count")
        weekly_count = 0
        for kind in EDITOR_WEEK_TYPES:
            values = types[kind]
            delivered = values.get("delivered") if isinstance(values, dict) else None
            drafts = delivered.get("drafts") if isinstance(delivered, dict) else None
            finals = delivered.get("finals") if isinstance(delivered, dict) else None
            target = values.get("target") if isinstance(values, dict) else None
            gap = values.get("gap") if isinstance(values, dict) else None
            if not _count(drafts) or not _count(finals):
                raise ValueError("editor weekly API has invalid delivery counts")
            if target is not None and not _count(target):
                raise ValueError("editor weekly API has an invalid target")
            if gap is not None and not _count(gap):
                raise ValueError("editor weekly API has an invalid gap")
            weekly_count += drafts + finals
            bucket = totals[kind]
            bucket["drafts"] += drafts
            bucket["finals"] += finals
            if target is not None:
                bucket["target"] += target
                bucket["target_rows"] += 1
            if gap is not None:
                bucket["gap"] += gap
                bucket["gap_rows"] += 1

        if row_count != weekly_count:
            raise ValueError("editor account total does not match creative-type delivery totals")
        matched += 1
        accounts_delivered += row_count

    by_type = {
        kind: {
            "target_total": values["target"] if values["target_rows"] == matched else None,
            "targets_configured": values["target_rows"],
            "drafts": values["drafts"],
            "finals": values["finals"],
            "gap_total": values["gap"] if values["gap_rows"] == matched else None,
            "gaps_available": values["gap_rows"],
        }
        for kind, values in totals.items()
    }
    return {
        "week": week,
        "rows_compared": len(rows),
        "rows_matched": matched,
        "delivered_total": accounts_delivered,
        "by_type": by_type,
    }
