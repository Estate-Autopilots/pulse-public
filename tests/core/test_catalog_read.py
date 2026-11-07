"""Install-local catalogue security proof; synthetic records only, real PostgreSQL/RLS and Fastify."""
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
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def test_catalogue_api_and_install_boundary(worker, owner, api):
    first, other = build_world(worker, owner, api), build_world(worker, owner, api)
    ids = []
    for world in [first, other]:
        with worker.transaction():
            set_tenant(worker, world.org)
            for kind, status in [('service', 'active'), ('product', 'active'), ('package', 'active'), ('service', 'draft'), ('product', 'archived')]:
                row = worker.execute("""insert into pulse.erp_item(org_id,kind,status,name,description,price,gst_rate,cost,source)
                    values(%s,%s,%s,%s,'<script>synthetic</script>',12345,18,999,'{"secret":"source-secret"}') returning id""",
                                     (world.org, kind, status, 'Synthetic ' + kind)).fetchone()
                if world == first and status == 'active':
                    ids.append(str(row['id']))
    with owner.transaction():
        set_tenant(owner, other.org)
        owner.execute("insert into pulse.org_domain(org_id,host,sign_in,added_by) values(%s,'catalog-other.example','password','synthetic')", (other.org,))
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_ITEMS': json.dumps(ids),
           'PULSE_OPERATOR_TOKEN': 'synthetic-catalog-operator-' + '0' * 32}
    result = subprocess.run(['node', 'test/catalog-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api',
                            env=env, capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr
    key_id, digest = uuid.uuid4(), hashlib.sha256(b'synthetic-secret').hexdigest()
    api.execute("select pulse.catalog_manage('issue',%s,%s)", (key_id, digest))
    token = 'b' * 43
    api.execute("select pulse.catalog_manage('share',%s,%s)", (ids[0], token))
    with worker.transaction():
        set_tenant(worker, first.org)
        worker.execute("update pulse.erp_item set status='archived' where id=%s", (ids[0],))
    assert api.execute('select pulse.catalog_public(%s) item', (token,)).fetchone()['item'] is None
    with worker.transaction():
        set_tenant(worker, first.org)
        worker.execute("update pulse.erp_item set status='active' where id=%s", (ids[0],))
    # Spoofing transaction org cannot select the other tenant; functions always use the install marker.
    with api.transaction():
        set_tenant(api, other.org)
        rows = api.execute('select pulse.catalog_read(%s,%s) items', (key_id, digest)).fetchone()['items']
        assert {r['id'] for r in rows} == set(ids)
        assert api.execute('select count(*) n from pulse.erp_item').fetchone()['n'] == 0, 'no staff ERP grant'
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            api.execute('select * from pulse_priv.catalog_key')
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            api.execute('select pulse.catalog_projection()')
    # Simulate moving the service to another synthetic installation: the original key cannot authenticate.
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()['r']
        assert role.replace('_', '').isalnum()
        owner.execute(f'set local role {role}')
        owner.execute('update pulse.install set org_id=%s', (other.org,))
    assert api.execute('select pulse.catalog_key_hash(%s) h', (key_id,)).fetchone()['h'] is None
    assert api.execute('select pulse.catalog_read(%s,%s) items', (key_id, digest)).fetchone()['items'] is None
    assert api.execute('select pulse.catalog_public(%s) item', (token,)).fetchone()['item'] is None
    other_key = uuid.uuid4()
    api.execute("select pulse.catalog_manage('issue',%s,%s)", (other_key, digest))
    other_rows = api.execute('select pulse.catalog_read(%s,%s) items', (other_key, digest)).fetchone()['items']
    assert len(other_rows) == 3 and not {r['id'] for r in other_rows}.intersection(ids)
