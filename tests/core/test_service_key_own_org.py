"""WAS-KEYS (1568): a hosted company's service key binds its own organisation on the shared address; synthetic data only."""
import hashlib
import uuid

import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant


def _as_schema_owner(owner, org):
    role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()['r']
    assert role.replace('_', '').isalnum()
    owner.execute(f'set local role {role}')
    set_tenant(owner, org)


def _key(owner, org, label, scopes=('clients.read', 'catalog.read')):
    """A key issued straight into one company (as integration_key_issue does there); returns (id, digest)."""
    key_id = uuid.uuid4()
    digest = hashlib.sha256(f'synthetic-{key_id}'.encode()).hexdigest()
    with owner.transaction():
        _as_schema_owner(owner, org)
        owner.execute("insert into pulse_priv.service_key(id,org_id,key_hash,scopes,label) values(%s,%s,%s,%s,%s)",
                      (key_id, org, digest, list(scopes), label))
    return key_id, digest


def _client(worker, org, name):
    with worker.transaction():
        set_tenant(worker, org)
        return worker.execute("insert into pulse.client(org_id,display_name) values(%s,%s) returning id", (org, name)).fetchone()['id']


def _reach(api, on=True):
    api.execute("select set_config('pulse.service_key_reach',%s,true)", ('1' if on else '',))


def _clients(api, key_id):
    """What withServiceKey does: bind with the reach flag, clear it, then read."""
    with api.transaction():
        _reach(api)
        digest = api.execute('select pulse.service_key_hash(%s) h', (key_id,)).fetchone()['h']
        if digest is None:
            return None, None
        ok = api.execute("select pulse.service_key_auth(%s,%s,'clients.read') ok", (key_id, digest)).fetchone()['ok']
        _reach(api, False)
        org = api.execute('select pulse.current_org() o').fetchone()['o']
        page = api.execute('select pulse.service_clients(%s,pulse.service_key_hash(%s),null,200) p', (key_id, key_id)).fetchone()['p'] if ok else None
        return org, page


def test_hosted_key_reads_only_its_own_company(worker, owner, api):
    ea, wl, other = (build_world(worker, owner, api) for _ in range(3))  # the first world is the install (EA-like)
    ids = {w.org: _client(worker, w.org, f'Synthetic client {w.code}') for w in (ea, wl, other)}
    wl_key, _ = _key(owner, wl.org, 'Synthetic WAS')
    ea_key, _ = _key(owner, ea.org, 'Synthetic EA app')

    org, page = _clients(api, wl_key)
    assert org == wl.org
    assert {i['id'] for i in page['items']} == {str(ids[wl.org])}

    # The install's key never sees the hosted company.
    org, page = _clients(api, ea_key)
    assert org == ea.org
    assert {i['id'] for i in page['items']} == {str(ids[ea.org])}

    # The catalogue read is the key's company's too.
    for org_id in (ea.org, wl.org):
        with worker.transaction():
            set_tenant(worker, org_id)
            worker.execute("insert into pulse.erp_item(org_id,kind,status,name,price,gst_rate) values(%s,'service','active',%s,100,18)",
                           (org_id, f'Synthetic item {org_id}'))
    with api.transaction():
        _reach(api)
        digest = api.execute('select pulse.service_key_hash(%s) h', (wl_key,)).fetchone()['h']
        assert api.execute("select pulse.service_key_auth(%s,%s,'catalog.read') ok", (wl_key, digest)).fetchone()['ok']
        _reach(api, False)
        names = {i['name'] for i in api.execute('select pulse.service_key_catalog(%s) c', (wl_key,)).fetchone()['c']}
        assert names == {f'Synthetic item {wl.org}'}


def test_hosted_key_needs_the_shared_address(worker, owner, api):
    ea, wl, other = (build_world(worker, owner, api) for _ in range(3))
    wl_key, digest = _key(owner, wl.org, 'Synthetic WAS')
    # No flag, no organisation: only the install's keys bind (the old behaviour for everyone else).
    with api.transaction():
        assert api.execute('select pulse.service_key_hash(%s) h', (wl_key,)).fetchone()['h'] is None
        assert not api.execute("select pulse.service_key_auth(%s,%s,'clients.read') ok", (wl_key, digest)).fetchone()['ok']
        assert api.execute('select pulse.current_org() o').fetchone()['o'] is None
    # Another company's context, no flag: refused, and the context is not moved.
    with api.transaction():
        set_tenant(api, other.org)
        assert api.execute('select pulse.service_key_hash(%s) h', (wl_key,)).fetchone()['h'] is None
        assert not api.execute("select pulse.service_key_auth(%s,%s,'clients.read') ok", (wl_key, digest)).fetchone()['ok']
        assert api.execute('select pulse.current_org() o').fetchone()['o'] == other.org
    # Its own company's context (its own address) binds without the flag.
    with api.transaction():
        set_tenant(api, wl.org)
        assert api.execute("select pulse.service_key_auth(%s,%s,'clients.read') ok", (wl_key, digest)).fetchone()['ok']
    # The lookup policy shows nothing once the lookup is over, even to the owner role in a foreign context.
    with owner.transaction():
        _as_schema_owner(owner, other.org)
        owner.execute("select set_config('pulse.service_key_reach','1',true)")
        assert owner.execute('select count(*) n from pulse_priv.service_key').fetchone()['n'] == 0


def test_key_of_one_company_cannot_act_in_another(worker, owner, api):
    ea, wl, other = (build_world(worker, owner, api) for _ in range(3))
    _client(worker, other.org, 'Synthetic other client')
    wl_key, digest = _key(owner, wl.org, 'Synthetic WAS', ('clients.read', 'updates.requests.manage'))
    with api.transaction():
        set_tenant(api, other.org)
        _reach(api)
        assert api.execute("select pulse.service_key_auth(%s,%s,'clients.read') ok", (wl_key, digest)).fetchone()['ok']
        _reach(api, False)
        # Bound to WL, whatever context the request started in: the other company's client is not there.
        assert api.execute('select pulse.current_org() o').fetchone()['o'] == wl.org
        page = api.execute('select pulse.service_clients(%s,%s,null,200) p', (wl_key, digest)).fetchone()['p']
        assert page['items'] == []
    # A forged context: the actor says the WL key, the organisation says another company. Functions that trust the
    # transaction's actor still find the key only in current_org(), so they refuse.
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, other.org)
        api.execute("select set_config('pulse.actor_account',%s,true)", (f'service:{wl_key}',))
        api.execute("select pulse.service_update_request_list(%s,null,null,null,10)", (wl_key,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, other.org)
        api.execute("select set_config('pulse.actor_account',%s,true)", (f'service:{wl_key}',))
        api.execute("select pulse.service_key_catalog(%s)", (wl_key,))
    # A wrong secret for a real key id never binds data reads.
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        _reach(api)
        api.execute('select pulse.service_clients(%s,%s,null,10)', (wl_key, '0' * 64))


def test_revoked_and_expired_hosted_keys_fail(worker, owner, api):
    ea, wl = (build_world(worker, owner, api) for _ in range(2))
    revoked, r_digest = _key(owner, wl.org, 'Synthetic revoked')
    expired, e_digest = _key(owner, wl.org, 'Synthetic expired')
    with owner.transaction():
        _as_schema_owner(owner, wl.org)
        owner.execute('update pulse_priv.service_key set revoked_at=now() where id=%s', (revoked,))
        owner.execute("update pulse_priv.service_key set expires_at=now()-interval '1 minute' where id=%s", (expired,))
    for key_id, digest in ((revoked, r_digest), (expired, e_digest)):
        with api.transaction():
            _reach(api)
            assert api.execute('select pulse.service_key_hash(%s) h', (key_id,)).fetchone()['h'] is None
            assert not api.execute("select pulse.service_key_auth(%s,%s,'clients.read') ok", (key_id, digest)).fetchone()['ok']
            assert api.execute('select pulse.current_org() o').fetchone()['o'] is None
        assert _clients(api, key_id) == (None, None)
    # An unknown id with the flag on: nothing.
    with api.transaction():
        _reach(api)
        assert api.execute('select pulse.service_key_hash(%s) h', (uuid.uuid4(),)).fetchone()['h'] is None
