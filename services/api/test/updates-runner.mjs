import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { serviceProxy } from '../../../apps/web/app/lib/service-proxy.mjs';
import { v1ProxyOptions } from '../../../apps/web/app/api/proxy.mjs';
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 1 }), app = createApp(pool,pool);
const people = JSON.parse(process.env.TEST_PEOPLE), badPeople = JSON.parse(process.env.TEST_BAD_PEOPLE);
const issue = async (scopes, status=200) => {
  const id = randomUUID(), secret = randomBytes(32).toString('base64url');
  const r = await app.inject({ method:'POST',url:'/api/v1/operator/service-keys',headers:{authorization:`Bearer ${process.env.PULSE_OPERATOR_TOKEN}`},
    payload:{action:'issue',id,hash:createHash('sha256').update(secret).digest('hex'),scopes,label:'Synthetic publisher'} });
  assert.equal(r.statusCode,status,r.body); return {authorization:`Bearer psvc_${id}_${secret}`};
};
const staff = (url,email,method='GET') => app.inject({url,method,headers:{'cf-access-authenticated-user-email':email}});
const payload = {slot:'2026-10-18-am',headline:'Synthetic handoff',sections:{live:[{title:'Live one'},{title:'Live two'}],readyToTry:[{title:'Try one'}],ideas:[{title:'Idea one'},{title:'Idea two'},{title:'Idea three'}],needsYou:[{text:'Review one'},{text:'Review two'}],requests:[{title:'Ship',status:'Ready',progress:100}],plan:{label:'Today',items:[]}},audience:[people.a.id,people.b.id,people.a.id],onBehalfOf:people.sender.id};
try {
  const key = await issue(['updates.post']), reader = await issue(['clients.read']);
  // Updates alone needs no AI member; mixing in a v1 grant still requires one.
  await issue(['updates.post','tasks.read'],400);
  const post = (body=payload,headers=key) => app.inject({method:'POST',url:'/api/v1/service/updates',headers,payload:body});
  for (const headers of [{},{authorization:'Bearer psvc_junk'}]) for (const body of [{},payload])
    assert.equal((await post(body,headers)).statusCode,401,'invalid credentials precede body validation');
  assert.equal((await post(payload,reader)).statusCode,403);
  for (const [url,method,body] of [['/api/v1/service/clients','GET'],['/api/v1/service/quotes','POST',{clientId:randomUUID(),lines:[{itemId:randomUUID(),qty:1}]}],[`/api/v1/service/chats/${randomUUID()}/messages`,'POST',{text:'x'}]]) {
    const refused = await app.inject({url,method,headers:{...key,'idempotency-key':url.endsWith('/quotes')?randomUUID():payload.slot},payload:body});
    assert.equal(refused.statusCode,403,refused.body);
  }
  const first = await post(); assert.equal(first.statusCode,201,first.body); const id = first.json().updateId;
  assert.deepEqual((await post({...payload,audience:[people.b.id,people.a.id]})).json(),{updateId:id,replayed:true});
  assert.equal((await post({...payload,headline:'Changed'})).statusCode,409);
  for (const body of [{...payload,extra:true},{...payload,audience:[]},{...payload,sections:{live:Array(13).fill({title:'x'})}}]) assert.equal((await post(body)).statusCode,400);
  for (const sections of [{extra:true},{live:[{title:'x',extra:true}]},{plan:{label:'Today',items:[],extra:true}},{requests:[{title:'x',status:'x',progress:101}]}]) assert.equal((await post({...payload,sections})).statusCode,400);
  for (const slot of ['2026-02-30-am','0000-01-01-am','2026-10-18-noon']) assert.equal((await post({...payload,slot})).statusCode,400);
  for (const person of badPeople) for (const field of ['audience','onBehalfOf']) assert.equal((await post({...payload,[field]:field==='audience'?[person]:person})).statusCode,422);
  for (const email of [people.outside.email,people.admin.email]) {
    assert.deepEqual((await staff('/api/v1/updates',email)).json().items,[]);
    assert.equal((await staff(`/api/v1/updates/${id}/open`,email,'POST')).statusCode,404);
  }
  const list = await staff('/api/v1/updates',people.a.email); assert.equal(list.statusCode,200,list.body);
  for (const query of ['limit=0','cursor=invalid','extra=true']) assert.equal((await staff('/api/v1/updates?'+query,people.a.email)).statusCode,400);
  assert.equal(list.json().items[0].openedAt,null); assert.equal('sections' in list.json().items[0],false); assert.equal('openedBy' in list.json().items[0],false);
  assert.deepEqual(list.json().items[0].counts,{live:2,readyToTry:1,requests:1,ideas:3,needsYou:2});
  assert.deepEqual((await staff('/api/v1/updates',people.a.email)).json().items[0],list.json().items[0]);
  const unread = await staff(`/api/v1/updates/${id}/open`,people.sender.email,'POST');
  assert.equal(unread.statusCode,200,unread.body);
  assert.deepEqual(unread.json().openedBy.map(p => p.personId).sort(),[people.a.id,people.b.id].sort());
  assert.ok(unread.json().openedBy.every(p => p.name && p.openedAt===null));
  const open = () => staff(`/api/v1/updates/${id}/open`,people.a.email,'POST');
  const opened = await open(); assert.equal(opened.statusCode,200,opened.body);
  assert.equal((await open()).json().openedAt,opened.json().openedAt);
  assert.match(opened.json().openedAt,/:00(?:\.000)?(?:Z|\+00:00)$/); assert.equal('openedBy' in opened.json(),false);
  assert.equal(opened.json().poster,'Synthetic publisher (AI)');
  const sender = (await staff(`/api/v1/updates/${id}/open`,people.sender.email,'POST')).json();
  assert.equal(sender.openedBy.length,2);
  assert.equal(sender.openedBy.find(p => p.personId===people.a.id).openedAt,opened.json().openedAt);
  assert.equal(sender.openedBy.find(p => p.personId===people.b.id).openedAt,null);
  assert.equal(sender.openedAt,null); assert.equal(sender.isSender,true);
  assert.equal((await staff('/api/v1/updates/not-a-uuid/open',people.a.email,'POST')).statusCode,404);
  const second = await post({...payload,slot:'2026-10-18-pm',sections:{live:[],needsYou:[]},audience:[people.a.id,people.b.id,people.sender.id]}); assert.equal(second.statusCode,201,second.body);
  const page = (await staff('/api/v1/updates?limit=1',people.a.email)).json(); assert.equal(page.items.length,1); assert.ok(page.nextCursor);
  assert.equal(page.items[0].id,second.json().updateId); assert.equal(page.items[0].openedAt,null);
  assert.deepEqual(page.items[0].counts,{live:0,readyToTry:0,requests:0,ideas:0,needsYou:0});
  const next = (await staff(`/api/v1/updates?limit=1&cursor=${page.nextCursor}`,people.a.email)).json();
  assert.equal(next.items.length,1); assert.notEqual(next.items[0].id,page.items[0].id); assert.equal(next.nextCursor,null);
  const selfAudience = await staff(`/api/v1/updates/${second.json().updateId}/open`,people.sender.email,'POST');
  assert.equal(selfAudience.statusCode,200,selfAudience.body); assert.ok(selfAudience.json().openedAt);
  assert.deepEqual(selfAudience.json().openedBy.map(p => p.personId).sort(),[people.a.id,people.b.id].sort());
  assert.ok(selfAudience.json().openedBy.every(p => p.openedAt===null));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url,options) => { assert.equal(options.headers.has('cookie'),false); return Response.json({ok:true}); };
    const r = await serviceProxy(new Request('https://synthetic.example/api/v1/service/updates',{method:'POST',headers:{...key,cookie:'staff'},body:JSON.stringify(payload)}),{params:Promise.resolve({path:['updates']})});
    assert.equal(r.status,200); assert.equal(v1ProxyOptions.allowPostPath(['updates',id,'open']),true);
  } finally { globalThis.fetch = originalFetch; }
  console.log('Updates: scope 403, slot replay/conflict, audience/admin 404, receipt once/sender-only unread audience, strict schema, 422 staff validation, section counts without receipts, pagination and proxy passed');
} finally { await app.close(); await pool.end(); }
