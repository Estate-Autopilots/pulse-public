"""EST-2577: task import through the real API, PostgreSQL and forced tenant RLS. Synthetic only."""
import json
import os
import subprocess
from pathlib import Path

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_hr_suite import _staff
from test_tasks_rt1 import one, team  # noqa: F401


def test_task_import(worker, owner, api, team, tmp_path):  # noqa: F811
    w = team
    other = build_world(worker, owner, api)
    _staff(worker, other)
    for world in (w, other):
        with worker.transaction():
            set_tenant(worker, world.org)
            worker.execute("update pulse.project set title='Shared project name',name='Shared project name' where id=%s", (world.project,))
    with worker.transaction():
        set_tenant(worker, other.org)
        worker.execute("update pulse.person set display_name='Foreign Only' where id=%s", (other.lead,))
        worker.execute("insert into pulse.project(org_id,registry_no,name,title) select %s,max(registry_no)+1,'Foreign project','Foreign project' from pulse.project", (other.org,))
    agent = one(api, w, w.manager, "select pulse.agent_create(%s) id", (Jsonb({
        "name": "Import Helper AI", "username": "import-helper", "title": "Checks drafts", "ownerId": str(w.manager), "lane": "quick"}),))["id"]
    one(api, w, w.manager, "select pulse.agent_settings_save(%s,%s)", (agent, Jsonb({"tools": ["chats", "tasks"]})))
    env = {**os.environ, 'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '0', 'PULSE_ORG_ID': str(w.org),
           'TEST_MEMBER': w.editor_handle, 'TEST_HEAD': f'editor2@{w.domain}', 'TEST_REPORT': str(tmp_path / 'import.json'),
           'TEST_IDS': json.dumps({k: str(v) for k, v in dict(org=w.org, otherOrg=other.org, member=w.editor, head=w.editor2,
               agent=agent, project=w.project, foreignPerson=other.editor, foreignProject=other.project).items()})}
    for role, key in [('api', 'TEST_API_CONFIG'), ('migrate', 'TEST_OWNER_CONFIG')]:
        config = conninfo_to_dict(dsn(role))
        config['database'] = config.pop('dbname')
        env[key] = json.dumps(config)
    result = subprocess.run(['node', 'test/task-import-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api',
                            env=env, text=True, capture_output=True, timeout=180)
    assert result.returncode == 0, result.stdout + '\n' + result.stderr
    assert json.loads((tmp_path / 'import.json').read_text())['ok'] is True
