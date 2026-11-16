"""Synthetic install-local service reads through real PostgreSQL/RLS and Fastify."""
import hashlib
import hmac
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant


def test_service_reads(worker, owner, api):
    first, other = build_world(worker, owner, api), build_world(worker, owner, api)
    expected = {'clients': [], 'leads': []}
    identity_key = os.urandom(32)
    rotated_key = os.urandom(32)
    protected_name = 'Synthetic protected-name sentinel'
    contacts = {}
    for world in [first, other]:
        with owner.transaction():
            role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()['r']
            assert role.replace('_', '').isalnum()
            owner.execute(f'set local role {role}')
            set_tenant(owner, world.org)
            owner.execute("update pulse.person set status='inactive' where id=%s", (world.editor2,))
            outsider = uuid.uuid4()
            owner.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'External owner','client')", (outsider, world.org))
            active = {'id': str(world.editor), 'name': 'Editor One'}
            foreign_owner = other.editor if world == first else first.editor
            client_ids = []
            for n, (person, status) in enumerate([(world.editor, 'active'), (world.editor2, 'paused'), (outsider, None), (None, 'prospect'), (foreign_owner, 'churned')]):
                cid = uuid.uuid4()
                client_ids.append(cid)
                owner.execute("""insert into pulse.client(id,org_id,display_name,client_type,status,relationship_owner_id,email,phone,city)
                    values(%s,%s,%s,'other',%s,%s,'private@example.invalid','+919999999999','private-address')""",
                              (cid, world.org, f'Synthetic client {n}', status, person))
                if world == first:
                    expected['clients'].append({'id': str(cid), 'name': f'Synthetic client {n}', 'status': status,
                                                'salesperson': active if person == world.editor else None})
            owner.execute("update pulse.client set entity_kind='company' where id=%s", (client_ids[0],))
            for undone in [False, True]:
                cid = uuid.uuid4()
                name, status = ('Synthetic undone merge', 'active') if undone else ('Excluded merged client', 'churned')
                owner.execute("""insert into pulse.client(id,org_id,display_name,client_type,status,entity_kind,phone)
                    values(%s,%s,%s,'other',%s,'company',%s)""", (cid, world.org, name, status, None if undone else '+919999999999'))
                owner.execute("""insert into pulse.record_merge(org_id,entity_type,keep_id,gone_id,moved,previous_status,merged_by,undone_at)
                    values(%s,'client',%s,%s,'[]','active',%s,case when %s then now() end)""",
                              (world.org, client_ids[0], cid, world.editor, undone))
                if world == first and undone:
                    expected['clients'].append({'id': str(cid), 'name': name, 'status': status, 'salesperson': None})
            owner.execute("insert into pulse.client(org_id,display_name,client_type) values(%s,'Excluded internal','internal')", (world.org,))
            source, subject = uuid.uuid4(), uuid.uuid4()
            owner.execute("""insert into pulse_priv.acq_source(id,org_id,controller,project_id,path,kind,account,purpose,owner_id,label)
                values(%s,%s,%s,%s,'agency','manual','synthetic','lead',%s,'Synthetic source')""",
                          (source, world.org, world.org, world.project, world.editor))
            iv = os.urandom(12)
            encrypted = AESGCM(identity_key).encrypt(iv, json.dumps({'name': protected_name, 'phone': '+919999999999',
                                                                   'email': 'private@example.invalid'}).encode(),
                                                   f'{world.org}|agency'.encode())
            contact = {'version': 'v1', 'iv': iv.hex(), 'tag': encrypted[-16:].hex(), 'data': encrypted[:-16].hex(),
                       'controller': str(world.org), 'path': 'agency'}
            contacts[str(world.org)] = contact
            owner.execute("""insert into pulse_priv.acq_subject(id,org_id,controller,path,contact)
                values(%s,%s,%s,'agency',%s)""", (subject, world.org, world.org, Jsonb(contact)))
            # Phone aliases exist only under the second configured key version.
            alias = hmac.new(rotated_key, f'{world.org}|agency|phone:+919999999999'.encode(), hashlib.sha256).hexdigest()
            owner.execute("""insert into pulse_priv.acq_identity(org_id,controller,path,key_version,keyed,subject_id)
                values(%s,%s,'agency','v2',%s,%s)""", (world.org, world.org, alias, subject))
            for n in range(6):
                lead, person = uuid.uuid4(), world.editor2 if n == 1 else world.editor
                body = {'test': n == 4, 'email': 'private@example.invalid', 'phone': '+919999999999',
                        'address': 'private-address', 'aliases': ['identity-secret']}
                owner.execute("""insert into pulse_priv.acq_enquiry(id,org_id,controller,path,project_id,subject_id,source_id,
                    namespace,external_id,occurred,owner_id,body,withdrawn)
                    values(%s,%s,%s,'agency',%s,%s,%s,'identity-secret',%s,'2026-10-16T10:00:00Z',%s,%s,%s)""",
                              (lead, world.org, world.org, world.project, subject, source, f'identity-secret-{n}', person, Jsonb(body), n == 5))
                stage = 'new'
                if n in (0, 2):
                    previous = uuid.uuid4()
                    owner.execute("""insert into pulse_priv.acq_stage(id,org_id,enquiry_id,request_key,stage,effective,actor,verification,evidence,confidence)
                        values(%s,%s,%s,'first','connected','2026-10-16T11:00:00Z',%s,'reported','Synthetic evidence','Synthetic confidence')""",
                                  (previous, world.org, lead, world.editor))
                    stage = 'connected'
                    if n == 2:
                        booked = uuid.uuid4()
                        for sid, label, at, reverses in [(booked, 'booking', '12:00', None), (uuid.uuid4(), 'cancelled', '13:00', booked)]:
                            owner.execute("""insert into pulse_priv.acq_stage(id,org_id,enquiry_id,request_key,stage,effective,actor,verification,evidence,confidence,reverses)
                                values(%s,%s,%s,%s,%s,%s,%s,'reported','Synthetic evidence','Synthetic confidence',%s)""",
                                          (sid, world.org, lead, label, label, f'2026-10-16T{at}:00Z', world.editor, reverses))
                if world == first and n < 4:
                    expected['leads'].append({'id': str(lead), 'name': None, 'stage': stage, 'receivedAt': '2026-10-16T10:00:00+00:00',
                                              'salesperson': None if person == world.editor2 else active})
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_EXPECTED': json.dumps(expected),
           'TEST_PROTECTED_NAME': protected_name, 'TEST_PROTECTED_CONTACT': json.dumps(contacts[str(first.org)]),
           'PULSE_ACQUISITION_IDENTITY_KEYS': json.dumps([{'version': 'v1', 'key': identity_key.hex()}, {'version': 'v2', 'key': rotated_key.hex()}])}
    result = subprocess.run(['node', 'test/service-reads-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api',
                            env=env, capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr
    runner = Path(__file__).resolve().parents[2] / 'services/api'
    empty = subprocess.run(['node', 'test/service-reads-runner.mjs'], cwd=runner,
                           env={**env, 'TEST_PHONE_EDGE': 'empty', 'PULSE_ACQUISITION_IDENTITY_KEYS': ''},
                           capture_output=True, text=True, timeout=90)
    assert empty.returncode == 0, empty.stdout + empty.stderr
    empty_key = json.loads(next(line.removeprefix('PHONE_EDGE ') for line in empty.stdout.splitlines() if line.startswith('PHONE_EDGE ')))['keyId']
    with owner.transaction():
        owner.execute(f'set local role {role}')
        set_tenant(owner, first.org)
        audit = owner.execute("""select resource,fields,actor_account from pulse.audit_event
            where action='service_phone_lookup' and resource_id=%s""", (empty_key,)).fetchall()
        assert audit == [{'resource': 'leads', 'fields': ['matches:0'], 'actor_account': 'service:' + empty_key}]
        # Two versions × 33 scopes exceed the SQL's 64-alias bound: explicit 503, never partial success.
        for _ in range(32):
            controller, subject = uuid.uuid4(), uuid.uuid4()
            owner.execute("insert into pulse_priv.acq_subject(id,org_id,controller,path) values(%s,%s,%s,'agency')",
                          (subject, first.org, controller))
            alias = hmac.new(rotated_key, f'{controller}|agency|phone:+919999999999'.encode(), hashlib.sha256).hexdigest()
            owner.execute("""insert into pulse_priv.acq_identity(org_id,controller,path,key_version,keyed,subject_id)
                values(%s,%s,'agency','v2',%s,%s)""", (first.org, controller, alias, subject))
    overflow = subprocess.run(['node', 'test/service-reads-runner.mjs'], cwd=runner, env={**env, 'TEST_PHONE_EDGE': 'overflow'},
                              capture_output=True, text=True, timeout=90)
    assert overflow.returncode == 0, overflow.stdout + overflow.stderr
    key, digest = uuid.uuid4(), hashlib.sha256(b'synthetic-secret').hexdigest()
    api.execute("select pulse.service_key_manage('issue',%s,%s,%s,'Synthetic reader')", (key, digest, ['clients.read', 'leads.read']))
    wrong_scope = uuid.uuid4()
    api.execute("select pulse.service_key_manage('issue',%s,%s,%s,'Other scope')", (wrong_scope, digest, ['catalog.read']))
    for resource in ['clients', 'leads']:
        with api.transaction():
            set_tenant(api, other.org)
            page = api.execute(f'select pulse.service_{resource}(%s,%s) page', (key, digest)).fetchone()['page']
            assert sorted(page['items'], key=lambda i: i['id']) == sorted(expected[resource], key=lambda i: i['id'])
            assert page['nextCursor'] is None
            assert api.execute('select count(*) n from pulse.erp_item').fetchone()['n'] == 0
        for invalid in [None, 0, 201]:
            with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():
                api.execute(f'select pulse.service_{resource}(%s,%s,null,%s)', (key, digest, invalid))
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            api.execute(f'select pulse.service_{resource}(%s,%s)', (key, '0' * 64))
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            api.execute(f'select pulse.service_{resource}(%s,%s)', (wrong_scope, digest))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        api.execute('select * from pulse_priv.acq_enquiry')
    # Module switches are read in the authenticated service transaction, without staff identity.
    with owner.transaction():
        owner.execute(f'set local role {role}')
        set_tenant(owner, first.org)
        owner.execute("""insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active)
            values(%s,'tenant','modules',1,'{"off":["acquisition"]}',true)""", (first.org,))
    env['TEST_MODULE_OFF'] = '1'
    result = subprocess.run(['node', 'test/service-reads-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api',
                            env=env, capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr
    with owner.transaction():
        owner.execute(f'set local role {role}')
        owner.execute('update pulse.install set org_id=%s', (other.org,))
    for resource in ['clients', 'leads']:
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            api.execute(f'select pulse.service_{resource}(%s,%s)', (key, digest))
