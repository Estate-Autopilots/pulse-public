"""PR-PIPELINE: the worker's hourly PR pipeline tick, per tenant, without a database (a fake connection)."""
from contextlib import contextmanager

import psycopg

import pulse_workers.__main__ as main


class Conn:
    def __init__(self, ready=True, fail_org=None):
        self.ready, self.fail_org, self.org, self.calls = ready, fail_org, None, []

    def execute(self, sql, *args):
        self.calls.append((self.org, sql))
        conn = self

        class R:
            def fetchone(self):
                if "to_regprocedure" in sql:
                    return {"ready": conn.ready}
                if conn.org == conn.fail_org:
                    raise ValueError("synthetic failure")
                return {"r": {"enabled": True, "ideas": 1}}
        return R()


def run(monkeypatch, conn, orgs):
    monkeypatch.setattr(main, "active_orgs", lambda c: orgs)

    @contextmanager
    def tx(c, org):
        c.org = org
        yield c
    monkeypatch.setattr(main, "tenant_tx", tx)
    main._run_pr_pipeline_tick(conn)


def test_ticks_every_tenant_and_one_failure_does_not_stop_the_others(monkeypatch):
    c = Conn(fail_org="b")
    run(monkeypatch, c, ["a", "b", "c"])
    ticked = [o for o, sql in c.calls if "pr_pipeline_tick(false)" in sql]
    assert ticked == ["a", "b", "c"]


def test_nothing_runs_before_the_migration(monkeypatch):
    c = Conn(ready=False)
    run(monkeypatch, c, ["a", "b"])
    assert not any("pr_pipeline_tick(false)" in sql for _, sql in c.calls)


def test_database_errors_reach_the_loop(monkeypatch):
    class Down(Conn):
        def execute(self, sql, *a):
            raise psycopg.OperationalError("synthetic: down")
    import pytest
    with pytest.raises(psycopg.OperationalError):
        run(monkeypatch, Down(), ["a"])
