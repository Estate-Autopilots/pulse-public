"""Service-only drafts and SQL approval enforcement on disposable synthetic tenants."""
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
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import erp, one  # noqa: F401


def test_service_quotes(worker, owner, api, erp):  # noqa: F811
    w = erp
    other = build_world(worker, owner, api)
    ids = {k: str(uuid.uuid4()) for k in ['item', 'inactive', 'foreign', 'unowned', 'lead']}
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute('update pulse.client set relationship_owner_id=%s where id=%s', (w.editor, w.client))
        worker.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'Synthetic unowned')", (ids['unowned'], w.org))
        for name, status in [('item', 'active'), ('inactive', 'archived')]:
            worker.execute("insert into pulse.erp_item(id,org_id,kind,name,price,gst_rate,status) values(%s,%s,'service','Synthetic item',10000,18,%s)", (ids[name], w.org, status))
        for pid, email in [(w.founder, f'founder@{w.domain}'), (w.finance, f'finance@{w.domain}')]:
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, email, pid))
        set_tenant(worker, other.org)
        worker.execute("insert into pulse.erp_item(id,org_id,kind,name,price,status) values(%s,%s,'product','Other item',10000,'active')", (ids['foreign'], other.org))
    with owner.transaction():
        set_tenant(owner, w.org)
        source, subject = uuid.uuid4(), uuid.uuid4()
        owner.execute("insert into pulse_priv.acq_source(id,org_id,controller,project_id,path,kind,account,purpose,owner_id,label) values(%s,%s,%s,%s,'buyer','manual','synthetic','lead',%s,'Synthetic')", (source, w.org, w.org, w.project, w.editor))
        owner.execute("insert into pulse_priv.acq_subject(id,org_id,controller,path) values(%s,%s,%s,'buyer')", (subject, w.org, w.org))
        owner.execute("insert into pulse_priv.acq_enquiry(id,org_id,controller,path,project_id,subject_id,source_id,namespace,external_id,occurred,owner_id,body) values(%s,%s,%s,'buyer',%s,%s,%s,'synthetic','lead',now(),%s,'{}')", (ids['lead'], w.org, w.org, w.project, subject, source, w.editor))
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '0', 'TEST_API_CONFIG': json.dumps(config),
           'TEST_IDS': json.dumps({**ids, 'client': str(w.client), 'salesperson': str(w.editor), 'org': str(w.org), 'domain': w.domain}),
           'PULSE_OPERATOR_TOKEN': 'synthetic-quote-operator-' + '0' * 32}
    result = subprocess.run(['node', 'test/service-quotes-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr
    made = json.loads(next(line.removeprefix('QUOTES ') for line in result.stdout.splitlines() if line.startswith('QUOTES ')))
    changed, lead = made['changed'], made['lead']
    source_ref = 'synthetic-source-reference'
    assert one(api, w, w.finance, 'select source_ref from pulse.erp_document where id=%s', (made['source'],))['source_ref'] == source_ref
    assert one(api, w, w.finance, "select detail from pulse.erp_event where subject_id=%s and kind='created'", (made['source'],))['detail'] == {'from': 'service_key', 'sourceRef': source_ref}
    row = one(api, w, w.finance, 'select created_by,service_key_id,catalogue_rate from pulse.erp_document d join pulse.erp_line l on l.document_id=d.id where d.id=%s', (changed,))
    assert row['created_by'] is None and row['service_key_id'] and row['catalogue_rate'] == 10000
    assert one(api, w, w.finance, 'select client_id,lead_id from pulse.erp_document where id=%s', (lead,)) == {'client_id': None, 'lead_id': uuid.UUID(ids['lead'])}
    one(api, w, w.finance, "update pulse.erp_document set owner_approval='approved' where id=%s", (changed,))
    assert one(api, w, w.finance, 'select owner_approval from pulse.erp_document where id=%s', (changed,))['owner_approval'] == 'needed'
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match='Owner approval needed'):
        one(api, w, w.finance, 'select pulse.erp_document_issue(%s)', (changed,))
    one(api, w, w.founder, 'select pulse.erp_document_issue(%s)', (changed,))
    assert one(api, w, w.finance, 'select owner_approval from pulse.erp_document where id=%s', (changed,))['owner_approval'] == 'approved'
    assert one(api, w, w.finance, "select count(*) n from pulse.erp_event where subject_id=%s and kind='owner_approved'", (changed,))['n'] == 1
    assert one(api, w, w.finance, "select count(*) n from pulse.erp_event where subject_id=%s and kind='created' and detail=%s", (changed, Jsonb({'from': 'service_key'})))['n'] == 1
    with api.transaction():
        set_tenant(api, other.org)
        assert api.execute('select count(*) n from pulse.erp_document').fetchone()['n'] == 0
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        api.execute('select pulse.service_quote_result(%s)', (changed,))
    one(api, w, w.finance, 'update pulse.erp_line set item_id=null where document_id=%s', (lead,))
    assert one(api, w, w.finance, 'select owner_approval from pulse.erp_document where id=%s', (lead,))['owner_approval'] == 'needed'
    one(api, w, w.finance, 'update pulse.erp_line set item_id=%s,catalogue_rate=null where document_id=%s', (ids['item'], lead))
    assert one(api, w, w.finance, 'select owner_approval from pulse.erp_document where id=%s', (lead,))['owner_approval'] is None
    with owner.transaction():
        set_tenant(owner, w.org)
        audit = owner.execute("select actor_id,actor_account,changes from pulse.audit_event where action='service_quote_create' and resource_id=%s", (changed,)).fetchone()
        assert audit['actor_id'] is None and audit['actor_account'].startswith('service:') and audit['changes'] == {}
    key, reader = uuid.uuid4(), uuid.uuid4()
    digest = 'b' * 64
    api.execute("select pulse.service_key_manage('issue',%s,%s,array['quotes.draft.create'],'Synthetic direct')", (key, digest))
    api.execute("select pulse.service_key_manage('issue',%s,%s,array['clients.read'],'Synthetic reader')", (reader, digest))
    payload = {'clientId': str(w.client), 'lines': [{'itemId': ids['item'], 'qty': 1}]}

    def context(auth_key, scope, quote_key=None):
        with api.transaction():
            assert api.execute('select pulse.service_key_auth(%s,%s,%s) ok', (auth_key, digest, scope)).fetchone()['ok']
            return api.execute('select pulse.service_quote_context(%s,%s) c', (quote_key or auth_key, Jsonb(payload))).fetchone()['c']

    assert context(key, 'quotes.draft.create')['salesperson']['id'] == str(w.editor)
    # SQL re-checks the transaction's authenticated key and its scope: no actor, another key, or a key without the scope.
    for auth_key, scope, quote_key in [(reader, 'clients.read', None), (reader, 'clients.read', key)]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            context(auth_key, scope, quote_key)
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        api.execute('select pulse.service_quote_context(%s,%s)', (key, Jsonb(payload)))
    # Staff cannot forge service provenance or write the approval flag.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match='Service provenance'):
        one(api, w, w.founder, "insert into pulse.erp_document(org_id,doc_type,service_key_id,request_key,request_hash) values(%s,'quotation',%s,%s,%s)",
            (w.org, key, uuid.uuid4(), 'c' * 64))
    staff_doc = one(api, w, w.founder, "insert into pulse.erp_document(org_id,doc_type,owner_approval) values(%s,'quotation','approved') returning id,owner_approval", (w.org,))
    assert staff_doc['owner_approval'] is None
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.founder, 'update pulse.erp_document set service_key_id=%s where id=%s', (key, staff_doc['id']))
    with api.transaction():
        set_tenant(api, w.org, w.finance)
        api.execute("update pulse.erp_settings set company='{}'")
    with pytest.raises(psycopg.Error) as no_state:
        context(key, 'quotes.draft.create')
    assert no_state.value.sqlstate == 'P0422'
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) values(%s,'tenant','modules',1,'{\"off\":[\"money\"]}',true)", (w.org,))
    with pytest.raises(psycopg.errors.NoDataFound):
        context(key, 'quotes.draft.create')
