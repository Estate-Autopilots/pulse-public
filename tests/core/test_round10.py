"""Round 10 synthetic certification in disposable PostgreSQL, never organizational amounts."""
import json
import os
import subprocess
import uuid
from pathlib import Path

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def test_round10_certification_and_replay(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    roles = {role: uuid.uuid4() for role in ['person', 'leadership', 'admin']}
    with worker.transaction():
        set_tenant(worker, w.org)
        for role, pid in roles.items():
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, 'Synthetic '+role))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence) values(%s,%s,%s,'Pod 1','{}')", (w.org, pid, role))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, role+'@round10.example', pid))
            if role != 'person':
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, pid, role))
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_ORG_ID': str(w.org), 'TEST_REPORT': str(tmp_path/'round10.json')}
    result = subprocess.run(['node','test/round10-runner.mjs'], cwd=Path(__file__).resolve().parents[2]/'services/api', env=env, text=True, capture_output=True, timeout=180, check=False)
    assert result.returncode == 0, result.stdout+'\n'+result.stderr
    report = json.loads((tmp_path/'round10.json').read_text())
    assert report['checks'] >= 50
    if os.environ.get('ROUND10_RECEIPT_DIR'):
        out = Path(os.environ['ROUND10_RECEIPT_DIR']); out.mkdir(parents=True, exist_ok=True)
        (out/'synthetic-acceptance.json').write_text(json.dumps(report, indent=2))
