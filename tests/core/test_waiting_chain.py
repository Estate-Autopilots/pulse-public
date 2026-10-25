"""EST-1746: synthetic waiting graphs through real RLS and the staff HTTP boundary."""
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
from test_agent_coworkers import agent_one, make_agent
from test_tasks_rt1 import as_, new_task, notes, one, team  # noqa: F401


def owner_sql(owner, w, query, args=()):
    # Synthetic setup has a staff viewer so source-replay protection preserves no stale locked fields.
    with owner.transaction():
        set_tenant(owner, w.org, w.manager)
        cur = owner.execute(query, args)
        return cur.fetchall() if cur.description else None


def chain(api, w, who, task):
    return one(api, w, who, 'select pulse.task_chain(%s) r', (task,))['r']


def block(api, w, a, b):
    return one(api, w, w.manager, 'select pulse.task_block(%s,%s) id', (a, b))['id']


def test_actor_fallback(api, owner, team):
    w = team
    t = new_task(api, w, w.editor, title='Synthetic actor')
    for assignee, owner_id, project, creator, expected in [
        (w.editor, w.outsider, w.project, w.editor2, w.editor),
        (None, w.outsider, w.project, w.editor2, w.outsider),
        (None, None, w.project, w.editor2, w.lead),
        (None, None, None, w.editor2, w.editor2),
        (None, None, None, None, None),
    ]:
        owner_sql(owner, w, 'update pulse.project set lead_person_id=%s where id=%s', (w.lead, w.project))
        owner_sql(owner, w, 'update pulse.task set assignee_person_id=%s,owner_id=%s,project_id=%s,created_by=%s where id=%s',
                  (assignee, owner_id, project, creator, t))
        assert one(api, w, w.manager, 'select pulse.task_actor(%s) a', (t,))['a'] == expected


def test_breadth_first_cap_declared_and_closed(api, owner, team):
    w = team
    tasks = [new_task(api, w, w.editor, title=f'Synthetic chain {i}') for i in range(8)]
    edges = [(0, 1, 4), (0, 2, 2), (1, 3, 1), (2, 4, 9), (3, 5, 8), (5, 6, 7), (6, 7, 6)]
    for a, b, age in edges:
        lid = block(api, w, tasks[a], tasks[b])
        owner_sql(owner, w, "update pulse.task_link set created_at='2026-01-01'::timestamptz+%s*interval '1 hour' where id=%s", (age, lid))
    owner_sql(owner, w, "insert into pulse.blocker(org_id,task_id,blocker_key,opened_at,owner_side,source) values(%s,%s,'external_input',now(),'external','declared')", (w.org, tasks[0]))
    result = chain(api, w, w.editor, tasks[0])
    assert [s['blocker']['id'] for s in result['steps']] == [str(tasks[i]) for i in (2, 1, 3, 4, 5)]
    assert [s['depth'] for s in result['steps']] == [1, 1, 2, 2, 3]
    assert result['more'] == 2 and result['declared'][0]['kind'] == 'external_input'
    assert all(s['answer'] is None and s['nudgedAt'] is None for s in result['steps'])
    # A legacy cycle cannot loop forever or inflate the number of remaining steps.
    owner_sql(owner, w, 'insert into pulse.task_link(org_id,task_id,blocker_id,created_by) values(%s,%s,%s,%s)', (w.org, tasks[7], tasks[0], w.manager))
    assert chain(api, w, w.editor, tasks[0])['more'] == 3
    owner_sql(owner, w, "update pulse.task set status='in_review' where id=%s", (tasks[2],))
    assert chain(api, w, w.editor, tasks[0])['steps'][0]['next'] == 'closed'


def test_hidden_root_and_step_and_other_org(api, worker, owner, team):
    w = team
    root = new_task(api, w, w.editor, title='Synthetic visible root')
    mid, hidden = [new_task(api, w, w.manager, title=f'Private synthetic {i}', assigneeId=str(w.outsider)) for i in range(2)]
    block(api, w, root, mid)
    block(api, w, mid, hidden)
    result = chain(api, w, w.editor, root)
    assert result['steps'][1]['blocker']['hidden'] and result['steps'][1]['blocker']['title'] is None
    isolated = new_task(api, w, w.editor, title='Synthetic unshared task')
    for who in (w.outsider, uuid.uuid4(), None):
        with pytest.raises(psycopg.errors.NoDataFound):
            chain(api, w, who, isolated)
    foreign = build_world(worker, owner, api)
    ft = new_task(api, foreign, foreign.editor, title='Synthetic foreign blocker')
    owner_sql(owner, foreign, 'insert into pulse.task_link(org_id,task_id,blocker_id,created_by) values(%s,%s,%s,%s)', (foreign.org, root, ft, foreign.manager))
    assert len(chain(api, w, w.editor, root)['steps']) == 2
    with pytest.raises(psycopg.errors.NoDataFound):
        chain(api, foreign, foreign.editor, root)
    assert one(api, foreign, foreign.manager, 'select pulse.task_actor(%s) a', (mid,))['a'] is None
    assert one(api, foreign, foreign.editor, 'select pulse.task_blocked_on(%s) r', (foreign.editor,))['r'] == {'rows': []}


@pytest.mark.parametrize('started', [False, True])
def test_cycles_and_single_unblocked_notice(api, worker, team, started):
    w = team
    a, b, c = [new_task(api, w, w.editor, title=f'Synthetic cycle {i}') for i in range(3)]
    if started:
        as_(api, w, w.editor, "select pulse.task_move(%s,'in_progress')", (a,))
    block(api, w, a, b)
    assert one(api, w, w.editor, 'select status from pulse.task where id=%s', (a,))['status'] == 'blocked'
    for source, target in [(b, a), (c, a)]:
        if source == c:
            block(api, w, b, c)
        with pytest.raises(psycopg.errors.InvalidParameterValue, match='wait on each other'):
            block(api, w, source, target)
    block(api, w, a, c)
    as_(api, w, w.manager, 'select pulse.task_unblock(%s,%s)', (a, b))
    assert notes(worker, w, w.editor, 'task.unblocked') == []
    as_(api, w, w.manager, 'select pulse.task_unblock(%s,%s)', (a, c))
    assert one(api, w, w.editor, 'select status from pulse.task where id=%s', (a,))['status'] == ('in_progress' if started else 'open')
    assert len(notes(worker, w, w.editor, 'task.unblocked')) == 1


def test_blocked_on_oldest_limit_and_ai_owner(api, owner, team):
    w = team
    agent, _ = make_agent(api, w, ownerId=str(w.outsider))
    target = new_task(api, w, w.editor, title='Synthetic blocking work')
    for i in range(52):
        waiting = new_task(api, w, w.editor, title=f'Synthetic wait {i}')
        lid = block(api, w, waiting, target)
        owner_sql(owner, w, "update pulse.task_link set created_at='2026-01-01'::timestamptz+%s*interval '1 hour' where id=%s", (51-i, lid))
    result = one(api, w, w.editor, 'select pulse.task_blocked_on(%s) r', (w.editor,))['r']
    assert set(result) == {'rows'} and len(result['rows']) == 50
    assert [r['waiting']['title'] for r in result['rows']][:2] == ['Synthetic wait 51', 'Synthetic wait 50']
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, 'select pulse.task_blocked_on(%s)', (w.editor,))
    owner_sql(owner, w, 'update pulse.task set owner_id=%s,assignee_person_id=%s where id=%s', (agent, agent, target))
    for who in (w.outsider, w.manager):
        assert len(one(api, w, who, 'select pulse.task_blocked_on(%s) r', (agent,))['r']['rows']) == 50
    assert len(agent_one(api, w, agent, 'select pulse.task_blocked_on(%s) r', (agent,))['r']['rows']) == 50
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, 'select pulse.task_blocked_on(%s)', (agent,))
    owner_sql(owner, w, "update pulse.task set status='done' where id=%s", (target,))
    assert one(api, w, w.outsider, 'select pulse.task_blocked_on(%s) r', (agent,))['r'] == {'rows': []}


@pytest.mark.parametrize('ai_owned', [False, True])
def test_blocked_on_redacts_hidden_tasks(api, owner, team, ai_owned):
    w = team
    target = new_task(api, w, w.editor, title='Synthetic blocking detail')
    waiting = new_task(api, w, w.manager, title='Synthetic private waiting detail',
                       assigneeId=str(w.editor if ai_owned else w.outsider))
    lid = block(api, w, waiting, target)
    if ai_owned:
        person, _ = make_agent(api, w, ownerId=str(w.outsider))
        viewer = w.outsider
        owner_sql(owner, w, 'update pulse.task set owner_id=%s,assignee_person_id=%s where id=%s', (person, person, target))
    else:
        viewer = person = w.editor
        # The creator remains the actor after the task is unassigned; linking grants no waiting-task visibility.
        owner_sql(owner, w, 'update pulse.task set owner_id=null,assignee_person_id=null,project_id=null where id=%s', (target,))
    assert not one(api, w, viewer, 'select pulse.task_visible(%s) v', (waiting,))['v']
    assert one(api, w, viewer, 'select pulse.task_visible(%s) v', (target,))['v'] == (not ai_owned)
    rows = one(api, w, viewer, 'select pulse.task_blocked_on(%s) r', (person,))['r']['rows']
    assert len(rows) == 1 and rows[0]['linkId'] == str(lid)
    assert rows[0]['waiting'] == {'id': str(waiting), 'title': None, 'hidden': True, 'status': 'blocked', 'owner': None}
    assert rows[0]['blocker'] == {'id': str(target), 'title': None if ai_owned else 'Synthetic blocking detail', 'hidden': ai_owned}


def test_http_waiting_boundary(api, team):
    cfg = conninfo_to_dict(dsn('api'))
    cfg['database'] = cfg.pop('dbname')
    script = r'''
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import Ajv from 'ajv/dist/2020.js';
const doc = load(readFileSync('openapi/waiting.yaml', 'utf8'));
const validate = (name, data) => { const check = new Ajv({strict:false, validateFormats:false}).compile({...doc, $ref:`#/components/schemas/${name}`}); assert.ok(check(data), JSON.stringify(check.errors)); };
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const email = process.env.TEST_MEMBER;
const call = (url, user = email, payload) => app.inject({url, method: payload ? 'POST' : 'GET', headers: {'cf-access-authenticated-user-email':user}, ...(payload ? {payload} : {})});
try {
 const a = (await call('/api/v0/tasks', email, {title:'Synthetic HTTP waiting'})).json().id;
 const b = (await call('/api/v0/tasks', email, {title:'Synthetic HTTP blocker'})).json().id;
 assert.equal((await call(`/api/v0/tasks/${a}/block`, email, {blockerId:b})).statusCode, 200);
 const r = await call(`/api/v0/tasks/${a}/waiting`); assert.equal(r.statusCode, 200);
 validate('Chain', r.json());
 assert.deepEqual(Object.keys(r.json()).sort(), ['declared','more','steps','task']);
 assert.equal(r.json().steps[0].blocker.id, b);
 assert.equal((await call(`/api/v0/tasks/${a}/waiting`, 'not-a-member@example.test')).statusCode, 404);
 assert.equal((await app.inject(`/api/v0/tasks/${a}/waiting`)).statusCode, 401);
 const list = (await call('/api/v0/me/blocked-on')).json(); validate('BlockedOn', list); assert.equal(list.rows[0].blocker.id, b);
 assert.equal((await call(`/api/v0/agents/${crypto.randomUUID()}/blocked-on`)).statusCode, 403);
 assert.equal((await call(`/api/v0/tasks/${a}/unblock`, email, {blockerId:b})).json().cleared, 1);
} finally { await app.close(); await pool.end(); }
'''
    env = {**os.environ, 'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '0',
           'TEST_API_CONFIG': json.dumps(cfg), 'TEST_MEMBER': team.editor_handle}
    run = subprocess.run(['node', '--input-type=module', '-e', script], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, capture_output=True, text=True, timeout=90)
    assert run.returncode == 0, (run.stderr + run.stdout)[-4000:]
