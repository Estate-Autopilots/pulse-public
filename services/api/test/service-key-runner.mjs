import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { withServiceKey } from '../dist/service-key.js';
import { serviceProxy } from '../../../apps/web/app/lib/service-proxy.mjs';
import { catalogProxy } from '../../../apps/web/app/lib/catalog-proxy.mjs';
import { createApiProxy, v0ProxyOptions } from '../../../apps/web/app/api/proxy.mjs';

const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 1 });
// Only fixture handlers: prove service cards receive the authenticated transaction. The real clients read
// (EST-1247) keeps its route and query schema; only its handler is swapped for this context probe.
const contextProbe = (req,reply) => withServiceKey(req,reply,'clients.read', async (c,keyId) => ({
  keyId, ...(await c.query("select current_setting('pulse.org_id') org, current_setting('pulse.actor_account') actor, (select count(*)::int from pulse.erp_item) staff_rows")).rows[0],
  identityHeaders: ['cookie','x-pulse-session','cf-access-authenticated-user-email'].filter(k => req.headers[k]),
}));
const app = createApp(pool,pool,route => { if (route.method === 'GET' && route.url === '/api/v1/service/clients') route.handler = contextProbe; }), logs = [], responses = [], sensitive = [];
const execFile = promisify(execFileCallback);
for (const level of ['info','warn','error']) app.log[level] = (...args) => logs.push(JSON.stringify(args));
app.log.child = () => app.log;
app.addHook('onSend', async (_req,_reply,payload) => { responses.push(String(payload)); return payload; });
const admin = '/api/v1/operator/service-keys';
const operator = { authorization: `Bearer ${process.env.PULSE_OPERATOR_TOKEN}` };
const manage = (payload, headers = operator) => app.inject({ method:'POST',url:admin,headers,payload });
const issue = async (scopes, agentId) => {
  const id = randomUUID(), secret = randomBytes(32).toString('base64url'), hash = createHash('sha256').update(secret).digest('hex');
  sensitive.push(secret,hash);
  const response = await manage({ action:'issue',id,hash,scopes,label:'Synthetic agent',agentId });
  assert.equal(response.statusCode,200); assert.deepEqual(response.json(),{ id });
  return { id, hash, headers:{ authorization:`Bearer psvc_${id}_${secret}` } };
};
const call = (key,url = '/api/v1/catalog/items', extra = {}) => app.inject({ url,headers:key.headers,...extra });
try {
  const catalog = await issue(['catalog.read']), clients = await issue(['clients.read','quotes.draft.create']);
  const list = await app.inject({ url:admin,headers:operator });
  assert.equal(list.statusCode,200);
  const info = list.json().keys.find(k => k.id === catalog.id);
  assert.deepEqual(Object.keys(info).sort(),['id','label','scopes','agentId','createdAt','revokedAt','lastUsedAt'].sort());
  assert.deepEqual(info.scopes,['catalog.read']); assert.equal(info.lastUsedAt,null);
  const items = await call(catalog);
  assert.equal(items.statusCode,200,items.body);
  assert.deepEqual(items.json().items.map(i=>i.id).sort(),JSON.parse(process.env.TEST_ITEMS).sort());
  assert.equal((await call(clients)).statusCode,403);
  for (const authorization of [undefined,'Bearer wrong','Bearer psvc_bad',`Bearer psvc_${catalog.id}_${'a'.repeat(43)}`,`Bearer psvc_${randomUUID()}_${'b'.repeat(43)}`]) {
    assert.equal((await call(catalog,undefined,{ headers:authorization ? {authorization} : {} })).statusCode,401);
    assert.equal((await call(catalog,'/api/v1/service/clients',{ headers:authorization ? {authorization} : {cookie:'pulse_session=staff'} })).statusCode,401);
  }
  const staff = { cookie:'pulse_session=staff', 'x-pulse-session':'a'.repeat(43), 'cf-access-authenticated-user-email':'synthetic-admin@example.test' };
  for (const url of ['/api/v0/erp/documents','/api/v0/people','/api/v0/auth/sign-in','/api/v1/operator/service-keys','/api/v1/catalog/offers/'+ 'a'.repeat(43),'/api/v1/service/unknown','/healthz']) {
    assert.equal((await call(catalog,url,{ headers:{...staff,...catalog.headers} })).statusCode,403,url);
  }
  for (const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS']) assert.equal((await call(catalog,undefined,{method})).statusCode,403,method);
  for (const url of ['/api/v1/catalog/items?org_id=other','/api/v1/service/clients?org_id=other','/api/v1/service/quotes?limit=1']) assert.equal((await call(clients,url,{method:url.includes('quotes')?'POST':'GET'})).statusCode,400);
  for (const url of ['/api/v1/catalog/items','/api/v1/service/clients']) assert.equal((await call(catalog,url,{headers:{...catalog.headers,'x-pulse-host':'service-other.example'}})).statusCode,403);
  const context = await call(clients,'/api/v1/service/clients?cursor=synthetic&limit=1',{headers:{...staff,...clients.headers}});
  assert.equal(context.statusCode,200,context.body); assert.equal(context.json().keyId,clients.id);
  assert.equal(context.json().actor,'service:'+clients.id); assert.equal(context.json().org,process.env.TEST_ORG);
  assert.equal(context.json().staff_rows,0); assert.deepEqual(context.json().identityHeaders,[]);
  assert.equal((await call(clients,'/api/v1/service/quotes',{method:'POST',payload:{}})).statusCode,400);
  // The real quote handler (EST-1248) fails inside the authenticated transaction: no ERP state or no such client.
  const failed = await call(clients,'/api/v1/service/quotes',{method:'POST',headers:{...clients.headers,'idempotency-key':randomUUID()},
    payload:{clientId:randomUUID(),lines:[{itemId:randomUUID(),qty:1}]}});
  assert.ok([404,422].includes(failed.statusCode),failed.body);
  const clean = await pool.query("select nullif(current_setting('pulse.actor_account',true),'') actor");
  assert.equal(clean.rows[0].actor,null,'transaction actor cannot leak through the pool after rollback');
  const fields = {action:'issue',id:randomUUID(),hash:catalog.hash,scopes:['catalog.read'],label:'Synthetic'};
  for (const payload of [ {...fields,rawSecret:'forbidden'}, {...fields,scopes:['finance.read']}, {...fields,scopes:[]}, {...fields,scopes:['catalog.read','catalog.read']}, {...fields,label:''}, {...fields,label:'a'.repeat(61)}, {...fields,hash:undefined}, {...fields,action:'revoke'}, {...fields,label:undefined} ]) assert.equal((await manage(payload)).statusCode,400);
  assert.equal((await app.inject({url:admin,headers:staff})).statusCode,401);
  assert.equal((await app.inject({url:admin,headers:{...operator,'x-pulse-client-ip':'web'}})).statusCode,404);
  assert.equal((await app.inject({url:admin+'?org_id=other',headers:operator})).statusCode,400);
  const lastUsed = (await app.inject({url:admin,headers:operator})).json().keys.find(k=>k.id===catalog.id).lastUsedAt;
  assert.match(lastUsed,/:00(?:\.000)?(?:Z|\+00:00)$/);
  await manage({action:'revoke',id:catalog.id});
  assert.equal((await call(catalog)).statusCode,401);
  assert.ok((await app.inject({url:admin,headers:operator})).json().keys.find(k=>k.id===catalog.id).revokedAt);

  const posting = await issue(['chats.post'],process.env.TEST_AGENT);
  const chatPath = `/api/v1/service/chats/${process.env.TEST_CHAT}/messages`;
  const image = {name:'card.png',mime:'image/png',bytes:Buffer.from('89504e470d0a1a0a','hex').toString('base64')};
  const postChat = (payload={text:'Synthetic API update',image}, headers={...posting.headers,'idempotency-key':'2026-10-17-am'}, url=chatPath) =>
    app.inject({method:'POST',url,headers,payload});
  assert.equal((await postChat(undefined,{})).statusCode,401);
  // Signed out, an invalid body still answers 401, never a schema 400 (EST-1521, release smoke anonymous contract).
  assert.equal((await postChat({},{})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/service/quotes',payload:{}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/service/quotes',headers:{authorization:'Bearer psvc_junk'},payload:{}})).statusCode,401);
  assert.equal((await postChat(undefined,{...clients.headers,'idempotency-key':'2026-10-17-am'})).statusCode,403);
  assert.equal((await postChat(undefined,undefined,`/api/v1/service/chats/${randomUUID()}/messages`)).statusCode,403);
  const posted = await postChat(); assert.equal(posted.statusCode,201,posted.body);
  assert.deepEqual(Object.keys(posted.json()).sort(),['chatId','messageId','replayed']);
  assert.equal((await postChat()).statusCode,200);
  assert.equal((await postChat({text:'Different',image})).statusCode,409);
  for (const body of [{text:'x',image:{...image,mime:'image/gif'}},{text:'x',image:{...image,mime:'image/jpeg'}},
    {text:'x',image:{...image,bytes:'%%%'}},{text:'x',image:{...image,extra:true}},{text:'x',extra:true}]) assert.equal((await postChat(body)).statusCode,400);
  for (const slot of ['2026-02-30-am','2026-10-17-noon','0000-01-01-am']) assert.equal((await postChat(undefined,{...posting.headers,'idempotency-key':slot})).statusCode,400);
  assert.equal((await postChat({text:'x',image:{...image,bytes:Buffer.alloc(2097153).toString('base64')}})).statusCode,413);
  const limitImage = Buffer.alloc(2097152); Buffer.from('89504e470d0a1a0a','hex').copy(limitImage);
  assert.equal((await postChat({text:'At the limit',image:{...image,bytes:limitImage.toString('base64')}},{...posting.headers,'idempotency-key':'2026-10-17-pm'})).statusCode,201);
  assert.equal((await app.inject({method:'POST',url:chatPath,headers:{...posting.headers,'content-type':'application/json'},payload:'x'.repeat(3*1024*1024+1)})).statusCode,413);
  assert.equal((await call(posting,chatPath)).statusCode,403,'posting key cannot read messages');
  for (const payload of [{...fields,scopes:['chats.post']},{...fields,agentId:process.env.TEST_AGENT}]) assert.equal((await manage(payload)).statusCode,400);

  // Exercise the real CLI against HTTP on loopback, with no raw credential in argv/stdout/responses.
  process.env.PULSE_API_URL = await app.listen({host:'127.0.0.1',port:0});
  const env = {...process.env,PULSE_OPERATOR_URL:process.env.PULSE_API_URL};
  const keyFile = join(process.env.TEST_SCRATCH_DIR,'service-cli.key');
  const cli = (...args) => execFile(process.execPath,['dist/service-key-admin.js',...args],{env});
  const created = await cli('issue',keyFile,'--scopes','catalog.read','--label','CLI synthetic');
  assert.match(created.stdout,/^[0-9a-f-]{36}\n$/); assert.equal(created.stderr,'');
  assert.equal((await stat(keyFile)).mode & 0o777,0o600);
  // The base64url secret may itself contain '_': take it from the fixed token shape, never split on '_' (a 1-char tail matched log text, EST-1960).
  const raw = await readFile(keyFile,'utf8'), [, rawId, rawSecret] = raw.match(/^psvc_([0-9a-f-]{36})_([A-Za-z0-9_-]{43})$/) ?? [];
  assert.equal(rawId,created.stdout.trim()); sensitive.push(raw,rawSecret);
  const cliKey = {headers:{authorization:'Bearer '+raw}};
  assert.equal((await call(cliKey)).statusCode,200);
  await assert.rejects(cli('issue',keyFile,'--scopes','catalog.read','--label','No overwrite'));
  assert.equal(await readFile(keyFile,'utf8'),raw);
  assert.ok((await cli('list')).stdout.split('\n').includes(created.stdout.trim()));
  const web = (path, method='GET',body) => new Request('https://synthetic.example/api/v1/service/'+path,{method,headers:{...staff,...clients.headers,host:'synthetic.example','content-type':'application/json','idempotency-key':randomUUID(),'x-pulse-host':'service-other.example'},...(body===undefined?{}:{body})});
  const proxied = await serviceProxy(web('clients'),{params:Promise.resolve({path:['clients']})});
  assert.equal(proxied.status,200); assert.deepEqual((await proxied.json()).identityHeaders,[]);
  const catalogWeb = await catalogProxy(new Request('https://synthetic.example/api/v1/catalog/items',{headers:cliKey.headers}),{params:Promise.resolve({path:['items']})});
  assert.equal(catalogWeb.status,200);
  assert.equal((await createApiProxy(v0ProxyOptions)(web('erp/documents'),{params:Promise.resolve({path:['erp','documents']})})).status,403);
  const chatFile = join(process.env.TEST_SCRATCH_DIR,'service-chat-cli.key');
  const chatKey = await cli('issue',chatFile,'--scopes','chats.post','--agent',process.env.TEST_AGENT,'--label','AI updates');
  assert.equal((await stat(chatFile)).mode & 0o777,0o600);
  await cli('revoke',chatKey.stdout.trim());
  await cli('revoke',created.stdout.trim()); assert.equal((await call(cliKey)).statusCode,401);

  // Exact forwarding, method/path/query/body limits, redirects and no secret-bearing upstream errors.
  const originalFetch = globalThis.fetch;
  let forwarded;
  try {
    globalThis.fetch = async (url,options) => { forwarded={url,options}; return Response.json({ok:true},{headers:{'set-cookie':'never=forward','retry-after':'60'}}); };
    const quoteId = randomUUID();
    assert.equal((await serviceProxy(web('quotes','POST','{}'),{params:Promise.resolve({path:['quotes']})})).status,200);
    assert.deepEqual([...forwarded.options.headers.keys()].sort(),['authorization','content-type','idempotency-key','x-pulse-host'].sort());
    assert.equal(forwarded.options.headers.get('x-pulse-host'),'synthetic.example');
    assert.equal(forwarded.options.redirect,'error'); assert.equal(forwarded.options.cache,'no-store'); assert.ok(forwarded.options.signal);
    assert.equal((await serviceProxy(web('quotes','POST','a'.repeat(65537)),{params:Promise.resolve({path:['quotes']})})).status,413);
    assert.equal((await serviceProxy(web('quotes','POST','a'.repeat(65536)),{params:Promise.resolve({path:['quotes']})})).status,200);
    const chatParts=['chats',process.env.TEST_CHAT,'messages'];
    for (const [size,status] of [[65537,200],[3*1024*1024,200],[3*1024*1024+1,413]]) assert.equal((await serviceProxy(web(chatParts.join('/'),'POST','a'.repeat(size)),{params:Promise.resolve({path:chatParts})})).status,status);
    assert.equal((await serviceProxy(web(chatParts.join('/')),{params:Promise.resolve({path:chatParts})})).status,403);
    assert.equal((await serviceProxy(web(`quotes/${quoteId}/ready-notice`,'POST','{}'),{params:Promise.resolve({path:['quotes',quoteId,'ready-notice']})})).status,400);
    // Signed out, the release smoke's `{}` POST answers 401 before that no-body refusal and never reaches the API (EST-1912).
    const seenBefore = forwarded;
    const anonymous = new Request(`https://synthetic.example/api/v1/service/quotes/${quoteId}/ready-notice`,{method:'POST',headers:{...staff,'content-type':'application/json'},body:'{}'});
    assert.equal((await serviceProxy(anonymous,{params:Promise.resolve({path:['quotes',quoteId,'ready-notice']})})).status,401);
    assert.equal(forwarded,seenBefore);
    for (const path of [['..','operator','service-keys'],['quotes','not-a-uuid','ready-notice'],['%2e%2e','operator'],['clients','extra']]) assert.equal((await serviceProxy(web(path.join('/')),{params:Promise.resolve({path})})).status,403);
    assert.equal((await serviceProxy(web('clients','POST','{}'),{params:Promise.resolve({path:['clients']})})).status,403);
    assert.equal((await serviceProxy(web('clients?org=other'),{params:Promise.resolve({path:['clients']})})).status,400);
    assert.equal((await serviceProxy(web('quotes/'+quoteId+'/ready-notice','POST'),{params:Promise.resolve({path:['quotes',quoteId,'ready-notice']})})).status,200);
  } finally { globalThis.fetch = originalFetch; }
  const redirectServer = (await import('node:http')).createServer((_req,res)=>{res.writeHead(302,{location:'/leak'});res.end();});
  await new Promise(resolve=>redirectServer.listen(0,'127.0.0.1',resolve));
  process.env.PULSE_API_URL = 'http://127.0.0.1:'+redirectServer.address().port;
  try { assert.equal((await serviceProxy(web('clients'),{params:Promise.resolve({path:['clients']})})).status,503); }
  finally { await new Promise(resolve=>redirectServer.close(resolve)); }

  // The real clients route (EST-1247) with an empty handler, swapped as above: the budgets are what is measured here.
  const budgetApp = createApp(pool,pool,route => { if (route.method === 'GET' && route.url === '/api/v1/service/clients') route.handler = (req,reply) => withServiceKey(req,reply,'clients.read', async () => ({ items: [] })); }), reader = await issue(['clients.read','catalog.read']);
  try {
    // Junk credentials (missing, malformed, unknown, refused) spend only the failed-auth bucket.
    const junk = [{}, {authorization:'Bearer psvc_bad'}, {authorization:`Bearer psvc_${randomUUID()}_${'c'.repeat(43)}`}];
    const statuses = [];
    for (let i=0;i<210;i++) for (const url of ['/api/v1/service/clients', ...(i%3===1?['/api/v1/catalog/items']:[])]) statuses.push((await budgetApp.inject({url,headers:junk[i%3]})).statusCode);
    assert.ok(statuses.slice(0,120).every(code => code === 401),'failures below the bucket answer 401');
    assert.equal(statuses.at(-1),429);
    const limited=await budgetApp.inject({url:'/api/v1/service/clients'});
    assert.equal(limited.statusCode,429); assert.equal(limited.headers['retry-after'],'60');
    assert.match(limited.headers['cache-control'],/no-store/); assert.equal(limited.headers['referrer-policy'],'no-referrer');
    assert.equal((await budgetApp.inject({url:'/api/v1/catalog/items',headers:reader.headers})).statusCode,200,'junk flood never limits a valid catalogue read');
    for (let i=1;i<120;i++) assert.equal((await budgetApp.inject({url:'/api/v1/service/clients',headers:reader.headers})).statusCode,200,'valid key after junk flood');
    const spent = await budgetApp.inject({url:'/api/v1/service/clients',headers:reader.headers});
    assert.equal(spent.statusCode,429,'121st authenticated request'); assert.equal(spent.headers['retry-after'],'60');
    assert.equal((await call(clients,'/api/v1/service/clients')).statusCode,200,'budget isolated by API process');
  } finally { await budgetApp.close(); }
  // A separate creation with no configured operator removes the operator routes entirely.
  delete process.env.PULSE_OPERATOR_TOKEN;
  const disabled = createApp(pool,pool);
  try { assert.equal((await disabled.inject({url:admin,headers:operator})).statusCode,404); }
  finally { await disabled.close(); }
  for (const value of [...sensitive,operator.authorization]) {
    assert.ok(!JSON.stringify(logs).includes(value),`logs exclude secrets/digests (${value.length}-char value)`);
    assert.ok(!JSON.stringify(responses).includes(value),`responses exclude secrets/digests (${value.length}-char value)`);
  }
  assert.ok(logs.some(v=>v.includes('serviceKeyId')&&v.includes('scope_refused')));
  console.log('Service key issue/list/catalogue/scope/staff/host/revoke/proxy/CLI/budget/log + failed-auth bucket checks passed');
} finally { await app.close(); await pool.end(); }
