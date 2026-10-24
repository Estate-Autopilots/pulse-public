"""Small synthetic membership/key fixture reused by v1 work, chat and search adapters."""
import hashlib
import secrets
import uuid

from psycopg.types.json import Jsonb
from test_agent_coworkers import make_agent, owner_sql
from test_tasks_rt1 import new_task, one


def work_fixture(api, owner, w, *, app_key=True):
    agent, _ = make_agent(api, w, 'v1-work-agent')
    freelancer = uuid.uuid4()
    owner_sql(owner, w, "insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic freelance editor','freelancer')", (freelancer, w.org))
    projects, tasks = [], []
    for index in range(3):
        pid = one(api, w, w.manager, 'select pulse.work_project_save(null,%s) r',
                  (Jsonb({'type': 'internal', 'name': f'Synthetic project {index}'}),))['r']['id']
        projects.append(pid)
        for n in range(2):
            if index == 0 and n == 0:
                # Construct an imported row; source updates must not override a manually locked assignee.
                task = owner_sql(owner, w, "insert into pulse.task(org_id,title,project_id,owner_id,assignee_person_id,source) values(%s,'Synthetic freelance task',%s,%s,%s,'imported') returning id", (w.org, pid, freelancer, freelancer))[0]['id']
            else:
                task = new_task(api, w, w.manager, title=f'Synthetic task {index}-{n}', projectId=pid)
            tasks.append(str(task))
        if index < 2:
            owner_sql(owner, w, 'insert into pulse.project_member(org_id,project_id,person_id,role) values(%s,%s,%s,\'member\')', (w.org, pid, agent))
    keys = {}
    for name, scopes in [('ai', ['tasks.read', 'projects.read']), ('ai2', ['tasks.read', 'projects.read']), ('writeOnly', ['tasks.write']), ('writer', ['tasks.read', 'tasks.write', 'projects.read', 'projects.write'])]:
        keys[name] = one(api, w, w.manager, 'select pulse.agent_key_issue(%s,%s,30,%s) k', (agent, name, scopes))['k']
    if app_key:  # Connected-app keys belong to this install; the second tenant exercises its AI key only.
        kid, secret = uuid.uuid4(), secrets.token_urlsafe(32)
        one(api, w, w.manager, "select pulse.service_key_manage('issue',%s,%s,%s,'Synthetic work app',%s)",
            (kid, hashlib.sha256(secret.encode()).hexdigest(), ['tasks.read', 'tasks.write', 'projects.read', 'projects.write'], agent))
        keys['app'] = f'psvc_{kid}_{secret}'
    email = f'v1-staff@{w.domain}'
    owner_sql(owner, w, "insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, email, w.manager))
    return {'agent': str(agent), 'freelancer': str(freelancer), 'projects': projects, 'tasks': tasks, 'keys': keys, 'staffEmail': email,
            'org': str(w.org), 'staff': str(w.manager), 'member': str(w.editor), 'outsider': str(getattr(w, 'outsider', w.editor2))}
