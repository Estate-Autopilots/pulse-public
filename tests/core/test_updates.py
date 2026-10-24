"""Company-neutral updates: API acceptance plus forced RLS as two pulse_api viewers."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
from psycopg.conninfo import conninfo_to_dict
import pytest
from conftest import dsn
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_agent_coworkers import make_agent
from test_tasks_rt1 import as_, one, team  # noqa: F401


def test_updates_acceptance_and_two_viewer_rls(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, 'synthetic-publisher')
    other = build_world(worker, owner, api)
    inactive = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side,status) values(%s,%s,'Inactive synthetic','staff','inactive')", (inactive, w.org))
    people = {key: {'id': str(pid), 'email': email} for key, pid, email in [
        ('a', w.editor, w.editor_handle), ('b', w.editor2, f'editor2@{w.domain}'),
        ('sender', w.lead, 'hr@estateautopilots.com'), ('admin', w.manager, 'admin@estateautopilots.com'),
        ('outside', w.outsider, f'outside@{w.domain}')]}  # Give the outsider a real staff login for the negative control.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, people['outside']['email'], w.outsider))
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_PEOPLE': json.dumps(people),
           'TEST_BAD_PEOPLE': json.dumps([str(inactive), str(agent), str(other.editor)]),
           'PULSE_OPERATOR_TOKEN': 'synthetic-updates-operator-' + '0' * 32}
    # Observe identity during INSERT, not just after the service function returns.
    with owner.transaction():
        owner.execute('''create function pulse.test_update_identity() returns trigger language plpgsql as $$
          begin if pulse.current_viewer() is not null then raise exception 'Service became a person'; end if; return new; end $$;
          create trigger test_update_identity before insert on pulse.update_post for each row execute function pulse.test_update_identity()''')
    try:
        result = subprocess.run(['node', 'test/updates-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api',
                                env=env, capture_output=True, text=True, timeout=90)
    finally:
        with owner.transaction():
            owner.execute('drop trigger test_update_identity on pulse.update_post; drop function pulse.test_update_identity()')
    assert result.returncode == 0, result.stdout + result.stderr
    # Definer/owner reads need only the tenant; the outbox recipient re-check has no staff viewer.
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("select set_config('pulse.viewer_id','',true)")
        assert owner.execute('select pulse.current_viewer() v').fetchone()['v'] is None
        assert owner.execute('select count(*) n from pulse.update_post').fetchone()['n'] == 2
        assert owner.execute('select count(*) n from pulse.update_receipt').fetchone()['n'] == 2
        set_tenant(owner, other.org)
        assert owner.execute('select count(*) n from pulse.update_post').fetchone()['n'] == 0
    with pytest.raises(psycopg.errors.InsufficientPrivilege), worker.transaction():
        set_tenant(worker, w.org)
        worker.execute('select * from pulse.update_post')
    # Raw table SELECTs run under pulse_api, including an actual admin, without an admin bypass.
    for person, count in [(w.editor, 2), (w.manager, 0), (w.lead, 2)]:
        assert one(api, w, person, 'select count(*) n from pulse.update_post')['n'] == count
        assert one(api, w, person, 'select count(*) n from pulse.update_receipt')['n'] == {w.editor: 1, w.manager: 0, w.lead: 2}[person]
    assert one(api, w, w.editor2, 'select count(*) n from pulse.update_receipt')['n'] == 0
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, 'delete from pulse.update_receipt')
    assert one(api, other, other.manager, 'select count(*) n from pulse.update_post')['n'] == 0


def test_updates_key_scope_and_agent_constraints(api, worker, owner, team):  # noqa: F811
    agent, _ = make_agent(api, team, 'synthetic-updates-agent')
    for scopes, agent_id in [(['updates.post'], None), (['updates.post', 'tasks.read'], agent)]:
        api.execute("select pulse.service_key_manage('issue',%s,%s,%s,'Synthetic updates',%s)",
                    (uuid.uuid4(), 'a' * 64, scopes, agent_id))
    with pytest.raises(psycopg.errors.CheckViolation), api.transaction():
        api.execute("select pulse.service_key_manage('issue',%s,%s,%s,'Synthetic updates')",
                    (uuid.uuid4(), 'b' * 64, ['updates.post', 'tasks.read']))
