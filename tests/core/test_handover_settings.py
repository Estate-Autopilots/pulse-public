"""Synthetic allocator races and real staff API/proxy boundaries; no outgoing hand-overs."""
import json
import os
import subprocess
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row
from conftest import dsn
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_site_visit_settings import people, _config, _person  # noqa: F401
from test_tasks_rt1 import one

SAVE = "select pulse.handover_settings(%s,%s,%s) s"
INSERT = "insert into pulse.client(org_id,display_name) values(%s,'Synthetic customer') returning id,customer_code"


def test_allocator_lifecycle(api, worker, owner, people):
    w = people
    run = lambda q, a=(): one(api, w, w.admin, q, a)
    initial = run("select pulse.handover_settings() s")["s"]
    assert initial == dict(version=0, approvedAccountIds=[], customerCodePrefix=None, prefixLocked=False, configured=False)
    ids = [run(INSERT, (w.org,))["id"] for _ in range(2)]
    with pytest.raises(RuntimeError), api.transaction():
        set_tenant(api, w.org, w.admin)
        api.execute(SAVE, (0, ["synthetic.account"], "WL"))
        raise RuntimeError("Synthetic rollback")
    assert run("select pulse.handover_settings() s")["s"] == initial
    assert run("select count(*) n from pulse.client where customer_code is not null")["n"] == 0
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse_priv.handover_setting(org_id,next_code) values(%s,9999999)", (w.org,))
    with pytest.raises(psycopg.errors.ProgramLimitExceeded):
        run(SAVE, (0, ["synthetic.account"], "WL"))
    assert run("select pulse.handover_settings() s")["s"] == initial
    assert run("select count(*) n from pulse.client where customer_code is not null")["n"] == 0
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse_priv.handover_setting set next_code=1 where org_id=%s", (w.org,))
    saved = run(SAVE, (0, ["synthetic.account"], "WL"))["s"]
    assert saved["version"] == 1 and saved["prefixLocked"] and saved["configured"]
    assert run("select array_agg(customer_code order by created_at,id) codes from pulse.client")["codes"] == ["WL-000001", "WL-000002"]
    for version, prefix, message in [(0, "WL", "settings_changed"), (1, "XX", "prefix_locked"), (1, None, "prefix_locked")]:
        with pytest.raises(psycopg.errors.SerializationFailure, match=message):
            run(SAVE, (version, [], prefix))
    for q, args in [("update pulse.client set customer_code='WL-123456' where id=%s", (ids[0],)),
                    ("update pulse.client set customer_code=null where id=%s", (ids[0],)),
                    ("insert into pulse.client(org_id,display_name,customer_code) values(%s,'Synthetic','WL-900000')", (w.org,))]:
        with pytest.raises(psycopg.errors.CheckViolation):
            run(q, args)
    other = build_world(worker, owner, api)
    with pytest.raises(psycopg.errors.CheckViolation):
        run("update pulse.client set org_id=%s where id=%s", (other.org, ids[0]))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("delete from pulse.client where id=%s", (ids[0],))
    run(SAVE, (1, [], "WL"))
    assert run(INSERT, (w.org,))["customer_code"] == "WL-000003"
    with pytest.raises(RuntimeError), api.transaction():
        set_tenant(api, w.org, w.admin)
        api.execute(INSERT, (w.org,))
        raise RuntimeError("Synthetic insert rollback")
    assert run(INSERT, (w.org,))["customer_code"] == "WL-000004"
    cid = uuid.uuid4()
    run("select pulse.company_fill_project(%s,%s,%s,'Synthetic Drive customer',null)", (w.project, "drive-path-client:synthetic", cid))
    assert run("select customer_code from pulse.client where id=%s", (cid,))["customer_code"] == "WL-000005"
    for who, world in [(w.member, w), (other.manager, other)]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            one(api, world, who, "select pulse.handover_settings()")
    for q in ["select * from pulse_priv.handover_setting", "select pulse.handover_sender_error('synthetic.account')"]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            run(q)
    kid, digest = uuid.uuid4(), "0" * 64
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse_priv.service_key(id,org_id,key_hash,scopes,label) values(%s,%s,%s,'{catalog.read}','Synthetic')", (kid, w.org, digest))
    def sender(account):
        with api.transaction():
            assert api.execute("select pulse.service_key_auth(%s,%s,'catalog.read') ok", (kid, digest)).fetchone()["ok"]
            return api.execute("select pulse.handover_sender_error(%s) error", (account,)).fetchone()["error"]
    assert sender("synthetic.account") == "handover_not_configured"
    run(SAVE, (2, ["synthetic.account"], "WL"))
    assert sender("synthetic.account") is None
    assert sender("unknown") == "sender_not_approved" and sender(None) == "sender_not_approved"
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse_priv.handover_setting set next_code=1000000 where org_id=%s", (w.org,))
    assert run(INSERT, (w.org,))["customer_code"] == "WL-1000000"
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse_priv.handover_setting set next_code=9999999 where org_id=%s", (w.org,))
    assert run(INSERT, (w.org,))["customer_code"] == "WL-9999999"
    with pytest.raises(psycopg.errors.ProgramLimitExceeded):
        run(INSERT, (w.org,))


def test_configuration_insert_races(api, admin, people):
    w = people
    with psycopg.connect(dsn("api"), autocommit=True, row_factory=dict_row) as second, ThreadPoolExecutor(max_workers=2) as jobs:
        def save():
            return one(second, w, w.admin, SAVE, (0, ["synthetic"], "WL"))
        def blocked(future):
            until = time.monotonic() + 5
            while time.monotonic() < until:
                if admin.execute("select cardinality(pg_blocking_pids(%s)) n", (second.info.backend_pid,)).fetchone()["n"]:
                    assert not future.done()
                    return
                time.sleep(.01)
            pytest.fail("Second connection did not wait on the allocator lock")
        with api.transaction():
            set_tenant(api, w.org, w.admin)
            first = api.execute(INSERT, (w.org,)).fetchone()
            assert first["customer_code"] is None
            pending = jobs.submit(save)
            blocked(pending)
        assert pending.result(timeout=5)["s"]["prefixLocked"]
        with api.transaction():
            set_tenant(api, w.org, w.admin)
            api.execute(SAVE, (1, ["synthetic"], "WL"))
            pending = jobs.submit(one, second, w, w.admin, INSERT, (w.org,))
            blocked(pending)
        assert pending.result(timeout=5)["customer_code"] == "WL-000002"
        def insert(c):
            return one(c, w, w.admin, INSERT, (w.org,))["customer_code"]
        futures = [jobs.submit(insert, c) for c in (api, second)]
        assert sorted(f.result(timeout=5) for f in futures) == ["WL-000003", "WL-000004"]
        futures = [jobs.submit(one, c, w, w.admin, SAVE, (2, ["synthetic"], "WL")) for c in (api, second)]
        results = []
        for f in futures:
            try:
                results.append(f.result(timeout=5)["s"]["version"])
            except psycopg.errors.SerializationFailure:
                results.append("settings_changed")
        assert sorted(map(str, results)) == ["3", "settings_changed"]


API = r'''
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
import { createApiProxy, v0ProxyOptions } from '../../apps/web/app/api/proxy.mjs';
const pool=new Pool({...JSON.parse(process.env.TEST_API_CONFIG),max:2}), app=createApp(pool,pool), path='/api/v0/integrations/handovers/settings';
const admin={'cf-access-authenticated-user-email':process.env.TEST_ADMIN,origin:process.env.PULSE_PUBLIC_URL};
const call=(payload,headers=admin,url=path)=>app.inject({url,method:payload===undefined?'GET':'POST',headers,...(payload===undefined?{}:{payload})});
try {
  const initial=await call(); assert.equal(initial.statusCode,200);
  assert.deepEqual(initial.json(),{version:0,approvedAccountIds:[],customerCodePrefix:null,prefixLocked:false,configured:false});
  const body={version:0,approvedAccountIds:['synthetic'],customerCodePrefix:'WL'};
  for(const bad of [null,[],{}, {...body,version:'0'}, {...body,version:-1}, {...body,version:1.5}, {...body,org:'foreign'}, {...body,approvedAccountIds:[null]}, {...body,approvedAccountIds:'synthetic'},
    {...body,approvedAccountIds:['same','same']},{...body,approvedAccountIds:Array.from({length:6},(_,i)=>'synthetic'+i)}, {...body,approvedAccountIds:['invalid space']},
    {...body,approvedAccountIds:['synthetic\n']}, {...body,customerCodePrefix:'WL\n'},
    {...body,customerCodePrefix:'W'}, {...body,customerCodePrefix:'lower'}, {...body,customerCodePrefix:'TOOLONG'}, {...body,customerCodePrefix:'WL-'}]) {
    const r=await call(bad); assert.equal(r.statusCode,422,r.body); assert.equal(r.json().error,'invalid'); assert.ok(r.json().fields.length);
  }
  for(const headers of [{}, {'cf-access-authenticated-user-email':process.env.TEST_MEMBER}, {...admin,authorization:'Bearer psvc_invalid'},
    {...admin,authorization:'Bearer pcat_invalid'}, {...admin,authorization:'Bearer '+'x'.repeat(43)}, {...admin,'x-pulse-agent-key':'pak_invalid'}])
    for(const b of [undefined,body]) { const r=await call(b,headers); assert.ok([401,403].includes(r.statusCode),r.body); assert.equal(r.headers['cache-control'],'private, no-store'); }
  assert.equal((await call(body,{...admin,origin:'https://foreign.example'})).statusCode,403);
  assert.equal((await call(body,{})).statusCode,401,'anonymous POST authenticates before CSRF');
  const {origin,...withoutOrigin}=admin; assert.equal((await call(body,withoutOrigin)).statusCode,403);
  assert.equal((await call(undefined,admin,path+'?org=foreign')).statusCode,400);
  for(const b of [undefined,body]) assert.equal((await call(b,{...admin,'x-pulse-host':'handover-other.example','cf-access-authenticated-user-email':process.env.TEST_FOREIGN_ADMIN})).statusCode,403);
  assert.equal((await call(body)).statusCode,200);
  const customer=await app.inject({url:'/api/v0/clients',method:'POST',headers:admin,payload:{displayName:'Synthetic manual customer'}});
  assert.equal(customer.statusCode,200,customer.body); assert.equal(customer.json().customerCode,'WL-000001');
  assert.equal((await call(body)).json().error,'settings_changed');
  assert.equal((await call({...body,version:1,customerCodePrefix:'XX'})).json().error,'prefix_locked');
  let forwarded=0;
  const proxy=createApiProxy({...v0ProxyOptions,hostLookup:async()=>({own:true,signIn:'access'}),fetchImpl:async(url,opts)=>{
    forwarded++; return new Response((await app.inject({url:path,method:opts.method,headers:opts.headers,...(opts.body?{payload:opts.body}:{})})).body,{headers:{'content-type':'application/json'}});
  }});
  for(const [method,extra,status] of [['POST',{origin:'https://foreign.example'},403],['POST',{},403],['GET',{authorization:'Bearer psvc_invalid'},403],
    ['GET',{'x-pulse-agent-key':'pak_invalid'},401],['PUT',{origin},405]]) {
    const r=await proxy(new Request(origin+path,{method,headers:{host:'synthetic.example',...admin,...extra,...(method==='POST'&&!Object.keys(extra).length?{origin:''}:{})}}),{params:Promise.resolve({path:['integrations','handovers','settings']})});
    assert.equal(r.status,status); assert.equal(r.headers.get('cache-control'),'private, no-store');
  }
  assert.equal(forwarded,0);
  const encoded=await proxy(new Request(origin+path,{headers:{host:'synthetic.example',...admin,authorization:'Bearer device'}}),{params:Promise.resolve({path:['%69ntegrations','handovers','settings']})});
  assert.equal(encoded.status,403); assert.equal(encoded.headers.get('cache-control'),'private, no-store');
  const r=await proxy(new Request(origin+path,{method:'POST',headers:{host:'synthetic.example',...admin},body:JSON.stringify({...body,version:1})}),{params:Promise.resolve({path:['integrations','handovers','settings']})});
  assert.equal(r.status,200); assert.equal((await r.json()).version,2); assert.equal(forwarded,1);
} finally {await app.close(); await pool.end();}
'''


def test_staff_api_and_proxy(people, worker, owner, api):
    foreign = build_world(worker, owner, api)
    _person(worker, foreign, "Synthetic foreign admin", "admin", "admin")
    with owner.transaction():
        set_tenant(owner, foreign.org)
        owner.execute("insert into pulse.org_domain(org_id,host,sign_in,added_by) values(%s,'handover-other.example','access','synthetic')", (foreign.org,))
    env = {**os.environ, "TEST_API_CONFIG": _config(dsn("api")), "TEST_ADMIN": f"admin@{people.domain}",
           "TEST_FOREIGN_ADMIN": f"admin@{foreign.domain}",
           "TEST_MEMBER": f"member@{people.domain}", "PULSE_PUBLIC_URL": "https://synthetic.example", "PULSE_PUBLIC_LOGIN_ENABLED": "0"}
    result = subprocess.run(["node", "--input-type=module", "-e", API], cwd=Path(__file__).resolve().parents[2] / "services/api",
                            env=env, capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, (result.stdout + result.stderr)[-4000:]
