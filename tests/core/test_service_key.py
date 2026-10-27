"""Install-local scoped credentials: real PostgreSQL/RLS, Fastify, CLI and web proxy; synthetic data only."""
import hashlib
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from test_hr_suite import _staff
from test_service_chat_post import setup_chat
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def _switch_install(owner, org):
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()['r']
        assert role.replace('_', '').isalnum()
        owner.execute(f'set local role {role}')
        owner.execute('update pulse.install set org_id=%s', (org,))


def test_service_key_api_and_proxy(worker, owner, api, tmp_path):
    first, other = build_world(worker, owner, api), build_world(worker, owner, api)
    ids = []
    for world in [first, other]:
        with worker.transaction():
            set_tenant(worker, world.org)
            row = worker.execute("""insert into pulse.erp_item(org_id,kind,status,name,price,gst_rate)
                values(%s,'service','active','Synthetic service',12345,18) returning id""", (world.org,)).fetchone()
            if world == first:
                ids.append(str(row['id']))
    with owner.transaction():
        set_tenant(owner, other.org)
        owner.execute("insert into pulse.org_domain(org_id,host,sign_in,added_by) values(%s,'service-other.example','password','synthetic')", (other.org,))
    _staff(worker, first)
    agent, chat, _ = setup_chat(api, first)
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_ITEMS': json.dumps(ids),
           'TEST_AGENT': str(agent), 'TEST_CHAT': str(chat), 'TEST_ORG': str(first.org), 'TEST_SCRATCH_DIR': str(tmp_path),
           'PULSE_OPERATOR_TOKEN': 'synthetic-service-operator-' + '0' * 32}
    result = subprocess.run(['node', 'test/service-key-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api',
                            env=env, capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr


def test_service_key_sql_scope_revocation_and_install(worker, owner, api, ingest, privacy):
    first, other = build_world(worker, owner, api), build_world(worker, owner, api)
    key_id, digest = uuid.uuid4(), hashlib.sha256(b'synthetic-service-secret').hexdigest()
    api.execute("select pulse.service_key_manage('issue',%s,%s,%s,'Synthetic')", (key_id, digest, ['catalog.read']))
    for connection in [api, worker, ingest, privacy]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege), connection.transaction():
            connection.execute('select * from pulse_priv.service_key')
    with api.transaction():
        set_tenant(api, other.org)
        assert api.execute('select pulse.service_key_hash(%s) h', (key_id,)).fetchone()['h'] == digest
        assert api.execute('select pulse.service_key_auth(%s,%s,%s) ok', (key_id, digest, 'catalog.read')).fetchone()['ok']
        context = api.execute("select pulse.current_org() org, current_setting('pulse.actor_account') actor").fetchone()
        assert context == {'org': first.org, 'actor': 'service:' + str(key_id)}
        assert api.execute('select count(*) n from pulse.erp_item').fetchone()['n'] == 0
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            api.execute('select pulse.catalog_projection()')
    before = api.execute('select pulse.service_key_list() keys').fetchone()['keys'][0]
    assert set(before) == {'id', 'label', 'scopes', 'agentId', 'createdAt', 'revokedAt', 'lastUsedAt'}
    for bad_hash, scope in [(digest, 'clients.read'), (digest, 'unknown'), ('0' * 64, 'catalog.read'), (digest, None)]:
        assert not api.execute('select pulse.service_key_auth(%s,%s,%s) ok', (key_id, bad_hash, scope)).fetchone()['ok']
    assert api.execute('select pulse.service_key_auth(%s,%s,%s) ok', (key_id, digest, 'catalog.read')).fetchone()['ok']
    after = api.execute('select pulse.service_key_list() keys').fetchone()['keys'][0]
    assert before['lastUsedAt'] == after['lastUsedAt']
    # Check the stored (unrounded) timestamp too: a second request must not write it again.
    with owner.transaction():
        set_tenant(owner, first.org)
        stored_before = owner.execute('select last_used_at from pulse_priv.service_key where id=%s', (key_id,)).fetchone()
    api.execute('select pulse.service_key_auth(%s,%s,%s)', (key_id, digest, 'catalog.read'))
    with owner.transaction():
        set_tenant(owner, first.org)
        assert owner.execute('select last_used_at from pulse_priv.service_key where id=%s', (key_id,)).fetchone() == stored_before
        # Forced RLS denies the other company's key even to the table owner in a foreign context.
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()['r']
        owner.execute(f'set local role {role}')
        set_tenant(owner, other.org)
        assert owner.execute('select count(*) n from pulse_priv.service_key').fetchone()['n'] == 0
    _switch_install(owner, other.org)
    assert api.execute('select pulse.service_key_hash(%s) h', (key_id,)).fetchone()['h'] is None
    assert not api.execute('select pulse.service_key_auth(%s,%s,%s) ok', (key_id, digest, 'catalog.read')).fetchone()['ok']
    assert api.execute('select pulse.service_key_list() keys').fetchone()['keys'] == []
    api.execute("select pulse.service_key_manage('revoke',%s)", (key_id,))  # Foreign install cannot revoke it.
    _switch_install(owner, first.org)
    assert api.execute('select pulse.service_key_hash(%s) h', (key_id,)).fetchone()['h'] == digest
    api.execute("select pulse.service_key_manage('revoke',%s)", (key_id,))
    assert api.execute('select pulse.service_key_hash(%s) h', (key_id,)).fetchone()['h'] is None
    assert not api.execute('select pulse.service_key_auth(%s,%s,%s) ok', (key_id, digest, 'catalog.read')).fetchone()['ok']


def test_service_key_sql_constraints(worker, owner, api):
    build_world(worker, owner, api)
    digest = hashlib.sha256(b'synthetic-service-secret').hexdigest()
    for bad_hash, scopes, label in [('bad', ['catalog.read'], 'Synthetic'), (digest, [], 'Synthetic'),
                                     (digest, ['staff.read'], 'Synthetic'), (digest, [None], 'Synthetic'),
                                     (digest, ['catalog.read'], ''), (digest, ['catalog.read'], 'x' * 61)]:
        with pytest.raises(psycopg.errors.CheckViolation), api.transaction():
            api.execute("select pulse.service_key_manage('issue',%s,%s,%s,%s)", (uuid.uuid4(), bad_hash, scopes, label))
    with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():
        api.execute("select pulse.service_key_manage('revoke',%s,%s)", (uuid.uuid4(), digest))
