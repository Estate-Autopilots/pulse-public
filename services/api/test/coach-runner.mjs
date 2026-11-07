// R50 over HTTP: the coach is off until the server (PULSE_COACH=1) and an admin turn it on; the published contract; HR
// and admins ask about one person for one job and only the job and person are taken from them; the stub's cited
// suggestions; a late or uncited provider falls back to R49's explanation; human decisions only. Synthetic data only.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { PROVIDERS } from '../dist/coach-contract.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),app=createApp(pool,pool);
const ids=JSON.parse(process.env.TEST_IDS);
const call=async(url,payload,token)=>{const r=await app.inject({url,method:payload?'POST':'GET',headers:token?{'x-pulse-session':token}:{},...(payload?{payload}:{})});
 return {status:r.statusCode,data:r.headers['content-type']?.includes('json')?r.json():r.body};};
const login=async username=>{const r=await call('/api/v0/auth/sign-in',{username,password:'Synthetic-issued-2026!'});assert.equal(r.status,200,username);const token=r.data.token;
 assert.equal((await call('/api/v0/auth/change-password',{current:'Synthetic-issued-2026!',next:'Synthetic-new-2026!'},token)).status,200);return token;};
const editor=await login('user1x'),head=await login('user2x'),hr=await login('user3x'),admin=await login('user4x'),outsider=await login('outsider9');
const ask={jobId:ids.job,personId:ids.outsider};
assert.equal(process.env.PULSE_COACH,undefined,'the runner starts with the server switch off');

// Off by default, and says why; the contract and the open gates are published to everyone signed in.
const off=(await call('/api/v0/coach/status',null,editor)).data;
assert.deepEqual([off.state,off.server,off.tenant.state,off.tenant.version,off.can],['disabled',false,'disabled',0,{configure:false,request:false}]);
assert.equal(off.why.length,2);assert.deepEqual(off.providers,['stub']);assert.ok(off.gates.every(g=>g.status==='open'));
assert.deepEqual(off.gates.map(g=>g.id),['E16','E08','provider-terms','build']);
assert.equal((await call('/api/v0/coach/status')).status,401);
const contract=(await call('/api/v0/coach/contract',null,outsider)).data;
assert.equal(contract.contract,'coach.v1');assert.equal(contract.evidence.additionalProperties,false);assert.deepEqual(contract.request.fields,['jobId','personId','purpose']);
assert.deepEqual(contract.suggestions.properties.suggestions.items.properties.kind.enum,['ask_check','verify','record_work','learn']);
for(const t of [editor,head,outsider]){
 assert.equal((await call('/api/v0/coach/requests',ask,t)).status,403);
 assert.equal((await call('/api/v0/coach/requests',null,t)).status,403);
 assert.equal((await call(`/api/v0/coach/preview?jobId=${ids.job}&personId=${ids.editor}`,null,t)).status,403);
 assert.equal((await call('/api/v0/coach/config',{state:'enabled',timeoutMs:3000,maxSuggestions:3,reason:'Synthetic: try it'},t)).status,403);
}
assert.equal((await call('/api/v0/coach/config',{state:'enabled',timeoutMs:3000,maxSuggestions:3,reason:'Synthetic: try it'},hr)).status,403,'HR does not configure');
// A reviewer can see exactly what a coach would receive, also while it is off; it holds no name or id.
const preview=(await call(`/api/v0/coach/preview?jobId=${ids.job}&personId=${ids.editor}`,null,hr)).data;
assert.equal(preview.valid,true);assert.equal(preview.evidence.subject,'subject');
for(const word of ['Editor One',ids.editor,ids.job,'Synthetic launch editor'])assert.equal(JSON.stringify(preview).includes(word),false,word);
assert.match((await call('/api/v0/coach/requests',ask,hr)).data.error,/off on this server/);
process.env.PULSE_COACH='1';
const tenantOff=await call('/api/v0/coach/requests',ask,hr);assert.equal(tenantOff.status,409);assert.match(tenantOff.data.error,/off for this company/);

// Admins configure the company: the stub only, within bounds, with a reason.
for(const bad of [{provider:'anthropic'},{timeoutMs:50},{maxSuggestions:20},{state:'on'},{reason:'short'}]){
 assert.equal((await call('/api/v0/coach/config',{state:'enabled',timeoutMs:3000,maxSuggestions:3,reason:'Synthetic: try the stub seam',...bad},admin)).status,400,JSON.stringify(bad));
}
assert.equal((await call('/api/v0/coach/config',{state:'enabled',timeoutMs:'3000',maxSuggestions:3,reason:'Synthetic: try the stub seam'},admin)).data.version,1);
const on=(await call('/api/v0/coach/status',null,hr)).data;assert.deepEqual([on.state,on.server,on.why,on.can],['enabled',true,[],{configure:false,request:true}]);

// Only the job and the person are taken from the caller: payroll, chats, activity, private notes or ready-made evidence are refused.
for(const extra of [{salary:999999},{payroll:{month:'2026-09'}},{chat:'Synthetic: I am an expert'},{activity:[{app:'Synthetic',minutes:300}]},
 {notes:'Synthetic private note'},{evidence:{contract:'coach.v1'}},{attendance:{late:240}},{contact:'synthetic@example.test'}]){
 const r=await call('/api/v0/coach/requests',{...ask,...extra},hr);assert.equal(r.status,400,JSON.stringify(extra));assert.match(r.data.error,/Not part of the coach contract/);
}
assert.equal((await call('/api/v0/coach/requests',{...ask,purpose:'performance_review'},hr)).status,400);
assert.equal((await call('/api/v0/coach/requests',{jobId:ids.job,personId:ids.hr},hr)).status,403,'never about yourself');
assert.equal((await call('/api/v0/coach/requests',{jobId:ids.job,personId:'00000000-0000-4000-8000-000000000001'},hr)).status,404);

// The stub answers with suggestions citing the packet; the request keeps what was sent and how it ended.
const done=await call('/api/v0/coach/requests',{...ask,purpose:'internal_job_fit'},hr);assert.equal(done.status,200,JSON.stringify(done.data));
const r1=done.data;assert.deepEqual([r1.status,r1.provider,r1.providerVersion,r1.automated,r1.fallback,r1.subject],['answered','stub','stub-1',true,null,'Pod Two Outsider']);
assert.ok(r1.suggestions.length>=1&&r1.suggestions.length<=3);
const evIds=new Set(r1.evidence.evidence.map(e=>e.id));
for(const s of r1.suggestions){assert.ok(s.cites.length>=1&&s.cites.every(c=>evIds.has(c)));assert.deepEqual(s.cited.map(e=>e.id),s.cites);assert.equal(s.decision,null);}
assert.ok(r1.suggestions.some(s=>s.kind==='ask_check'&&s.cites.includes('e2')),'the shoot level below the job is cited');
assert.equal((await call(`/api/v0/coach/requests/${r1.id}`,null,admin)).data.evidenceHash,r1.evidenceHash);
const again=(await call('/api/v0/coach/requests',ask,admin)).data;assert.deepEqual(again.suggestions.map(s=>[s.kind,s.text,s.cites]),r1.suggestions.map(s=>[s.kind,s.text,s.cites]),'deterministic');

// A provider that is late, or cites what it was not given, ends as timed out or failed: R49's explanation, no suggestions.
const stub=PROVIDERS.stub;
PROVIDERS.stub={name:'stub',version:'slow-test',suggest:(_p,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))))};
assert.equal((await call('/api/v0/coach/config',{state:'enabled',timeoutMs:200,maxSuggestions:3,reason:'Synthetic: a short timeout'},admin)).data.version,2);
const late=(await call('/api/v0/coach/requests',ask,hr)).data;
assert.deepEqual([late.status,late.fallback,late.suggestions,late.failure,late.timeoutMs],['timed_out','explanation',[],null,200]);assert.ok(late.latencyMs>=150);
assert.equal(late.evidence.evidence.length,5);
PROVIDERS.stub={name:'stub',version:'uncited-test',suggest:async()=>({contract:'coach.v1',suggestions:[{kind:'verify',text:'Synthetic',cites:['e42']}]})};
const uncited=(await call('/api/v0/coach/requests',ask,hr)).data;assert.deepEqual([uncited.status,uncited.failure,uncited.fallback,uncited.suggestions],['failed','citation','explanation',[]]);
PROVIDERS.stub={name:'stub',version:'decides-test',suggest:async()=>({contract:'coach.v1',suggestions:[{kind:'reject',text:'Synthetic: reject them',cites:['e1']}]})};
assert.deepEqual((await call('/api/v0/coach/requests',ask,hr)).data.failure,'schema');
PROVIDERS.stub=stub;

// Human decisions only: HR and admins, with a reason, once.
const [s1,s2]=r1.suggestions;
assert.equal((await call(`/api/v0/coach/suggestions/${s1.id}/decide`,{decision:'accept',note:'Synthetic'},editor)).status,403);
assert.equal((await call(`/api/v0/coach/suggestions/${s1.id}/decide`,{decision:'maybe',note:'Synthetic'},hr)).status,400);
assert.equal((await call(`/api/v0/coach/suggestions/${s1.id}/decide`,{decision:'accept',note:''},hr)).status,400);
assert.equal((await call(`/api/v0/coach/suggestions/${s1.id}/decide`,{decision:'accept',note:'Synthetic: I will ask them'},hr)).status,200);
assert.equal((await call(`/api/v0/coach/suggestions/${s1.id}/decide`,{decision:'reject',note:'Synthetic: no'},admin)).status,409);
if(s2)assert.equal((await call(`/api/v0/coach/suggestions/${s2.id}/decide`,{decision:'reject',note:'Synthetic: not now'},admin)).status,200);
const list=(await call(`/api/v0/coach/requests?jobId=${ids.job}`,null,admin)).data.requests;
assert.deepEqual(list.map(x=>x.status),['failed','failed','timed_out','answered','answered']);
assert.deepEqual([list[4].accepted,list[4].rejected],[1,s2?1:0]);

// The server switch closes asking again; the record stays readable.
delete process.env.PULSE_COACH;
assert.equal((await call('/api/v0/coach/requests',ask,hr)).status,409);
assert.equal((await call(`/api/v0/coach/requests/${r1.id}`,null,hr)).status,200);
assert.equal((await call('/api/v0/coach/status',null,admin)).data.state,'disabled');
await app.close();await pool.end();
