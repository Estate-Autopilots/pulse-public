"""PM-BUILD-4 (EA #36, migration 2532): the v1 pager's cursor key lives in the database, made once, so a saved cursor
still opens after the API restarts. The API role reads it through one function (also inside a read-only transaction);
no other service role reads it, and nobody reads the table directly."""
import psycopg
import pytest


def key_of(conn):
    with conn.transaction():
        return conn.execute("select pulse.v1_cursor_key() k").fetchone()["k"]


def test_one_stable_key_for_the_api(api, owner):
    k1 = key_of(api)
    assert isinstance(k1, bytes) and len(k1) == 32
    # the same key on every call and every connection (a restarted API reads the same key)
    assert key_of(api) == k1
    # readable inside a read-only request transaction (nothing is written at read time)
    with api.transaction():
        api.execute("set transaction read only")
        assert api.execute("select pulse.v1_cursor_key() k").fetchone()["k"] == k1
    assert owner.execute("select count(*) n from pulse_priv.v1_cursor_key").fetchone()["n"] == 1


@pytest.mark.parametrize("role", ["worker", "ingest", "privacy"])
def test_other_roles_cannot_read_the_key(request, role):
    conn = request.getfixturevalue(role)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with conn.transaction():
            conn.execute("select pulse.v1_cursor_key()")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with conn.transaction():
            conn.execute("select key from pulse_priv.v1_cursor_key")


def test_api_cannot_read_the_table_directly(api):
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with api.transaction():
            api.execute("select key from pulse_priv.v1_cursor_key")
