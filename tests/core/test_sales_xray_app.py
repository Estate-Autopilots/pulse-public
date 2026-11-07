"""EST-1363 (0710): the Sales X-Ray app's records belong to one staff person in one company.

pulse.sales_xray is the API's only way in. A person's link, their Connect attempts and their status are their own:
a colleague (even an admin) and another company see nothing; an attempt works once, for the person who started it;
only sealed values are stored; nobody without a staff record gets in. Synthetic tenants and values only.
"""
import json
import uuid

import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_account_security import command, hashof

BASE, BACK = 'https://salesxray.example.test', 'https://pulse.example.test/apps/sales-xray/callback'
BOX = {'k': 'k1', 'w': 'd3JhcHBlZA==', 'd': 'c2VhbGVk'}


def staff(worker, org, name):
    person = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (person, org, name))
    return person


def sx(api, w, viewer, op, body=None):
    return command(api, w, 'pulse.sales_xray(%s,%s)', (op, json.dumps(body or {})), viewer)


def save(api, w, viewer, base=BASE):
    return sx(api, w, viewer, 'save', {'base': base, 'redirectUri': BACK, 'access': BOX, 'accessExpiresAt': '2030-01-01T00:00:00Z', 'refresh': BOX,
                                       'scopes': ['calls:read', 'leads:read'], 'account': {'person': 'Fictional Seller', 'workspace': 'Fictional Homes', 'kind': 'organisation', 'role': 'member'}})


def test_a_link_is_the_persons_own(worker, owner, api):
    w, other = build_world(worker, owner, api), build_world(worker, owner, api)
    seller, colleague, stranger = staff(worker, w.org, 'Synthetic Seller'), staff(worker, w.org, 'Synthetic Colleague'), staff(worker, other.org, 'Synthetic Stranger')
    assert sx(api, w, seller, 'status') == {'connected': False}
    assert sx(api, w, seller, 'link') is None

    assert save(api, w, seller) == {'ok': True, 'fresh': True}
    status = sx(api, w, seller, 'status')
    assert status['connected'] is True and status['account']['workspace'] == 'Fictional Homes'
    assert 'access' not in status and 'refresh' not in status, 'status never carries a sealed value'
    link = sx(api, w, seller, 'lock')
    assert link['access'] == BOX and link['redirectUri'] == BACK and link['scopes'] == ['calls:read', 'leads:read']
    assert save(api, w, seller)['fresh'] is False

    # Nobody else reads it: a colleague, the company's admin, another company's person.
    assert sx(api, w, colleague, 'link') is None and sx(api, w, colleague, 'status') == {'connected': False}
    boss = staff(worker, w.org, 'Synthetic Admin')
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, boss))
    assert sx(api, w, boss, 'link') is None
    assert sx(api, other, stranger, 'link') is None

    assert sx(api, w, seller, 'refreshed', {'access': {**BOX, 'k': 'k2'}, 'accessExpiresAt': '2031-01-01T00:00:00Z', 'refresh': BOX}) == {'ok': True}
    assert sx(api, w, seller, 'link')['access']['k'] == 'k2'
    assert sx(api, w, seller, 'drop') == {'ok': True}
    assert sx(api, w, seller, 'status') == {'connected': False}
    with owner.transaction():
        set_tenant(owner, w.org)
        actions = [r['action'] for r in owner.execute("select action from pulse.audit_event where org_id=%s and resource='sales_xray_link' order by at", (w.org,)).fetchall()]
    assert actions == ['sales_xray_connected', 'sales_xray_connected', 'sales_xray_disconnected']


def test_an_attempt_works_once_for_the_person_who_started_it(worker, owner, api):
    w = build_world(worker, owner, api)
    seller, colleague = staff(worker, w.org, 'Synthetic Seller'), staff(worker, w.org, 'Synthetic Colleague')
    state = hashof('synthetic-state')
    begun = {'stateHash': state, 'verifier': 'v' * 64, 'base': BASE, 'redirectUri': BACK}
    assert sx(api, w, seller, 'begin', begun) == {'ok': True}
    assert sx(api, w, colleague, 'take', {'stateHash': state}) == {'error': 'state_invalid'}, 'a state carried to another session finds nothing'
    assert sx(api, w, seller, 'take', {'stateHash': state}) == {'verifier': 'v' * 64, 'base': BASE, 'redirectUri': BACK}
    assert sx(api, w, seller, 'take', {'stateHash': state}) == {'error': 'state_invalid'}
    with pytest.raises(psycopg.errors.CheckViolation):
        sx(api, w, seller, 'begin', {**begun, 'stateHash': 'not-a-hash'})


def test_the_registered_client_is_per_company_and_only_sealed(worker, owner, api):
    w, other = build_world(worker, owner, api), build_world(worker, owner, api)
    seller, stranger = staff(worker, w.org, 'Synthetic Seller'), staff(worker, other.org, 'Synthetic Stranger')
    client = {'base': BASE, 'redirectUri': BACK, 'clientId': 'sxc_' + 'A' * 24, 'secret': BOX}
    assert sx(api, w, seller, 'client', client) is None
    assert sx(api, w, seller, 'client_save', client) == {'clientId': 'sxc_' + 'A' * 24, 'secret': BOX}
    assert sx(api, w, seller, 'client_save', {**client, 'clientId': 'sxc_' + 'Z' * 24})['clientId'] == 'sxc_' + 'A' * 24, 'the first registration stays'
    assert sx(api, other, stranger, 'client', client) is None
    with pytest.raises(psycopg.errors.CheckViolation):
        sx(api, w, seller, 'client_save', {**client, 'redirectUri': BACK + '/x', 'secret': {'plain': 'sxcs_secret'}})


def test_only_an_active_staff_person_gets_in(worker, owner, api):
    w = build_world(worker, owner, api)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        sx(api, w, None, 'status')
    leaver = staff(worker, w.org, 'Synthetic Leaver')
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.person set status='inactive' where id=%s", (leaver,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        sx(api, w, leaver, 'status')
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        sx(api, w, staff(worker, w.org, 'Synthetic Seller'), 'sideways')
