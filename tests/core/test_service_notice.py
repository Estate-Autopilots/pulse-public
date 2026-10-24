"""Quote-ready delivery, projection permissions and unnamed-lead privacy on synthetic tenants."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_erp_invoice import draft, erp, one, person, setup_company  # noqa: F401


def test_service_notice(worker, owner, api, erp):  # noqa: F811
    w = erp
    other = build_world(worker, owner, api)
    other.finance = person(worker, other, 'Synthetic Other Finance', 'finance')
    setup_company(api, other, other.finance)
    foreign = draft(api, other, other.finance, 'quotation')
    staff_doc = draft(api, w, w.finance, 'quotation')
    invoice = draft(api, w, w.finance)
    item, lead, subject, source = [uuid.uuid4() for _ in range(4)]
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute('update pulse.client set relationship_owner_id=%s where id=%s', (w.editor, w.client))
        worker.execute("insert into pulse.erp_item(id,org_id,kind,name,price,gst_rate,status) values(%s,%s,'service','Synthetic item',10000,18,'active')", (item, w.org))
        for pid, handle in [(w.editor, 'salesperson'), (w.member, 'other'), (w.finance, 'finance')]:
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f'{handle}@{w.domain}', pid))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse_priv.acq_source(id,org_id,controller,project_id,path,kind,account,purpose,owner_id,label) values(%s,%s,%s,%s,'buyer','manual','synthetic','lead',%s,'Synthetic')", (source, w.org, w.org, w.project, w.editor))
        owner.execute("insert into pulse_priv.acq_subject(id,org_id,controller,path,contact) values(%s,%s,%s,'buyer','{\"name\":\"CONTACT-CANARY\",\"phone\":\"PHONE-CANARY\",\"email\":\"EMAIL-CANARY\"}')", (subject, w.org, w.org))
        owner.execute("insert into pulse_priv.acq_enquiry(id,org_id,controller,path,project_id,subject_id,source_id,namespace,external_id,occurred,owner_id,body) values(%s,%s,%s,'buyer',%s,%s,%s,'synthetic','EXTERNAL-ID-CANARY','2026-10-02 20:00Z',%s,'{}')", (lead, w.org, w.org, w.project, subject, source, w.editor))
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '0', 'TEST_API_CONFIG': json.dumps(config),
           'TEST_IDS': json.dumps({'item': str(item), 'lead': str(lead), 'client': str(w.client), 'domain': w.domain,
                                  'foreign': str(foreign), 'staff': str(staff_doc), 'invoice': str(invoice)}),
           'PULSE_OPERATOR_TOKEN': 'synthetic-notice-operator-' + '0' * 32}
    result = subprocess.run(['node', 'test/service-notice-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr
    made = json.loads(next(line.removeprefix('NOTICES ') for line in result.stdout.splitlines() if line.startswith('NOTICES ')))
    with owner.transaction():
        set_tenant(owner, w.org)
        rows = owner.execute("select * from pulse.notification where event_type='quote_ready' order by created_at").fetchall()
        assert len(rows) == 3 and {r['person_id'] for r in rows} == {w.editor}
        by_doc = {str(r['subject_id']): r for r in rows}
        assert by_doc[made['quote']]['title'] == 'Quotation ready for Northstar Homes: 1 item(s), INR 118.00'
        assert by_doc[made['lead']]['title'] == 'Quotation ready for a lead received 3 Oct: 2 item(s), INR 224.00 · owner approval needed'
        assert by_doc[made['unflagged']]['title'] == 'Quotation ready for a lead received 3 Oct: 1 item(s), INR 118.00'
        for r in rows:
            assert r['subject_type'] == 'erp_document' and r['href'] == f"/quotes/{r['subject_id']}"
            assert 'CANARY' not in r['title'] and 'CALLER-TEXT' not in r['title']
        assert owner.execute('select count(*) n from pulse.hr_mail_outbox where notification_id=any(%s)', ([r['id'] for r in rows],)).fetchone()['n'] == 3
        audit = owner.execute("select actor_account from pulse.audit_event where action='service_quote_notify' and resource_id=%s", (made['lead'],)).fetchall()
        assert len(audit) == 1 and audit[0]['actor_account'] == 'service:' + made['key']
        for function in ['quote_party_label(uuid)', 'service_quote_notify(uuid,text,uuid)', 'salesperson_quote(uuid)']:
            definition = owner.execute('select pg_get_functiondef(%s::regprocedure) d', ('pulse.' + function,)).fetchone()['d'].lower()
            assert all(word not in definition for word in ['decrypt', 'acq_subject', 'external_id', 'contact', 'buyer'])
        definition = owner.execute("select pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure) d").fetchone()['d']
        assert "p_type like 'comp.%'" in definition and 'comp_notice_allowed' in definition
        for who in [w.member, w.finance]:
            assert owner.execute("select pulse.notification_recipient_allowed(%s,'quote_ready','erp_document',%s) ok", (who, made['lead'])).fetchone()['ok'] is False
        assert owner.execute("select pulse.notification_recipient_allowed(%s,'quote_ready','erp_document',%s) ok", (w.editor, made['lead'])).fetchone()['ok'] is True
    assert one(api, w, w.editor, 'select pulse.salesperson_quote(%s) q', (made['lead'],))['q']['name'] == 'a lead received 3 Oct'
    assert one(api, other, other.manager, 'select pulse.salesperson_quote(%s) q', (made['lead'],))['q'] is None
    direct_key, digest = uuid.uuid4(), 'b' * 64
    api.execute("select pulse.service_key_manage('issue',%s,%s,array['notify.quote_ready'],'Synthetic direct notice')", (direct_key, digest))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org)
        api.execute('select pulse.service_quote_notify(%s,%s,%s)', (direct_key, digest, made['lead']))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        assert api.execute("select pulse.service_key_auth(%s,%s,'notify.quote_ready') ok", (direct_key, digest)).fetchone()['ok']
        api.execute('select pulse.service_quote_notify(%s,%s,%s)', (direct_key, 'c' * 64, made['lead']))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) values(%s,'tenant','modules',1,'{\"off\":[\"money\"]}',true)", (w.org,))
    assert one(api, w, w.finance, 'select pulse.salesperson_quote(%s) q', (made['lead'],))['q'] is None
    with pytest.raises(psycopg.errors.NoDataFound), api.transaction():
        assert api.execute("select pulse.service_key_auth(%s,%s,'notify.quote_ready') ok", (direct_key, digest)).fetchone()['ok']
        api.execute('select pulse.service_quote_notify(%s,%s,%s)', (direct_key, digest, made['lead']))
