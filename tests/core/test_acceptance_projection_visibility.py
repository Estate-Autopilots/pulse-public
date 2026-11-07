"""The projection watermark skips only transactions that cannot add rows to this database's event log."""

from __future__ import annotations

import os
import uuid

import psycopg
import pytest
from helpers import FOLDER_MIME, build_world, drive_id, emit, issue_asset, upload
from psycopg import sql
from psycopg.conninfo import make_conninfo
from pulse_sdk.db import set_tenant
from pulse_workers.projector import ProjectionRunner
from pulse_workers.workgraph import WorkGraph


def test_other_database_transaction_does_not_hold_up_projection(worker, owner, api, admin):
    if not admin.execute("select rolsuper from pg_roles where rolname = current_user").fetchone()["rolsuper"]:
        pytest.skip("cross-database transaction setup requires the throwaway CI database superuser")

    blocker_name = f"pulse_ci_blocker_{uuid.uuid4().hex}"
    admin.execute(sql.SQL("create database {}").format(sql.Identifier(blocker_name)))
    blocker = psycopg.connect(make_conninfo(os.environ["PULSE_CI_DATABASE_URL"], dbname=blocker_name))
    try:
        blocker.execute("select pg_current_xact_id()")  # hold an older XID open in a different database
        w = build_world(worker, owner, api)
        cid = w.cid("HK", 3)
        issue_asset(api, w, cid)
        upload(worker, w, drive_id(), f"{cid}-v1.mp4", "visibility-probe", folder=w.drafts, minutes=20)

        ProjectionRunner(worker, WorkGraph()).catch_up(w.org)
        with worker.transaction():
            set_tenant(worker, w.org)
            assert worker.execute("select count(*) as n from pulse.version where file_id is not null").fetchone()["n"] == 1
    finally:
        blocker.rollback()
        blocker.close()
        admin.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(blocker_name)))


def test_same_database_transaction_holds_projection_cursor(worker, owner, api):
    w = build_world(worker, owner, api)
    runner = ProjectionRunner(worker, WorkGraph())
    runner.catch_up(w.org)
    first, second = drive_id(), drive_id()

    with owner.transaction():
        emit(owner, w.org, "drive.folder.created", f"file:gdrive:{first}",
             {"name": "Held transaction", "mime": FOLDER_MIME, "parents": [w.root]},
             source=w.changes, time=w.at(10))
        emit(worker, w.org, "drive.folder.created", f"file:gdrive:{second}",
             {"name": "Later committed transaction", "mime": FOLDER_MIME, "parents": [w.root]},
             source=w.changes, time=w.at(11))
        assert runner.catch_up(w.org) == 0

    assert runner.catch_up(w.org) == 2
