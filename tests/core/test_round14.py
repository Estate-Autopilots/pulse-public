"""Native binding, permission and reordered offline intake; disposable identities only."""
import json,os,subprocess,uuid
from pathlib import Path
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant

def test_round14_native_trust(worker,owner,api,tmp_path):
    w=build_world(worker,owner,api)
    roles={r:uuid.uuid4() for r in ['person','outsider','manager','admin']}
    with worker.transaction():
        set_tenant(worker,w.org)
        for role,pid in roles.items():
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')",(pid,w.org,'Synthetic '+role))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence) values(%s,%s,%s,'Pod 1','{}')",(w.org,pid,role))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",(w.org,role+'@round14.example',pid))
            if role in ['admin','manager']:
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,unit_id,valid_from) values(%s,%s,%s,%s,'2020-01-01')",(w.org,pid,role,w.pod if role=='manager' else None))
        worker.execute("insert into pulse.task(org_id,project_id,title,owner_id,status,source) values(%s,%s,'Synthetic authorized shoot',%s,'open','pulse')",(w.org,w.project,roles['person']))
    config=conninfo_to_dict(dsn('api'));config['database']=config.pop('dbname')
    wc=conninfo_to_dict(dsn('migrate'));wc['database']=wc.pop('dbname')
    env={**os.environ,'TEST_API_CONFIG':json.dumps(config),'TEST_OWNER_CONFIG':json.dumps(wc),'PULSE_ORG_ID':str(w.org),'TEST_PROJECT':str(w.project),'TEST_ROLES':json.dumps({r:str(p) for r,p in roles.items()}),'TEST_REPORT':str(tmp_path/'round14.json')}
    result=subprocess.run(['node','test/round14-runner.mjs'],cwd=Path(__file__).resolve().parents[2]/'services/api',env=env,text=True,capture_output=True,timeout=180)
    assert result.returncode==0,result.stdout+'\n'+result.stderr
    report=json.loads((tmp_path/'round14.json').read_text());assert report['checks']>=35
    if os.environ.get('ROUND14_RECEIPT_DIR'):
        out=Path(os.environ['ROUND14_RECEIPT_DIR']);out.mkdir(parents=True,exist_ok=True);(out/'synthetic-acceptance.json').write_text(json.dumps(report,indent=2))
