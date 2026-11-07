"""Folders onboarding never proposes: a built-in list that cannot be switched off, plus a company's additions."""

from __future__ import annotations

import re
from collections.abc import Iterable
from functools import lru_cache

# The finance words mirror the Drive backfill's sensitive-segment filter (`pulse_gdrive_snapshot.backfill`).
BUILTIN_PATTERNS = (
    r"hr", r"human\s+resources?",
    r"salary", r"salaries", r"payroll", r"finances?", r"financial", r"bank\s+statements?", r"compensation",
    r"remuneration", r"payslips?",
    r"legal",
    r"credentials?", r"passwords?",
    r"personal", r"archive[sd]?",
)


@lru_cache(maxsize=32)
def _matcher(extra: tuple[str, ...]) -> re.Pattern[str]:
    words = "|".join(f"(?:{pattern})" for pattern in (*BUILTIN_PATTERNS, *extra))
    return re.compile(rf"(?<![a-z])(?:{words})(?![a-z])", re.IGNORECASE)


def is_protected(path: str, extra: Iterable[str] = ()) -> bool:
    """True when any path segment hits a built-in or company pattern (case-insensitive, word-bounded)."""
    matcher = _matcher(tuple(extra))
    return any(
        matcher.search(re.sub(r"[\s_.\-]+", " ", part.strip().casefold()))
        for part in re.split(r"[/\\]+", path)
        if part.strip()
    )
