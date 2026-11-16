from __future__ import annotations

import pytest

from pulse_rules.protected_paths import is_protected


@pytest.mark.parametrize("path", [
    "HR/Offer Letters",
    "Shared drives/Human_Resources/2026",
    "Finance/Q3",
    "Accounts/Payroll2026",
    "Ops/Salary-Slips",
    "Legal/NDAs",
    "Studio/CREDENTIALS",
    "IT/Passwords",
    "Team/Personal",
    "Northwind Homes/Archived Projects",
])
def test_builtin_segments_are_protected(path):
    assert is_protected(path)
    assert is_protected(path, ())


@pytest.mark.parametrize("path", [
    "Three Rivers/Launch Film",
    "Northwind Homes/Personality Shoot",
    "Lakeview Group/Shrine Road",
    "Northwind Homes/Maple Rise/Exports",
])
def test_words_inside_other_words_are_not_protected(path):
    assert not is_protected(path)


def test_company_patterns_add_to_the_builtins_and_stay_word_bounded():
    extra = ("board\\s+minutes", "board")
    assert is_protected("Admin/Board_Minutes/2026", extra)
    assert is_protected("HR/Offer Letters", extra)
    assert not is_protected("Northwind Homes/Boardwalk Villas", extra)
    assert not is_protected("Admin/Board Minutes/2026")
