"""Round 11 delivery and portal acceptance; disposable tenant only."""
import json
import os
import subprocess
import uuid
from pathlib import Path
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def test_round11_delivery_portal(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    client, client_b, project_b = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    asset, va, vb = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    roles = {r: uuid.uuid4() for r in ['person', 'reviewer', 'manager', 'pgs', 'hr', 'leadership', 'admin']}
    with worker.transaction():
        set_tenant(worker, w.org)
        for role, pid in roles.items():
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, 'Synthetic '+role))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence) values(%s,%s,%s,'Pod 1','{}')", (w.org, pid, role))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, role+'@round11.example', pid))
            if role not in ['person', 'reviewer']:
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,unit_id,valid_from) values(%s,%s,%s,%s,'2020-01-01')", (w.org,pid,role,w.pod if role in ['manager', 'pgs'] else None))
        worker.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'Synthetic client')",(client,w.org))
        worker.execute('update pulse.project set unit_id=%s,client_id=%s where id=%s', (w.pod,client,w.project))
        worker.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'Synthetic client B')", (client_b,w.org))
        worker.execute("insert into pulse.project(id,org_id,name,title,client_id,unit_id,registry_no) values(%s,%s,'Synthetic project B','Synthetic project B',%s,%s,99999)", (project_b,w.org,client_b,w.pod))
        worker.execute("insert into pulse.asset(id,org_id,project_id,legacy_key,deliverable_type,first_seq) values(%s,%s,%s,%s,'video',1)", (asset,w.org,w.project,'synthetic:'+str(asset)))
        for number, ver in enumerate([va,vb],1):
            worker.execute("insert into pulse.version(id,org_id,asset_id,version_no,kind,created_at,creator_person_id) values(%s,%s,%s,%s,'final',now(),%s)", (ver,w.org,asset,number,roles['person']))
    config = conninfo_to_dict(dsn('api')); config['database'] = config.pop('dbname')
    wc = conninfo_to_dict(dsn('worker')); wc['database'] = wc.pop('dbname')
    env = {**os.environ,'TEST_API_CONFIG':json.dumps(config),'TEST_WORKER_CONFIG':json.dumps(wc),'PULSE_ORG_ID':str(w.org),'TEST_PROJECT':str(w.project),'TEST_CLIENT':str(client),'TEST_PROJECT_B':str(project_b),'PULSE_REVIEW_MEDIA_ROOT':str(tmp_path/'media'),'TEST_VERSION_A':str(va),'TEST_VERSION_B':str(vb),'TEST_ROLES':json.dumps({r:str(p) for r,p in roles.items()}),'TEST_REPORT':str(tmp_path/'round11.json')}
    result = subprocess.run(['node','test/round11-runner.mjs'],cwd=Path(__file__).resolve().parents[2]/'services/api',env=env,text=True,capture_output=True,timeout=180)
    assert result.returncode == 0, result.stdout+'\n'+result.stderr
    report=json.loads((tmp_path/'round11.json').read_text())
    assert report['checks']>=30
    if os.environ.get('ROUND11_RECEIPT_DIR'):
        out=Path(os.environ['ROUND11_RECEIPT_DIR']); out.mkdir(parents=True,exist_ok=True)
        (out/'synthetic-acceptance.json').write_text(json.dumps(report,indent=2))
