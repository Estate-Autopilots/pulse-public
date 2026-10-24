"""Synthetic request register API and participant-only pulse_api RLS acceptance."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_agent_coworkers import make_agent
from test_tasks_rt1 import as_, one, team  # noqa: F401


def test_request_register_api_and_rls(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, 'synthetic-register-agent')
    other = build_world(worker, owner, api)
    inactive = uuid.uuid4()
    people = {key: {'id': str(pid), 'email': f'{key}@{w.domain}'} for key, pid in [
        ('a', w.editor), ('b', w.editor2), ('sender', w.lead), ('admin', w.manager), ('outside', w.outsider)]}
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side,status) values(%s,%s,'Inactive synthetic','staff','inactive')", (inactive, w.org))
        for person in people.values():
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace synthetic login')", (w.org, person['email'], person['id']))
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_PEOPLE': json.dumps(people),
           'TEST_BAD_PEOPLE': json.dumps([str(inactive), str(agent), str(other.editor)]),
           'PULSE_OPERATOR_TOKEN': 'synthetic-register-operator-' + '0' * 32}
    def run(extra=None):
        result = subprocess.run(['node', 'test/update-requests-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api',
                                env={**env, **(extra or {})}, capture_output=True, text=True, timeout=90, check=False)
        assert result.returncode == 0, result.stdout + result.stderr
    run()
    with owner.transaction():
        set_tenant(owner, w.org)
        # The request-register migration must preserve every API v1 grant and its AI binding.
        scopes = owner.execute("""insert into pulse_priv.service_key(id,org_id,key_hash,scopes,label,agent_id)
            values(%s,%s,repeat('0',64),pulse.v1_scopes(),'Synthetic v1 regression',%s)
            returning scopes""", (uuid.uuid4(), w.org, agent)).fetchone()['scopes']
        assert len(scopes) == 20 and 'tasks.read' in scopes
        reply = owner.execute("select id,update_id from pulse.update_request where source='update_reply'").fetchone()
        # Even an actual admin in the update audience cannot read someone else's request.
        owner.execute('update pulse.update_post set audience=array_append(audience,%s) where id=%s', (w.manager, reply['update_id']))
        assert owner.execute('select count(*) n from pulse.update_receipt').fetchone()['n'] == 0
    for viewer, count in [(w.editor, 1), (w.manager, 0), (w.editor2, 0), (w.lead, 1)]:
        assert one(api, w, viewer, 'select count(*) n from pulse.update_request where id=%s', (reply['id'],))['n'] == count
        assert (one(api, w, viewer, 'select pulse.update_request_view(%s) r', (reply['id'],))['r'] is not None) == bool(count)
    assert one(api, other, other.manager, 'select count(*) n from pulse.update_request')['n'] == 0
    for sql in ['delete from pulse.update_request', "update pulse.update_request set note='changed'"]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, w.editor, sql)
    for sql in ["select pulse.service_update_request_list(gen_random_uuid(),null,null,null,50)",
                "select pulse.service_update_request_set(gen_random_uuid(),gen_random_uuid(),'done',null,null)",
                "select pulse.service_update_request_create(gen_random_uuid(),'x',null,null,'task','x',null)"]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, w.editor, sql)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.update_request set status='done',updated_at=now()-interval '2 days'")
        next_id = owner.execute("select id from pulse.update_post where slot='2026-10-18-pm'").fetchone()['id']
    run({'TEST_HISTORY_ID': str(next_id)})
