"""ACCEPT-SHARED (1625): a hosted company's client link, opened on the shared address, is found by its exact token hash and
runs in its own company; a company's own address and unknown tokens answer as before. Synthetic data only."""
import hashlib
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_erp_invoice import draft, issue, one, person, setup_company

FAKE_PDF = b"%PDF-1.4 synthetic accept-shared fixture"


def _as_schema_owner(owner, org):
    role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()['r']
    assert role.replace('_', '').isalnum()
    owner.execute(f'set local role {role}')
    set_tenant(owner, org)


def _company(worker, owner, api):
    w = build_world(worker, owner, api)
    w.founder = person(worker, w, "Synthetic Founder", "leadership")
    w.finance = person(worker, w, "Synthetic Finance", "finance")
    setup_company(api, w, w.founder)
    return w


def _token(label):
    """A raw link token (43 URL-safe characters, as the API issues) and its stored hash."""
    raw = (f"SyntheticAcceptShared{label}" + "x" * 43)[:43]
    return raw, hashlib.sha256(raw.encode()).hexdigest()


def _quote_link(api, owner, w, label, day="2026-04-02", pdf=True):
    q = draft(api, w, w.finance, "quotation", day=day)
    issue(api, w, w.finance, q)
    raw, h = _token(label)
    one(api, w, w.finance, "select pulse.erp_accept_link_create(%s,%s,30)", (q, h))
    if pdf:
        with owner.transaction():
            _as_schema_owner(owner, w.org)
            owner.execute("insert into pulse.erp_document_file(org_id,document_id,kind,bytes,sha256) values(%s,%s,'pdf',%s,%s)",
                          (w.org, q, FAKE_PDF, hashlib.sha256(FAKE_PDF).hexdigest()))
    return q, raw, h


def _reach(api, on=True):
    api.execute("select set_config('pulse.erp_accept_reach',%s,true)", ('1' if on else '',))


def _org(api):
    return api.execute('select pulse.current_org() o').fetchone()['o']


def test_hosted_link_opens_and_decides_in_its_own_company_on_the_shared_address(worker, owner, api):
    install, hosted = build_world(worker, owner, api), _company(worker, owner, api)  # the first world is the install
    q, _, h = _quote_link(api, owner, hosted, "Open")
    with api.transaction():
        set_tenant(api, install.org)
        _reach(api)
        seen = api.execute('select pulse.erp_accept_open(%s) r', (h,)).fetchone()['r']
        assert seen['canDecide'] and seen['number'] == 'QT/26-27/0001' and seen['buyer'] == 'Northstar Homes LLP'
        assert _org(api) == hosted.org
        assert api.execute("select current_setting('pulse.erp_accept_reach',true) f").fetchone()['f'] == ''
    with api.transaction():
        set_tenant(api, install.org)
        _reach(api)
        assert bytes(api.execute('select pulse.erp_accept_file(%s) b', (h,)).fetchone()['b']) == FAKE_PDF
    with api.transaction():
        set_tenant(api, install.org)
        _reach(api)
        r = api.execute("select pulse.erp_accept_decide(%s,'accepted','Synthetic Signer','Go ahead',%s,'test') r", (h, 'a' * 64)).fetchone()['r']
        assert r == {'decision': 'accepted', 'number': 'QT/26-27/0001'}
        assert _org(api) == hosted.org
    doc = one(api, hosted, hosted.finance, "select status,decision from pulse.erp_document where id=%s", (q,))
    assert doc['status'] == 'accepted' and doc['decision']['name'] == 'Synthetic Signer' and doc['decision']['via'] == 'link'
    with api.transaction():
        set_tenant(api, hosted.org, hosted.finance)
        kinds = [r['kind'] for r in api.execute('select kind from pulse.erp_event where subject_id=%s order by at', (q,)).fetchall()]
    assert kinds[-2:] == ['link_opened', 'client_accepted']
    # The install's own company has none of it.
    with owner.transaction():
        _as_schema_owner(owner, install.org)
        assert owner.execute('select count(*) n from pulse.erp_event where subject_id=%s', (q,)).fetchone()['n'] == 0
    # Answered once only, from the shared address too.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match='already answered'), api.transaction():
        set_tenant(api, install.org)
        _reach(api)
        api.execute("select pulse.erp_accept_decide(%s,'declined','Synthetic Signer',null,%s,'test')", (h, 'a' * 64))


def test_wrong_or_unknown_tokens_and_own_addresses_answer_as_before(worker, owner, api):
    install, hosted, other = build_world(worker, owner, api), _company(worker, owner, api), _company(worker, owner, api)
    q, _, h = _quote_link(api, owner, hosted, "Wrong")
    unknown = hashlib.sha256(b'synthetic-unknown-token').hexdigest()
    # Another company's own address (no reach flag): not found, and the request stays in that company.
    for ctx in (other.org, install.org):
        with api.transaction():
            set_tenant(api, ctx)
            assert api.execute('select pulse.erp_accept_open(%s) r', (h,)).fetchone()['r'] is None
            assert api.execute('select pulse.erp_accept_file(%s) b', (h,)).fetchone()['b'] is None
            assert _org(api) == ctx
        with pytest.raises(psycopg.errors.InvalidParameterValue, match='expired; ask for a new one'), api.transaction():
            set_tenant(api, ctx)
            api.execute("select pulse.erp_accept_decide(%s,'accepted','Synthetic Signer',null,%s,'test')", (h, 'a' * 64))
    # Unknown or malformed tokens on the shared address: exactly the old answers, and the request does not move.
    for bad in (unknown, '0' * 64, 'not-a-hash', None):
        with api.transaction():
            set_tenant(api, install.org)
            _reach(api)
            assert api.execute('select pulse.erp_accept_open(%s) r', (bad,)).fetchone()['r'] is None
            _reach(api)
            assert api.execute('select pulse.erp_accept_file(%s) b', (bad,)).fetchone()['b'] is None
            assert _org(api) == install.org
        with pytest.raises(psycopg.errors.InvalidParameterValue, match='expired; ask for a new one'), api.transaction():
            set_tenant(api, install.org)
            _reach(api)
            api.execute("select pulse.erp_accept_decide(%s,'accepted','Synthetic Signer',null,%s,'test')", (bad, 'a' * 64))
    # The hosted company's own address still works without the flag (unchanged behaviour).
    with api.transaction():
        set_tenant(api, hosted.org)
        assert api.execute('select pulse.erp_accept_open(%s) r', (h,)).fetchone()['r']['number'] == 'QT/26-27/0001'
    # Revoked or expired hosted links answer as they always did, from the shared address too.
    with owner.transaction():
        _as_schema_owner(owner, hosted.org)
        owner.execute("update pulse.erp_accept_link set expires_at=now()-interval '1 minute' where token_hash=%s", (h,))
    with api.transaction():
        set_tenant(api, install.org)
        _reach(api)
        assert api.execute('select pulse.erp_accept_open(%s) r', (h,)).fetchone()['r'] is None
    with pytest.raises(psycopg.errors.InvalidParameterValue, match='expired; ask for a new one'), api.transaction():
        set_tenant(api, install.org)
        _reach(api)
        api.execute("select pulse.erp_accept_decide(%s,'accepted','Synthetic Signer',null,%s,'test')", (h, 'a' * 64))


def test_a_company_cannot_list_or_see_another_companys_links(worker, owner, api):
    install, a, b = build_world(worker, owner, api), _company(worker, owner, api), _company(worker, owner, api)
    _, _, ha = _quote_link(api, owner, a, "CompanyA")
    _, _, hb = _quote_link(api, owner, b, "CompanyB")
    with api.transaction():
        set_tenant(api, a.org, a.finance)
        assert [r['token_hash'] for r in api.execute('select token_hash from pulse.erp_accept_link').fetchall()] == [ha]
        # Setting the lookup's own settings by hand shows nothing more: the lookup policy is the definer's only.
        api.execute("select set_config('pulse.erp_accept_find',%s,true)", (hb,))
        _reach(api)
        assert [r['token_hash'] for r in api.execute('select token_hash from pulse.erp_accept_link').fetchall()] == [ha]
        assert api.execute('select count(*) n from pulse.erp_accept_link where token_hash=%s', (hb,)).fetchone()['n'] == 0
    # The service role cannot call the lookup itself.
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, a.org)
        api.execute('select pulse.erp_accept_bind(%s)', (hb,))
    # After a lookup, the owner role in a foreign context sees nothing of the other company.
    with owner.transaction():
        _as_schema_owner(owner, a.org)
        owner.execute("select set_config('pulse.erp_accept_reach','1',true)")
        assert owner.execute('select count(*) n from pulse.erp_accept_link where token_hash=%s', (hb,)).fetchone()['n'] == 0


def test_http_open_file_and_decide_on_the_shared_address(worker, owner, api):
    install, hosted, other = build_world(worker, owner, api), _company(worker, owner, api), _company(worker, owner, api)
    q, raw, _ = _quote_link(api, owner, hosted, "Http")
    for w, host in ((hosted, 'accept-hosted.synthetic.example'), (other, 'accept-other.synthetic.example')):
        with owner.transaction():
            set_tenant(owner, w.org)
            owner.execute("insert into pulse.org_domain(org_id,host,sign_in,added_by) values(%s,%s,'password','synthetic')", (w.org, host))
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_TOKEN': raw, 'TEST_PDF': FAKE_PDF.decode(),
           'TEST_HOSTED_HOST': 'accept-hosted.synthetic.example', 'TEST_OTHER_HOST': 'accept-other.synthetic.example'}
    result = subprocess.run(['node', 'test/accept-shared-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api',
                            env=env, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    doc = one(api, hosted, hosted.finance, "select status,decision from pulse.erp_document where id=%s", (q,))
    assert doc['status'] == 'accepted' and doc['decision']['name'] == 'Synthetic Signer'
