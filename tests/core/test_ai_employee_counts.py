"""AI totals stay separate from human HR figures and inside privileged views. Synthetic tenants only."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_agent_coworkers import make_agent

SCRIPT = r'''
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const result = {};
for (const role of ['admin', 'leadership', 'hr', 'staff', 'manager', 'accountant']) {
  result[role] = {};
  for (const path of ['hr/desk', 'leadership-week', 'insights', 'home', 'my-week']) {
    const r = await app.inject({url: `/api/v0/${path}`, headers: {'cf-access-authenticated-user-email': `${role}@counts.example.test`}});
    result[role][path] = {status: r.statusCode, body: r.json()};
  }
}
console.log('RESULT:' + JSON.stringify(result));
await app.close(); await pool.end();
'''


def snapshot(w):
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_ORG_ID': str(w.org)}
    p = subprocess.run(['node', '--input-type=module', '-e', SCRIPT],
                       cwd=Path(__file__).resolve().parents[2] / 'services/api',
                       env=env, capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr[-2000:]
    return json.loads(next(line[7:] for line in p.stdout.splitlines() if line.startswith('RESULT:')))


@pytest.mark.parametrize('attendance_enabled', [True, False])
def test_ai_count_is_separate_and_role_gated(worker, owner, api, attendance_enabled):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        for n, (person, role) in enumerate([(w.manager, 'admin'), (w.lead, 'hr'), (w.editor2, 'leadership'),
                             (w.editor, 'staff'), (uuid.uuid4(), 'manager'), (uuid.uuid4(), 'accountant')], start=1):
            if role in ('manager', 'accountant'):
                worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (person, w.org, f'Synthetic {role}'))
            worker.execute("insert into pulse.account(id,org_id,provider,handle,holder_person_id,purpose) values(%s,%s,'google',%s,%s,'Workspace account')",
                           (uuid.uuid4(), w.org, f'{role}@counts.example.test', person))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence,user_no,username) values(%s,%s,'Synthetic role','test',%s,%s)", (w.org, person, n, f'counts-user-{n}'))
            if role != 'staff':
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2026-01-01')", (w.org, person, role))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute('select pulse.hr_defaults()')
        owner.execute('update pulse.hr_policy set attendance_enabled=%s', (attendance_enabled,))
    before = snapshot(w)
    make_agent(api, w, username='synthetic-count-helper')
    after = snapshot(w)
    for role in ('admin', 'leadership', 'hr'):
        for path, key in [('hr/desk', 'counts'), ('home', 'people')]:
            assert before[role][path]['status'] == after[role][path]['status'] == 200
            b, a = before[role][path]['body'][key], after[role][path]['body'][key]
            assert b['ai'] == 0 and a['ai'] == 1
            assert {k: v for k, v in a.items() if k != 'ai'} == {k: v for k, v in b.items() if k != 'ai'}
            assert a['headcount'] == 6
        assert before[role]['home']['body']['attendance'] == after[role]['home']['body']['attendance']
        assert before[role]['home']['body']['leave'] == after[role]['home']['body']['leave']
    for role in ('admin', 'leadership'):
        for path in ('leadership-week', 'insights'):
            assert after[role][path]['status'] == 200
            b, a = before[role][path]['body']['people'], after[role][path]['body']['people']
            assert b['headcount'] == a['headcount'] == 6 and b['ai'] == 0 and a['ai'] == 1
    for role in ('staff', 'manager', 'accountant', 'hr'):
        for path in ('leadership-week', 'insights'):
            assert after[role][path]['status'] == 403
    for role in ('staff', 'manager', 'accountant'):
        assert after[role]['hr/desk']['status'] == 403
        for result in after[role].values():
            assert '"ai":' not in json.dumps(result['body'])
    # The shared summary must not leak the count through personal or pod views.
    for results in after.values():
        assert '"ai":' not in json.dumps(results['my-week']['body'])
