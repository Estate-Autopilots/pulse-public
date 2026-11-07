"""EST-1406 (0685): `tasks.read` and `people.read` on the install-local psvc_ boundary. Own tasks only, through the
EST-1396 (iss, sub) link; the directory is staff-only with an allowlisted shape. Synthetic only."""
import base64
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
from test_account_security import auth_world  # noqa: F401  (fixture)
from test_agent_coworkers import make_agent, owner_sql
from test_service_chat_post import DIGEST

ISS = 'https://accounts.google.com'
TASKS = 'select pulse.service_my_tasks(%s,%s,%s,%s) r'
PEOPLE = 'select pulse.service_people(%s,%s,%s,%s) r'
ITEM = {'id', 'title', 'status', 'dueAt', 'bucket', 'dueSoon', 'link'}
PERSON = {'id', 'name', 'workEmail', 'roles', 'teams', 'active', 'link'}
NOT_LINKED = {'error': 'person_not_linked'}


def call(api, w, sql, args):
    with api.transaction():
        set_tenant(api, w.org)
        return api.execute(sql, args).fetchone()['r']


def issue(api, scopes, agent=None):
    key = uuid.uuid4()
    api.execute("select pulse.service_key_manage('issue',%s,%s,%s,'Synthetic WAS',%s)", (key, DIGEST, scopes, agent))
    return key


def link(owner, w, person, sub, domain='example.test'):
    owner_sql(owner, w, 'insert into pulse_priv.google_identity(org_id,person_id,issuer,subject,email,domain) values(%s,%s,%s,%s,%s,%s)',
              (w.org, person, ISS, sub, f'{sub}@{domain}', domain))


def task(worker, w, person, title, status='open', due="now()+interval '3 days'", assignee='same', deleted=False):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute(f"""insert into pulse.task(org_id,title,owner_id,assignee_person_id,status,due_at,deleted_at)
            values(%s,%s,%s,%s,%s,{due},case when %s then now() end) returning id""",
                              (w.org, title, person, person if assignee == 'same' else assignee, status, deleted)).fetchone()['id']


@pytest.fixture
def was(api, worker, owner, auth_world):  # noqa: F811
    w = auth_world
    w.agent, _ = make_agent(api, w, 'was-app')
    owner_sql(owner, w, "insert into pulse_priv.google_settings(org_id,enabled,allowed_domains) values(%s,true,'{example.test}')", (w.org,))
    link(owner, w, w.editor, 'sub-editor')
    link(owner, w, w.editor2, 'sub-editor2')
    link(owner, w, w.manager, 'sub-manager', 'other.test')  # linked before its domain was removed
    w.key = issue(api, ['tasks.read', 'people.read'], w.agent)
    return w


@pytest.mark.parametrize('zone', ['Asia/Kolkata', 'Pacific/Honolulu'])
def test_own_tasks_only_with_due_buckets(api, worker, owner, was, zone):
    w = was
    owner_sql(owner, w, 'update pulse.org set time_zone=%s where id=%s', (zone, w.org))
    tz_start = "((now() at time zone pulse.org_time_zone())::date::timestamp at time zone pulse.org_time_zone())"
    tz_end = "(((now() at time zone pulse.org_time_zone())::date+1)::timestamp at time zone pulse.org_time_zone())"
    ids = {
        'overdue': task(worker, w, w.editor, 'Synthetic overdue', 'blocked', f"{tz_start}-interval '1 second'"),
        'earlier_today': task(worker, w, w.editor, 'Synthetic earlier today', due=tz_start),
        'today': task(worker, w, w.editor, 'Synthetic later today', 'in_progress', f'now()+({tz_end}-now())/2'),
        'soon': task(worker, w, w.editor, 'Synthetic within a day', 'in_review', "now()+interval '23 hours 59 minutes'"),
        'unknown_soon': task(worker, w, w.editor, 'Synthetic unknown soon', 'unknown', "now()+interval '23 hours 59 minutes 1 second'"),
        'later': task(worker, w, w.editor, 'Synthetic after a day', 'unknown', "now()+interval '24 hours 1 minute'"),
        'undated': task(worker, w, w.editor, 'Synthetic owner-only, no date', due='null', assignee=None),
    }
    for status, deleted in [('done', False), ('cancelled', False), ('accepted', False), ('open', True)]:
        task(worker, w, w.editor, f'Synthetic excluded {status}', status, deleted=deleted)
    task(worker, w, w.editor2, 'Synthetic other person')
    task(worker, w, w.editor, 'Synthetic handed on', assignee=w.editor2)  # owned by the editor, the assignee's task
    mine = call(api, w, TASKS, (w.key, DIGEST, ISS, 'sub-editor'))
    assert set(mine) == {'personId', 'generatedAt', 'items'} and mine['personId'] == str(w.editor)
    items = {i['id']: i for i in mine['items']}
    assert set(items) == {str(v) for v in ids.values()} and all(set(i) == ITEM for i in items.values())
    got = {k: items[str(v)] for k, v in ids.items()}
    assert [i['id'] for i in mine['items']] == [str(ids[k]) for k in ['overdue', 'earlier_today', 'today', 'soon', 'unknown_soon', 'later', 'undated']]
    want = {'overdue': ('overdue', False, 'blocked'), 'earlier_today': ('due_today', False, 'open'), 'today': ('due_today', True, 'in_progress'), 'soon': (got['soon']['bucket'], False, 'in_review'),
            'unknown_soon': (got['unknown_soon']['bucket'], False, 'open'), 'later': ('upcoming', False, 'open'), 'undated': ('no_due_date', False, 'open')}  # `unknown` shows as open
    assert {k: (g['bucket'], g['dueSoon'], g['status']) for k, g in got.items()} == want and got['undated']['dueAt'] is None
    assert all(i['link'] == '/tasks/' + i['id'] for i in items.values()) and got['today']['dueAt'].endswith('Z')
    other = call(api, w, TASKS, (w.key, DIGEST, ISS, 'sub-editor2'))
    assert other['personId'] == str(w.editor2) and {i['title'] for i in other['items']} == {'Synthetic other person', 'Synthetic handed on'}


def test_task_refusals(api, worker, owner, was):
    w, other = was, build_world(worker, owner, api)
    task(worker, other, other.editor, 'Synthetic other company')
    link(owner, other, other.editor, 'sub-other-company')
    assert call(api, w, TASKS, (w.key, DIGEST, ISS, 'sub-other-company')) == NOT_LINKED  # this install's company only
    for issuer, sub in [(ISS, 'sub-unknown'), (ISS, 'sub-manager'), ('https://evil.example', 'sub-editor'), (ISS, str(w.editor))]:
        assert call(api, w, TASKS, (w.key, DIGEST, issuer, sub)) == NOT_LINKED  # unlinked, domain removed, other issuer, guessed id
    owner_sql(owner, w, "update pulse.person set status='inactive' where id=%s", (w.editor2,))
    assert call(api, w, TASKS, (w.key, DIGEST, ISS, 'sub-editor2')) == NOT_LINKED
    owner_sql(owner, w, 'update pulse_priv.google_settings set enabled=false where org_id=%s', (w.org,))
    assert call(api, w, TASKS, (w.key, DIGEST, ISS, 'sub-editor')) == NOT_LINKED
    owner_sql(owner, w, 'update pulse_priv.google_settings set enabled=true where org_id=%s', (w.org,))
    people_only, legacy = issue(api, ['people.read'], w.agent), issue(api, ['clients.read'])
    revoked = issue(api, ['tasks.read'], w.agent)
    api.execute("select pulse.service_key_manage('revoke',%s)", (revoked,))
    for key, digest in [(people_only, DIGEST), (legacy, DIGEST), (revoked, DIGEST), (w.key, '0' * 64), (uuid.uuid4(), DIGEST)]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            call(api, w, TASKS, (key, digest, ISS, 'sub-editor'))
    assert call(api, w, TASKS, (w.key, DIGEST, ISS, 'sub-editor'))['personId'] == str(w.editor)
    for table, assignment, reset in [('agent_member', 'disabled_at=now()', 'disabled_at=null'), ('person', "status='inactive'", "status='active'")]:
        column = 'person_id' if table == 'agent_member' else 'id'
        owner_sql(owner, w, f'update pulse.{table} set {assignment} where {column}=%s', (w.agent,))
        for sql, args in [(TASKS, (w.key, DIGEST, ISS, 'sub-editor')), (PEOPLE, (w.key, DIGEST, None, 10))]:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                call(api, w, sql, args)
        owner_sql(owner, w, f'update pulse.{table} set {reset} where {column}=%s', (w.agent,))


def test_people_directory_allowlist(api, worker, owner, was):
    w, other = was, build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(org_id,display_name,side,status) values(%s,'Synthetic left','staff','offboarded'),(%s,'Synthetic client','client','active')", (w.org, w.org))
        closing, project_team = (worker.execute('insert into pulse.unit(org_id,kind,name) values(%s,%s,%s) returning id', (w.org, kind, name)).fetchone()['id']
                                 for kind, name in [('team', 'Before closing'), ('project_team', 'Synthetic project team')])
        for unit, until in [(closing, None), (project_team, None), (w.pod, '2026-01-02')]:
            worker.execute("insert into pulse.role_assignment(org_id,person_id,unit_id,role_key,valid_from,valid_to) values(%s,%s,%s,'member','2026-01-01',%s)", (w.org, w.lead, unit, until))
    owner_sql(owner, w, "update pulse.role_assignment set valid_to='2026-01-02' where person_id=%s and unit_id=%s and role_key='pgs'", (w.lead, w.pod))
    owner_sql(owner, w, "update pulse.person set status='inactive' where id=%s", (w.editor2,))
    owner_sql(owner, w, "insert into pulse_priv.person_private(person_id,org_id,work_email) values(%s,%s,'editor.one@example.test')", (w.editor, w.org))
    seen, page = [], {'nextCursor': None}
    while page['nextCursor'] or not seen:
        page = call(api, w, PEOPLE, (w.key, DIGEST, base64.urlsafe_b64decode(page['nextCursor']).decode() if page['nextCursor'] else None, 2))
        assert set(page) == {'items', 'nextCursor'} and len(page['items']) <= 2
        seen += page['items']
    people = {p['id']: p for p in seen}
    assert [p['id'] for p in seen] == sorted(people) and all(set(p) == PERSON for p in seen)
    assert set(people) == {str(x) for x in [w.editor, w.editor2, w.lead, w.manager]}  # no AI, client, offboarded or other company
    editor2, lead, manager = (people[str(x)] for x in [w.editor2, w.lead, w.manager])
    assert people[str(w.editor)] == {'id': str(w.editor), 'name': 'Editor One', 'workEmail': 'editor.one@example.test', 'roles': [],
                      'teams': [{'id': str(w.pod), 'name': 'Pod 1'}], 'active': True, 'link': f'/people/{w.editor}'}
    assert editor2['active'] is False and editor2['workEmail'] is None
    assert sorted(manager['roles']) == ['admin', 'head_pgs'] and lead['roles'] == []
    assert lead['teams'] == [{'id': str(closing), 'name': 'Before closing'}]
    for key in [issue(api, ['tasks.read'], w.agent), issue(api, ['clients.read'])]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            call(api, w, PEOPLE, (key, DIGEST, None, 10))
    assert call(api, other, PEOPLE, (w.key, DIGEST, None, 200))['items'] == seen  # always this install's company


def test_http_and_proxy(api, worker, owner, was):
    task(worker, was, was.editor, 'Synthetic token task')
    config = {('database' if k == 'dbname' else k): v for k, v in conninfo_to_dict(dsn('api')).items()}
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_AGENT': str(was.agent),
           'TEST_PEOPLE': json.dumps([str(x) for x in [was.editor, was.editor2, was.lead, was.manager]])}
    result = subprocess.run(['node', 'test/service-tasks-people-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api',
                            env=env, capture_output=True, text=True, timeout=90, check=False)
    assert result.returncode == 0 and 'SERVICE_TASKS_PEOPLE ok' in result.stdout, result.stdout + result.stderr
