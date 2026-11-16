// R49 over HTTP: the published method, a job's requirements, the ranked candidates with every contribution, the
// pick gate (HR's acceptance), and the check a person answers about what Pulse read. Synthetic people and skills only.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),app=createApp(pool,pool);
const ids=JSON.parse(process.env.TEST_IDS);
const call=async(url,payload,token)=>{const r=await app.inject({url,method:payload?'POST':'GET',headers:token?{'x-pulse-session':token}:{},...(payload?{payload}:{})});
 return {status:r.statusCode,data:r.headers['content-type']?.includes('json')?r.json():r.body};};
const login=async username=>{const r=await call('/api/v0/auth/sign-in',{username,password:'Synthetic-issued-2026!'});assert.equal(r.status,200,username);const token=r.data.token;
 assert.equal((await call('/api/v0/auth/change-password',{current:'Synthetic-issued-2026!',next:'Synthetic-new-2026!'},token)).status,200);return token;};
const editor=await login('user1x'),head=await login('user2x'),hr=await login('user3x'),admin=await login('user4x'),outsider=await login('outsider9');
// Everyone reads how matching works; only HR and admins see jobs and candidates.
const method=await call('/api/v0/ats/method',null,editor);assert.equal(method.status,200);
assert.equal(method.data.current.version,0);assert.deepEqual(method.data.can,{review:false,accept:false});assert.equal(method.data.defaults.required,3);
for(const t of [editor,head,outsider]){
 assert.equal((await call('/api/v0/ats/jobs',null,t)).status,403);
 assert.equal((await call(`/api/v0/ats/jobs/${ids.job}/candidates`,null,t)).status,403);
 assert.equal((await call('/api/v0/ats/jobs',{title:'Synthetic'},t)).status,403);
 assert.equal((await call('/api/v0/ats/weights',{weights:{},reason:'x'},t)).status,403);
}
assert.deepEqual((await call('/api/v0/ats/jobs',null,admin)).data.jobs.map(j=>[j.title,j.required,j.preferred]),[['Synthetic launch editor',2,3]]);
// A requirement: required/preferred, level, months, accepted alternatives; refusals in the database's words.
const job=(await call(`/api/v0/ats/jobs/${ids.job}`,null,hr)).data;assert.equal(job.requirements.length,5);
assert.deepEqual(job.requirements.map(r=>r.importance),['required','required','preferred','preferred','preferred']);
assert.equal(job.requirements[0].also[0].label,'Reel editing');assert.equal(job.requirements[2].mapped[0].relation,'exact');
const extra=await call(`/api/v0/ats/jobs/${ids.job}/requirements`,{conceptId:ids.drone,importance:'preferred',minLevel:'',recentMonths:'',also:[],note:''},hr);
assert.equal(extra.status,400);assert.match(extra.data.error,/no longer offered/);
assert.equal((await call(`/api/v0/ats/jobs/${ids.job}/requirements`,{conceptId:ids.drone,importance:'essential'},hr)).status,400);
const same=await call(`/api/v0/ats/jobs/${ids.job}/requirements`,{id:ids.shootReq,conceptId:job.requirements[1].conceptId,importance:'required',minLevel:2,note:'Synthetic: shoots'},admin);
assert.equal(same.status,200);assert.equal((await call(`/api/v0/ats/jobs/${ids.job}`,null,hr)).data.requirements[1].version,2);
// Candidates: everyone active, ranked, each requirement with its outcome and contributions.
const cands=(await call(`/api/v0/ats/jobs/${ids.job}/candidates`,null,hr)).data;
assert.equal(cands.candidates.length,5);assert.equal(cands.candidates[0].personId,ids.editor);assert.equal(Number(cands.candidates[0].points),5.4);
const edit=cands.candidates[0].requirements[0];assert.equal(edit.outcome,'matched');assert.equal(edit.considered.filter(c=>c.counted).length,1);
const out=cands.candidates.find(c=>c.personId===ids.outsider);assert.equal(out.requirements[1].outcome,'missing');
assert.ok(cands.candidates.filter(c=>Number(c.points)===0).every(c=>c.requirements.every(r=>r.outcome==='unknown')),'nothing on record is unknown, not missing');
// No pick before the job is open and HR accepts the weights; an admin alone cannot accept.
assert.match((await call(`/api/v0/ats/jobs/${ids.job}/picks`,{personId:ids.editor,note:'Synthetic'},hr)).data.error,/Open the job/);
assert.equal((await call('/api/v0/ats/jobs',{id:ids.job,title:'Synthetic launch editor',status:'open'},hr)).status,200);
const early=await call(`/api/v0/ats/jobs/${ids.job}/picks`,{personId:ids.editor,note:'Synthetic'},hr);assert.equal(early.status,403);assert.match(early.data.error,/not accepted/);
assert.equal((await call('/api/v0/ats/accept',{version:0,note:'Synthetic: read three explanations'},admin)).status,403);
assert.equal((await call('/api/v0/ats/accept',{version:0,note:'Synthetic: read three explanations'},hr)).status,200);
const pick=await call(`/api/v0/ats/jobs/${ids.job}/picks`,{personId:ids.editor,note:'Synthetic: strongest launch cuts'},hr);assert.equal(pick.status,200);
assert.equal((await call(`/api/v0/ats/jobs/${ids.job}/picks`,{personId:ids.editor,note:'Synthetic again'},admin)).status,409);
assert.equal((await call(`/api/v0/ats/picks/${pick.data.id}/withdraw`,{note:'Synthetic'},editor)).status,403);
// Weights: HR and admins publish a new version; refusals say why.
const bad=await call('/api/v0/ats/weights',{weights:{...method.data.defaults,preferred:5},reason:'Synthetic'},admin);assert.equal(bad.status,400);assert.match(bad.data.error,/preferred/);
assert.equal((await call('/api/v0/ats/weights',{weights:{...method.data.defaults,required:4},reason:'Synthetic: required counts more'},admin)).data.version,1);
assert.equal((await call('/api/v0/ats/method',null,outsider)).data.current.accepted,null);
// The correction route: HR asks; the person sees only the question and their own reading, corrects and answers.
const ask=await call(`/api/v0/ats/jobs/${ids.job}/checks`,{personId:ids.outsider,requirementId:ids.shootReq,question:'Synthetic: is Learning right?'},hr);assert.equal(ask.status,200);
const mine=(await call('/api/v0/ats/my-checks',null,outsider)).data.checks;assert.equal(mine.length,1);assert.equal(mine[0].before.outcome,'missing');
assert.equal(JSON.stringify(mine).includes('Synthetic launch editor'),false);
assert.deepEqual((await call('/api/v0/ats/my-checks',null,editor)).data.checks,[]);
assert.equal((await call(`/api/v0/ats/checks/${ask.data.id}/answer`,{answer:'Synthetic'},editor)).status,403);
assert.equal((await call(`/api/v0/ats/checks/${ask.data.id}/answer`,{answer:'Synthetic: still learning'},outsider)).status,200);
assert.equal((await call(`/api/v0/ats/checks/${ask.data.id}/close`,{note:'Synthetic'},outsider)).status,403);
assert.equal((await call(`/api/v0/ats/checks/${ask.data.id}/close`,{note:'Synthetic: thanks'},hr)).status,200);
const after=(await call(`/api/v0/ats/jobs/${ids.job}`,null,admin)).data;
assert.deepEqual(after.checks.map(c=>[c.person,c.before,c.after,c.answer]),[['Pod Two Outsider','missing','missing','Synthetic: still learning']]);
assert.deepEqual(after.picks.map(p=>[p.person,p.by,p.weightsVersion]),[['Editor One','Project Lead',0]]);
await app.close();await pool.end();
