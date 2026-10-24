"""EST-2284: staff visit HTTP and note history against PostgreSQL, synthetic tenants only."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from test_site_visit_instances import create, query, rows, settings, visits  # noqa: F401
from test_site_visit_settings import _config, _person


def save(api, w, vid, person, value, field=None):
    sql, args = ('select pulse.site_visit_notes_save(%s,%s)', (vid, value)) if field is None else (
        'select pulse.site_visit_field_note_save(%s,%s,%s)', (vid, field, value))
    return query(api, w, person, sql, args)


def test_prefill_is_current_narrow_and_tenant_bound(api, owner, visits):
    w, other = visits
    query(api, w, w.manager, "update pulse.client set phone='+919999900001',relationship_owner_id=%s where id=%s", (w.editor, w.customer))
    for status, number, customer, org in [('issued', 'Q/1', w.customer, w.org), ('draft', None, w.customer, w.org), ('issued', 'OTHER/1', other.customer, other.org)]:
        query(owner, w if org == w.org else other, None, "insert into pulse.erp_document(org_id,doc_type,status,number,client_id,issued_at) values(%s,'quotation',%s,%s,%s,now())", (org, status, number, customer))
    prefill = query(api, w, w.editor, 'select pulse.site_visit_prefill(%s) v', (w.customer,))[0]['v']
    assert prefill['phone'] == '+919999900001' and prefill['latestQuote']['number'] == 'Q/1'
    assert prefill['salesperson'] == {'id': str(w.editor), 'name': 'Editor One'}
    assert set(prefill['latestQuote']) == {'id', 'number'}
    assert query(api, other, other.manager, 'select pulse.site_visit_prefill(%s) v', (w.customer,)) == [{'v': None}]


def test_notes_permissions_snapshot_and_history(api, owner, visits):
    w, other = visits
    field = dict(key='roof', state='active', appliesTo=None)
    settings(api, w, 1, [field])
    vid = create(api, w, assignee=w.editor)
    settings(api, w, 2, [{**field, 'state': 'archived'}, {**field, 'key': 'later'}])
    save(api, w, vid, w.editor, 'first')
    save(api, w, vid, w.editor, 'roof note', 'roof')  # Archived since the immutable start.
    save(api, w, vid, w.manager, 'admin')
    save(api, w, vid, w.manager, 'admin')  # No change means no history row.
    for person, target, key in [(w.editor2, vid, None), (other.manager, vid, None), (w.manager, create(api, other), None)]:
        with pytest.raises(psycopg.Error):
            save(api, w, target, person, 'forbidden', key)
    for key in ['later', 'missing', '']:
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            save(api, w, vid, w.editor, 'not in snapshot', key)
    for value, key in [('x' * 4001, None), ('x' * 2001, 'roof'), (None, None)]:
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            save(api, w, vid, w.manager, value, key)
    query(owner, w, None, 'update pulse.site_visit set assigned_person_id=%s where id=%s', (w.editor2, vid))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        save(api, w, vid, w.editor, 'former assignee')
    save(api, w, vid, w.editor2, 'new assignee')
    query(owner, w, None, "update pulse.site_visit set status='submitted',submitted_by=%s,submitted_at=now() where id=%s", (w.manager, vid))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        save(api, w, vid, w.editor2, 'submitted assignee')
    save(api, w, vid, w.manager, 'post submit')
    save(api, w, vid, w.manager, '', 'roof')
    history = [h for h in rows(api, w, 'site_visit_history') if h['visit_id'] == vid]
    assert len(history) == 7
    assert {(h['action'], h['from_value'], h['to_value'], h['actor_id']) for h in history if h['action'] != 'visit_created'} == {
        ('visit_notes_changed', '', 'first', w.editor), ('field_notes_changed', '', 'roof note', w.editor),
        ('visit_notes_changed', 'first', 'admin', w.manager), ('visit_notes_changed', 'admin', 'new assignee', w.editor2),
        ('visit_edited_after_submit', 'new assignee', 'post submit', w.manager), ('visit_edited_after_submit', 'roof note', '', w.manager)}
    assert next(h for h in history if h['to_value'] == 'roof note')['field_key'] == 'roof'
    assert query(api, other, other.manager, 'select * from pulse.site_visit_field_note where visit_id=%s', (vid,)) == []


def test_owner_edits_and_hr_remains_refused(api, owner, visits):
    w, _ = visits
    for person, role in [(w.lead, 'leadership'), (w.editor2, 'hr')]:
        query(owner, w, None, "insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2026-01-01')", (w.org, person, role))
    settings(api, w, 1, [dict(key='roof', state='active', appliesTo=None)])
    vid = create(api, w, assignee=w.editor2)
    for field in [None, 'roof']:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            save(api, w, vid, w.editor2, 'HR assignee', field)
        save(api, w, vid, w.lead, 'owner open', field)
    query(owner, w, None, "update pulse.site_visit set status='submitted',submitted_by=%s,submitted_at=now() where id=%s", (w.manager, vid))
    for field in [None, 'roof']:
        save(api, w, vid, w.lead, 'owner submitted', field)
    history = query(api, w, w.lead, 'select * from pulse.site_visit_history where visit_id=%s', (vid,))
    assert len(history) == 5
    assert {(h['field_key'], h['actor_id'], h['from_value'], h['to_value']) for h in history if h['action'] == 'visit_edited_after_submit'} == {
        (key, w.lead, 'owner open', 'owner submitted') for key in [None, 'roof']}
    query(owner, w, None, "update pulse.person set status='inactive' where id=%s", (w.lead,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        save(api, w, vid, w.lead, 'inactive owner')


def test_failed_history_rolls_back_note(api, owner, visits):
    w, _ = visits
    vid = create(api, w)
    with owner.transaction():
        owner.execute("create function pg_temp.reject_note_history() returns trigger language plpgsql as $$ begin raise exception 'synthetic history failure' using errcode='23514'; end $$")
        owner.execute("create trigger reject_note_history before insert on pulse.site_visit_history for each row execute function pg_temp.reject_note_history()")
    try:
        with pytest.raises(psycopg.errors.CheckViolation):
            save(api, w, vid, w.manager, 'must roll back')
        assert next(v for v in rows(api, w) if v['id'] == vid)['notes'] == ''
        assert len(rows(api, w, 'site_visit_history')) == 1
    finally:
        with owner.transaction():
            owner.execute('drop trigger reject_note_history on pulse.site_visit_history')


API = r'''
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app=createApp(pool,pool);
const ids=JSON.parse(process.env.TEST_VISITS);
const call=async(path,role='member',payload,method=payload===undefined?'GET':'POST')=>{
 const r=await app.inject({url:'/api/v0/'+path,method,headers:role?{'cf-access-authenticated-user-email':role+'@'+ids.domain}:{},...(payload===undefined?{}:{payload})});
 return {status:r.statusCode,data:r.json()};
};
const base='customers/'+ids.customer+'/site-visits';
let r=await call(base);assert.equal(r.status,200);assert.deepEqual(r.data.visits,[]);
assert.deepEqual(r.data.customer,{name:'Synthetic Customer',phone:null,siteAddress:null,systemSizeKw:null,latestQuote:null,salesperson:null});
for(const extra of [{customerId:ids.otherCustomer},{name:'forged'},{assignedPersonId:ids.foreignPerson},{notes:null}])assert.equal((await call(base,'admin',{typeKey:'survey',...extra})).status,400);
r=await call(base,'member',{typeKey:'survey',notes:'first'});assert.equal(r.status,200,JSON.stringify(r));
const vid=r.data.visit.id, visit='site-visits/'+vid;assert.equal(r.data.visit.customer_id,ids.customer);
assert.equal(r.data.visit.assigned_person_id,ids.member);assert.equal(r.data.history.length,1);
assert.equal((await call(base,'member',{typeKey:'survey'})).status,200);assert.equal((await call(base)).data.visits.length,2);
assert.equal((await call(visit+'/notes','other',{notes:'forbidden'},'PUT')).status,403);
assert.equal((await call(visit+'/notes','member',{notes:'changed'},'PUT')).status,200);
r=await call(visit+'/fields/roof/notes','member',{notes:'field'},'PUT');assert.equal(r.status,200,JSON.stringify(r));
assert.deepEqual(r.data.fieldNotes,[{field_key:'roof',notes:'field'}]);assert.equal(r.data.history.length,3);
assert.equal((await call(visit+'/fields/later/notes','member',{notes:'forbidden'},'PUT')).status,400);
assert.equal((await call(visit+'/notes','member',{notes:'x'.repeat(4001)},'PUT')).status,400);
assert.equal((await call(visit+'/notes','admin',{notes:'admin'},'PUT')).status,200);
assert.equal((await call(visit,'other')).status,200);assert.deepEqual((await call(visit,'other')).data.history,[]);
for(const path of ['customers/'+ids.otherCustomer+'/site-visits','site-visits/'+ids.foreignVisit])assert.equal((await call(path)).status,404);
assert.equal((await call('customers/'+ids.secondCustomer+'/site-visits','member',{typeKey:'survey'})).status,403);
assert.equal((await call(visit+'/notes','member',{notes:'x',customerId:ids.otherCustomer},'PUT')).status,400);
await app.close();await pool.end();
'''


def test_staff_visit_routes(api, owner, worker, visits):
    w, other = visits
    w.member = _person(worker, w, 'Synthetic Member', 'member')
    _person(worker, w, 'Synthetic Admin', 'admin', 'admin')
    _person(worker, w, 'Synthetic Other', 'other')
    query(api, w, w.manager, 'update pulse.client set after_closing_person_id=%s where id=%s', (w.member, w.customer))
    second = uuid.uuid4()
    query(api, w, w.manager, "insert into pulse.client(id,org_id,display_name) values(%s,%s,'Synthetic second')", (second, w.org))
    settings(api, w, 1, [dict(key='roof', state='active', appliesTo=None)])
    env = {**os.environ, 'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '0', 'TEST_API_CONFIG': _config(dsn('api')),
           'TEST_VISITS': json.dumps(dict(domain=w.domain, customer=str(w.customer), member=str(w.member), secondCustomer=str(second),
                                         otherCustomer=str(other.customer), foreignPerson=str(other.editor), foreignVisit=str(create(api, other))))}
    p = subprocess.run(['node', '--input-type=module', '-e', API], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, capture_output=True, text=True, timeout=240)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]
