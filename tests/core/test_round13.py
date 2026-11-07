"""Fair credit, corrections, publication and learning on a disposable tenant."""
import json
import os
import subprocess
import uuid
from pathlib import Path
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def test_round13_fair_work(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    roles = {r: uuid.uuid4() for r in ['person', 'outsider', 'reviewer', 'manager', 'hr', 'leadership', 'admin']}
    versions, families = [], []
    device = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        for role, pid in roles.items():
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid,w.org,'Synthetic '+role))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence) values(%s,%s,%s,'Pod 1','{}')",(w.org,pid,role))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",(w.org,role+'@round13.example',pid))
            if role in ['manager', 'hr', 'leadership', 'admin']:
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,unit_id,valid_from) values(%s,%s,%s,%s,'2020-01-01')",(w.org,pid,role,w.pod if role=='manager' else None))
        worker.execute("insert into pulse.device(id,org_id,default_person_id,platform,label,public_key) values(%s,%s,%s,'linux','Synthetic device','test-only')",(device,w.org,roles['person']))
        worker.execute('update pulse.project set unit_id=%s where id=%s',(w.pod,w.project))
        for i in range(6):
            asset, ver = uuid.uuid4(), uuid.uuid4()
            worker.execute("insert into pulse.asset(id,org_id,project_id,legacy_key,deliverable_type,first_seq) values(%s,%s,%s,%s,'video',1)",(asset,w.org,w.project,'synthetic:'+str(asset)))
            worker.execute("insert into pulse.version(id,org_id,asset_id,version_no,kind,created_at,creator_person_id) values(%s,%s,%s,1,'final',now(),%s)",(ver,w.org,asset,roles['person']))
            versions.append(str(ver)); families.append(str(w.project)+':'+str(asset))
    config = conninfo_to_dict(dsn('api'));config['database']=config.pop('dbname')
    wc = conninfo_to_dict(dsn('migrate'));wc['database']=wc.pop('dbname')
    env={**os.environ,'TEST_API_CONFIG':json.dumps(config),'TEST_OWNER_CONFIG':json.dumps(wc),'PULSE_ORG_ID':str(w.org),'TEST_DEVICE':str(device),'TEST_PROJECT':str(w.project),'TEST_ROLES':json.dumps({r:str(p) for r,p in roles.items()}),'TEST_VERSIONS':json.dumps(versions),'TEST_FAMILIES':json.dumps(families),'TEST_REPORT':str(tmp_path/'round13.json')}
    result=subprocess.run(['node','test/round13-runner.mjs'],cwd=Path(__file__).resolve().parents[2]/'services/api',env=env,text=True,capture_output=True,timeout=180)
    assert result.returncode == 0,result.stdout+'\n'+result.stderr
    report=json.loads((tmp_path/'round13.json').read_text())
    assert report['checks']>=50
    if os.environ.get('ROUND13_RECEIPT_DIR'):
        out=Path(os.environ['ROUND13_RECEIPT_DIR']);out.mkdir(parents=True,exist_ok=True)
        (out/'synthetic-acceptance.json').write_text(json.dumps(report,indent=2))
