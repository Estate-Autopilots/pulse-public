// PRESENCE-ONBOARD acceptance on a disposable database with synthetic people only: no double check-in (racing taps,
// replayed offline taps), offline sync limits, office Wi-Fi and phone-geofence simulations through the server tick
// ("ask" vs automatic, never automatic check-out), the day timeline with "That's not right", reminders, the payroll
// month and cut-off, onboarding, and who may see government IDs (with the access log). Synthetic ID numbers only.
// PRESENCE-2: ID files and bank details sealed by the API with throwaway keyrings (TEST_KEY_DIR): the missing-key
// refusal, rotation and re-wrapping, the re-encryption of what 0149 kept under the in-database key, and no key byte
// in anything sent to PostgreSQL, stored, or answered. (The API's log is checked by test_presence_onboard.py.)
import assert from 'node:assert/strict';import {Client as PgClient,Pool} from 'pg';import {chmod,writeFile} from 'node:fs/promises';import {randomBytes} from 'node:crypto';import {join} from 'node:path';import {createApp} from '../dist/app.js';
import {bankContext,loadKeyring,open} from '../dist/document-keys.js';import {rekeyDocuments} from '../dist/document-rekey.js';
// Every query this process sends to PostgreSQL, with its values.
const wire=[];const sendQuery=PgClient.prototype.query;
PgClient.prototype.query=function(q,v,...rest){const values=Array.isArray(v)?v:q?.values;wire.push([typeof q==='string'?q:q?.text??'',...(values??[])]);return sendQuery.call(this,q,v,...rest);};
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),owner=new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG)),worker=new Pool(JSON.parse(process.env.TEST_WORKER_CONFIG));
const app=createApp(pool,pool);const roles=JSON.parse(process.env.TEST_ROLES);const ORG=process.env.PULSE_ORG_ID;
let checks=0;const receipts=[];const answers=[];
const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;receipts.push({label,passed:true});};
const ok=(v,label)=>{assert.ok(v,label);checks++;receipts.push({label,passed:true});};
async function call(path,body,{role='person',token,ip,method}={}){
 const headers=token?{authorization:'Bearer '+token}:{'cf-access-authenticated-user-email':role+'@presence.example'};if(ip)headers['x-pulse-client-ip']=ip;
 const r=await app.inject({url:'/api/v0/'+path,method:method??(body===undefined?'GET':'POST'),headers,...(body===undefined?{}:{payload:body})});
 answers.push(r.rawPayload);let data;try{data=r.json();}catch{data=r.rawPayload;}return {status:r.statusCode,data,headers:r.headers};
}
async function own(sql,args=[],viewer){const c=await owner.connect();try{await c.query('begin');await c.query('set local role pulse_owner');await c.query("select set_config('pulse.org_id',$1,true)",[ORG]);if(viewer)await c.query("select set_config('pulse.viewer_id',$1,true)",[viewer]);const r=await c.query(sql,args);await c.query('commit');return r.rows;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
async function work(sql,args=[]){const c=await worker.connect();try{await c.query('begin');await c.query("select set_config('pulse.org_id',$1,true)",[ORG]);const r=await c.query(sql,args);await c.query('commit');return r.rows;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
const tick=()=>work('select pulse.companion_presence_tick(null)');
const KEYS=process.env.TEST_KEY_DIR,keyFile=join(KEYS,'document-master.key'),absent=join(KEYS,'absent.key');
const K1=['doc-2026-10',randomBytes(32)],K2=['doc-2027-01',randomBytes(32)],K3=['doc-elsewhere',randomBytes(32)];
const keyring=async(...lines)=>{await writeFile(keyFile,lines.map(([k,v])=>`${k} ${v.toString('base64')}\n`).join(''),{mode:0o600});await chmod(keyFile,0o600);process.env.PULSE_DOCUMENT_KEY_FILE=keyFile;};
async function rekey(){const c=await owner.connect();try{await c.query('begin');await c.query('set local role pulse_owner');const r=await rekeyDocuments(c,(await loadKeyring()).ring,[ORG]);await c.query('commit');return r;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
process.env.PULSE_DOCUMENT_KEY_FILE=absent;
async function pair(role,platform,name){
 const s=(await call('native/pair/start',{platform,name},{role})).data;
 eq((await call('native/pair/decide',{code:s.code,approve:true},{role})).data.status,'approved',role+' approves '+platform);
 return (await call('native/pair/poll',{pairId:s.pairId,pollSecret:s.pollSecret},{role})).data;
}

await own('select pulse.hr_defaults()');await own('update pulse.hr_policy set attendance_enabled=true');
// The whole civil day is a shift, so the fixtures never depend on when CI runs.
await own("update pulse.hr_policy set shift_start='00:00',shift_end='24:00',work_days=array[1,2,3,4,5,6,7],grace_minutes=0");

// ---------------------------------------------------------------- no double check-in, offline sync (R16 rules kept)
const started=new Date(Date.now()-20*60000).toISOString(); // INTEGRITY part 2: a saved tap syncs within 30 minutes
const race=await Promise.all([1,2,3].map(i=>call('attendance/check-in',{mode:'office',via:'web',trigger:'manual',at:started,queueId:'po-race-tap-0'+i},{role:'other'})));
eq(race.filter(r=>r.status===200).length,1,'three racing taps check in once');
ok(race.filter(r=>r.status===409).every(r=>/already checked in/i.test(r.data.error)),'the other taps are told they are already checked in');
eq((await own("select count(*)::int n from pulse.attendance_entry where person_id=$1 and voided_at is null",[roles.other]))[0].n,1,'one attendance row');
const at=new Date(Date.now()-25*60000).toISOString();
const queued=await call('attendance/break',{action:'start',at,queueId:'po-offline-break-01'},{role:'other'});
eq(queued.status,409,'a saved break earlier than the check-in is refused, not rewritten');
const back=new Date(Date.now()-5*60000).toISOString();
eq((await call('attendance/break',{action:'start',at:back,queueId:'po-offline-break-02'},{role:'other'})).status,200,'a break saved offline syncs with its own time');
eq((await call('attendance/break',{action:'start',at:back,queueId:'po-offline-break-02'},{role:'other'})).data.replayed,true,'the same saved tap replayed is one break');
eq((await call('attendance/check-out',{at:new Date(Date.now()-40*60000).toISOString(),queueId:'po-offline-out-old'},{role:'other'})).status,409,'a tap saved more than 30 minutes ago needs a correction (INTEGRITY part 2)');
eq((await call('attendance/check-out',{at:new Date(Date.now()-10*60000).toISOString()},{role:'other'})).status,400,'a past time comes only from a saved offline action');
eq((await call('attendance/check-out',{queueId:'po-offline-out-01'},{role:'other'})).status,200,'check-out closes the open break');
eq((await call('attendance/check-out',{queueId:'po-offline-out-01'},{role:'other'})).data.replayed,true,'a replayed check-out is the same check-out');
eq((await call('attendance/check-out',{},{role:'other'})).status,409,'checking out twice is refused');

// ----------------------------------------------------------------------------------- HR's check-in settings
eq((await call('hr/checkin-settings',{arrival:'auto'})).status,403,'a member cannot change check-in settings');
eq((await call('hr/checkin-settings',{arrival:'auto'},{role:'leadership'})).status,403,'leadership reads but HR decides check-in settings');
let settings=(await call('hr/checkin-settings',undefined,{role:'hr'})).data;
eq(settings.arrival,'ask','arrival asks "Check in?" by default');eq(settings.reminders.enabled,false,'reminders start off');
eq((await call('hr/checkin-settings',{cutoffDay:31},{role:'hr'})).status,400,'cut-off beyond the 28th refused');
settings=(await call('hr/checkin-settings',{cutoffDay:26,reminders:{enabled:true,startOffset:0,longBreak:30}},{role:'hr'})).data;
eq([settings.cutoffDay,settings.reminders.enabled,settings.reminders.startOffset,settings.reminders.longBreak],[26,true,0,30],'HR sets the cut-off and turns reminders on');
ok(/^HR: /.test(settings.reminders.approvedBy),'HR\'s decision is the approval reference');

// Office with Wi-Fi and a public network; HR's existing presence route.
const office={name:'Synthetic Studio',lat:18.5204,lng:73.8567,radius:150,wifi:[{ssid:'Synth-Office',bssids:['a4:2b:b0:11:22:33']}],publicIpRanges:['203.0.113.0/24']};
eq((await call('hr/presence',{offices:[office],dwellMinutes:3,leaveMinutes:5},{role:'hr'})).status,200,'HR registers an office');
const officeId=(await call('hr/presence',undefined,{role:'hr'})).data.offices[0].id;

// ------------------------------------------------------------- office Wi-Fi on the laptop: "ask" (HR's default)
const laptop=await pair('person','windows','Synthetic laptop');
const wifi={officeId,consent:true,autoConsent:true,wifi:{ssid:'Synth-Office',bssid:'a4:2b:b0:11:22:33'}};
let p=await call('companion/presence',wifi,{token:laptop.accessToken});
// ATT (0861): the person's engine weighs the signals (the office access point alone is strong: 70).
eq([p.data.score,p.data.checkedIn,p.data.asked],[70,false,false],'joining office Wi-Fi alone: holding, nothing yet');
eq(p.data.signals,['wifi'],'the signal kind, never a place');
await own("update pulse.attendance_presence_state set holding_since=now()-interval '4 minutes' where person_id=$1",[roles.person]);
await tick();
let day=(await call('companion',undefined,{token:laptop.accessToken})).data;
eq(day.state,'out','asking never checks in');eq(day.arrival?.office,'Synthetic Studio','every surface sees the "Check in?" prompt');
let note=(await own("select title,href,event_type from pulse.notification where person_id=$1 and event_type='attendance.arrival'",[roles.person]))[0];
eq([note.title,note.href],['You’re at Synthetic Studio. Check in?','/me?arrived=1'],'the arrival question names the office and opens My desk');
await tick();await tick();
eq((await own("select count(*)::int n from pulse.notification where person_id=$1 and event_type='attendance.arrival'",[roles.person]))[0].n,1,'asked once a day, not on every tick');
const tapped=await call('attendance/check-in',{mode:'office',via:'desktop',trigger:'notification',queueId:'po-arrival-tap-01'},{token:laptop.accessToken});
eq(tapped.status,200,'one tap on the question checks in');
day=(await call('companion',undefined,{token:laptop.accessToken})).data;eq([day.state,day.arrival],['in',null],'the prompt is gone once checked in');

// The day timeline: the question, the tap, how it was recorded; HR reads it, another member cannot.
let timeline=(await call('attendance/day')).data;
eq(timeline.events.map(e=>e.kind),['arrival_asked'],'the person sees what Pulse noticed');
eq([timeline.events[0].office,timeline.events[0].signals,timeline.events[0].device],['Synthetic Studio',['wifi'],'laptop'],'office, signal kind and device, nothing else');
eq([timeline.sessions[0].inVia,timeline.sessions[0].inTrigger],['desktop','notification'],'the check-in shows it came from the notification on the laptop');
eq((await call('attendance/day?person='+roles.person,undefined,{role:'other'})).status,403,'another member cannot read someone\'s day');
eq((await call('attendance/day?person='+roles.person,undefined,{role:'hr'})).data.events.length,1,'HR reads the day');
ok(!JSON.stringify(await own('select * from pulse.attendance_event')).match(/"lat"|"lng"|18\.52|73\.85|203\.0/),'no coordinates or addresses are stored for any event');

// ATT: leaving the office network in the middle of the (all-day) shift is not a departure: no "Leaving for the day?",
// no correction proposed by Pulse, still checked in (coming back makes it a break; leaving at the day's end checks out).
await own("update pulse.hr_policy set presence_auto_checkout=false,presence_question=false");
p=await call('companion/presence',{officeId,consent:true,autoConsent:true,wifi:null},{token:laptop.accessToken});
await own("update pulse.attendance_presence_state set last_confident_at=now()-interval '20 minutes' where person_id=$1",[roles.person]);
p=await call('companion/presence',{officeId,consent:true,autoConsent:true,wifi:null},{token:laptop.accessToken});
eq((await own("select count(*)::int n from pulse.notification where person_id=$1 and event_type in ('attendance.departure','attendance.ask','attendance.checkout')",[roles.person]))[0].n,0,'leaving the office network asks nothing');
eq((await own("select count(*)::int n from pulse.attendance_regularisation where person_id=$1",[roles.person]))[0].n,0,'and proposes no correction');
eq((await call('companion',undefined,{token:laptop.accessToken})).data.state,'in','the person is still checked in');
await own("update pulse.hr_policy set presence_auto_checkout=true,presence_question=true");
timeline=(await call('attendance/day')).data;
eq(timeline.events.map(e=>e.kind),['arrival_asked'],'the timeline holds what Pulse noticed, nothing invented');

// "That's not right": the person's own correction, linked to the event it disputes.
const event=timeline.events[0];
const reg=await call('hr/regularisations',{kind:'late',date:timeline.date,reason:'Synthetic: I arrived earlier than Pulse noticed',entryId:timeline.sessions[0].id});
eq(reg.status,200,'the correction request is filed: '+JSON.stringify(reg.data));
eq((await call('attendance/events/'+event.id+'/dispute',{correctionId:reg.data.id})).status,200,'the event is linked to the correction');
eq((await call('attendance/events/'+event.id+'/dispute',{correctionId:reg.data.id},{role:'other'})).status,403,'nobody else can dispute the person\'s event');
ok((await call('attendance/day')).data.events[0].disputedAt,'the timeline shows it was disputed');
await call('attendance/check-out',{},{token:laptop.accessToken});

// ---------------------------------------------------- phone geofence: one signal asks, two signals may check in
await own("delete from pulse.notification_reminder where person_id=$1",[roles.lead]);
eq((await call('hr/checkin-settings',{arrival:'auto'},{role:'hr'})).data.arrival,'auto','HR allows automatic check-in when Pulse is sure');
const phone=await pair('lead','android','Synthetic phone');
p=await call('companion/presence',{officeId,consent:true,autoConsent:true,region:'enter'},{token:phone.accessToken});
eq([p.data.score,p.data.signals],[50,['geofence']],'arriving inside the geofence is one signal');
await own("update pulse.attendance_presence_state set holding_since=now()-interval '4 minutes' where person_id=$1",[roles.lead]);
await tick();
day=(await call('companion',undefined,{token:phone.accessToken})).data;
eq([day.state,day.arrival?.office],['out','Synthetic Studio'],'geofence alone asks, even when HR allows automatic');
// Office network as well (trusted gateway address): two kinds of signal, held through the dwell, check in.
p=await call('companion/presence',{officeId,consent:true,autoConsent:true,region:'enter'},{token:phone.accessToken,ip:'203.0.113.9'});
eq(p.data.signals,['geofence','network'],'geofence and office network together');
await own("update pulse.attendance_presence_state set confident_since=now()-interval '4 minutes' where person_id=$1",[roles.lead]);
await tick();
day=(await call('companion',undefined,{token:phone.accessToken})).data;eq(day.state,'in','two signals through the dwell: checked in automatically');
timeline=(await call('attendance/day',undefined,{role:'lead'})).data;
eq(timeline.events.map(e=>e.kind),['arrival_asked','auto_check_in'],'the automatic check-in is in the person\'s timeline');
eq(timeline.events[1].signals,['geofence','network'],'with the signals that confirmed it');
eq((await own("select count(*)::int n from pulse.attendance_entry where person_id=$1 and voided_at is null",[roles.lead]))[0].n,1,'still one attendance row');
// Without the person's own automatic consent, Pulse only asks.
const third=await pair('outsider','android','Synthetic phone 2');
await call('companion/presence',{officeId,consent:true,autoConsent:false,region:'enter'},{token:third.accessToken,ip:'203.0.113.9'});
await own("update pulse.attendance_presence_state set confident_since=now()-interval '4 minutes',holding_since=now()-interval '4 minutes' where person_id=$1",[roles.outsider]);
await tick();
eq((await call('companion',undefined,{token:third.accessToken})).data.state,'out','no automatic check-in without the person\'s own consent');
eq((await own("select count(*)::int n from pulse.attendance_event where person_id=$1 and kind='arrival_asked'",[roles.outsider]))[0].n,1,'they are asked instead');
// Device consent default: a new device follows the person's onboarding agreement; withdrawal stops every device.
eq((await call('companion/presence',undefined,{token:(await pair('member2','android','Synthetic phone 3')).accessToken})).data.enabled,false,'no agreement, no sensing');
eq((await call('onboarding/consent',{given:true,auto:false},{role:'member2'})).status,200,'the person agrees to office arrival in onboarding');
const fourth=await pair('member2','macos','Synthetic laptop 2');
eq((await call('companion/presence',undefined,{token:fourth.accessToken})).data.enabled,true,'their new device follows that agreement');
eq((await call('onboarding/consent',{given:true},{role:'hr',token:undefined})).status,200,'HR can agree only for themselves');
eq((await call('onboarding/consent',{given:false},{role:'outsider'})).status,200,'withdrawal');
eq((await own('select consent from pulse.companion_presence where device_id=$1',[third.deviceId]))[0].consent,false,'withdrawal reaches every device and clears its evidence');

// ------------------------------------------------------------------------------------------------- reminders
const now=new Date();
eq((await call('attendance/break',{action:'start',at:new Date(now.getTime()-25*60000).toISOString(),queueId:'po-long-break-01'},{role:'lead'})).status,409,'a break before the check-in is refused');
await own("update pulse.attendance_entry set checked_in_at=now()-interval '3 hours' where person_id=$1 and checked_out_at is null",[roles.lead]);
eq((await call('attendance/break',{action:'start',queueId:'po-long-break-02'},{role:'lead'})).status,200,'on a break');
// A saved tap syncs within 30 minutes (INTEGRITY part 2), so the 45-minute break is set in the database.
await own("update pulse.attendance_break set started_at=now()-interval '45 minutes' where person_id=$1 and ended_at is null",[roles.lead]);
const sent=(await work('select pulse.notification_reminder_tick(now()) n'))[0].n;
ok(sent>=2,'the tick reminds: start for those not in, a "Back?" for the long break');
eq((await own("select count(*)::int n from pulse.notification where person_id=$1 and event_type='attendance.break'",[roles.lead]))[0].n,1,'a long break gets one gentle prompt');
ok((await own("select count(*)::int n from pulse.notification where person_id=$1 and event_type='attendance.start'",[roles.member2]))[0].n===1,'someone not checked in gets the start reminder at the shift start');
eq((await own("select count(*)::int n from pulse.notification where person_id=$1 and event_type='attendance.start'",[roles.lead]))[0].n,0,'someone checked in gets no start reminder');
// Later ticks stay on today's date in India: run just before midnight, +40 minutes would open tomorrow's budget.
const toMidnight=Math.max(0,24*60-1-Math.floor(((now.getTime()+330*60000)%86400000)/60000));
for(let i=0;i<4;i++)await work("select pulse.notification_reminder_tick(now()+make_interval(mins=>$1)) n",[Math.min(20*(i+1),toMidnight)]);
ok((await own("select count(*)::int n from pulse.notification where person_id=$1 and event_type='attendance.start'",[roles.member2]))[0].n<=2,'at most two start reminders a day');
eq((await own("select count(*)::int n from pulse.notification where person_id=$1 and event_type='attendance.arrival'",[roles.lead]))[0].n+(await own("select count(*)::int n from pulse.notification where person_id=$1 and event_type='attendance.start'",[roles.lead]))[0].n<=2,true,'arrival question and start reminder share one budget');
ok((await call('attendance/day',undefined,{role:'member2'})).data.events.some(e=>e.kind==='reminder'&&e.detail==='start'),'reminders are visible in the person\'s timeline');
await call('attendance/break',{action:'end'},{role:'lead'});await call('attendance/check-out',{},{role:'lead'});

// --------------------------------------------------------------------------------------- the payroll month
const desk=(await call('hr/self',undefined,{role:'lead'})).data;
ok(desk.payroll&&desk.payroll.cutoffDay===26,'My desk shows the payroll month with HR\'s cut-off');
eq(typeof desk.payroll.present,'number','days present');ok('late' in desk.payroll&&'halfDays' in desk.payroll&&'leave' in desk.payroll&&'pendingCorrections' in desk.payroll,'late marks, half-days, leave and pending corrections');
eq(desk.payroll.cutoffDate,desk.today.slice(0,7)+'-26','the cut-off date is in the current month');

// ------------------------------------------------------------------------------------------------- onboarding
let mine=(await call('onboarding')).data;
eq(mine.self,true,'the person opens their own onboarding');ok(mine.missing.includes('doc:aadhaar')&&mine.missing.includes('bank'),'it lists what is missing');
eq((await call('onboarding/'+roles.person,undefined,{role:'other'})).status,403,'another member cannot open it');
eq((await call('onboarding/'+roles.person+'/details',{dob:'1994-02-03',address:'Synthetic Lane 1',emergencyName:'Synthetic Parent',emergencyRelation:'Parent',emergencyPhone:'+91 90000 00001',personalPhone:'+91 90000 00002',personalEmail:'person.home@presence.example'})).status,200,'the person enters their details');
eq((await call('onboarding/'+roles.person+'/details',{dob:'2024-01-01'})).status,400,'an impossible birth date is refused');
eq((await call('onboarding/'+roles.person+'/details',{address:'x'},{role:'other'})).status,403,'nobody else can write it');
eq((await own("select personal_phone from pulse_priv.hr_contact where person_id=$1",[roles.person],roles.other)).length,0,'another member cannot read the contact row even through the owner role');
const contact=(await own("select personal_phone,emergency from pulse_priv.hr_contact where person_id=$1",[roles.person],roles.hr))[0];
eq(contact.personal_phone,'+91 90000 00002','HR\'s contact record receives the person\'s own phone');
const workerView=(await work('select pulse.onboarding_missing($1) m',[roles.person]))[0].m;
ok(!workerView.includes('phone')&&!workerView.includes('email')&&!workerView.includes('emergency'),'the reminder worker (no viewer) sees the contact details as done: '+JSON.stringify(workerView));ok(contact.emergency.includes('Synthetic Parent'),'and the emergency contact');
// No keyring on the server: no ID files and no bank details, with a sentence HR can act on. Never a fallback key.
const PDF=Buffer.from('%PDF-1.4\n% synthetic masked aadhaar\n').toString('base64'),PDF_BYTES=Buffer.from(PDF,'base64');
eq((await call('onboarding')).data.filesReady,false,'without the keyring the wizard knows files are paused');
eq((await call('hr/onboard',undefined,{role:'hr'})).data.filesReady,false,'and so does HR\'s Onboard team');
let refused=await call('onboarding/'+roles.person+'/bank',{holder:'Synthetic Person',bank:'Example Bank',ifsc:'EXMP0001234',account:'000123456789',confirm:'000123456789'});
eq([refused.status,refused.data.error],[503,'Bank details can’t be saved yet: the document encryption key isn’t installed on this Pulse server. Nothing was saved. HR: ask the Pulse administrator to install it.'],'bank details are refused without the keyring');
refused=await call('onboarding/'+roles.person+'/documents',{kind:'aadhaar',number:'2345 6789 0124',bytes:PDF,mime:'application/pdf',name:'aadhaar-masked.pdf'});
eq([refused.status,refused.data.error],[503,'ID files can’t be uploaded yet: the document encryption key isn’t installed on this Pulse server. Nothing was saved. HR: ask the Pulse administrator to install it.'],'an ID upload is refused without the keyring');
eq((await own("select count(*)::int n from pulse_priv.identity_document where person_id=$1",[roles.person]))[0].n,0,'nothing was saved, not even the masked number');
eq((await own("select bank,bank_masked from pulse_priv.person_onboarding where person_id=$1",[roles.person]))[0],{bank:null,bank_masked:null},'no bank details either');
eq((await call('onboarding/'+roles.person+'/documents',{kind:'pan',number:'ABCPE1234F'})).status,200,'a masked number alone still saves: there is nothing to encrypt');
await keyring(K1);
eq((await call('onboarding')).data.filesReady,true,'with the keyring installed, files are open again');
const bank=await call('onboarding/'+roles.person+'/bank',{holder:'Synthetic Person',bank:'Example Bank',ifsc:'EXMP0001234',account:'000123456789',confirm:'000123456789'});
eq(bank.data.masked,'Example Bank ••••6789','bank details are shown masked');
const stored=(await own("select bank,bank_masked,bank_key,bank_key_id from pulse_priv.person_onboarding where person_id=$1",[roles.person]))[0];
ok(!Buffer.from(stored.bank).toString('latin1').includes('000123456789'),'the account number is encrypted at rest');
eq(stored.bank_key_id,'doc-2026-10','sealed by the API under the active key, whose ID is kept beside it');
eq(JSON.parse(open((await loadKeyring()).ring,{keyId:stored.bank_key_id,dataKey:stored.bank_key,data:stored.bank},bankContext(ORG,roles.person)).toString()).account,'000123456789','and only the keyring opens it');
eq((await call('onboarding/'+roles.person+'/bank',{holder:'S P',ifsc:'BAD',account:'1'})).status,400,'a wrong IFSC is refused');

// Government IDs: only masked numbers; encrypted files; the person and HR see them; every access logged.
eq((await call('onboarding/'+roles.person+'/documents',{kind:'aadhaar',number:'2345 6789 0123'})).status,400,'a wrong Aadhaar check digit is refused');
eq((await call('onboarding/'+roles.person+'/documents',{kind:'aadhaar',number:'2345 6789 0124',bytes:Buffer.from('MZ fake').toString('base64'),mime:'application/pdf',name:'a.pdf'})).status,400,'a file that is not really a PDF is refused');
const aadhaar=await call('onboarding/'+roles.person+'/documents',{kind:'aadhaar',number:'2345 6789 0124',bytes:PDF,mime:'application/pdf',name:'aadhaar-masked.pdf'});
eq([aadhaar.status,aadhaar.data.masked],[200,'XXXX XXXX 0124'],'Aadhaar kept as XXXX XXXX 0124');
const pan=await call('onboarding/'+roles.person+'/documents',{kind:'pan',number:'ABCPE1234F'});
eq(pan.data.masked,'XXXXXX234F','PAN kept masked');
const everything=JSON.stringify(await own("select * from pulse_priv.identity_document"))+JSON.stringify(await own("select * from pulse_priv.person_onboarding"))+JSON.stringify(await own("select * from privacy.access_log"));
ok(!everything.includes('23456789')&&!everything.includes('ABCPE1234F')&&!everything.includes('ABCPE'),'no full ID number anywhere in the database');
ok(!Buffer.from((await own("select file from pulse_priv.identity_document where id=$1",[aadhaar.data.id]))[0].file).toString('latin1').includes('synthetic masked aadhaar'),'the file is encrypted at rest');
const sealedRow=(await own("select key_id,file,size from pulse_priv.identity_document where id=$1",[aadhaar.data.id]))[0];
eq([sealedRow.key_id,sealedRow.file.length,sealedRow.size],['doc-2026-10',PDF_BYTES.length+29,PDF_BYTES.length],'sealed by the API with the active key: its ID is kept with the file');
mine=(await call('onboarding')).data;
eq(mine.documents.find(d=>d.kind==='aadhaar').document.masked,'XXXX XXXX 0124','the person sees their masked number');
const own_file=await call('onboarding/documents/'+aadhaar.data.id+'/file');
eq(own_file.status,200,'the person opens their own file');eq(own_file.headers['cache-control'],'private, no-store','never cached');
eq((await call('onboarding/documents/'+aadhaar.data.id+'/file',undefined,{role:'other'})).status,403,'another member cannot open it');
const leaderView=(await call('onboarding/'+roles.person,undefined,{role:'leadership'})).data;
eq([leaderView.canSeeIds,leaderView.documents.find(d=>d.kind==='aadhaar').document.masked],[false,null],'leadership without the HR documents permission sees only "on file"');
eq((await call('onboarding/documents/'+aadhaar.data.id+'/file',undefined,{role:'leadership'})).status,403,'and cannot open the file');
eq((await call('onboarding/documents/'+aadhaar.data.id+'/file',undefined,{token:laptop.accessToken})).status,403,'a device credential cannot open ID files');
const hrView=(await call('onboarding/'+roles.person,undefined,{role:'hr'})).data;
eq([hrView.canSeeIds,hrView.documents.find(d=>d.kind==='pan').document.masked],[true,'XXXXXX234F'],'HR sees masked numbers');
eq((await call('onboarding/documents/'+aadhaar.data.id+'/file',undefined,{role:'hr'})).status,200,'HR opens the file');
const log=await own("select l.resource,l.purpose,v.display_name viewer from privacy.access_log l left join pulse.person v on v.id=l.viewer_id where l.subject_person_id=$1 order by l.id",[roles.person]);
ok(log.some(l=>l.resource==='identity.aadhaar.file'&&l.purpose==='hr_document_view'),'HR opening the file is logged');
ok(log.some(l=>l.resource==='identity.aadhaar.file'&&l.purpose==='self'),'the person\'s own opening is logged too');
ok(log.some(l=>l.resource==='identity.documents'&&l.purpose==='hr_onboarding'),'HR reading the masked list is logged');
ok(log.some(l=>l.resource==='identity.aadhaar'&&l.purpose==='upload'),'uploads are logged');
eq((await call('onboarding/documents/'+aadhaar.data.id+'/check',{ok:false,note:''},{role:'hr'})).status,400,'a rejection needs a reason');
eq((await call('onboarding/documents/'+aadhaar.data.id+'/check',{ok:true},{role:'person'})).status,403,'nobody checks their own documents');
eq((await call('onboarding/documents/'+aadhaar.data.id+'/check',{ok:true},{role:'hr'})).status,200,'HR checks the document');
eq((await call('onboarding/documents/'+aadhaar.data.id+'/remove',{})).status,403,'a checked document is removed only by HR');
eq((await call('onboarding/documents/'+pan.data.id+'/remove',{})).status,200,'the person removes an unchecked one');
eq((await own("select status,file from pulse_priv.identity_document where id=$1",[pan.data.id]))[0],{status:'removed',file:null},'removal clears it');

// Rotation: a new key ID for new files, older files still open, re-wrapping moves them and the old key can go.
await keyring(K1,K2);
const cheque=await call('onboarding/'+roles.person+'/documents',{kind:'bank_proof',bytes:PDF,mime:'application/pdf',name:'cheque.pdf'});
eq((await own("select key_id from pulse_priv.identity_document where id=$1",[cheque.data.id]))[0].key_id,'doc-2027-01','after rotation new files use the new key');
let opened=await call('onboarding/documents/'+aadhaar.data.id+'/file',undefined,{role:'hr'});
ok(opened.status===200&&Buffer.from(opened.data).equals(PDF_BYTES),'a file sealed with the older key still opens');
const moved=await rekey();
eq([moved.legacyFiles,moved.legacyBank,moved.rewrapped],[0,0,2],'re-wrapping moves the older file and the bank details to the new key');
eq((await own("select count(*)::int n from pulse_priv.identity_document where file is not null and key_id<>'doc-2027-01'"))[0].n,0,'nothing is left on the older key');
await keyring(K2);
opened=await call('onboarding/documents/'+aadhaar.data.id+'/file',undefined,{role:'hr'});
ok(opened.status===200&&Buffer.from(opened.data).equals(PDF_BYTES),'the older key has left the keyring and the file still opens; the file itself never changed');
eq((await rekey()).rewrapped,0,'re-wrapping again changes nothing');
eq((await call('onboarding/documents/'+aadhaar.data.id+'/file',undefined,{role:'other'})).status,403,'access is still the person and HR only');
eq((await call('onboarding/documents/'+aadhaar.data.id+'/file',undefined,{role:'leadership'})).status,403,'not leadership');
// A key the server no longer has, or no keyring at all: a clear refusal, and no "opened" entry for a file not shown.
const fileLog=async()=>(await own("select count(*)::int n from privacy.access_log where subject_person_id=$1 and resource='identity.aadhaar.file'",[roles.person]))[0].n;
const seen=await fileLog();
await keyring(K3);
const lost=await call('onboarding/documents/'+aadhaar.data.id+'/file',undefined,{role:'hr'});
eq([lost.status,lost.data.error],[503,'This file was sealed with document key “doc-2027-01”, which this Pulse server’s keyring no longer lists. HR: ask the Pulse administrator to restore that key.'],'a file whose key is gone is refused, naming the key ID');
process.env.PULSE_DOCUMENT_KEY_FILE=absent;
const off=await call('onboarding/documents/'+aadhaar.data.id+'/file');
eq([off.status,off.data.error],[503,'This file can’t be opened: the document encryption key isn’t installed on this Pulse server. HR: ask the Pulse administrator to install it.'],'without the keyring nothing opens');
eq(await fileLog(),seen,'a file that could not be opened leaves no "opened" entry');
await keyring(K2);
// A sealed file copied onto another record (another document of the same person here) does not open.
await own("update pulse_priv.identity_document c set file=a.file,file_key=a.file_key,key_id=a.key_id from pulse_priv.identity_document a where a.id=$1 and c.id=$2",[aadhaar.data.id,cheque.data.id]);
eq((await call('onboarding/documents/'+cheque.data.id+'/file')).status,503,'a sealed file moved onto another record does not open');
ok(/does not match its encryption key/.test((await call('onboarding/documents/'+cheque.data.id+'/file')).data.error),'it says so');

// The dev migration: what 0149 sealed with the in-database key is re-sealed with the keyring, then 0152's key table
// and constraints hold again. (Recreated here as 0149 left them, on top of the fully migrated schema.)
await own("alter table pulse_priv.identity_document drop constraint identity_document_sealed");
await own("alter table pulse_priv.person_onboarding drop constraint person_onboarding_bank_sealed");
await own("create table pulse_priv.identity_key (org_id uuid primary key references pulse.org(id), key bytea not null)");
await own("insert into pulse_priv.identity_key values($1,public.gen_random_bytes(32))",[ORG]);
const legacy=(await own(`insert into pulse_priv.identity_document(org_id,person_id,kind,file,mime,size,file_name,source,added_by)
 select $1,$2,'bank_proof',public.pgp_sym_encrypt_bytea($3,encode(key,'hex'),'cipher-algo=aes256'),'application/pdf',$4,'old-cheque.pdf','self',$2 from pulse_priv.identity_key returning id`,[ORG,roles.other,PDF_BYTES,PDF_BYTES.length]))[0].id;
await own(`insert into pulse_priv.person_onboarding(org_id,person_id,bank,bank_masked)
 select $1,$2,public.pgp_sym_encrypt_bytea(convert_to('{"holder":"Synthetic Other","account":"000987654321"}','UTF8'),encode(key,'hex'),'cipher-algo=aes256'),'Example Bank ••••4321' from pulse_priv.identity_key
 on conflict(person_id) do update set bank=excluded.bank,bank_masked=excluded.bank_masked`,[ORG,roles.other]);
const waiting=await call('onboarding/documents/'+legacy+'/file',undefined,{role:'other'});
eq([waiting.status,waiting.data.error],[503,'This file is waiting to be re-encrypted. HR: ask the Pulse administrator to run the document re-encryption.'],'a file still under the in-database key waits for re-encryption');
const resealed=await rekey();
eq([resealed.legacyFiles,resealed.legacyBank],[1,1],'the re-encryption re-seals the old file and the old bank details');
const reopened=await call('onboarding/documents/'+legacy+'/file',undefined,{role:'other'});
ok(reopened.status===200&&Buffer.from(reopened.data).equals(PDF_BYTES),'the old file opens, now sealed with the keyring');
const oldBank=(await own("select bank,bank_key,bank_key_id from pulse_priv.person_onboarding where person_id=$1",[roles.other]))[0];
eq(JSON.parse(open((await loadKeyring()).ring,{keyId:oldBank.bank_key_id,dataKey:oldBank.bank_key,data:oldBank.bank},bankContext(ORG,roles.other)).toString()).account,'000987654321','the old bank details survive, sealed with the keyring');
await own("drop table pulse_priv.identity_key");
await own("alter table pulse_priv.identity_document add constraint identity_document_sealed check ((file is null) = (file_key is null) and (file is null) = (key_id is null))");
await own("alter table pulse_priv.person_onboarding add constraint person_onboarding_bank_sealed check ((bank is null) = (bank_key is null) and (bank is null) = (bank_key_id is null))");
checks++;receipts.push({label:'every file and bank detail carries its wrapped key again (0152\'s constraints hold)',passed:true});
await assert.rejects(own("insert into pulse_priv.identity_document(org_id,person_id,kind,file,mime,size,source,added_by) values($1,$2,'bank_proof','\\x01','application/pdf',1,'hr',$2)",[ORG,roles.other]));
checks++;receipts.push({label:'a file without its wrapped key cannot be stored',passed:true});

// Agents' proposals: shown with their source, confirmed by a person; IDs only as a pointer to Drive.
await work(`insert into pulse_priv.profile_proposal(org_id,person_id,field,value,source,source_label,source_ref) values($1,$2,'address','Synthetic Road 2','hr_sheet','HR sheet · Employee details (synthetic)','sheet:synthetic#row2')`,[ORG,roles.other]);
await work(`insert into pulse_priv.profile_proposal(org_id,person_id,field,document_kind,source,source_label,source_ref) values($1,$2,'document','pan','drive','Drive · HR/KYC/Synthetic Other','drive-file-synthetic-1')`,[ORG,roles.other]);
await assert.rejects(work(`insert into pulse_priv.profile_proposal(org_id,person_id,field,value,document_kind,source,source_label,source_ref) values($1,$2,'document','ABCPE1234F','pan','drive','x','y')`,[ORG,roles.other]));checks++;receipts.push({label:'a proposal can never carry an ID number',passed:true});
await assert.rejects(work('select * from pulse_priv.identity_document'));checks++;receipts.push({label:'the proposal agent cannot read documents',passed:true});
const theirs=(await call('onboarding',undefined,{role:'other'})).data;
eq(theirs.proposals.map(x=>[x.field,x.sourceLabel]),[['address','HR sheet · Employee details (synthetic)'],['document','Drive · HR/KYC/Synthetic Other']],'each proposal shows its source');
eq((await call('onboarding/proposals/'+theirs.proposals[0].id,{accept:true},{role:'person'})).status,403,'someone else cannot accept it');
eq((await call('onboarding/proposals/'+theirs.proposals[0].id,{accept:true},{role:'other'})).status,200,'the person accepts their address');
eq((await call('onboarding/proposals/'+theirs.proposals[1].id,{accept:true},{role:'hr'})).status,200,'HR confirms the Drive file is their PAN');
const pointer=(await call('onboarding/'+roles.other,undefined,{role:'hr'})).data.documents.find(d=>d.kind==='pan').document;
eq([pointer.source,pointer.masked,pointer.hasFile],['drive',null,false],'the PAN is "on file in Drive": no number, no copy');

// HR's Onboard team view and one-click nudges (in-app only).
eq((await call('hr/onboard',undefined,{role:'other'})).status,403,'members do not see the onboarding roster');
const team=(await call('hr/onboard',undefined,{role:'hr'})).data;
const row=team.people.find(x=>x.id===roles.person);
ok(row&&row.percent>0&&row.apps.desktop===true&&row.firstCheckIn,'HR sees profile %, apps and first check-in');
ok(team.people.find(x=>x.id===roles.member3).firstCheckIn===null,'and who has never checked in');
const nudge=await call('hr/onboard/nudge',{kind:'checkin',personIds:[roles.member3]},{role:'hr'});
eq(nudge.data,{sent:1,skipped:0},'one click nudges');
eq((await call('hr/onboard/nudge',{kind:'checkin',personIds:[roles.member3]},{role:'hr'})).data,{sent:0,skipped:1},'once a day');
eq((await call('hr/onboard/nudge',{kind:'checkin',personIds:[roles.member3]},{role:'leadership'})).status,403,'leadership does not nudge');
ok((await call('hr/onboard',undefined,{role:'hr'})).data.people.find(x=>x.id===roles.member3).nudged.checkin,'HR sees the nudge was sent');

// Profile reminders: off until HR turns them on, then in-app, gently.
await own("update pulse_priv.person_onboarding set seen_at=now()-interval '2 days' where person_id=$1",[roles.other]);
eq((await work("select pulse.onboarding_tick(date_trunc('day',now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'+interval '12 hours') n"))[0].n,0,'no profile reminders until HR turns them on');
await call('hr/checkin-settings',{onboardingReminders:true},{role:'hr'});
ok((await work("select pulse.onboarding_tick(date_trunc('day',now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'+interval '12 hours') n"))[0].n>=1,'then the person with gaps is reminded');
eq((await own("select event_type,href from pulse.notification where person_id=$1 and href='/welcome'",[roles.other]))[0],{event_type:'update.self',href:'/welcome'},'first in the app, opening the wizard');
eq((await work("select pulse.onboarding_tick(date_trunc('day',now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'+interval '12 hours') n"))[0].n,0,'not twice a day');

// No master key anywhere: not in what this process sent to PostgreSQL (so not in its logs), not stored, not answered.
const masters=[K1,K2,K3].map(([,k])=>k),forms=(k)=>[k.toString('base64'),k.toString('hex'),k.toString('base64url')];
const has=(b)=>masters.some((k)=>b.indexOf(k)>=0||forms(k).some((f)=>b.toString('latin1').includes(f)));
const asBytes=(x)=>Buffer.isBuffer(x)?x:Buffer.from(typeof x==='string'?x:JSON.stringify(x)??'');
ok(!wire.some((q)=>q.some((x)=>x!=null&&has(asBytes(x)))),`no master key byte was ever sent to the database (${wire.length} queries)`);
const rows=[...await own('select * from pulse_priv.identity_document'),...await own('select * from pulse_priv.person_onboarding'),...await own('select * from privacy.access_log'),...await own('select * from pulse.record_change')];
ok(!rows.some((r)=>Object.values(r).some((x)=>x!=null&&has(asBytes(x)))),`no master key in the database (${rows.length} rows)`);
ok(!answers.some((a)=>a&&has(Buffer.from(a))),`no master key in any API answer (${answers.length})`);
const wrapped=(await own('select file_key k from pulse_priv.identity_document where file_key is not null union all select bank_key from pulse_priv.person_onboarding where bank_key is not null')).map((r)=>r.k);
ok(wrapped.length>=3&&!answers.some((a)=>a&&wrapped.some((w)=>Buffer.from(a).indexOf(w)>=0||Buffer.from(a).toString('latin1').includes(w.toString('base64')))),'wrapped data keys never leave the API either');
await writeFile(join(KEYS,'all.keys'),masters.map((k)=>k.toString('base64')).join('\n'));
await writeFile(process.env.TEST_REPORT,JSON.stringify({checks,receipts},null,1));
await pool.end();await owner.end();await worker.end();
