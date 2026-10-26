"""Installation ownership and EA bootstrap gates against the scratch PostgreSQL database."""

from __future__ import annotations

import os
import re
import sys
import uuid
from contextlib import nullcontext
from pathlib import Path

import pytest
from pulse_sdk import migrate as pulse_migrate
from pulse_sdk.db import set_tenant

from pulse_gdrive_snapshot import bootstrap


def _owner_role(owner) -> str:
    role = os.environ.get("PULSE_DB_OWNER") or owner.execute(
        "select pg_get_userbyid(datdba) as owner_role from pg_database where datname=current_database()"
    ).fetchone()["owner_role"]
    if owner.execute("select rolsuper as superuser from pg_roles where rolname=%s", (role,)).fetchone()["superuser"]:
        role = "pulse_owner"
    assert re.fullmatch(r"[a-z_][a-z0-9_]*", role)
    return role


def test_install_migration_marks_ea_without_writing_a_tenant_row(owner):
    source = (Path(__file__).resolve().parents[2] / "db/migrations/0133_install.sql").read_text()
    with owner.transaction():
        role = _owner_role(owner)
        owner.execute(f"set local role {role}")
        owner.execute("savepoint install_migration_test")
        assert owner.execute("select pulse.install_org()").fetchone()["install_org"] is None

        ea = owner.execute("select id from pulse.org where code='EA'").fetchone()
        if ea:
            org_id = ea["id"]
        else:
            org_id = uuid.uuid4()
            set_tenant(owner, org_id)
            owner.execute("insert into pulse.org(id,slug,name,code) values(%s,'ea-test','Synthetic EA','EA')",
                          (org_id,))
        owner.execute("select set_config('pulse.org_id','',true)")
        assert owner.execute("select pulse.current_org()").fetchone()["current_org"] is None

        before = owner.execute("select id,slug,name,code from pulse.org order by id").fetchall()
        owner.execute("drop function if exists pulse.install_ea(uuid)")
        owner.execute("drop function if exists pulse.install_org()")
        owner.execute("drop table if exists pulse.install")
        owner.execute(pulse_migrate.up_section(source), prepare=False)

        after = owner.execute("select id,slug,name,code from pulse.org order by id").fetchall()
        assert after == before
        marker = owner.execute("select org_id,initialised_by from pulse.install").fetchone()
        assert marker == {"org_id": org_id, "initialised_by": "migration:ea"}
        assert owner.execute("select pulse.install_org()").fetchone()["install_org"] == org_id
        privileges = owner.execute("""select
          has_table_privilege('pulse_api','pulse.install','select') api_select,
          has_table_privilege('pulse_worker','pulse.install','select') worker_select,
          has_table_privilege('pulse_ingest','pulse.install','select') ingest_select,
          has_table_privilege('pulse_api','pulse.install','insert') api_insert,
          has_table_privilege('pulse_worker','pulse.install','update') worker_update,
          has_function_privilege('pulse_worker','pulse.install_ea(uuid)','execute') worker_bootstrap""").fetchone()
        assert privileges == {"api_select": True, "worker_select": True, "ingest_select": True,
                              "api_insert": False, "worker_update": False, "worker_bootstrap": True}
        owner.execute("rollback to savepoint install_migration_test")
        owner.execute("release savepoint install_migration_test")


def test_ea_bootstrap_function_initialises_an_empty_install_and_is_transactional(worker):
    org_id = uuid.uuid4()
    with worker.transaction():
        worker.execute("savepoint empty_install")
        created = worker.execute("select pulse.install_ea(%s) org_id", (org_id,)).fetchone()["org_id"]
        assert created == org_id
        assert worker.execute("select pulse.install_org()").fetchone()["install_org"] == org_id
        assert worker.execute("select code from pulse.org where id=%s", (org_id,)).fetchone()["code"] == "EA"
        assert worker.execute("select initialised_by from pulse.install").fetchone()["initialised_by"] == "pulse-ea-bootstrap"
        worker.execute("rollback to savepoint empty_install")
        worker.execute("release savepoint empty_install")


def test_ea_bootstrap_refuses_northwind_without_writing(monkeypatch, capsys, worker, owner):
    org_id = uuid.uuid4()
    with owner.transaction():
        owner.execute(f"set local role {_owner_role(owner)}")
        set_tenant(owner, org_id)
        owner.execute("insert into pulse.org(id,slug,name,code) values(%s,'northwind-test','Northwind Studio','NWS')",
                      (org_id,))
        owner.execute("insert into pulse.install(org_id,initialised_by) values(%s,'test:northwind')", (org_id,))

    before_orgs = worker.execute("select count(*) n from pulse.list_active_orgs()").fetchone()["n"]
    statements: list[str] = []

    class RecordingConnection:
        def __getattr__(self, name):
            return getattr(worker, name)

        def execute(self, statement, params=()):
            statements.append(statement)
            return worker.execute(statement, params)

    connection = RecordingConnection()
    monkeypatch.setattr(bootstrap, "url_for", lambda _role: "worker-url")
    monkeypatch.setattr(bootstrap.psycopg, "connect", lambda *_args, **_kwargs: nullcontext(connection))
    monkeypatch.setattr(bootstrap.signal, "signal", lambda *_args: None)
    monkeypatch.setattr(sys, "argv", ["pulse-ea-bootstrap"])

    try:
        assert bootstrap.main() == 1
        assert "non-EA organization" in capsys.readouterr().err
        assert all(re.match(r"\s*(select|begin|commit|rollback|savepoint|release|set)\b", sql, re.I)
                   for sql in statements)
        assert worker.execute("select pulse.install_org()").fetchone()["install_org"] == org_id
        assert worker.execute("select count(*) n from pulse.list_active_orgs()").fetchone()["n"] == before_orgs
    finally:
        with owner.transaction():
            owner.execute(f"set local role {_owner_role(owner)}")
            owner.execute("delete from pulse.install where org_id=%s", (org_id,))
            set_tenant(owner, org_id)
            owner.execute("delete from pulse.org where id=%s", (org_id,))
