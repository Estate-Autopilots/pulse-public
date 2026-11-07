"""Event Core acceptance tests against a real PostgreSQL 17 + pgvector.

PULSE_CI_DATABASE_URL points at a THROWAWAY database: only pulse_ci or pulse_ci_* are accepted. Two modes:
- superuser (the CI service container, tools/pg-scratch.sh): the session fixture bootstraps roles and one login per
  service (pulse_<svc>_login), and every test connects as the login it exercises;
- member (root's pulse_ci on ea-postgres): the URL's login may SET ROLE to pulse_owner and the four service roles;
  every test connection runs as the service role (``-c role=pulse_api`` …). Needs the vector extension in place.
Either way the Pulse schemas are dropped and rebuilt with db/migrations, and row-level security and grants apply
exactly as in production. Tests create fresh tenants (random ids), never shared fixtures.
"""

from __future__ import annotations

import inspect
import os
import re

import psycopg
import pytest
from _pytest.runner import runtestprotocol
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

from pulse_sdk import migrate

# RELEASE-5: lane C's modules ship off until the server switches them on (services/api/src/modules.ts SERVER_SWITCHED);
# the suite tests them switched on, as their rounds built them (the default-off answers: services/api/test/module-routes.test.mjs).
# RELEASE-6: R52's connectors likewise ("setup": its Settings tab and API, nothing read; its runner checks reading stays off).
for _name, _value in {"PULSE_RELATIONSHIPS": "1", "PULSE_SKILLS": "1", "PULSE_JOBS": "1", "PULSE_CHAT_IMPORT": "preview", "PULSE_CONNECTORS": "setup", "PULSE_CREATIVE": "1", "PULSE_SALES_XRAY": "1"}.items():
    os.environ.setdefault(_name, _value)
ADMIN_URL = os.environ.get("PULSE_CI_DATABASE_URL")
LOGINS = {"migrate": "pulse_migrator_login", "api": "pulse_api_login", "worker": "pulse_worker_login",
          "ingest": "pulse_ingest_login", "privacy": "pulse_privacy_login"}
GROUPS = {"api": "pulse_api", "worker": "pulse_worker", "ingest": "pulse_ingest", "privacy": "pulse_privacy",
          "owner": "pulse_owner"}            # member mode: "owner" becomes the database's owner role
THROWAWAY = re.compile(r"^pulse_ci(_[a-z0-9_]+)?$")   # the only databases this suite may reset
MODE = {"value": None}

if not ADMIN_URL:
    pytest.skip("PULSE_CI_DATABASE_URL is not set (scratch PostgreSQL: bash tools/pg-scratch.sh start)",
                allow_module_level=True)


def role_url(role: str) -> str:
    """The admin connection with the user swapped for the service login (superuser mode: trust auth on the scratch
    server's socket)."""
    return make_conninfo(ADMIN_URL, user=LOGINS[role], password=None)


def detect_mode(admin: psycopg.Connection) -> str:
    if admin.execute("select rolsuper from pg_roles where rolname = current_user").fetchone()[0]:
        return "superuser"
    owner = migrate.default_owner(admin)
    GROUPS["owner"] = owner
    missing = [g for g in GROUPS.values() if not admin.execute(
        "select exists (select 1 from pg_roles where rolname = %s) and pg_has_role(current_user, %s, 'SET')",
        (g, g)).fetchone()[0]]
    if missing:
        pytest.exit(f"PULSE_CI_DATABASE_URL's login cannot SET ROLE {missing}: use a superuser or a member login")
    if not admin.execute("select exists (select 1 from pg_extension where extname = 'vector')").fetchone()[0]:
        pytest.exit("the CI database has no vector extension (root creates it) and the login is not a superuser")
    return "member"


@pytest.fixture(scope="session")
def database():
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        name = admin.execute("select current_database()").fetchone()[0]
        if not THROWAWAY.match(name):
            pytest.exit(f"refusing to reset database {name!r}: only pulse_ci or pulse_ci_* may be reset")
        MODE["value"] = detect_mode(admin)
        if MODE["value"] == "member":
            admin.execute(f"set role {GROUPS['owner']}")
        # OPS-2: tools/ci-db-shards.py hands each shard a fresh copy of a database it already migrated (the same steps
        # as below); migrate() then finds nothing pending.
        if os.environ.get("PULSE_CI_PREMIGRATED") != "1":
            admin.execute("drop schema if exists pulse, pulse_priv, privacy, pulse_route cascade")
            admin.execute("drop table if exists public.schema_migrations")
        if MODE["value"] == "superuser":
            migrate.bootstrap_scratch(admin)
    url = role_url("migrate") if MODE["value"] == "superuser" else ADMIN_URL
    owner = "pulse_owner" if MODE["value"] == "superuser" else GROUPS["owner"]
    with psycopg.connect(url, autocommit=True) as conn:
        migrate.migrate(conn, owner=owner, verbose=False)
        migrate.sync_registry(conn, owner=owner)
    yield


def dsn(role: str) -> str:
    """A connection string for a service role (for code that opens its own pool, e.g. the ingest app)."""
    if MODE["value"] == "superuser":
        return role_url(role)
    return make_conninfo(ADMIN_URL, options=f"-c role={GROUPS[role]}")


def _connect(role: str) -> psycopg.Connection:
    kw = dict(autocommit=True, row_factory=dict_row, application_name=f"test-{role}")
    if MODE["value"] == "superuser":
        return psycopg.connect(role_url("migrate" if role == "owner" else role), **kw)
    return psycopg.connect(ADMIN_URL, options=f"-c role={GROUPS[role]}", **kw)


@pytest.fixture
def api(database):
    with _connect("api") as c:
        yield c


@pytest.fixture
def worker(database):
    with _connect("worker") as c:
        yield c


@pytest.fixture
def ingest(database):
    with _connect("ingest") as c:
        yield c


@pytest.fixture
def privacy(database):
    with _connect("privacy") as c:
        yield c


@pytest.fixture
def owner(database):
    """The owner (migration) role: only for test set-up that production does in migrations or admin tooling."""
    with _connect("owner") as c:
        yield c


@pytest.fixture
def admin(database):
    """Catalogue checks and log reads. Superuser in superuser mode, else the owner role (row-level security still
    applies to it: read tenant rows with helpers.read_as)."""
    if MODE["value"] == "superuser":
        with psycopg.connect(ADMIN_URL, autocommit=True, row_factory=dict_row) as c:
            yield c
    else:
        with _connect("owner") as c:
            yield c


@pytest.fixture(autouse=True)
def reset_install_marker(database, owner):
    """Each synthetic API test starts uninstalled, then its first world becomes that install's company."""
    with owner.transaction():
        role = owner.execute(
            "select pg_get_userbyid(nspowner) as owner_role from pg_namespace where nspname='pulse'"
        ).fetchone()["owner_role"]
        if not re.fullmatch(r"[a-z_][a-z0-9_]*", role):
            raise AssertionError(f"unexpected pulse schema owner role: {role!r}")
        owner.execute(f"set local role {role}")
        owner.execute("delete from pulse.install")


# --- OPS-2: a browser test that fails runs once more ---------------------------------------------------------------
# Browser flows share the server's two heavy-work CPUs with everything else and can lose a race (13 Oct: a notice
# springing open over a button). A browser test whose test body fails runs once more: if it passes then, it counts as
# passed and is reported as flaky (the terminal summary and PULSE_CI_FLAKY_FILE, which tools/ci.sh shows in its
# summary); if it fails again it fails exactly as before. Setup and teardown failures, and other tests, never retry.
# In tools/ci-db-shards.py's parallel shards (PULSE_CI_RETRY_LATER) the one retry happens alone after the shards
# instead: beside the other shard, R47 and UX-5B failed their immediate retries too and passed alone (15 Oct).
# PULSE_CI_BROWSER_RETRY=0: no retry (that alone run is the retry).
FLAKY: list[tuple[str, str]] = []


def _browser_test(item) -> bool:
    if any("browser" in str(m.kwargs.get("reason", "")).lower() for m in item.iter_markers("skipif")):
        return True
    try:
        return "PULSE_AUTH_BROWSER" in inspect.getsource(item.function)
    except (AttributeError, OSError, TypeError):
        return False


def pytest_runtest_protocol(item, nextitem):
    if os.environ.get("PULSE_AUTH_BROWSER") != "1" or not _browser_test(item):
        return None
    item.ihook.pytest_runtest_logstart(nodeid=item.nodeid, location=item.location)
    reports = runtestprotocol(item, log=False, nextitem=nextitem)
    failed = [r for r in reports if r.failed]
    later = os.environ.get("PULSE_CI_RETRY_LATER")  # tools/ci-db-shards.py retries it alone, after the shards
    if failed and all(r.when == "call" for r in failed) and os.environ.get("PULSE_CI_BROWSER_RETRY") != "0":
        first = (failed[0].longreprtext or "").strip().splitlines()
        if later:
            with open(later, "a", encoding="utf-8") as out:
                out.write(f"{item.nodeid}\t{first[-1][:300] if first else ''}\n")
            print(f"\n{item.nodeid} failed beside the other shard; it runs once more alone afterwards")
            for report in reports:
                item.ihook.pytest_runtest_logreport(report=report)
            item.ihook.pytest_runtest_logfinish(nodeid=item.nodeid, location=item.location)
            return True
        print(f"\nretrying {item.nodeid} once (browser test failed: {first[-1][:200] if first else 'no message'})")
        reports = runtestprotocol(item, log=False, nextitem=nextitem)
        if not any(r.failed for r in reports):
            FLAKY.append((item.nodeid, first[-1][:300] if first else ""))
    for report in reports:
        item.ihook.pytest_runtest_logreport(report=report)
    item.ihook.pytest_runtest_logfinish(nodeid=item.nodeid, location=item.location)
    return True


def pytest_terminal_summary(terminalreporter):
    if not FLAKY:
        return
    terminalreporter.section("flaky browser tests (failed once, passed on retry)")
    for nodeid, first in FLAKY:
        terminalreporter.write_line(f"FLAKY {nodeid}: {first}")
    path = os.environ.get("PULSE_CI_FLAKY_FILE")
    if path:
        with open(path, "a", encoding="utf-8") as out:
            out.writelines(f"{nodeid}\t{first}\n" for nodeid, first in FLAKY)

