import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { serviceProxy } from '../../../apps/web/app/lib/service-proxy.mjs';
import { v1ProxyOptions } from '../../../apps/web/app/api/proxy.mjs';
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 1 }), app = createApp(pool,pool);
const people = JSON.parse(process.env.TEST_PEOPLE), badPeople = JSON.parse(process.env.TEST_BAD_PEOPLE);
const service = (url,method,headers,payload) => app.inject({url:'/api/v1/service/'+url,method,headers,payload});
const staff = (url,person,method='GET',payload) => app.inject({url:'/api/v1/'+url,method,headers:{'cf-access-authenticated-user-email':people[person].email},payload});
const issue = async scopes => {
  const id = randomUUID(), secret = randomBytes(32).toString('base64url');
  const r = await app.inject({method:'POST',url:'/api/v1/operator/service-keys',headers:{authorization:`Bearer ${process.env.PULSE_OPERATOR_TOKEN}`},
    payload:{action:'issue',id,hash:createHash('sha256').update(secret).digest('hex'),scopes,label:'Synthetic register manager'}});
  assert.equal(r.statusCode,200,r.body); return {authorization:`Bearer psvc_${id}_${secret}`};
};
try {
  if (process.env.TEST_HISTORY_ID) {
    const r = await staff(`updates/${process.env.TEST_HISTORY_ID}/requests`,'a');
    assert.equal(r.statusCode,200,r.body); assert.deepEqual(r.json().items,[]);
  } else {
    const key = await issue(['updates.requests.manage']), poster = await issue(['updates.post']);
    const post = body => service('update-requests','POST',key,body);
    const set = (id,body) => service(`update-requests/${id}/progress`,'POST',key,body);
    const update = {slot:'2026-10-18-am',headline:'Synthetic update',sections:{},audience:[people.a.id,people.b.id],onBehalfOf:people.sender.id};
    for (const [path,method,body] of [['update-requests','GET'],['update-requests','POST',{ref:'scope-test',askedBy:people.a.id,onBehalfOf:people.sender.id,source:'task',text:'x'}],[`update-requests/${randomUUID()}/progress`,'POST',{status:'planned'}]]) assert.equal((await service(path,method,poster,body)).statusCode,403);
    for (const path of ['updates',`chats/${randomUUID()}/messages`]) assert.equal((await service(path,'POST',key,path==='updates'?update:{text:'x'})).statusCode,403);
    const first = await service('updates','POST',poster,update); assert.equal(first.statusCode,201,first.body); const uid=first.json().updateId;
    for (const person of ['outside','admin']) for (const suffix of ['reply','requests']) assert.equal((await staff(`updates/${uid}/${suffix}`,person,suffix==='reply'?'POST':'GET',suffix==='reply'?{text:'Hidden'}:undefined)).statusCode,404);
    const reply = await staff(`updates/${uid}/reply`,'a','POST',{text:'  Ship the synthetic change  '}); assert.equal(reply.statusCode,201,reply.body);
    const row=reply.json().request, id=row.id;
    assert.equal(row.status,'new'); assert.equal(row.source,'update_reply'); assert.equal(row.updateId,uid); assert.equal(row.text,'Ship the synthetic change');
    assert.equal(row.askedBy.id,people.a.id); assert.equal(row.onBehalf.id,people.sender.id); assert.ok(row.askedBy.name && row.onBehalf.name);
    for (const person of ['b','admin','outside']) assert.equal((await staff(`update-requests/${id}`,person)).statusCode,404);
    for (const person of ['a','sender']) assert.equal((await staff(`update-requests/${id}`,person)).statusCode,200);
    for (const path of ['updates/not-a-uuid/reply','updates/not-a-uuid/requests','update-requests/not-a-uuid']) assert.equal((await staff(path,'a',path.endsWith('reply')?'POST':'GET',path.endsWith('reply')?{text:'x'}:undefined)).statusCode,404);
    assert.deepEqual((await staff(`updates/${uid}/requests`,'a')).json().items,[]);
    assert.equal((await service('update-requests','GET',key)).json().items[0].id,id);
    const planned = await set(id,{status:'planned',progress:10,note:'Queued for the synthetic preview'}); assert.equal(planned.statusCode,200,planned.body);
    assert.equal(planned.json().request.progress,10); assert.ok(Date.parse(planned.json().request.updatedAt)>=Date.parse(row.updatedAt));
    const next=await service('updates','POST',poster,{...update,slot:'2026-10-18-pm'}); assert.equal(next.statusCode,201,next.body);
    const live = await staff(`updates/${next.json().updateId}/requests`,'a'); assert.equal(live.statusCode,200,live.body);
    assert.equal(live.json().items[0].status,'planned'); assert.equal(live.json().items[0].progress,10); assert.equal(live.json().items[0].note,'Queued for the synthetic preview');
    assert.deepEqual((await staff(`updates/${next.json().updateId}/requests`,'b')).json().items,[]);
    const body={ref:'synthetic:request-1',askedBy:people.a.id,onBehalfOf:people.sender.id,source:'task',text:'Synthetic request',askedAt:'2026-01-01T00:00:00Z'};
    const made=await post(body); assert.equal(made.statusCode,201,made.body);
    const replay=await post(body); assert.equal(replay.statusCode,200,replay.body); assert.equal(replay.json().request.id,made.json().request.id); assert.equal(replay.json().replayed,true);
    for (const change of [{text:'Changed'},{askedBy:people.b.id},{onBehalfOf:people.b.id},{source:'chat'},{askedAt:'2026-01-02T00:00:00Z'}]) assert.equal((await post({...body,...change})).statusCode,409);
    const implicit = await post({...body,ref:'implicit-time',askedAt:undefined}); assert.equal(implicit.statusCode,201,implicit.body);
    const implicitReplay=await post({...body,ref:'implicit-time',askedAt:undefined}); assert.equal(implicitReplay.statusCode,200,implicitReplay.body); assert.equal(implicitReplay.json().request.id,implicit.json().request.id);
    for (const person of badPeople) for (const field of ['askedBy','onBehalfOf']) assert.equal((await post({...body,ref:randomUUID(),[field]:person})).statusCode,422);
    for (const change of [{extra:true},{source:'update_reply'},{text:' '},{text:'x'.repeat(1001)},{ref:'bad ref'},{askedAt:'9999-01-01T00:00:00Z'},{askedAt:'invalid'},{askedAt:'2026-02-30T00:00:00Z'}]) {
      for (const ref of [body.ref,randomUUID()]) {
        const response=await post({...body,ref,...change});
        assert.equal(response.statusCode,400,`Invalid ${Object.keys(change).join(',')} with ${ref===body.ref?'reused':'fresh'} ref: ${response.body}`);
      }
    }
    for (const change of [{},{extra:true},{status:'unknown'},{progress:101},{progress:-1},{progress:0.5},{note:'x'.repeat(1001)},{status:null}]) assert.equal((await set(id,change)).statusCode,400);
    for (const status of ['new','planned','started','in_progress','test_site','waiting','live','done']) assert.equal((await set(made.json().request.id,{status})).statusCode,200);
    for (const query of ['limit=101','limit=0','status=unknown','cursor=invalid','onBehalfOf=invalid','extra=x']) assert.equal((await service('update-requests?'+query,'GET',key)).statusCode,400);
    const page=(await service(`update-requests?limit=1&onBehalfOf=${people.sender.id}`,'GET',key)).json(); assert.equal(page.items.length,1); assert.ok(page.nextCursor);
    const page2=(await service(`update-requests?limit=1&cursor=${page.nextCursor}`,'GET',key)).json(); assert.notEqual(page2.items[0].id,page.items[0].id);
    assert.deepEqual((await service('update-requests?status=waiting','GET',key)).json(),{items:[],nextCursor:null});
    assert.equal((await set(randomUUID(),{note:'x'})).statusCode,404);
    assert.equal((await service(`update-requests/${id}`,'DELETE',key)).statusCode,403); assert.equal((await staff(`update-requests/${id}`,'a')).statusCode,200);
    assert.equal((await staff(`updates/${uid}/reply`,'a','POST',{text:'x',extra:true})).statusCode,400);
    const originalFetch=globalThis.fetch;
    try {
      globalThis.fetch=async (_url,options) => { assert.equal(options.headers.has('cookie'),false); return Response.json({ok:true}); };
      const proxy=(path,method='GET',query='') => serviceProxy(new Request(`https://synthetic.example/api/v1/service/${path}${query}`,{method,headers:{...key,cookie:'staff'}}),{params:Promise.resolve({path:path.split('/')})});
      for (const [path,method,query] of [['update-requests','GET','?status=planned&limit=50&cursor='+id+'&onBehalfOf='+people.sender.id],['update-requests','POST',''],[`update-requests/${id}/progress`,'POST','']]) assert.equal((await proxy(path,method,query)).status,200);
      assert.equal((await proxy('update-requests','POST','?status=new')).status,400); assert.equal((await proxy(`update-requests/${id}/progress`,'POST','?limit=1')).status,400);
      assert.equal((await proxy('update-requests','DELETE')).status,403); assert.equal(v1ProxyOptions.allowPostPath(['updates',uid,'reply']),true);
    } finally { globalThis.fetch=originalFetch; }
    console.log('Request API: scope refusal, participant privacy, live register, replay/conflict, strict schemas, pagination and proxies passed');
  }
} finally { await app.close(); await pool.end(); }
