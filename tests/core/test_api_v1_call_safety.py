"""v1-call-safety/1: synthetic real-Postgres concurrency, private receipts and Fastify refusal audit."""
import hashlib
import json
import os
import secrets
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from test_agent_coworkers import make_agent, owner_sql
from test_tasks_rt1 import one, team  # noqa: F401


def test_call_safety(api, worker, owner, ingest, privacy, team):  # noqa: F811
    w, other = team, build_world(worker, owner, api)
    agent, _ = make_agent(api, w, 'v1-call-safety')
    keys = [one(api, w, w.manager, "select pulse.agent_key_issue(%s,'safety',30,%s) k", (agent, ['tasks.write']))['k'] for _ in range(2)]
    key, secret = uuid.uuid4(), secrets.token_urlsafe(32)
    api.execute("select pulse.service_key_manage('issue',%s,%s,%s,'Synthetic safety app',%s)", (key, hashlib.sha256(secret.encode()).hexdigest(), ['tasks.write'], agent))
    keys.append(f'psvc_{key}_{secret}')
    owner.execute('create table pulse_priv.v1_safety_commit (org_id uuid references pulse.org(id) deferrable initially deferred)')
    owner.execute('grant insert on pulse_priv.v1_safety_commit to pulse_api')
    for role in [api, worker, ingest, privacy]:
        for table in ['v1_call', 'v1_replay']:
            with pytest.raises(psycopg.errors.InsufficientPrivilege), role.transaction():
                role.execute(f'select * from pulse_priv.{table}')
    for role in [worker, ingest, privacy]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege), role.transaction():
            role.execute("select pulse.v1_replay(null,'fixture',null,null)")
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    owner_config = conninfo_to_dict(owner.info.dsn)
    owner_config['database'] = owner_config.pop('dbname')
    result = subprocess.run(['node', 'test/v1-safety-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api',
                            env={**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_OWNER_CONFIG': json.dumps(owner_config),
                                 'TEST_KEYS': json.dumps(keys), 'TEST_ORG': str(w.org), 'TEST_OTHER': str(other.org), 'TEST_AGENT': str(agent)},
                            capture_output=True, text=True, timeout=90, check=False)
    owner.execute('drop table pulse_priv.v1_safety_commit')
    assert result.returncode == 0, result.stdout + result.stderr
    # Forced RLS applies even to the table owner: a tenant cannot see another tenant's private stored response.
    assert owner_sql(owner, other, 'select * from pulse_priv.v1_replay where org_id=%s', (w.org,)) == []
