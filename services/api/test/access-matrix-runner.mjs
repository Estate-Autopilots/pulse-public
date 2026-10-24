import { denied } from './role-expectations.mjs';
import { budget } from '../dist/service-key.js';
import { DESIGNER_DETAIL_ROLES } from '../../../apps/web/app/lib/designers-view.mjs';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { readFile, writeFile } from 'node:fs/promises';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG));const routes=[];
const app=createApp(pool,pool,r=>{if(r.method==='HEAD')return;for(const method of [r.method].flat())if(method!=='HEAD')routes.push({method,url:r.url});});
const roles=JSON.parse(process.env.TEST_ROLES),tokens={};const receipts=[];const missing='00000000-0000-4000-8000-000000000001';
let apiChecks=0;
const call=async(url,token,payload,method=payload?'POST':'GET')=>{apiChecks++;const r=await app.inject({url,method,headers:{'x-pulse-client-ip':crypto.randomUUID(),...(token?{'x-pulse-session':token}:{})},...(payload?{payload}:{})});return {status:r.statusCode,data:r.headers['content-type']?.includes('json')?r.json():r.body};};
for(const role of Object.keys(roles)){
 const r=await call('/api/v0/auth/sign-in',null,{username:'synthetic.'+role,password:'Synthetic-issued-2026!'});assert.equal(r.status,200,role+' sign-in');tokens[role]=r.data.token;
 assert.equal((await call('/api/v0/people',tokens[role])).status,403,'forced password change');
 assert.equal((await call('/api/v0/auth/change-password',tokens[role],{current:'Synthetic-issued-2026!',next:'Synthetic-final-2026!'})).status,200);
 assert.equal((await call('/api/v0/me',tokens[role])).data.role,role);
}
const groups=['person','manager','pgs','hr','leadership','admin'];const staff=r=>['hr','leadership','admin'].includes(r),lead=r=>['leadership','admin'].includes(r);
// Explicit expected denials. Other reads are self/member scoped by their handlers and RLS.
await app.ready();
for(const role of groups){
 // Each role is an independent fixture; don't spend one process-wide failed-auth window across all six matrices.
 app.serviceBudget.failed=budget(120);
 for(const route of routes){
 const {method,url:pattern}=route;if(/^\/api\/v0\/(?:portal\/)?auth\/(branding|sign-in|forgot|forgot-username|set-password|two-step|confirm-email|link-sign-in|google\/start|google\/callback|join|join-peek|account-sign-in|connect-peek|connect-join)$/.test(pattern))continue;if(['/api/v0/portal/auth/sign-in','/api/v0/portal/auth/forgot'].includes(pattern))continue;if(pattern==='/api/v0/native/refresh'){const unauth=await call('/api/v0/native/refresh',null,{});assert.equal(unauth.status,401);continue;}if(['/api/v0/native/pair/start','/api/v0/native/pair/poll'].includes(pattern)){const unauth=await call(pattern,null,{});assert.equal(unauth.status,400,'public pairing refuses a malformed request');continue;}if(pattern==='/api/v0/native/about'){const pub=await call(pattern,null,null,'GET');assert.equal(pub.status,200,'about is public');assert.deepEqual(Object.keys(pub.data).sort(),['company','pairing','product'],'about names the company only');continue;}if(pattern==='/api/v0/brand'||pattern==='/api/v0/brand/:kind'){const pub=await call(pattern==='/api/v0/brand'?pattern:'/api/v0/brand/logo',null);assert.ok([200,404].includes(pub.status),'the organisation logo is public (sign-in page, e-mail, print): '+pub.status);receipts.push({role,method,route:pattern,status:pub.status,public:true});continue;}if(pattern==='/api/v0/host'){const pub=await call(pattern,null);assert.equal(pub.status,200,'UX-TENANT: which company an address belongs to is public (the sign-in page asks before anyone signs in)');assert.equal(pub.data.own,true);receipts.push({role,method,route:pattern,status:pub.status,public:true});continue;}if(pattern.startsWith('/api/v0/accept/')||pattern.startsWith('/api/v0/offer/')){const pub=await call(pattern.replace(':token','synthetic-invalid-token'),null,method==='POST'?{decision:'accepted',name:'Synthetic'}:undefined,method);assert.equal(pub.status,404,'a client acceptance link answers signed out, and an unknown token is not found: '+pub.status);receipts.push({role,method,route:pattern,status:pub.status,public:true});continue;}if(pattern==='/healthz'||pattern==='/api/v0/auth/branding'||pattern==='/api/v0/auth/sign-in'||pattern==='/api/v0/auth/forgot'||pattern==='/api/v0/auth/set-password'||pattern==='/api/v0/auth/sign-out'||pattern==='/api/v0/chats/events')continue;
 if(method==='GET'&&pattern==='/api/v1/openapi.json'){
  // EST-1611: the public reference is exactly the committed schema; no data endpoint is exempted.
  const pub=await call(pattern,null);
  const reference=JSON.parse((await readFile(new URL('../openapi/v1.yaml',import.meta.url),'utf8')).replace(/^#.*\n/gm,''));
  assert.equal(pub.status,200,'API v1 reference is public');assert.deepEqual(pub.data,reference,'the public reference contains only the committed schema');
  receipts.push({role,method,route:pattern,status:pub.status,public:true});continue;
 }
 if(/^\/api\/v1\/(tasks|projects)(?:\/|$)/.test(pattern)){
  // Scoped work operations require one bearer key; staff roles and missing keys never reach body validation.
  app.serviceBudget.failed=budget(120);
  for(const token of [null,tokens[role]]){
   const response=await call(pattern.replace(/:\w+/g,missing),token,method==='GET'?undefined:{},method);
   assert.equal(response.status,401,'scoped work route refuses staff sessions: '+method+' '+pattern);
   assert.equal(response.data.type,'about:blank');assert.equal(response.data.status,401);
  }
  receipts.push({role,method,route:pattern,status:401,bearerKeyRequired:true});continue;
 }
 if(pattern.startsWith('/api/v1/service/')){
  // EST-1248: service-key routes never accept a staff session: the body is validated (400), then a service credential is required (401).
  for(const token of [null,tokens[role]]){const response=await call(pattern,token,{},method);assert.ok([400,401].includes(response.status),'service route refuses staff sessions: '+pattern+' '+response.status);}
  receipts.push({role,method,route:pattern,serviceKeyRequired:true});continue;
 }
 if(pattern==='/v1/flow/hooks/:token'){
  // FLOW-E: another app's post starts a process only on a live address; an unknown one is 404 with or without sign-in.
  for(const token of [null,tokens[role]]){const r=await call('/v1/flow/hooks/'+'a'.repeat(32),token,{name:'Synthetic'},method);assert.equal(r.status,404,'unknown process address is unavailable');}
  receipts.push({role,method,route:pattern,status:404,public:true,tokenRequired:true});continue;
 }
 if(pattern==='/api/v1/catalog/offers/:token'){
  // Customer offers use their own capability, never a staff session. A valid-shaped unknown token reveals nothing.
  for(const token of [null,tokens[role]]){
   const offer=await call('/api/v1/catalog/offers/'+'a'.repeat(43),token,undefined,method);
   assert.equal(offer.status,404,'unknown catalogue offer is unavailable with or without staff sign-in');
   assert.deepEqual(offer.data,{error:'Offer unavailable'});
  }
  receipts.push({role,method,route:pattern,status:404,public:true,tokenRequired:true});continue;
 }
 const url=pattern.replace(':source',missing).replace(':binding',missing).replace(':account','unlinked@example.test').replace(':entity','project').replace(':file','synthetic-missing-file').replace(':flag',missing).replace(':run',missing).replace(':id',pattern.includes('/people/')||pattern.includes('/hr/person/')?process.env.TEST_PERSON:pattern.includes('/projects/')?process.env.TEST_PROJECT:missing);
 if(pattern.includes('/acquisition/webhook/')||pattern.includes('/chats/whatsapp-webhook/')||pattern.startsWith('/api/v0/policy-editor/')||pattern==='/api/v0/drive-changes/hook'){const disabled=await call(url,null,{},method);assert.equal(disabled.status,404,'unconfigured signed transport stays disabled');receipts.push({role,method,route:pattern,status:disabled.status,signedTransportOnly:true});continue;}
 // The update route validates its body before agentTx (and an AI employee's note its text, CHAT-WORK): use a valid shape so this matrix reaches authentication.
 const payload=pattern==='/api/v1/updates/:id/reply'?{text:'Synthetic request'}:pattern==='/api/v0/agents/:id/memory'?{body:'Synthetic note'}:pattern==='/api/v0/people/:id/badges'?{title:'Synthetic badge'}:pattern==='/api/v0/agent/handoffs/:id/updates'?{clientId:missing,state:'progress',text:'Synthetic update'}:pattern==='/api/v0/admin/sign-in/google'&&method==='PUT'?{enabled:false,allowedDomains:[],trustGoogle2Step:false,passwordSignIn:'on'}:method==='POST'?(pattern.startsWith('/api/v0/money/')?{dataset:'money_sheet_transactions',id:'missing',projectId:process.env.TEST_PROJECT,month:'2026-09-01',category:'Synthetic',amount:1,kind:'budget',currency:'INR'}:{}):undefined;
 if(pattern==='/api/v0/notifications/payroll-processed'){
  assert.equal((await call(url,tokens[role],payload,method)).status,503,'payroll processed gate is closed for every role');
  assert.equal((await call(url,null,payload,method)).status,401,'anonymous payroll processed authenticates first');
  receipts.push({role,method,route:pattern,status:503,activationClosed:true});continue;
 }
 const r=await call(url,tokens[role],payload,method);
 assert.ok(r.status<500,`${role} ${method} ${pattern}: ${r.status} ${JSON.stringify(r.data)}`);
 if(pattern.startsWith('/api/v0/agent/'))assert.equal(r.status,401,`a person's session cannot act as an AI co-worker: ${method} ${pattern} ${JSON.stringify(r.data)}`);
 if(pattern.startsWith('/api/v0/portal'))assert.equal(r.status,401,`staff session cannot impersonate client: ${method} ${pattern} ${JSON.stringify(r.data)}`);
 if(!pattern.startsWith('/api/v0/portal')&&denied(role,method,pattern))assert.ok((method==='GET'?[403]:[403,404]).includes(r.status),`${role} should not access ${method} ${pattern}: ${r.status}`);
 // Checking malformed requests is supplemented below by valid attempts against each sensitive boundary.
 receipts.push({role,method,route:pattern,status:r.status});
 // PULSE-HQ: an organisation-only module is off in the matrix's organisation, so its routes answer 404 like an unknown
 // route, signed in or not (role-expectations: /api/v0/hq).
 const anonymous=await call(url,null,payload,method);assert.ok((pattern==='/api/v0/hq'||pattern.startsWith('/api/v0/hq/')?[401,404]:[401]).includes(anonymous.status),'anonymous '+method+' '+pattern+': '+anonymous.status);
}
}
// Valid reads/writes: role boundaries must not depend on malformed requests or empty fixture data.
for(const role of groups){
 const token=tokens[role];const p=await call(`/api/v0/people/${process.env.TEST_PERSON}`,token);assert.equal(p.status,200);assert.equal(p.data.can.work,lead(role)||['manager','pgs'].includes(role));
 const out=await call(`/api/v0/people/${process.env.TEST_OTHER}`,token);assert.equal(out.data.can.work,lead(role));
 const hr=await call(`/api/v0/hr/person/${process.env.TEST_PERSON}`,token);assert.equal(hr.status,staff(role)||['manager','pgs'].includes(role)?200:403);
 const outside=await call(`/api/v0/hr/person/${process.env.TEST_OTHER}`,token);assert.equal(outside.status,staff(role)?200:403);
 assert.equal((await call('/api/v0/insights',token)).status,lead(role)?200:403);
 assert.equal((await call('/api/v0/hr/payroll',token)).status,['hr','leadership'].includes(role)?200:403); // operational admin deliberately has no salary grant
 assert.equal((await call('/api/v0/money',token)).status,role==='leadership'?200:403);
 if(role!=='hr'){const client=await call('/api/v0/clients/'+process.env.TEST_CLIENT,token);assert.equal(client.status,200);assert.equal(client.data.latest.length,role==='person'?1:2);assert.equal(client.data.projects[0].total,role==='person'?1:2);const list=await call('/api/v0/clients',token);assert.equal(list.data.clients.find(c=>c.id===process.env.TEST_CLIENT).deliveries,role==='person'?1:2);}
 assert.equal((await call('/api/v0/groups',token)).status,200);
 assert.equal((await call('/api/v0/chats',token)).status,200);
 if(!staff(role))assert.equal((await call('/api/v0/hr/imported-history',token,{personId:process.env.TEST_PERSON,month:'2026-09',leaveDays:1,reason:'Synthetic past report'})).status,403);
 if(!['hr','admin'].includes(role))assert.equal((await call(`/api/v0/people/${process.env.TEST_PERSON}/login`,token,{action:'issue'})).status,403);
 // Round 7B: everyone who works on projects can find and open any project; counts stay their own.
 if(role!=='hr'){
  const started=Date.now();const all=await call('/api/v0/projects?scope=all',token);assert.equal(all.status,200,role+' projects?scope=all');
  assert.ok(Date.now()-started<5000,role+' projects list within 5 s (a PGS scope once took 40 s)');
  assert.ok(all.data.projects.some(x=>x.projectId===process.env.TEST_PROJECT),role+' finds the project');
  assert.equal((await call('/api/v0/projects/'+process.env.TEST_PROJECT,token)).status,200,role+' opens the project');
  const tasks=await call('/api/v0/tasks?mine=1&q=synthetic',token);assert.equal(tasks.status,200);assert.ok(Array.isArray(tasks.data.statuses)&&typeof tasks.data.mine==='number');
 }
 // Round 7B: a correction suggestion from anyone with a person lands in Review data; nonsense is refused with a reason.
 const bad=await call('/api/v0/corrections/suggest',token,{entity:'project',entityId:process.env.TEST_PROJECT,field:'nonsense',value:'x'});assert.equal(bad.status,400);assert.equal(bad.data.error,'Choose what is wrong');
 const sent=await call('/api/v0/corrections/suggest',token,{entity:'project',entityId:process.env.TEST_PROJECT,field:'client',value:'Synthetic client B',note:'matrix '+role});assert.equal(sent.status,200,role+' suggests a correction');assert.ok(sent.data.id);
}
const designerWeek=await call('/api/v0/designers',tokens.manager);assert.equal(designerWeek.status,200,'manager designer collection');
const designerRows=designerWeek.data.designers;assert.deepEqual(designerRows.map(row=>row.personId).sort(),[roles.manager,roles.person].sort(),'manager sees own and managed designer rows');
for(const role of groups){const detail=await call(`/api/v0/designers/${roles[role]}`,tokens[role]);assert.equal(detail.status,DESIGNER_DETAIL_ROLES.has(role)?200:403,role+' self designer detail follows the page role rule');}
assert.equal(designerRows.find(row=>row.personId===roles.manager).types.logo,2,'manager own weekly row counts design files across projects');
assert.equal(designerRows.find(row=>row.personId===roles.person).types.logo,1,'manager sees managed designer work only on team projects');
assert.equal((await call(`/api/v0/designers/${roles.person}`,tokens.manager)).status,403,'manager cannot read a report daily detail');
const personDetail=await call(`/api/v0/designers/${roles.person}`,tokens.person);assert.equal(personDetail.status,200,'designer can read own daily detail');
assert.equal(personDetail.data.days.reduce((total,row)=>total+row.types.logo,0),2,'report self detail includes outside-project design file');
const adminDesigners=await call('/api/v0/designers',tokens.admin);assert.equal(adminDesigners.status,200,'admin designer collection');
assert.deepEqual(adminDesigners.data.designers.map(row=>row.personId).sort(),[roles.manager,roles.person].sort(),'admin roster contains exactly configured designers');
const scopeClient=await pool.connect();try{await scopeClient.query('begin');await scopeClient.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)",[process.env.PULSE_ORG_ID,roles.manager]);
 const scope=(await scopeClient.query('select pulse.manages($1) report,pulse.manages($2) self,$3::uuid=any(pulse.work_projects()) in_scope,$4::uuid=any(pulse.work_projects()) out_of_scope',[roles.person,roles.manager,process.env.TEST_DESIGN_PROJECT,process.env.TEST_DESIGN_OUTSIDE_PROJECT])).rows[0];
 assert.equal(scope.report,true,'real SQL manages() includes the report');assert.equal(scope.self,false,'real SQL manages() excludes self');assert.equal(scope.in_scope,true,'real SQL work_projects() includes the team project');assert.equal(scope.out_of_scope,false,'real SQL work_projects() excludes an unrelated project');
}finally{await scopeClient.query('rollback');scopeClient.release();}
const corrections=await call('/api/v0/review-data?kind=correction',tokens.admin);assert.equal(corrections.status,200);assert.equal(corrections.data.rows.filter(r=>r.kind==='correction').length,groups.length,'every suggestion reaches Review data');
assert.equal((await call('/api/v0/review-data/decide',tokens.admin,{ids:[corrections.data.rows[0].id],action:'accept'})).status,200,'admin marks a correction done');
assert.equal((await call(`/api/v0/people/${roles.admin}/login`,tokens.hr,{})).status,403,'HR cannot reset admins');
assert.equal((await call(`/api/v0/people/${roles.leadership}/login`,tokens.hr,{})).status,403,'HR cannot reset leadership');
assert.equal((await call('/api/v0/admin/invite-current',tokens.admin,{})).status,410,'temporary-password batch endpoint retired');
assert.equal((await call('/api/v0/hr/imported-history',tokens.hr,{personId:process.env.TEST_PERSON,month:'2026-09',leaveDays:1,reason:'Synthetic past report'})).status,200);
// Streaming and public authentication endpoints receive explicit checks too.
const apiOrigin=await app.listen({port:0,host:'127.0.0.1'});
for(const role of groups){
 assert.equal((await call('/healthz',tokens[role])).status,200);
 assert.equal((await call('/api/v0/auth/forgot',null,{username:'synthetic.'+role})).status,200);
 const abort=new AbortController();const stream=await fetch(apiOrigin+'/api/v0/chats/events',{headers:{'x-pulse-session':tokens[role]},signal:abort.signal});
 assert.equal(stream.status,200,role+' SSE');assert.match(new TextDecoder().decode((await stream.body.getReader().read()).value),/event: changed/);abort.abort();
}
assert.equal((await fetch(apiOrigin+'/api/v0/chats/events')).status,401);
await writeFile(process.env.TEST_REPORT,JSON.stringify({apiRoutes:routes.length,roles:groups,apiChecks:apiChecks+7,receipts,tokens}));
// Browser page matrix uses a temporary local web and API, connected only to this disposable tenant.
if(process.env.PULSE_PAGE_MATRIX==='1'){
 const {runPages}=await import('./page-matrix-runner.mjs');await runPages(tokens,process.env.TEST_REPORT,apiOrigin);
}
for(const role of groups){assert.equal((await call('/api/v0/auth/sign-out',tokens[role],{})).status,200);assert.equal((await call('/api/v0/me',tokens[role])).status,401);}
const finalReport=JSON.parse(await readFile(process.env.TEST_REPORT,'utf8'));finalReport.apiChecks=apiChecks+7;await writeFile(process.env.TEST_REPORT,JSON.stringify(finalReport));
await app.close();await pool.end();
