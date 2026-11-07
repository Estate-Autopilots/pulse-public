"""Federated My Tasks: two synthetic installs, each the only source of truth for its tasks (EST-2087)."""
import json
import os
import subprocess
import uuid
from pathlib import Path

from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant

from conftest import dsn
from helpers import build_world


def task_digest(worker, org):
    with worker.transaction():
        set_tenant(worker, org)
        return worker.execute("select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) d from pulse.task t "
                              "where t.org_id=%s", (org,)).fetchone()["d"]


def test_federated_my_tasks(worker, owner, api):
    worlds = []
    for i in range(3):
        w = build_world(worker, owner, api)
        inactive = uuid.uuid4()
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("insert into pulse.person(id,org_id,display_name,side,status) values(%s,%s,'Synthetic inactive','staff','inactive')", (inactive, w.org))
            worker.execute("insert into pulse.task(org_id,title,assignee_person_id,status,due_at) values(%s,%s,%s,'open',%s)",
                           (w.org, f"Synthetic mine {i}", w.editor, '2026-10-19T12:00:00Z' if i == 0 else None))
            worker.execute("insert into pulse.task(org_id,title,assignee_person_id,status) values(%s,'Synthetic private other-person task',%s,'open')", (w.org, w.editor2))
        with api.transaction():
            set_tenant(api, w.org, w.editor)
            name = api.execute("select name from pulse.org where id=%s", (w.org,)).fetchone()["name"]
        worlds.append({"org": str(w.org), "person": str(w.editor), "inactive": str(inactive), "name": name})
    before = [task_digest(worker, w["org"]) for w in worlds[:2]]
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    result = subprocess.run(['node', 'test/federated-my-tasks-runner.mjs'],
                            cwd=Path(__file__).resolve().parents[2] / 'services/api',
                            env={**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_WORLDS': json.dumps(worlds)},
                            text=True, capture_output=True, timeout=60)
    assert result.returncode == 0, result.stdout + '\n' + result.stderr
    print(result.stdout)  # The merged hub view: demo evidence.
    assert [task_digest(worker, w["org"]) for w in worlds[:2]] == before
