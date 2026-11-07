"""EST-647/648 module switches: /api/v0/me reads the tenant/modules config document and an off module's routes answer
404; synthetic only."""
import json, os, subprocess, uuid
from pathlib import Path
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def test_me_modules(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    pid = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic person','staff')", (pid, w.org))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence) values(%s,%s,'person','Pod 1','{}')", (w.org, pid))
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google','person@modules.example',%s,'Workspace account')", (w.org, pid))
    config = conninfo_to_dict(dsn('api')); config['database'] = config.pop('dbname')
    wc = conninfo_to_dict(dsn('migrate')); wc['database'] = wc.pop('dbname')
    kc = conninfo_to_dict(dsn('worker')); kc['database'] = kc.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_OWNER_CONFIG': json.dumps(wc), 'TEST_WORKER_CONFIG': json.dumps(kc), 'PULSE_ORG_ID': str(w.org),
           'TEST_REPORT': str(tmp_path / 'modules.json')}
    result = subprocess.run(['node', 'test/modules-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, text=True, capture_output=True, timeout=180)
    assert result.returncode == 0, result.stdout + '\n' + result.stderr
    assert json.loads((tmp_path / 'modules.json').read_text())['checks'] == 9
