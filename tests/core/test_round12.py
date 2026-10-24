"""Round 12 release fixture: synthetic tenants and provider payloads only."""
import json
import os
import subprocess
import uuid
from pathlib import Path
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def test_round12_acquisition_pipeline(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    client, client_b, project_b = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    roles = {r: uuid.uuid4() for r in ['person', 'outsider', 'manager', 'pgs', 'hr', 'leadership', 'admin']}
    with worker.transaction():
        set_tenant(worker, w.org)
        for role, pid in roles.items():
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid,w.org,'Synthetic '+role))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence) values(%s,%s,%s,'Pod 1','{}')",(w.org,pid,role))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",(w.org,role+'@round12.example',pid))
            if role not in ['person', 'outsider']:
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,unit_id,valid_from) values(%s,%s,%s,%s,'2020-01-01')",(w.org,pid,role,w.pod if role in ['manager','pgs'] else None))
        worker.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'Synthetic controller A')",(client,w.org))
        worker.execute('update pulse.project set unit_id=%s,client_id=%s where id=%s',(w.pod,client,w.project))
        worker.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'Synthetic controller B')",(client_b,w.org))
        worker.execute("insert into pulse.project(id,org_id,name,title,client_id,registry_no) values(%s,%s,'Synthetic B','Synthetic B',%s,99998)",(project_b,w.org,client_b))
    config = conninfo_to_dict(dsn('api'));config['database']=config.pop('dbname')
    env={**os.environ,'TEST_API_CONFIG':json.dumps(config),'PULSE_ORG_ID':str(w.org),'TEST_PROJECT':str(w.project),'TEST_PROJECT_B':str(project_b),'TEST_CLIENT':str(client),'TEST_CLIENT_B':str(client_b),'TEST_ROLES':json.dumps({r:str(p) for r,p in roles.items()}),'TEST_REPORT':str(tmp_path/'round12.json'),'PULSE_ACQUISITION_IDENTITY_KEYS':json.dumps([{'version':'v1','key':'a'*64}]),'PULSE_FINANCE_SCANNER_SECRET':'synthetic-test-scanner'}
    result=subprocess.run(['node','test/round12-runner.mjs'],cwd=Path(__file__).resolve().parents[2]/'services/api',env=env,text=True,capture_output=True,timeout=180)
    assert result.returncode == 0,result.stdout+'\n'+result.stderr
    report=json.loads((tmp_path/'round12.json').read_text())
    assert report['checks']>=50
    if os.environ.get('ROUND12_RECEIPT_DIR'):
        out=Path(os.environ['ROUND12_RECEIPT_DIR']);out.mkdir(parents=True,exist_ok=True)
        (out/'synthetic-acceptance.json').write_text(json.dumps(report,indent=2))
