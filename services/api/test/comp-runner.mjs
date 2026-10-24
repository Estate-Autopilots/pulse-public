// COMP-A acceptance on a disposable tenant with synthetic people and figures only (tests/core/test_comp.py): pay set up
// from salary records, a raise with its preview, approval and letter (PDF and DOCX), an offer from draft to a signed-out
// acceptance and probation, probation confirmed, a pause the month's pay respects, a bonus, a reimbursement claim with
// its bill, the full and final with its letter, who may see what at every step, amounts sealed in the database, the
// access log, notices without amounts, and no keyring → nothing saved. Mail goes to the sink (PULSE_CI=1).
import assert from 'node:assert/strict';import {Pool} from 'pg';import {chmod,writeFile} from 'node:fs/promises';import {randomBytes} from 'node:crypto';import {join} from 'node:path';
import {createApp} from '../dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),owner=new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
const app=createApp(pool,pool);const R=JSON.parse(process.env.TEST_ROLES);const ORG=process.env.PULSE_ORG_ID;
let checks=0;const receipts=[];
const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;receipts.push(label);};
const ok=(v,label)=>{assert.ok(v,label);checks++;receipts.push(label);};
async function call(path,body,{as='hr',anon=false,raw=false}={}){
 const headers=anon?{'x-pulse-client-ip':'198.51.100.7','user-agent':'comp-runner'}:{'cf-access-authenticated-user-email':as+'@comp.example'};
 const r=await app.inject({url:path.startsWith('/')?path:'/api/v0/'+path,method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{payload:body})});
 if(raw)return {status:r.statusCode,body:r.rawPayload,type:r.headers['content-type']};
 let data;try{data=r.json();}catch{data=r.rawPayload;}return {status:r.statusCode,data};
}
async function own(sql,args=[]){const c=await owner.connect();try{await c.query('begin');await c.query('set local role pulse_owner');await c.query("select set_config('pulse.org_id',$1,true)",[ORG]);const r=await c.query(sql,args);await c.query('commit');return r.rows;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
/** As the owner with HR as the viewer: the salary table's own writer policy wants the salary permission. */
async function asHr(sql,args=[]){const c=await owner.connect();try{await c.query('begin');await c.query('set local role pulse_owner');await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)",[ORG,R.hr]);const r=await c.query(sql,args);await c.query('commit');return r.rows;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
const notes=async(person)=>own("select event_type,title from pulse.notification where person_id=$1 and event_type like 'comp.%' order by created_at",[person]);
const PNG='data:image/png;base64,'+Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000','hex'),randomBytes(24)]).toString('base64');
const today=(await own("select pulse.lifecycle_today()::text d"))[0].d;
const addDays=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*864e5).toISOString().slice(0,10);
const first=today.slice(0,8)+'01';

try{
// ------------------------------------------------------------------------------- 0. no keyring, no pay
process.env.PULSE_DOCUMENT_KEY_FILE=join(process.env.TEST_KEY_DIR,'missing.key');
await asHr("insert into pulse_priv.hr_compensation(org_id,person_id,effective_month,kind,amount,source_file_id,source_name,source_sheet,basis) values($1,$2,$3,'current',61234,'syn','Synthetic sheet','Sheet','synthetic')",[ORG,R.person,addDays(first,-62)]);
let r=await call(`comp/people/${R.person}/setup`,{});
eq([r.status,/encryption key isn’t installed/.test(r.data.error)],[503,true],'without the keyring HR cannot set up pay: nothing is saved');
eq((await call('comp/people?figures=1')).status,503,'nor show figures');
eq((await call('comp/people')).status,200,'the table itself still opens (no amounts in it)');
const KEYS=process.env.TEST_KEY_DIR,keyFile=join(KEYS,'document-master.key');
await writeFile(keyFile,`comp-2026-10 ${randomBytes(32).toString('base64')}\n`,{mode:0o600});await chmod(keyFile,0o600);process.env.PULSE_DOCUMENT_KEY_FILE=keyFile;

// ------------------------------------------------------------------------------- 1. who sees the table
let table=(await call('comp/people')).data;
const row=(id)=>table.people.find((p)=>p.id===id);
eq([row(R.person).hasRecord,row(R.person).next.label,row(R.person).action],[false,'No pay record yet',{key:'setup',label:'Set up pay'}],'HR sees a person without a record and the one thing to do');
for(const as of ['person','head','other','admin'])eq((await call('comp/people',undefined,{as})).status,403,`${as} does not open People & pay`);
eq((await call('comp/people',undefined,{as:'founder'})).status,200,'a founder opens it');

// ------------------------------------------------------------------------------- 2. set up from salary records
r=await call(`comp/people/${R.person}/setup`,{});
ok(r.status===200&&r.data.startId,'HR sets up the person’s pay from the salary records');
let page=(await call(`comp/people/${R.person}`)).data;
eq([page.record.status,page.inForce.payType,page.inForce.figures.monthly,page.inForce.components.find((c)=>c.key==='basic').amount],['confirmed','salary',6123400,3061700],'the record is in force with the company’s split');
const stored=await own("select encode(s_data,'escape') d from pulse.comp_change where person_id=$1",[R.person]);
ok(stored.every((x)=>!x.d.includes('6123400')&&!x.d.includes('61234')),'the database holds only ciphertext for the figures');
eq((await call(`comp/people/${R.person}/setup`,{})).data.startId,null,'setting up twice changes nothing');

// ------------------------------------------------------------------------------- 3. a raise: preview, approval, letter
const raise={person:R.person,kind:'raise',effectiveOn:addDays(first,-31),payType:'salary',figures:{monthly:'67,500'},reason:'Synthetic annual review'};
r=await call('comp/preview',raise);
eq([r.status,r.data.preview.diff.monthly,r.data.preview.diff.percent>10,r.data.preview.arrears.amount>0],[200,626600,true,true],'the preview shows the difference, the share and the arrears of a backdated raise');
ok(r.data.letter.kind==='revision'&&r.data.letter.data.previousMonthly===6123400,'and what the letter will say');
eq((await call('comp/preview',{...raise,figures:{monthly:50000}})).data.error,'A raise is more than the pay before it: choose a cut or a correction','a "raise" that lowers pay is refused');
eq((await call('comp/preview',raise,{as:'person'})).status,403,'a member cannot preview pay');
r=await call('comp/changes',raise);
const raiseId=r.data.id;ok(raiseId,'HR proposes the raise');
eq((await call(`comp/changes/${raiseId}/decide`,{action:'approve'})).status,403,'HR does not approve it');
eq((await call(`comp/changes/${raiseId}/decide`,{action:'approve'},{as:'person'})).status,403,'nor does the person');
r=await call(`comp/changes/${raiseId}/decide`,{action:'approve'},{as:'founder'});
ok(r.status===200&&r.data.letterId&&r.data.arrearsId,'a founder approves; the letter is filed and the arrears recorded');
const raiseLetter=r.data.letterId;
let me=(await call('comp/me',undefined,{as:'person'})).data;
eq([me.inForce.figures.monthly,me.letters.length,me.items.map((i)=>i.kind)],[6750000,1,['arrears']],'the person sees their new pay, the letter and the arrears in My money');
let pdf=await call(`comp/letters/${raiseLetter}/pdf`,undefined,{as:'person',raw:true});
eq([pdf.status,pdf.body.subarray(0,5).toString()],[200,'%PDF-'],'the person opens the letter');
let docx=await call(`comp/letters/${raiseLetter}/docx`,undefined,{raw:true});
eq([docx.status,docx.body.subarray(0,2).toString()],[200,'PK'],'HR downloads it as Word');
eq((await call(`comp/letters/${raiseLetter}/pdf`,undefined,{as:'other',raw:true})).status,404,'a colleague cannot');
eq((await call(`comp/people/${R.person}`,undefined,{as:'other'})).status,403,'nor read their pay');
const titles=(await notes(R.person)).map((n)=>n.title);
ok(titles.includes('A letter about your pay is ready: Revision of your pay'),'the person is told, without an amount');
ok((await notes(R.founder)).some((n)=>n.event_type==='comp.waiting'&&/waiting for your approval/.test(n.title)),'the founder was asked');

// ------------------------------------------------------------------------------- 4. an offer to a candidate
const offer={person:R.candidate,role:'Synthetic editor',startOn:today,payType:'salary',figures:{monthly:42000},probationDays:90,noticeDays:15,terms:'Synthetic terms of work.'};
r=await call('comp/offers/preview',offer);
eq([r.status,r.data.letter.kind,r.data.letter.data.probationEnd],[200,'offer',addDays(today,89)],'the offer preview has the letter’s data');
const offerId=(await call('comp/offers',offer)).data.id;ok(offerId,'HR drafts the offer');
eq((await call(`comp/offers/${offerId}/propose`,{})).data.ok,true,'and asks a founder');
eq((await call(`comp/offers/${offerId}/send`,{},{as:'founder'})).status,400,'it cannot be sent before approval');
r=await call(`comp/offers/${offerId}/decide`,{action:'approve'},{as:'founder'});
ok(r.data.letterId,'a founder approves; the offer letter is filed');
eq((await call(`comp/offers/${offerId}/send`,{})).status,403,'HR cannot press Send');
r=await call(`comp/offers/${offerId}/send`,{},{as:'founder2'});
const url=r.data.url,token=url.split('/offer/')[1];ok(/^[A-Za-z0-9_-]{43}$/.test(token),'a founder sends it: the link is shown once');
r=await call(`/api/v0/offer/${token}`,undefined,{anon:true});
eq([r.status,r.data.role,r.data.canDecide,JSON.stringify(r.data).includes('4200000')||'monthly' in r.data],[200,'Synthetic editor',true,false],'signed out, the link opens the offer’s face');
pdf=await call(`/api/v0/offer/${token}/pdf`,undefined,{anon:true,raw:true});
eq([pdf.status,pdf.body.subarray(0,5).toString()],[200,'%PDF-'],'and its letter');
eq((await call(`/api/v0/offer/${'x'.repeat(43)}`,undefined,{anon:true})).status,404,'a made-up link opens nothing');
r=await call(`/api/v0/offer/${token}`,{decision:'accepted',name:'Synthetic Candidate'},{anon:true});
eq([r.status,r.data.decision],[200,'accepted'],'the candidate accepts with their typed name');
page=(await call(`comp/people/${R.candidate}`)).data;
eq([page.record.status,page.person.stage,page.person.role,page.employment.probationTo],['probation','probation','Synthetic editor',addDays(today,89)],'they start today on probation, in the offer’s role');
eq([page.inForce?.figures?.monthly,page.versions.map((v)=>v.kind)],[4200000,['offer']],'the accepted offer is the pay in force');
eq((await call(`/api/v0/offer/${token}`,{decision:'declined',name:'Synthetic Candidate'},{anon:true})).status,400,'the link answers once');

// ------------------------------------------------------------------------------- 5. probation confirmed
r=await call(`comp/people/${R.candidate}/probation`,{action:'confirm'});
ok(r.data.status==='approved'&&r.data.letterId,'HR confirms the probation (company policy: HR); the letter is filed');
eq((await call(`comp/people/${R.candidate}`)).data.record.status,'confirmed','the record is confirmed');

// ------------------------------------------------------------------------------- 6. pause, bonus, the month
r=await call('comp/pauses',{person:R.person,from:first,to:addDays(first,9),paidPercent:50,reasonKind:'unpaid_leave',note:'Synthetic family matter'});
const pauseId=r.data.id;ok(pauseId,'HR proposes a half-pay pause');
r=await call(`comp/pauses/${pauseId}/decide`,{action:'approve'},{as:'founder'});
ok(r.data.letterId,'a founder approves it; the person gets a letter');
r=await call('comp/items',{person:R.person,kind:'bonus',amount:5000,reason:'Synthetic festival bonus'});
await call(`comp/items/${r.data.id}/decide`,{action:'approve'},{as:'founder'});
const month=(await call(`comp/people/${R.person}/month?month=${today.slice(0,7)}`)).data;
ok(month.lines.some((l)=>/^Paused 10 days at 50%$/.test(l.label))&&month.lines.some((l)=>l.label==='Bonus'&&l.amount===500000)&&month.lines.some((l)=>l.label==='Arrears'),'the month’s pay respects the pause and includes the bonus and arrears');
eq((await call(`comp/people/${R.person}/month?month=${today.slice(0,7)}`,undefined,{as:'other'})).status,403,'a colleague cannot see it');

// ------------------------------------------------------------------------------- 7. a claim with its bill
const claim={category:'travel',spentOn:addDays(today,-1),vendor:'Synthetic Cabs',amount:'1,250',receipt:PNG};
r=await call('comp/claims',claim,{as:'person'});
const claimId=r.data.id;ok(claimId,'the person claims with a photo of the bill');
eq((await call('comp/claims',{...claim,vendor:'Again'},{as:'person'})).data.error,'This bill was already claimed','the same bill twice is refused');
eq((await call('comp/claims',{...claim,receipt:'data:image/png;base64,'+Buffer.from('not an image at all').toString('base64')},{as:'person'})).status,400,'a file that is not a bill is refused');
let waiting=(await call('comp/claims',undefined,{as:'head'})).data.claims;
eq([waiting.length,waiting[0].amount],[1,125000],'the head sees the claim and its amount');
let bill=await call(`comp/claims/${claimId}/receipt`,undefined,{as:'head',raw:true});
eq([bill.status,bill.body.subarray(1,4).toString()],[200,'PNG'],'and the bill');
eq((await call(`comp/claims/${claimId}/receipt`,undefined,{as:'other',raw:true})).status,404,'a colleague does not');
eq((await call(`comp/claims/${claimId}/decide`,{action:'approve'},{as:'person'})).status,403,'nobody approves their own claim');
eq((await call(`comp/claims/${claimId}/decide`,{action:'approve'},{as:'head'})).data.status,'approved','the head approves (under the threshold)');
ok((await notes(R.person)).some((n)=>n.title==='Your reimbursement claim was approved'),'the person is told');

// ------------------------------------------------------------------------------- 8. exit: the full and final
await own("insert into pulse.hr_employment(org_id,person_id,notice_from,notice_to,last_working_day,updated_by) values($1,$2,$3,$4,$4,$5) on conflict(person_id) do update set notice_from=excluded.notice_from,notice_to=excluded.notice_to,last_working_day=excluded.last_working_day",
 [ORG,R.person,addDays(today,-10),addDays(today,20),R.hr]);
r=await call(`comp/people/${R.person}/settlement/preview`,{encashDays:4,noticeServed:30,noticeRequired:30,exitKind:'resigned'});
eq([r.status,r.data.lastDay,r.data.lines.some((l)=>/^Leave encashment, 4 days$/.test(l.label)),r.data.lines.some((l)=>/^Reimbursement/.test(l.label))],[200,addDays(today,20),true,true],'the statement is worked out from the last day, leave, notice and the approved claim');
r=await call('comp/settlements',{person:R.person,encashDays:4,noticeServed:30,noticeRequired:30,exitKind:'resigned'});
const settleId=r.data.id;ok(settleId,'HR prepares it');
eq((await call(`comp/settlements/${settleId}/step`,{action:'approve'},{as:'founder'})).status,400,'a founder approves only a checked statement');
eq((await call(`comp/settlements/${settleId}/step`,{action:'check'})).data.status,'checked','HR checks it');
eq((await call(`comp/settlements/${settleId}/step`,{action:'approve'})).status,403,'HR does not approve it');
r=await call(`comp/settlements/${settleId}/step`,{action:'approve'},{as:'founder'});
eq([r.data.status,!!r.data.letterId],['issued',true],'a founder approves; the settlement letter goes out');
me=(await call('comp/me',undefined,{as:'person'})).data;
eq([me.settlement.status,me.letters.some((l)=>l.kind==='settlement')],['issued',true],'the person sees the settlement and its letter');
eq((await call(`comp/settlements/${settleId}`,undefined,{as:'person'})).status,200,'and reads the statement');
eq((await call(`comp/settlements/${settleId}`,undefined,{as:'other'})).status,404,'a colleague does not');

// ------------------------------------------------------------------------------- 9. the access log and the timeline
const logged=await own("select resource,purpose from privacy.access_log where subject_person_id=$1 and resource like 'comp.%'",[R.person]);
for(const [res,purpose] of [['comp.record','record_view'],['comp.pay','history_view'],['comp.record','self'],['comp.letter','self'],['comp.claim','claim_view']])
 ok(logged.some((l)=>l.resource===res&&l.purpose===purpose),`every look is logged: ${res} ${purpose}`);
const events=await own("select kind,detail::text d from pulse.comp_event where person_id=$1",[R.person]);
ok(events.length>8&&events.every((e)=>!/6750000|6123400|125000/.test(e.d)),'the timeline holds what happened, never an amount');
const allNotes=await own("select title from pulse.notification where event_type like 'comp.%'");
ok(allNotes.length>5&&allNotes.every((n)=>!/₹|67,500|61,234|1,250/.test(n.title)),'no notice carries an amount');

// ------------------------------------------------------------------------------- 10. policy
eq((await call('comp/policy',{approvers:'second_hr'})).status,403,'HR cannot change who approves pay');
eq((await call('comp/policy',{managers:'status',probationDays:60},{as:'hr'})).data.probationDays,60,'HR sets the probation default and what managers see');
eq((await call('comp/policy',{approvers:'leadership'},{as:'founder'})).data.approvers,'leadership','leadership decides who approves');
table=(await call('comp/people',undefined,{as:'head'})).data;
eq([table.people.map((p)=>p.id).sort(),table.people.some((p)=>'pay' in p||'change' in p)],[[R.person,R.candidate].sort(),false],'with the policy, the head sees their people’s status, never the pay');
}finally{await app.close();await pool.end();await owner.end();}
await writeFile(process.env.TEST_REPORT,JSON.stringify({checks,receipts},null,1));
console.log(`comp: ${checks} checks passed`);
