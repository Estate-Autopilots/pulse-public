"""Pulse Companion: pairing, the companion day, attendance from apps, office presence; disposable identities only."""
import json, os, subprocess, uuid
from pathlib import Path
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def test_companion_apps(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    roles = {r: uuid.uuid4() for r in ['person', 'outsider', 'hr', 'admin', 'leadership', 'manager', 'pgs', 'head_pgs']}
    with worker.transaction():
        set_tenant(worker, w.org)
        for role, pid in roles.items():
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, 'Synthetic ' + role))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence) values(%s,%s,%s,'Pod 1','{}')", (w.org, pid, role))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, role + '@companion.example', pid))
            if role in ['admin', 'hr', 'leadership', 'manager', 'pgs', 'head_pgs']:
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, pid, role))
    config = conninfo_to_dict(dsn('api')); config['database'] = config.pop('dbname')
    wc = conninfo_to_dict(dsn('migrate')); wc['database'] = wc.pop('dbname')
    nc = conninfo_to_dict(dsn('worker')); nc['database'] = nc.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_OWNER_CONFIG': json.dumps(wc), 'PULSE_ORG_ID': str(w.org),
           'TEST_WORKER_CONFIG': json.dumps(nc), 'TEST_ROLES': json.dumps({r: str(p) for r, p in roles.items()}), 'TEST_REPORT': str(tmp_path / 'companion.json')}
    result = subprocess.run(['node', 'test/companion-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, text=True, capture_output=True, timeout=180)
    assert result.returncode == 0, result.stdout + '\n' + result.stderr
    report = json.loads((tmp_path / 'companion.json').read_text())
    assert report['checks'] >= 60
    if os.environ.get('COMPANION_RECEIPT_DIR'):
        out = Path(os.environ['COMPANION_RECEIPT_DIR']); out.mkdir(parents=True, exist_ok=True)
        (out / 'companion-acceptance.json').write_text(json.dumps(report, indent=2))
