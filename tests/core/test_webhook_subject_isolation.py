"""EST-2189: migrated PG17 sender authorization, real tenant roles, synthetic quotations.

No HTTP is sent: dispatch is the last SQL authorization before the unchanged sender.
Run with test_install_events.py for capture, lease, dedup, ordering and retry coverage.
"""
import json
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import psycopg
import pytest
from conftest import _connect
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_install_events import erp, issued, mark, own, publish  # noqa: F401


def endpoint(owner, w, subjects):
    return own(owner, w, """insert into pulse_priv.webhook_endpoint
        (org_id,url,events,key_id,signing_secret,quotation_subject_ids)
        values(%s,'https://synthetic.invalid/hooks',array['quote.sent'],'test',repeat('x',32),%s::uuid[])
        returning id""", (w.org, subjects))[0]['id']


def due(conn):
    return conn.execute('select pulse.install_event_due(10) r').fetchone()['r']


def dispatch(conn, job):
    return conn.execute('select pulse.install_event_dispatch(%s,%s) r', (job['id'], job['lease'])).fetchone()['r']


def untouched(owner, w, subjects):
    rows = own(owner, w, """select status,attempts,endpoint_id,lease_token,raw_body,
        (select count(*) from pulse_priv.webhook_delivery d where d.event_id=e.id) deliveries
        from pulse_priv.install_event e where org_id=%s and subject_id=any(%s::uuid[])""", (w.org, subjects))
    assert rows
    assert all(tuple(r.values()) == ('pending', 0, None, None, None, 0) for r in rows)


def wait_locked(observer, pid):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if observer.execute('select cardinality(pg_blocking_pids(%s)) n', (pid,)).fetchone()['n']:
            return
        time.sleep(0.01)
    pytest.fail('authorization/policy writer did not wait on the endpoint lock')


def test_empty_preflight_and_capture_after_atomic_activation(api, owner, worker, erp):  # noqa: F811
    w = erp
    assert 170000 <= int(worker.info.server_version) < 180000
    fixture, before, after = [issued(api, w) for _ in range(3)]
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute('select id from pulse_priv.install_event where org_id=%s for update', (w.org,)).fetchall() == []
        mark(api, w, before, 'sent')  # commits during the empty FOR UPDATE preflight
        endpoint(owner, w, [fixture])  # activation includes restriction in the same transaction
    mark(api, w, after, 'sent')
    mark(api, w, fixture, 'sent')
    assert publish(worker) == 3 and publish(worker) == 0  # business capture/publish still works
    jobs = due(worker)
    assert len(jobs) == 1
    body = json.loads(dispatch(worker, jobs[0])['body'])
    assert body['subject'] == {'kind': 'quotation', 'id': str(fixture)}
    assert due(worker) == []
    untouched(owner, w, [before, after])


def test_publication_and_two_drains_never_lock_or_claim_business(api, owner, worker, erp):  # noqa: F811
    w = erp
    fixtures = [issued(api, w) for _ in range(2)]
    business = issued(api, w)
    endpoint(owner, w, fixtures)
    for q in [*fixtures, business]:
        mark(api, w, q, 'sent')
    barrier = Barrier(2)

    def drain():
        with _connect('worker') as c, c.transaction():
            c.execute("set local statement_timeout='5s'")
            jobs = due(c)
            barrier.wait(timeout=5)  # both drains keep their event locks until both have claimed
            return jobs

    with ThreadPoolExecutor(max_workers=2) as pool:
        with worker.transaction():
            assert publish(worker) == 3  # unpublished to either concurrent drain until commit
            futures = [pool.submit(drain) for _ in range(2)]
            assert [f.result(timeout=6) for f in futures] == [[], []]
        with owner.transaction():
            set_tenant(owner, w.org)
            owner.execute('select id from pulse_priv.install_event where subject_id=%s for update', (business,))
            futures = [pool.submit(drain) for _ in range(2)]
            jobs = [j for f in futures for j in f.result(timeout=6)]
    assert len(jobs) == 2 and len({j['id'] for j in jobs}) == 2
    assert {json.loads(dispatch(worker, j)['body'])['subject']['id'] for j in jobs} == {str(q) for q in fixtures}
    untouched(owner, w, [business])


@pytest.mark.parametrize('change', ['narrow', 'disable', 'replace', 'cleanup'])
def test_current_policy_rechecked_between_claim_and_dispatch(api, owner, worker, erp, change):  # noqa: F811
    w = erp
    fixture, business = issued(api, w), issued(api, w)
    ep = endpoint(owner, w, [fixture])
    for q in (fixture, business):
        mark(api, w, q, 'sent')
    publish(worker)
    job, = due(worker)
    assert dispatch(worker, job) is not None
    with owner.transaction():
        set_tenant(owner, w.org)
        if change == 'narrow':
            owner.execute("update pulse_priv.webhook_endpoint set quotation_subject_ids='{}' where id=%s", (ep,))
        else:
            owner.execute('update pulse_priv.webhook_endpoint set disabled_at=now() where id=%s', (ep,))
            if change == 'replace':
                endpoint(owner, w, [fixture])
            if change == 'cleanup':
                # Teardown retains restriction and history; repeated cleanup is safe.
                owner.execute('update pulse_priv.webhook_endpoint set disabled_at=coalesce(disabled_at,now()) where id=%s', (ep,))
    assert dispatch(worker, job) is None and due(worker) == []
    assert own(owner, w, 'select quotation_subject_ids from pulse_priv.webhook_endpoint where id=%s', (ep,))[0]['quotation_subject_ids'] is not None
    assert len(own(owner, w, 'select id from pulse_priv.webhook_delivery where endpoint_id=%s', (ep,))) == 1
    untouched(owner, w, [business])


def test_empty_invalid_lists_wrong_kind_and_normal_null_policy(api, owner, worker, erp):  # noqa: F811
    w = erp
    fixture, business = issued(api, w), issued(api, w)
    ep = endpoint(owner, w, [])
    for q in (fixture, business):
        mark(api, w, q, 'sent')
    # Synthetic non-quotation subject with the SAME UUID must not match a restricted endpoint.
    own(owner, w, """insert into pulse_priv.install_event(org_id,type,subject_kind,subject_id,dedup_key,data,occurred_at)
        values(%s,'quote.sent','task',%s,'synthetic-wrong-kind','{}',now())""", (w.org, fixture))
    publish(worker)
    assert due(worker) == []
    untouched(owner, w, [fixture, business])
    for invalid in ([fixture, None], [[fixture, business]]):
        with pytest.raises(psycopg.errors.CheckViolation):
            own(owner, w, 'update pulse_priv.webhook_endpoint set quotation_subject_ids=%s::uuid[] where id=%s', (invalid, ep))
    own(owner, w, 'update pulse_priv.webhook_endpoint set quotation_subject_ids=%s::uuid[] where id=%s', ([fixture], ep))
    job, = due(worker)
    assert json.loads(dispatch(worker, job)['body'])['subject']['kind'] == 'quotation'
    untouched(owner, w, [business])
    own(owner, w, 'update pulse_priv.webhook_endpoint set quotation_subject_ids=null where id=%s', (ep,))
    jobs = due(worker)
    bodies = [json.loads(dispatch(worker, j)['body']) for j in jobs]
    assert {(b['subject']['kind'], b['subject']['id']) for b in bodies} == {('task', str(fixture)), ('quotation', str(business))}


def test_missing_disabled_other_tenant_and_expiry_scope(api, owner, worker, erp):  # noqa: F811
    w, other = erp, build_world(worker, owner, api)
    fixture, business = issued(api, w), issued(api, w)
    for q in (fixture, business):
        mark(api, w, q, 'sent')
    publish(worker)
    assert due(worker) == []
    endpoint(owner, other, None)
    assert due(worker) == []
    own(owner, other, """insert into pulse_priv.install_event(org_id,type,subject_kind,subject_id,dedup_key,data,occurred_at,
        sequence,published_at,next_at) values(%s,'quote.sent','quotation',%s,'synthetic-tenant','{}',now(),1,now(),now())""", (other.org, fixture))
    ep = endpoint(owner, w, [fixture])
    own(owner, w, 'update pulse_priv.webhook_endpoint set disabled_at=now() where id=%s', (ep,))
    assert due(worker) == []
    untouched(owner, w, [fixture, business])
    own(owner, w, 'update pulse_priv.webhook_endpoint set disabled_at=null where id=%s', (ep,))
    # An excluded fifth-attempt row must not be changed even by expiry maintenance.
    own(owner, w, "update pulse_priv.install_event set attempts=5,lease_until=now()-interval '1s' where org_id=%s", (w.org,))
    assert due(worker) == []
    states = own(owner, w, 'select subject_id,status,attempts from pulse_priv.install_event where org_id=%s', (w.org,))
    assert {(r['subject_id'], r['status'], r['attempts']) for r in states} == {(fixture, 'dead_letter', 5), (business, 'pending', 5)}
    untouched(owner, other, [fixture])


@pytest.mark.parametrize('operation', ['claim', 'dispatch'])
def test_policy_writer_waits_for_authorization_transaction(api, owner, worker, erp, operation):  # noqa: F811
    w = erp
    fixture = issued(api, w)
    ep = endpoint(owner, w, [fixture])
    mark(api, w, fixture, 'sent')
    publish(worker)
    job = due(worker)[0] if operation == 'dispatch' else None
    with _connect('owner') as writer, ThreadPoolExecutor(max_workers=1) as pool:
        def narrow():
            writer.execute("set statement_timeout='5s'")
            return own(writer, w, "update pulse_priv.webhook_endpoint set quotation_subject_ids='{}' where id=%s", (ep,))
        with worker.transaction():
            authorized = due(worker) if operation == 'claim' else dispatch(worker, job)
            assert authorized
            future = pool.submit(narrow)
            wait_locked(owner, writer.info.backend_pid)
            assert not future.done()
        future.result(timeout=6)
    if job is None:
        job = authorized[0]
    assert dispatch(worker, job) is None


@pytest.mark.parametrize('operation', ['claim', 'dispatch'])
def test_authorization_waits_and_observes_committed_policy(api, owner, worker, erp, operation):  # noqa: F811
    w = erp
    fixture = issued(api, w)
    ep = endpoint(owner, w, [fixture])
    mark(api, w, fixture, 'sent')
    publish(worker)
    job = due(worker)[0] if operation == 'dispatch' else None
    with _connect('worker') as sender, ThreadPoolExecutor(max_workers=1) as pool:
        sender.execute("set statement_timeout='5s'")
        with owner.transaction():
            set_tenant(owner, w.org)
            owner.execute("update pulse_priv.webhook_endpoint set quotation_subject_ids='{}' where id=%s", (ep,))
            future = pool.submit(due, sender) if operation == 'claim' else pool.submit(dispatch, sender, job)
            wait_locked(owner, sender.info.backend_pid)
            assert not future.done()
        assert future.result(timeout=6) == ([] if operation == 'claim' else None)
    if operation == 'claim':
        untouched(owner, w, [fixture])
