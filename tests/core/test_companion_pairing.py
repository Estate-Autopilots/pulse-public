"""EST-658: native/about names the company; optional admin approval of new devices, kept inside each organisation."""
import json, os, subprocess, uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def _people(worker, w, names, domain):
    ids = {r: uuid.uuid4() for r in names}
    with worker.transaction():
        set_tenant(worker, w.org)
        for role, pid in ids.items():
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, 'Synthetic pairing ' + role))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence) values(%s,%s,%s,'Pod 1','{}')", (w.org, pid, role))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f'{role}@{domain}', pid))
            if role in ('admin', 'hr'):
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, pid, role))
    return ids


def test_admin_approval_api(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    roles = _people(worker, w, ['person', 'other', 'hr', 'admin'], 'pairing.example')
    config = conninfo_to_dict(dsn('api')); config['database'] = config.pop('dbname')
    wc = conninfo_to_dict(dsn('migrate')); wc['database'] = wc.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_OWNER_CONFIG': json.dumps(wc), 'PULSE_ORG_ID': str(w.org),
           'TEST_ORG_NAME': f'Synthetic {w.code}', 'TEST_ROLES': json.dumps({r: str(p) for r, p in roles.items()}),
           'TEST_REPORT': str(tmp_path / 'pairing.json')}
    result = subprocess.run(['node', 'test/companion-pairing-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, text=True, capture_output=True, timeout=180)
    assert result.returncode == 0, result.stdout + '\n' + result.stderr
    assert json.loads((tmp_path / 'pairing.json').read_text())['checks'] >= 30


def test_admin_cannot_see_or_decide_another_orgs_requests(worker, owner, api):
    a, b = build_world(worker, owner, api), build_world(worker, owner, api)
    admin_a = _people(worker, a, ['admin'], f'{a.code.lower()}.example')['admin']
    b_people = _people(worker, b, ['admin', 'person'], f'{b.code.lower()}.example')
    with owner.transaction():
        set_tenant(owner, b.org)
        owner.execute("""insert into pulse_priv.native_pair(org_id,code,poll_hash,platform,name,status,person_id,decided_at,expires_at)
                         values(%s,'BBBB-CCCC',repeat('a',64),'windows','Synthetic B laptop','awaiting_admin',%s,now(),now()+interval '24 hours')""",
                      (b.org, b_people['person']))
    with api.transaction():
        set_tenant(api, a.org, admin_a)
        assert api.execute("select pulse.native_pair_awaiting() d").fetchone()['d'] == []
    # A's admin finds no such request; B's admin in A's tenant is not an admin there.
    for viewer, error in ((admin_a, psycopg.errors.NoDataFound), (b_people['admin'], psycopg.errors.InsufficientPrivilege)):
        with pytest.raises(error), api.transaction():
            set_tenant(api, a.org, viewer)
            api.execute("select pulse.native_pair_admin_decide('BBBB-CCCC',true)")
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, a.org, b_people['admin'])
        api.execute("select pulse.native_pair_awaiting()")
    with api.transaction():
        set_tenant(api, b.org, b_people['admin'])
        assert 'BBBB-CCCC' in json.dumps(api.execute("select pulse.native_pair_awaiting() d").fetchone())
    with owner.transaction():
        set_tenant(owner, b.org)
        assert owner.execute("select status,device_id from pulse_priv.native_pair where code='BBBB-CCCC'").fetchone() == \
            {'status': 'awaiting_admin', 'device_id': None}
