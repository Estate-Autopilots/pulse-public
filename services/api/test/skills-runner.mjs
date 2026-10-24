// R48 over HTTP: the picker with attribution, HR's local list, a person's own claims, a separate verification by the
// pod head, the person-reviewed CV and its restricted, logged export. Synthetic people, codes and labels only.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),app=createApp(pool,pool);
const call=async(url,payload,token)=>{const r=await app.inject({url,method:payload?'POST':'GET',headers:token?{'x-pulse-session':token}:{},...(payload?{payload}:{})});
 return {status:r.statusCode,headers:r.headers,data:r.headers['content-type']?.includes('json')?r.json():r.body};};
const login=async username=>{const r=await call('/api/v0/auth/sign-in',{username,password:'Synthetic-issued-2026!'});assert.equal(r.status,200,username);const token=r.data.token;
 assert.equal((await call('/api/v0/auth/change-password',{current:'Synthetic-issued-2026!',next:'Synthetic-new-2026!'},token)).status,200);return token;};
const me=process.env.TEST_EDITOR,attribution='This service uses the ESCO classification of the European Commission.';
const editor=await login('user1x'),head=await login('user2x'),hr=await login('user3x'),admin=await login('user4x'),outsider=await login('outsider9');
// The picker: the approved slice with its licence and attribution; the list's curation is HR's and admins'.
const found=(await call('/api/v0/skills/catalog?q=video%20edit',null,editor)).data;
assert.equal(found.items[0].code,process.env.TEST_ESCO_EDIT);assert.equal(found.items[0].matched.label,'video editing');
assert.deepEqual(found.sources.map(s=>[s.family,s.attribution,s.softwareLicence]),[['esco',attribution,null]]);
assert.equal((await call('/api/v0/skills/setup',null,editor)).status,403);
assert.equal((await call('/api/v0/skills/local',{label:'Model shoot direction'},editor)).status,403);
const local=await call('/api/v0/skills/local',{label:'Model shoot direction',description:'Synthetic local skill'},hr);assert.equal(local.status,200);
const dup=await call('/api/v0/skills/local',{label:'model shoot direction'},admin);assert.equal(dup.status,409);assert.match(dup.data.error,/already in the list/);
const setup=(await call('/api/v0/skills/setup',null,hr)).data;
assert.equal(setup.sources[0].approvalRef,'E16 synthetic approval record');assert.equal(setup.rubric.confirmed,false);assert.deepEqual(setup.local.map(l=>l.label),['Model shoot direction']);
// The person's own claims; nobody else writes them.
const edit=found.items[0].id;
const mine=await call(`/api/v0/people/${me}/skills`,{conceptId:edit,level:3,since:'2025-04',note:'Synthetic note'},editor);assert.equal(mine.status,200,JSON.stringify(mine.data));
assert.equal((await call(`/api/v0/people/${me}/skills`,{conceptId:local.data.id,level:2},head)).status,403);
assert.equal((await call(`/api/v0/people/${me}/skills`,{conceptId:local.data.id,level:9},editor)).status,400);
assert.equal((await call(`/api/v0/people/${me}/skills`,{conceptId:local.data.id,level:2,since:'April'},editor)).status,400);
assert.equal((await call(`/api/v0/people/${me}/skills`,{conceptId:local.data.id,level:2},editor)).status,200);
// Who reads the profile: the person, their pod head, HR and admins; not a colleague in another pod.
for(const t of [editor,head,hr,admin])assert.equal((await call(`/api/v0/people/${me}/skills`,null,t)).status,200);
assert.equal((await call(`/api/v0/people/${me}/skills`,null,outsider)).status,403);
assert.equal((await call(`/api/v0/people/${me}`,null,head)).data.can.skills,true);
assert.equal((await call(`/api/v0/people/${me}`,null,outsider)).data.can.skills,false);
// Verification is a separate mark on one version, by the pod head or HR, never the person.
assert.equal((await call(`/api/v0/skills/claims/${mine.data.id}/verify`,{version:1,level:3},editor)).status,403);
assert.equal((await call(`/api/v0/skills/claims/${mine.data.id}/verify`,{version:1,level:2,note:'Synthetic: saw it'},head)).status,200);
assert.equal((await call(`/api/v0/skills/claims/${mine.data.id}/verify`,{version:2,level:2},head)).status,409);
let profile=(await call(`/api/v0/people/${me}/skills`,null,editor)).data;
const claimed=profile.skills.find(s=>s.id===mine.data.id);
assert.deepEqual([claimed.level,claimed.verification.level,claimed.verification.basis,claimed.verification.current],[3,2,'manager',true]);
assert.deepEqual(profile.can,{edit:true,verify:false,curate:false});
// Experience the person records; the CV they review is what others read, logged; the draft is theirs alone.
const exp=await call(`/api/v0/people/${me}/experience`,{title:'Shoot lead',started:'2025-03',outcomes:'Synthetic: 12 reels'},editor);assert.equal(exp.status,200);
assert.equal((await call(`/api/v0/people/${me}/experience`,{title:'Shoot lead',started:'2025-03'},hr)).status,403);
let cv=(await call(`/api/v0/people/${me}/cv`,null,editor)).data;assert.equal(cv.reviewed,null);assert.equal(cv.draft.body.skills.length,2);
const choice={headline:'Synthetic video editor',summary:'Synthetic summary',skills:[mine.data.id],experience:[exp.data.id]};
assert.equal((await call(`/api/v0/people/${me}/cv/preview`,choice,head)).status,403);
const preview=(await call(`/api/v0/people/${me}/cv/preview`,choice,editor)).data;assert.equal(preview.body.skills.length,1);
assert.equal((await call(`/api/v0/people/${me}/cv`,{...choice,sha256:cv.draft.sha256},editor)).status,409);
const kept=await call(`/api/v0/people/${me}/cv`,{...choice,sha256:preview.sha256},editor);assert.equal(kept.status,200);assert.equal(kept.data.version,1);
assert.equal((await call(`/api/v0/people/${me}/cv`,null,outsider)).status,403);
const seen=(await call(`/api/v0/people/${me}/cv`,null,head)).data;assert.equal(seen.reviewed.version,1);assert.equal(seen.draft,null);
assert.equal((await call(`/api/v0/people/${me}/cv/export`,null,outsider)).status,403);
const file=await call(`/api/v0/people/${me}/cv/export`,null,hr);assert.equal(file.status,200);
assert.match(file.headers['content-type'],/^text\/markdown/);assert.equal(file.headers['content-disposition'],'attachment; filename="cv-editor-one-v1.md"');
assert.match(file.data,/^# Editor One\n/);assert.match(file.data,/\*\*edit video footage\*\* \(ESCO\): Strong, self-assessed; verified Working by Editor Two \(manager, /);
assert.match(file.data,/Shoot lead/);assert.match(file.data,/self-reported/);assert.match(file.data,/Pulse's starting scale, not yet confirmed by HR/);
assert.ok(file.data.includes(attribution),'the export carries ESCO attribution');assert.equal(file.data.includes('Model shoot direction'),false,'only what the person chose');
cv=(await call(`/api/v0/people/${me}/cv`,null,editor)).data;
assert.deepEqual(cv.openedBy.map(o=>[o.by,o.purpose]).sort(),[['Editor Two','resume_view'],['Project Lead','resume_export']]);assert.equal(cv.changedSince,false);
// Work the person may link, with whether it is approved yet.
const work=(await call('/api/v0/skills/my-work',null,editor)).data;assert.ok(Array.isArray(work.tasks)&&Array.isArray(work.projects));
await app.close();await pool.end();
