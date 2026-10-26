"""Contract 1.1 phone lookup SQL (EST-1294): keyed digests for every key version, capped, audited without the number."""
import hashlib
import hmac
import json
import uuid

import psycopg
import pytest
from helpers import build_world
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant

PHONE = '+919812345678'
KEYS = {'v1': bytes.fromhex('a' * 64), 'v2': bytes.fromhex('b' * 64)}


def _alias(version, controller, path, phone=PHONE):
    key = hmac.new(KEYS[version], f'{controller}|{path}|phone:{phone}'.encode(), hashlib.sha256).hexdigest()
    return {'version': version, 'controller': str(controller), 'path': path, 'key': key}


def _as_owner(owner, org):
    role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()['r']
    assert role.replace('_', '').isalnum()
    owner.execute(f'set local role {role}')
    set_tenant(owner, org)


def _seed(owner, world):
    """Subject A keyed under v1 only, subject B under v2 only (a rotated key); 9 enquiries, 2 excluded."""
    leads = []
    with owner.transaction():
        _as_owner(owner, world.org)
        source = uuid.uuid4()
        owner.execute("""insert into pulse_priv.acq_source(id,org_id,controller,project_id,path,kind,account,purpose,owner_id,label)
            values(%s,%s,%s,%s,'agency','manual','synthetic','lead',%s,'Synthetic source')""",
                      (source, world.org, world.org, world.project, world.editor))
        for version, count in [('v1', 6), ('v2', 3)]:
            subject = uuid.uuid4()
            owner.execute("insert into pulse_priv.acq_subject(id,org_id,controller,path) values(%s,%s,%s,'agency')",
                          (subject, world.org, world.org))
            owner.execute("""insert into pulse_priv.acq_identity(org_id,controller,path,key_version,keyed,subject_id)
                values(%s,%s,'agency',%s,%s,%s)""", (world.org, world.org, version, _alias(version, world.org, 'agency')['key'], subject))
            for n in range(count):
                lead, excluded = uuid.uuid4(), version == 'v1' and n in (4, 5)
                owner.execute("""insert into pulse_priv.acq_enquiry(id,org_id,controller,path,project_id,subject_id,source_id,
                    namespace,external_id,occurred,owner_id,body,withdrawn)
                    values(%s,%s,%s,'agency',%s,%s,%s,'synthetic',%s,'2026-10-16T10:00:00Z',%s,%s,%s)""",
                              (lead, world.org, world.org, world.project, subject, source, f'{version}-{n}', world.editor,
                               Jsonb({'test': n == 4}), n == 5))
                if not excluded:
                    leads.append(str(lead))
        clients = []
        for n, phone in enumerate(['98123 45678', '+91 (981) 234-5678', '+919812345679', None]):
            cid = uuid.uuid4()
            owner.execute("""insert into pulse.client(id,org_id,display_name,client_type,status,phone)
                values(%s,%s,%s,'other','active',%s)""", (cid, world.org, f'Synthetic client {n}', phone))
            if n < 2:
                clients.append(str(cid))
        # Fewer than five matches makes this a deterministic regression for the gone-id exclusion.
        gone = uuid.uuid4()
        owner.execute("update pulse.client set entity_kind='company' where id=%s", (clients[0],))
        owner.execute("""insert into pulse.client(id,org_id,display_name,client_type,entity_kind,phone)
            values(%s,%s,'Merged phone client','other','company',%s)""", (gone, world.org, PHONE))
        owner.execute("""insert into pulse.record_merge(org_id,entity_type,keep_id,gone_id,moved,previous_status,merged_by)
            values(%s,'client',%s,%s,'[]','active',%s)""", (world.org, clients[0], gone, world.editor))
        owner.execute("insert into pulse.client(org_id,display_name,client_type,phone) values(%s,'Internal','internal',%s)", (world.org, PHONE))
    return sorted(leads), sorted(clients)


def test_service_phone_lookup_sql(worker, owner, api):
    first, other = build_world(worker, owner, api), build_world(worker, owner, api)
    leads, clients = _seed(owner, first)
    _seed(owner, other)  # Same number on another company: never matched by this install.
    key_id, digest = uuid.uuid4(), hashlib.sha256(b'synthetic-phone-secret').hexdigest()
    api.execute("select pulse.service_key_manage('issue',%s,%s,%s,'Synthetic')", (key_id, digest, ['clients.read', 'leads.read']))

    scopes = api.execute('select pulse.service_lead_scopes(%s,%s) s', (key_id, digest)).fetchone()['s']
    assert scopes == [{'controller': str(first.org), 'path': 'agency'}]
    aliases = [_alias(v, s['controller'], s['path']) for v in KEYS for s in scopes]
    page = api.execute('select pulse.service_leads_by_phone(%s,%s,%s) p', (key_id, digest, Jsonb(aliases))).fetchone()['p']
    assert page['nextCursor'] is None
    assert [i['id'] for i in page['items']] == leads[:5], 'both key versions match, exclusions apply, capped at 5'
    assert set(page['items'][0]) == {'id', 'name', 'stage', 'receivedAt', 'salesperson'} and page['items'][0]['name'] is None
    only_v2 = api.execute('select pulse.service_leads_by_phone(%s,%s,%s) p', (key_id, digest, Jsonb(aliases[1:]))).fetchone()['p']
    assert len(only_v2['items']) == 3, 'a lead keyed only under the second version is found'
    none = [_alias(v, first.org, 'agency', '+919000000000') for v in KEYS]
    assert api.execute('select pulse.service_leads_by_phone(%s,%s,%s) p', (key_id, digest, Jsonb(none))).fetchone()['p'] == {'items': [], 'nextCursor': None}

    found = api.execute('select pulse.service_clients_by_phone(%s,%s,%s) p', (key_id, digest, PHONE)).fetchone()['p']
    assert sorted(i['id'] for i in found['items']) == clients and found['nextCursor'] is None
    assert set(found['items'][0]) == {'id', 'name', 'status', 'salesperson'}
    assert api.execute('select pulse.service_clients_by_phone(%s,%s,%s) p', (key_id, digest, '+919000000000')).fetchone()['p']['items'] == []
    for bad in ['9812345678', 'not a phone', None]:
        with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():
            api.execute('select pulse.service_clients_by_phone(%s,%s,%s)', (key_id, digest, bad))
    with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():
        api.execute('select pulse.service_leads_by_phone(%s,%s,%s)', (key_id, digest, Jsonb({'not': 'array'})))

    with owner.transaction():
        _as_owner(owner, first.org)
        audit = owner.execute("""select resource,resource_id,actor_account,fields from pulse.audit_event
            where action='service_phone_lookup' order by at""").fetchall()
    assert [(a['resource'], a['fields']) for a in audit] == [
        ('leads', ['matches:7']), ('leads', ['matches:3']), ('leads', ['matches:0']), ('clients', ['matches:2']), ('clients', ['matches:0'])]
    assert all(a['resource_id'] == str(key_id) and a['actor_account'] == 'service:' + str(key_id) for a in audit)
    assert '9812345678' not in json.dumps(audit, default=str)

    narrow, narrow_digest = uuid.uuid4(), hashlib.sha256(b'synthetic-narrow-secret').hexdigest()
    api.execute("select pulse.service_key_manage('issue',%s,%s,%s,'Narrow')", (narrow, narrow_digest, ['catalog.read']))
    for sql, arg in [('service_lead_scopes(%s,%s)', None), ('service_leads_by_phone(%s,%s,%s)', Jsonb(aliases)),
                     ('service_clients_by_phone(%s,%s,%s)', PHONE)]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            api.execute('select pulse.' + sql, (narrow, narrow_digest) + ((arg,) if arg is not None else ()))


def test_source_ref_column_bounds(worker, owner, api):
    world = build_world(worker, owner, api)
    with owner.transaction():
        _as_owner(owner, world.org)
        column = owner.execute("""select data_type,is_nullable from information_schema.columns
            where table_schema='pulse' and table_name='erp_document' and column_name='source_ref'""").fetchone()
    assert column == {'data_type': 'text', 'is_nullable': 'YES'}
