"""One install-local quote-agent journey through real HTTP handlers and synthetic PostgreSQL."""
import json
import os
import re
import subprocess
import uuid
from pathlib import Path

from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_erp_invoice import erp  # noqa: F401


def test_service_flow(worker, owner, api, erp):  # noqa: F811
    w = erp
    item, lead, source, subject = [uuid.uuid4() for _ in range(4)]
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.client set relationship_owner_id=%s,phone='+919999999999',email='private-flow@example.invalid' where id=%s", (w.editor, w.client))
        worker.execute("insert into pulse.erp_item(id,org_id,kind,name,price,gst_rate,status) values(%s,%s,'service','Synthetic flow item',10000,18,'active')", (item, w.org))
        for person, handle in [(w.editor, 'salesperson'), (w.member, 'other')]:
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f'{handle}@{w.domain}', person))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse_priv.acq_source(id,org_id,controller,project_id,path,kind,account,purpose,owner_id,label) values(%s,%s,%s,%s,'buyer','manual','synthetic','lead',%s,'Synthetic flow')", (source, w.org, w.org, w.project, w.editor))
        owner.execute("insert into pulse_priv.acq_subject(id,org_id,controller,path,contact) values(%s,%s,%s,'buyer','{\"phone\":\"+919999999999\",\"email\":\"private-flow@example.invalid\"}')", (subject, w.org, w.org))
        owner.execute("insert into pulse_priv.acq_enquiry(id,org_id,controller,path,project_id,subject_id,source_id,namespace,external_id,occurred,owner_id,body) values(%s,%s,%s,'buyer',%s,%s,%s,'synthetic','flow-lead',now(),%s,'{}')", (lead, w.org, w.org, w.project, subject, source, w.editor))
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '0',
           'TEST_API_CONFIG': json.dumps(config),
           'TEST_IDS': json.dumps({'item': str(item), 'client': str(w.client), 'lead': str(lead),
                                   'salesperson': str(w.editor), 'domain': w.domain}),
           'PULSE_OPERATOR_TOKEN': 'synthetic-flow-operator-' + '0' * 32}
    result = subprocess.run(['node', 'test/service-flow-runner.mjs'],
                            cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env,
                            capture_output=True, text=True, timeout=90)
    output = result.stdout + result.stderr
    assert not re.search(r'psvc_[\w-]+_[\w-]{43}|\b[0-9a-f]{64}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|9999999999', output), 'runner output leaked private data'
    assert result.returncode == 0, output
    made = json.loads(next(line.removeprefix('FLOW ') for line in result.stdout.splitlines() if line.startswith('FLOW ')))
    with owner.transaction():
        set_tenant(owner, w.org)
        notices = owner.execute("select id,person_id,subject_id,title from pulse.notification where event_type='quote_ready'").fetchall()
        assert len(notices) == 1
        assert notices[0]['person_id'] == w.editor and str(notices[0]['subject_id']) == made['quote']
        assert 'owner approval needed' in notices[0]['title']
        recipients = owner.execute('select person_id from pulse.hr_mail_outbox where notification_id=%s', (notices[0]['id'],)).fetchall()
        assert recipients == [{'person_id': w.editor}]
        provenance = owner.execute('select status,service_key_id,owner_approval,source_ref from pulse.erp_document where id=%s', (made['quote'],)).fetchone()
        assert provenance == {'status': 'draft', 'service_key_id': uuid.UUID(made['keyId']),
                              'owner_approval': 'needed', 'source_ref': 'synthetic-flow-source'}
