"""EST-2551: HQ identity, brand writes, safe links and a second tenant, on PostgreSQL 17."""
import json
import os
import subprocess
from pathlib import Path

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def test_hq_identity(worker, owner, api, tmp_path):
    first = build_world(worker, owner, api)
    second = build_world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, first.org)
        owner.execute("update pulse.org set name='Synthetic Studio' where id=%s", (first.org,))
        owner.execute("update pulse.account set purpose='Workspace account' where org_id=%s and holder_person_id=%s", (first.org, first.editor))
        owner.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence) values(%s,%s,'person','Pod 1','{}') on conflict do nothing", (first.org, first.editor))
        owner.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (first.org, first.editor))
    with owner.transaction():
        set_tenant(owner, second.org)
        owner.execute("update pulse.org set name='Pulse' where id=%s", (second.org,))
        owner.execute("insert into pulse.hq_brand(org_id,body) values(%s,'{\"title\":\"Other tenant HQ\"}')", (second.org,))
        owner.execute("insert into pulse.hq_feature(org_id,key,category,name) values(%s,'other-tenant','work','Other feature')", (second.org,))
    env = {**os.environ, 'PULSE_ORG_ID': str(first.org), 'TEST_OTHER_ORG': str(second.org),
           'TEST_EMAIL': first.editor_handle, 'TEST_REPORT': str(tmp_path / 'hq.json')}
    for role, key in [('api', 'TEST_API_CONFIG'), ('migrate', 'TEST_OWNER_CONFIG')]:
        config = conninfo_to_dict(dsn(role))
        config['database'] = config.pop('dbname')
        env[key] = json.dumps(config)
    result = subprocess.run(['node', 'test/hq-identity-runner.mjs'],
                            cwd=Path(__file__).resolve().parents[2] / 'services/api',
                            env=env, text=True, capture_output=True, timeout=180)
    assert result.returncode == 0, result.stdout + '\n' + result.stderr
    assert json.loads((tmp_path / 'hq.json').read_text())['ok'] is True
