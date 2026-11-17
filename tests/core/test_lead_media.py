"""Private lead-photo contract through real PostgreSQL/RLS and Fastify; synthetic tenants only."""
import base64
import json
import os
import subprocess
import uuid
from pathlib import Path

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def test_lead_media(worker, owner, api, tmp_path):
    first, other = build_world(worker, owner, api), build_world(worker, owner, api)
    leads = []
    for w in [first, other]:
        with owner.transaction():
            set_tenant(owner, w.org)
            owner.execute('update pulse.project set unit_id=%s where id=%s', (w.pod, w.project))
            for who in [w.editor, w.editor2]:
                owner.execute("insert into pulse.task(org_id,project_id,title,owner_id,assignee_person_id,status,source) values(%s,%s,'Synthetic scope',%s,%s,'open','pulse')", (w.org, w.project, who, who))
            for name, who in [('owner', w.editor), ('peer', w.editor2), ('manager', w.manager)]:
                owner.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence) values(%s,%s,%s,'Pod 1','{}') on conflict do nothing", (w.org, who, 'manager' if name == 'manager' else 'video_editor'))
                owner.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f'{name}@{w.domain}', who))
            hr = uuid.uuid4()
            owner.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic HR','staff')", (hr, w.org))
            owner.execute("insert into pulse.people_profile(org_id,person_id,role,evidence) values(%s,%s,'hr','{}')", (w.org, hr))
            owner.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'hr','2020-01-01')", (w.org, hr))
            owner.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f'hr@{w.domain}', hr))
            source, subject = uuid.uuid4(), uuid.uuid4()
            owner.execute("insert into pulse_priv.acq_source(id,org_id,controller,project_id,path,kind,account,purpose,owner_id,label) values(%s,%s,%s,%s,'agency','manual','synthetic','lead',%s,'Synthetic source')", (source, w.org, w.org, w.project, w.editor))
            owner.execute("insert into pulse_priv.acq_subject(id,org_id,controller,path) values(%s,%s,%s,'agency')", (subject, w.org, w.org))
            for n in range(2):
                lead = uuid.uuid4()
                owner.execute("insert into pulse_priv.acq_enquiry(id,org_id,controller,path,project_id,subject_id,source_id,namespace,external_id,occurred,owner_id,body) values(%s,%s,%s,'agency',%s,%s,%s,'synthetic',%s,now(),%s,'{}')", (lead, w.org, w.org, w.project, subject, source, str(n), w.editor if n == 0 else w.editor2))
                leads.append(str(lead))
    keyfile = tmp_path / 'photo.key'
    keyfile.write_text('synthetic ' + base64.b64encode(os.urandom(32)).decode() + '\n')
    keyfile.chmod(0o600)
    env = {**os.environ, 'PULSE_PUBLIC_LOGIN_ENABLED': '0', 'PULSE_DOCUMENT_KEY_FILE': str(keyfile),
           'TEST_IDS': json.dumps({'org': str(first.org), 'other': str(other.org), 'domain': first.domain, 'leads': leads, 'person': str(first.editor)})}
    for role, key in [('api', 'TEST_API_CONFIG'), ('migrate', 'TEST_OWNER_CONFIG')]:
        cfg = conninfo_to_dict(dsn(role))
        cfg['database'] = cfg.pop('dbname')
        env[key] = json.dumps(cfg)
    result = subprocess.run(['node', 'test/lead-media-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, text=True, capture_output=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
