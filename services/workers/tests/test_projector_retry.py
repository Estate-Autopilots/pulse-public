"""LAND-CAPTAIN-10 (12 Nov 2026): a tenant whose projection cannot start waits before its next try.

Production's worker re-read the same events and failed with "FolderRulesError: no active folder_rules documents" for
9 of its 10 tenants about every 6 s, for weeks: a log flood that hid real errors and work repeated for nothing. Now a
failed tenant is tried again after 1 minute, then 2, 4 ... up to an hour; the other tenants are never held up.
"""

from __future__ import annotations

import logging
import uuid

import pytest
from pulse_rules.folder_rules import FolderRulesError

from pulse_workers import projector
from pulse_workers.projector import RETRY_FIRST_S, RETRY_MAX_S, Projection, ProjectionRunner

NO_RULES = FolderRulesError({"org": "x", "errors": ["no active folder_rules documents"]})
BAD_RULES = FolderRulesError({"org": "x", "errors": ["rules@1 /index_rules/0/match: invalid regular expression"]})


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class Runner(ProjectionRunner):
    """catch_up stubbed per tenant: a number of events, or an exception to raise."""

    def __init__(self, outcomes, clock):
        super().__init__(conn=None, projection=type("P", (Projection,), {"name": "workgraph"})(), clock=clock)
        self.outcomes = outcomes
        self.tries: list[uuid.UUID] = []

    def catch_up(self, org_id):
        self.tries.append(org_id)
        out = self.outcomes[org_id]
        if isinstance(out, Exception):
            raise out
        return out


@pytest.fixture
def orgs(monkeypatch):
    a, b = uuid.UUID(int=1), uuid.UUID(int=2)
    monkeypatch.setattr(projector, "active_orgs", lambda _conn: [a, b])
    return a, b


def test_a_tenant_without_folder_rules_waits_with_a_growing_delay_and_others_run(orgs, caplog):
    a, b = orgs
    clock = Clock()
    r = Runner({a: NO_RULES, b: 3}, clock)
    caplog.set_level(logging.INFO, logger="pulse.projector")
    assert r.run_all() == {a: -1, b: 3}
    # Every round after it within the minute: only the healthy tenant is tried.
    for _ in range(10):
        clock.t += 5
        assert r.run_all() == {b: 3}
    assert r.tries.count(a) == 1 and r.tries.count(b) == 11
    # The delays double up to the cap, and each wait is logged once (not every round).
    seen = []
    for _ in range(9):
        clock.t = r.waiting[a][0]
        r.run_all()
        seen.append(r.waiting[a][1])
    assert seen == [2 * RETRY_FIRST_S, 4 * RETRY_FIRST_S, 8 * RETRY_FIRST_S, 16 * RETRY_FIRST_S, 32 * RETRY_FIRST_S,
                    RETRY_MAX_S, RETRY_MAX_S, RETRY_MAX_S, RETRY_MAX_S]
    waits = [m for m in caplog.messages if "has no folder rules yet" in m]
    assert len(waits) == 10 and r.tries.count(a) == 10
    # Missing rules is a company's normal state before set-up: said at INFO, never as an error.
    assert not [rec for rec in caplog.records if rec.levelno >= logging.ERROR]


def test_a_tenant_projects_again_once_its_try_succeeds(orgs, caplog):
    a, b = orgs
    clock = Clock()
    r = Runner({a: NO_RULES, b: 0}, clock)
    caplog.set_level(logging.INFO, logger="pulse.projector")
    r.run_all()
    r.outcomes[a] = 7                     # the company added its folder rules
    clock.t += RETRY_FIRST_S
    assert r.run_all() == {a: 7, b: 0}
    assert a not in r.waiting
    assert any("projects again" in m for m in caplog.messages)
    clock.t += 1
    assert r.run_all() == {a: 7, b: 0}    # tried on every round again


def test_other_failures_are_errors_with_their_next_try_and_reach_on_error(orgs, caplog):
    a, b = orgs
    clock = Clock()
    told = []
    r = Runner({a: BAD_RULES, b: RuntimeError("boom")}, clock)
    r.on_error = told.append
    caplog.set_level(logging.INFO, logger="pulse.projector")
    assert r.run_all() == {a: -1, b: -1}
    errors = [rec.getMessage() for rec in caplog.records if rec.levelno == logging.ERROR]
    assert len(errors) == 2 and all("(next try in 60 s)" in e for e in errors)
    assert "invalid regular expression" in errors[0] and "RuntimeError: boom" in errors[1]
    assert len(told) == 2
    clock.t += 30
    assert r.run_all() == {}              # both wait: nothing tried, nothing logged
    assert len([rec for rec in caplog.records if rec.levelno == logging.ERROR]) == 2


def test_a_database_failure_still_ends_the_run_at_once(orgs):
    import psycopg

    a, b = orgs
    r = Runner({a: psycopg.OperationalError("server closed the connection"), b: 1}, Clock())
    with pytest.raises(psycopg.OperationalError):
        r.run_all()
    assert a not in r.waiting             # the caller reconnects; nothing about the tenant is remembered
