"""EST-1611: the API v1 front door on real PostgreSQL/RLS, Fastify and the web's bearer proxy (services/api/test/
v1-runner.mjs). Keys, people and chats are synthetic; the runner asserts no secret, digest or body reaches its logs."""
import hashlib
import json
import os
import secrets
import subprocess
import uuid
from pathlib import Path

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_agent_coworkers import make_agent
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def test_v1_front_door(api, worker, owner, team):  # noqa: F811
    w, other = team, build_world(worker, owner, api)  # the first world is the install's company
    with owner.transaction():
        set_tenant(owner, other.org)
        owner.execute("insert into pulse.org_domain(org_id,host,sign_in,added_by) values(%s,'v1-other.example','password','synthetic')", (other.org,))
    agent, old = make_agent(api, w, 'v1-front-door')
    chat = one(api, w, w.manager, "select pulse.chat_group_create('Synthetic v1 chat',%s) id", ([w.editor],))['id']
    outside = one(api, w, w.manager, "select pulse.chat_group_create('Synthetic outside chat',%s) id", ([w.editor],))['id']
    as_(api, w, w.manager, 'select pulse.agent_group_member(%s,%s,true)', (chat, agent))
    keys = {'old': old}
    for name, scopes in [('ai', ['chats.read']), ('aiTasks', ['tasks.read']), ('aiRevoked', ['chats.read'])]:
        keys[name] = one(api, w, w.manager, 'select pulse.agent_key_issue(%s,%s,30,%s) k', (agent, name, scopes))['k']
    one(api, w, w.manager, 'select pulse.agent_key_revoke(%s)', (keys['aiRevoked'][4:12],))
    for name, scopes in [('app', ['chats.read', 'tasks.read']), ('appTasks', ['tasks.read']), ('legacy', ['chats.post'])]:
        key, secret = uuid.uuid4(), secrets.token_urlsafe(32)
        api.execute("select pulse.service_key_manage('issue',%s,%s,%s,'Synthetic v1 app',%s)", (key, hashlib.sha256(secret.encode()).hexdigest(), scopes, agent))
        keys[name] = f'psvc_{key}_{secret}'
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_KEYS': json.dumps(keys), 'TEST_AGENT': str(agent), 'TEST_CHAT': str(chat),
           'TEST_OUTSIDE': str(outside), 'TEST_OTHER_HOST': 'v1-other.example', 'TEST_ORG': str(w.org), 'TEST_ADMIN': str(w.manager)}
    result = subprocess.run(['node', 'test/v1-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api',
                            env=env, capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr
