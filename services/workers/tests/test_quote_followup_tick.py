"""EST-1238: the quote follow-up minute tick runs per tenant; one tenant's timeout never stops the others."""
import contextlib

import psycopg
import pytest

from pulse_workers import __main__ as main


class Conn:
    def __init__(self, raise_for):
        self.raise_for, self.org, self.ran = raise_for, None, []

    def execute(self, sql, *args):
        if "quote_followup_tick()" in sql:
            if self.org in self.raise_for:
                raise self.raise_for[self.org]
            self.ran.append(self.org)
        result = {"r": {"due": 0, "told": 0}} if "quote_followup_tick()" in sql else {"ready": True}
        return type("Row", (), {"fetchone": lambda _self: result})()


def run(monkeypatch, conn):
    @contextlib.contextmanager
    def tx(c, org):
        c.org = org
        yield

    monkeypatch.setattr(main, "active_orgs", lambda c: ["a", "b"])
    monkeypatch.setattr(main, "tenant_tx", tx)
    main._run_quote_followup_tick(conn)


def test_a_tenant_timeout_is_logged_and_the_next_tenant_runs(monkeypatch):
    conn = Conn({"a": psycopg.errors.QueryCanceled("canceling statement due to statement timeout")})
    run(monkeypatch, conn)
    assert conn.ran == ["b"]


def test_a_tenant_error_is_logged_and_the_next_tenant_runs(monkeypatch):
    conn = Conn({"a": psycopg.errors.RaiseException("synthetic")})
    run(monkeypatch, conn)
    assert conn.ran == ["b"]


def test_a_lost_connection_still_stops_the_loop(monkeypatch):
    conn = Conn({"a": psycopg.OperationalError("server closed the connection")})
    with pytest.raises(psycopg.OperationalError):
        run(monkeypatch, conn)
    assert conn.ran == []
