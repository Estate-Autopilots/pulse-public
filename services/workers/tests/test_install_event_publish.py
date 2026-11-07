"""EST-1259: the minute block numbers the install's events in one budgeted call; only a lost connection stops it."""
import contextlib

import psycopg
import pytest

from pulse_workers import __main__ as main


class Conn:
    def __init__(self, error=None):
        self.error, self.ran = error, []

    @contextlib.contextmanager
    def transaction(self):
        yield

    def execute(self, sql, *args):
        self.ran.append(sql)
        if "install_event_publish()" in sql and self.error:
            raise self.error
        result = {"n": 2, "ready": True}
        return type("Row", (), {"fetchone": lambda _self: result})()


@pytest.mark.parametrize("error", [None, psycopg.errors.QueryCanceled("timeout"),
                                   psycopg.errors.RaiseException("synthetic")])
def test_publish_runs_once_with_its_own_budget_and_logs_failures(error):
    conn = Conn(error)
    main._run_install_event_publish(conn)
    assert conn.ran[1:] == ["set local statement_timeout = '20s'", "select pulse.install_event_publish() as n"]


def test_a_lost_connection_still_stops_the_loop():
    with pytest.raises(psycopg.OperationalError):
        main._run_install_event_publish(Conn(psycopg.OperationalError("server closed the connection")))
