"""Round 9 authorized synthetic end-to-end: review receipts, frozen briefs and reviewed client merges."""
import json
import os
import subprocess
import uuid
from pathlib import Path

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def config(role):
    c = conninfo_to_dict(dsn(role))
    c['database'] = c.pop('dbname')
    return c


def test_round9_authorization_replay_and_identity_workflow(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    roles = {r: uuid.uuid4() for r in ['person', 'manager', 'pgs', 'hr', 'leadership', 'admin']}
    with worker.transaction():
        set_tenant(worker, w.org)
        for role, pid in roles.items():
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid,w.org,'Synthetic '+role))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence) values(%s,%s,%s,'Pod 1','{}')",(w.org,pid,role))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",(w.org,role+'@round9.example',pid))
            if role != 'person':
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,unit_id,valid_from) values(%s,%s,%s,%s,'2020-01-01')",(w.org,pid,role,w.pod if role in ['manager','pgs'] else None))
        worker.execute('update pulse.project set unit_id=%s where id=%s',(w.pod,w.project))
        worker.execute("insert into pulse.task(org_id,title,status,owner_id,review_owner_id,review_due_at,review_calendar,review_work_days,source,project_id) values(%s,'Synthetic overdue review','in_review',%s,%s,now()-interval '4 days','Asia/Kolkata','{1,2,3,4,5}','pulse',%s)",(w.org,roles['person'],roles['person'],w.project))
        worker.execute("insert into pulse.task(org_id,title,status,owner_id,review_owner_id,review_due_at,source) values(%s,'Synthetic outside scope','in_review',%s,%s,now()-interval '4 days','pulse')",(w.org,w.editor2,w.editor2))
    env={**os.environ,'TEST_API_CONFIG':json.dumps(config('api')),'TEST_WORKER_CONFIG':json.dumps(config('worker')),'TEST_ROLES':json.dumps({r:str(p) for r,p in roles.items()}),'PULSE_ORG_ID':str(w.org),'TEST_PROJECT':str(w.project),'TEST_REPORT':str(tmp_path/'round9.json')}
    root=Path(__file__).resolve().parents[2]
    result=subprocess.run(['node','test/round9-runner.mjs'],cwd=root/'services/api',env=env,text=True,capture_output=True,timeout=180)
    assert result.returncode==0,result.stdout+'\n'+result.stderr
    report=json.loads((tmp_path/'round9.json').read_text())
    assert report['checks']>=70
    receipt_dir=os.environ.get('ROUND9_RECEIPT_DIR')
    if receipt_dir:
        Path(receipt_dir).mkdir(parents=True,exist_ok=True)
        (Path(receipt_dir)/'synthetic-acceptance.json').write_text(json.dumps(report,indent=2))
