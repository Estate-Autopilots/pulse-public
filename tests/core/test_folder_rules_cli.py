"""Exercise the folder-rules CLI against PostgreSQL's real worker-role RLS policies."""

from __future__ import annotations

import json

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import make_conninfo
from pulse_workers.__main__ import main


def test_rules_check_cli_reads_org_rules_as_worker_under_rls(worker, owner, api, monkeypatch, capsys):
    world = build_world(worker, owner, api)
    worker_url = make_conninfo(dsn("worker"), options="-c role=pulse_worker")
    monkeypatch.setenv("PULSE_DATABASE_URL_WORKER", worker_url)

    result = main(["rules", "check", "--org", str(world.org)])

    assert result == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["org"] == str(world.org)
    assert summary["valid"] is True
    assert summary["documents"] == [{"doc_key": "default", "version": 1}]
