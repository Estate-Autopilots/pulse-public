// Pulse Companion acceptance on a disposable database: browser pairing, the companion day, check-in → break →
// queued back-from-break → check-out with a device credential, HR office presence, request counts and revocation.
import assert from 'node:assert/strict';import {Pool} from 'pg';import {writeFile} from 'node:fs/promises';import {createApp} from '../dist/app.js';
import {deriveView} from '../../../packages/companion/src/view.js';
const worker=new Pool(JSON.parse(process.env.TEST_WORKER_CONFIG));
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),owner=new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG)),app=createApp(pool,pool);const roles=JSON.parse(process.env.TEST_ROLES);
let checks=0;const receipts=[];
const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;receipts.push({label,passed:true});};
const ok=(v,label)=>{assert.ok(v,label);checks++;receipts.push({label,passed:true});};
async function call(path,body,{role='person',token,anonymous=false,ip}={}){const headers=anonymous?{}:token?{authorization:'Bearer '+token}:{'cf-access-authenticated-user-email':role+'@companion.example'};if(ip)headers['x-pulse-client-ip']=ip;const r=await app.inject({url:'/api/v0/'+path,method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{payload:body})});return {status:r.statusCode,data:r.json()};}
async function own(sql,args=[]){const c=await owner.connect();try{await c.query('begin');await c.query('set local role pulse_owner');await c.query("select set_config('pulse.org_id',$1,true)",[process.env.PULSE_ORG_ID]);const r=await c.query(sql,args);await c.query('commit');return r.rows;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
await own('select pulse.hr_defaults()');await own('update pulse.hr_policy set attendance_enabled=true');
// Today is a working day whatever day CI runs (check-in refuses a weekly off): no change Monday to Saturday.
await own("update pulse.hr_policy set work_days=array(select distinct d from unnest(work_days||extract(isodow from now() at time zone 'Asia/Kolkata')::int) d order by d)");
const ago=(minutes)=>new Date(Date.now()-minutes*60000).toISOString();

// Browser and native clients use the same explicit policy, regardless of the person's role.
for(const role of ['person','hr','admin','outsider','leadership','manager','pgs','head_pgs']) {
  const result=await call('companion',undefined,{role});
  eq(result.status,200,role+' companion is readable');
  eq(result.data.attendanceEnabled,true,role+' companion reports the existing attendance policy');
}

// A web tab must not replay one person's saved taps into another person's authenticated session.
for (const [path,extra] of [['check-in',{}],['check-out',{}],['break',{action:'start'}]]) {
  eq((await call('attendance/'+path,{...extra,expectedPersonId:roles.outsider,queueId:'r16-cross-person-'+path})).status,403,'cross-person web '+path+' is refused');
}

// HR sets an office with Wi-Fi; nobody else can.
const office={name:'Synthetic Studio',lat:28.4595,lng:77.0266,radius:150,wifi:[{ssid:'Synth-Office',bssids:['A4-2B-B0-11-22-33']}]};
eq((await call('hr/presence',{offices:[office]})).status,403,'a member cannot set office presence');
eq((await call('hr/presence',{offices:[{...office,radius:20}]},{role:'hr'})).status,400,'radius below 50 m refused');
eq((await call('hr/presence',{offices:[{...office,wifi:[{ssid:'x',bssids:['not-a-mac']}]}]},{role:'hr'})).status,400,'malformed access-point address refused');
eq((await call('hr/presence',{offices:[office],autoCheckIn:false,sites:true},{role:'hr'})).status,200,'HR saves an office');
const presence=(await call('hr/presence',undefined,{role:'hr'})).data;
eq(presence.offices.length,1,'one office registered');eq(presence.offices[0].wifi[0].bssids,['a4:2b:b0:11:22:33'],'BSSID normalised');eq(presence.canEdit,true,'HR can edit');
eq((await call('hr/presence')).data.canEdit,false,'members read offices but cannot edit');
const officeId=presence.offices[0].id;

// Browser pairing: start (no account), approve on the site, collect tokens once.
const start=(await call('native/pair/start',{platform:'windows',name:'Synthetic laptop'},{anonymous:true}));
eq(start.status,200,'pairing starts without an account');ok(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(start.data.code),'readable eight-letter code');
const {pairId,pollSecret,code}=start.data;
eq((await call('native/pair/start',{platform:'toaster',name:'x'},{anonymous:true})).status,400,'unknown platform refused');
eq((await call('native/pair/poll',{pairId,pollSecret},{anonymous:true})).data.status,'pending','pending until approved');
eq((await call('native/pair/poll',{pairId,pollSecret:'x'.repeat(43)},{anonymous:true})).status,404,'wrong poll secret is unknown');
eq((await call('native/pair/'+code.replace('-','').toLowerCase())).data.name,'Synthetic laptop','the person sees the device name for the code');
eq((await call('native/pair/ZZZZ-ZZZZ')).status,404,'unknown code');
const second=(await call('native/pair/start',{platform:'android',name:'Unknown phone'},{anonymous:true})).data;
eq((await call('native/pair/decide',{code:second.code,approve:false},{role:'outsider'})).data.status,'denied','"this wasn\'t me" denies');
eq((await call('native/pair/poll',{pairId:second.pairId,pollSecret:second.pollSecret},{anonymous:true})).data.status,'denied','denied pairing never yields tokens');
eq((await call('native/pair/decide',{code,approve:true})).data.status,'approved','the person approves');
eq((await call('native/pair/decide',{code,approve:true},{role:'outsider'})).status,404,'an approved code cannot be approved again');
const paired=(await call('native/pair/poll',{pairId,pollSecret},{anonymous:true})).data;
eq(paired.status,'approved','tokens issued once approved');ok(/^[A-Za-z0-9_-]{43}$/.test(paired.accessToken)&&/^[A-Za-z0-9_-]{43}$/.test(paired.refreshToken),'device tokens');eq(paired.person.id,roles.person,'tokens belong to the approver');
eq((await call('native/pair/poll',{pairId,pollSecret},{anonymous:true})).data.status,'expired','tokens are collected only once');
const token=paired.accessToken,deviceId=paired.deviceId;
eq((await call('devices')).data.devices.some(d=>d.id===deviceId&&d.platform==='windows'),true,'the paired device is listed in Settings → Devices');
eq((await call('native/pair/'+code,undefined,{token})).status,403,'a device credential cannot approve other apps');
eq((await call('hr/presence',{offices:[]},{role:'hr',token})).status,403,'device scope excludes office settings');

// The companion day with the device credential.
let day=(await call('companion',undefined,{token}));
eq(day.status,200,'companion answers a device credential');eq(day.data.person.id,roles.person,'own day only');
ok(['out','off','holiday'].includes(day.data.state),'not checked in yet');eq(day.data.presence.offices[0].id,officeId,'offices reach the phone');
eq(day.data.presence.offices[0].wifi[0].ssid,'Synth-Office','office Wi-Fi reaches the phone');eq(day.data.timezone,'Asia/Kolkata','organisation clock');
ok(typeof day.data.shift.onTimeBy==='string'&&day.data.shiftStartsAt<day.data.shiftEndsAt,'shift instants');eq(day.data.waiting,null,'a member has nothing to decide');
eq((await call('companion',undefined,{role:'shared'})).status,403,'unknown identities are refused');

// check-in → break → queued back-from-break → check-out, the same rules as My desk.
eq((await call('attendance/check-in',{mode:'office',via:'mobile',trigger:'auto',place:{kind:'office',id:officeId,signal:'region'}},{token})).status,403,'automatic check-in is off until HR allows it');
eq((await call('attendance/check-in',{mode:'office',at:ago(240),queueId:'q-too-old-0001'},{token})).status,409,'an offline tap older than three hours is refused');
const checkIn=await call('attendance/check-in',{mode:'office',via:'desktop',trigger:'suggested',place:{kind:'office',id:officeId,signal:'wifi'}},{token});
eq(checkIn.status,200,'check in with one click');
eq((await call('attendance/check-in',{mode:'office',via:'desktop'},{token})).status,409,'a second check-in is refused like My desk');
day=(await call('companion',undefined,{token})).data;eq(day.state,'in','checked in');
const meta=(await own('select client from pulse.attendance_entry where id=$1',[checkIn.data.id]))[0].client;
eq([meta.via,meta.trigger,meta.place.kind,meta.place.signal,meta.device],['desktop','suggested','office','wifi',deviceId],'the entry records the app, trigger and signal');
ok(!JSON.stringify(meta).match(/lat|lng|28\.4/),'no coordinates are stored');
eq((await call('attendance/break',{action:'start',via:'desktop'},{token})).status,200,'take a break');
day=(await call('companion',undefined,{token})).data;eq(day.state,'break','on a break');ok(day.entry.breakStartedAt,'break start shown');
const back={action:'end',via:'mobile',at:new Date().toISOString(),queueId:'q-back-0000001'};
eq((await call('attendance/break',back,{token})).status,200,'a queued "I\'m back" syncs with its time');
eq((await call('attendance/break',back,{token})).data.replayed,true,'a retried queued action is applied once');
const brk=(await own("select end_client from pulse.attendance_break where entry_id=$1",[checkIn.data.id]))[0].end_client;eq([brk.queued,brk.queueId],[true,'q-back-0000001'],'the break end is marked as synced later');
eq((await call('attendance/check-out',{via:'chrome',at:new Date(Date.now()-60*60000).toISOString(),queueId:'q-early-out-01'},{token})).status,409,'a queued check-out before the break is refused');
eq((await call('attendance/check-out',{via:'chrome',trigger:'auto'},{token})).status,400,'check-out is never automatic');
eq((await call('attendance/check-out',{via:'chrome'},{token})).status,200,'check out');
eq((await call('attendance/check-out',{via:'chrome'},{token})).status,409,'checking out twice is refused');
day=(await call('companion',undefined,{token})).data;eq(day.state,'done','done for the day');ok(day.entry.out,'check-out time shown');
eq(day.attendanceEnabled,true,'device and web use the same attendance policy');
ok(deriveView(day,Date.now()).title.includes('Done'),'shared Pip panel renders the real completed day');
eq(day.streak.firstCheckIn,true,'first ever check-in is celebrated');
eq((await call('hr/self')).data.now.state,'done','My desk shows the same day');

// Requests waiting for HR's decision show on HR's companion.
const desk=(await call('hr/self')).data;let leaveDay=Date.now()+7*86400000;while(!desk.policy.workDays.includes(new Date(leaveDay).getUTCDay()||7))leaveDay+=86400000;
const leaveDate=new Date(leaveDay).toISOString().slice(0,10),leaveKind=desk.leave.types.find(t=>t.active)?.key;
const asked=await call('leave',{fromDate:leaveDate,toDate:leaveDate,kind:leaveKind,reason:'Synthetic'});eq(asked.status,200,'a member asks for leave: '+JSON.stringify(asked.data));
const hrDay=(await call('companion',undefined,{role:'hr'})).data;ok(hrDay.waiting?.count>=1,'HR sees requests waiting');eq(hrDay.waiting.href,'/me/approvals','HR opens the shared approval queue');

// HR allows automatic check-in: an office region event may check in by itself.
eq((await call('hr/presence',{offices:[{...presence.offices[0]}],autoCheckIn:true},{role:'hr'})).status,200,'HR allows automatic check-in');
const auto=await call('attendance/check-in',{mode:'office',via:'mobile',trigger:'auto',place:{kind:'office',id:officeId,signal:'region'}},{token});
eq(auto.status,403,'client cannot bypass server dwell with an auto tap');
const manualReturn=await call('attendance/check-in',{mode:'office',via:'mobile',trigger:'manual'},{token});eq(manualReturn.status,200,'manual check-in remains available');eq(manualReturn.data.resumed,true,'back after checking out: the gap becomes a break');
eq((await call('attendance/check-in',{mode:'office',trigger:'auto',place:{kind:'office',id:roles.person,signal:'region'}},{token})).status,400,'an unknown office is refused');

// Reversing an HR correction hides its preserved row everywhere; approved work overrides a day off consistently.
await own('update pulse.attendance_entry set voided_at=now(),checked_out_at=coalesce(checked_out_at,now()) where person_id=$1',[roles.person]);
day=(await call('companion',undefined,{token})).data;
eq(day.entry,null,'a voided correction is absent from the app day');
eq(day.streak.firstCheckIn,false,'voided attendance is not a first-check-in celebration');
eq(day.state,(await call('hr/self')).data.now.state,'voided correction agrees with My desk');
await own("insert into pulse.holiday(org_id,day,name,optional) values($1,$2,'Synthetic holiday',false) on conflict(org_id,day) do update set optional=false",[process.env.PULSE_ORG_ID,day.today]);
eq((await call('companion',undefined,{token})).data.state,'holiday','a holiday without an approved work request is off');
const work=await call('hr/work-days',{day:day.today,note:'Synthetic work on a holiday'});
eq(work.status,200,'request work on the synthetic holiday');
eq((await call('hr/flows/'+work.data.id+'/decision',{action:'approved',note:'Synthetic work approved'},{role:'hr'})).status,200,'HR approves the exceptional work day');
day=(await call('companion',undefined,{token})).data;
eq(day.shift.workingDay,true,'the approved work day is a working day for the app');
eq(day.holiday,null,'the approved work day does not show a holiday label');
eq(day.state,'out','the app invites checking in on the approved work day');
eq(day.state,(await call('hr/self')).data.now.state,'approved work agrees with My desk');

// Server-confirmed triangulation and dwell on this disposable synthetic person only.
eq((await call('hr/presence',{offices:[{...presence.offices[0],publicIpRanges:['192.168.1.0/24']}]},{role:'hr'})).status,400,'private IP ranges refused');
eq((await call('hr/presence',{offices:[{...presence.offices[0],publicIpRanges:['203.0.113.0/24']}],autoCheckIn:true,dwellMinutes:3,leaveMinutes:5},{role:'hr'})).status,200,'HR configures dwell and public network');
// This dwell fixture covers the full civil day, including its final minute.
// 23:59 excluded that minute and made the same assertion fail in late-night CI.
await own("update pulse.hr_policy set shift_start='00:00',shift_end='24:00' where org_id=$1",[process.env.PULSE_ORG_ID]);
const evidence={officeId,consent:true,autoConsent:true};
eq((await call('companion/presence')).status,403,'browser cannot read another device presence preference');
eq((await call('companion/presence',undefined,{token})).data.enabled,false,'new device defaults to no sensor consent');
eq((await call('companion/presence',{consent:true,autoConsent:false,consentOnly:true},{token})).status,200,'first explicit consent can be saved without any readings');
eq((await call('companion/presence',undefined,{token})).data.enabled,true,'device reads its own saved consent');
const firstConsent=(await own('select * from pulse.companion_presence where device_id=$1',[deviceId]))[0];
eq([firstConsent.auto_consent,firstConsent.office_id,firstConsent.region_at,firstConsent.wifi_at,firstConsent.ip_at],[false,null,null,null,null],'consent alone creates no evidence or automatic attendance');
eq((await call('companion/presence',evidence)).status,403,'browser cannot supply device presence');
eq((await call('companion/presence',{...evidence,officeId:roles.person},{token})).status,400,'unknown office evidence refused');
// ATT (0861): weights are the person's engine's (access point 70, geofence 50, network 40, the Wi-Fi's name 30).
eq((await call('companion/presence',{...evidence,region:'exit',wifi:{ssid:'Synth-Office'},ip:'203.0.113.2'},{token})).data.score,30,'SSID and forged body IP cannot establish confidence');
eq((await call('companion/presence',{...evidence,region:'enter',wifi:null},{token})).data.score,50,'region alone cannot auto check in');
const combined=await call('companion/presence',{...evidence,wifi:{ssid:'Synth-Office',bssid:'a4:2b:b0:11:22:33'}},{token});
eq(combined.status,200,'region plus registered BSSID admitted');eq(combined.data.score,100,'independent signals establish confidence');eq(combined.data.checkedIn,false,'first event starts dwell, not attendance');
const beforeConsent=(await own('select wifi_strength,region_inside from pulse.companion_presence where device_id=$1',[deviceId]))[0];
await call('companion/presence',{consent:true,autoConsent:true,consentOnly:true},{token});
eq((await own('select wifi_strength,region_inside from pulse.companion_presence where device_id=$1',[deviceId]))[0],beforeConsent,'preference reconciliation preserves current Wi-Fi/region evidence');
await own("update pulse.attendance_presence_state set holding_since=now()-interval '4 minutes',confident_since=now()-interval '4 minutes' where person_id=$1",[roles.person]);
eq((await call('companion/presence',{...evidence,autoConsent:false,wifi:{ssid:'Synth-Office',bssid:'a4:2b:b0:11:22:33'}},{token})).data.checkedIn,false,'person auto opt-out prevents check-in');
await call('hr/presence',{offices:[{...presence.offices[0],publicIpRanges:['203.0.113.0/24']}],autoCheckIn:false},{role:'hr'});
eq((await call('companion/presence',{...evidence,wifi:{ssid:'Synth-Office',bssid:'a4:2b:b0:11:22:33'}},{token})).data.checkedIn,false,'HR opt-out prevents check-in');
await call('hr/presence',{offices:[{...presence.offices[0],publicIpRanges:['203.0.113.0/24']}],autoCheckIn:true},{role:'hr'});
await assert.rejects(pool.query('select pulse.companion_presence_tick(null)'),e=>e.code==='42501');checks++;receipts.push({label:'API cannot invoke the scheduled worker scope',passed:true});
const wc=await worker.connect();try{await wc.query('begin');await wc.query("select set_config('pulse.org_id',$1,true)",[process.env.PULSE_ORG_ID]);await wc.query('select pulse.companion_presence_tick(null)');await wc.query('commit');}finally{wc.release();}
eq((await call('companion',undefined,{token})).data.state,'in','scheduled worker confirms dwell while the app is asleep');
const confirmed=await call('companion/presence',{...evidence,wifi:null},{token,ip:'203.0.113.7'});
eq(confirmed.data.score,90,'region plus trusted public IP holds confidence when Wi-Fi turns off');eq(confirmed.data.checkedIn,true,'server confirms check-in after dwell and both opt-ins');
day=(await call('companion',undefined,{token})).data;eq(day.state,'in','confirmed day reflects server attendance');eq(day.state,(await call('hr/self')).data.now.state,'auto attendance has My desk parity');
const automatic=(await own('select client from pulse.attendance_entry where id=$1',[day.entry.id]))[0].client;
eq(automatic.trigger,'auto','server-created attendance records the automatic trigger');eq(automatic.dwellMinutes,3,'HR dwell is recorded');ok(!JSON.stringify(automatic).match(/"lat"|"lng"|203\.0/),'attendance stores confidence, not coordinates or addresses');
// ATT: stepping out asks nothing and proposes nothing; coming back records a break. (The all-day shift ends at
// midnight: the end-of-day rules are switched off for this step so a late-night run judges the same absence.)
await own("update pulse.hr_policy set presence_auto_checkout=false,presence_question=false where org_id=$1",[process.env.PULSE_ORG_ID]);
await call('companion/presence',{...evidence,region:'exit',wifi:null},{token});
await own("update pulse.attendance_presence_state set last_confident_at=now()-interval '25 minutes' where person_id=$1",[roles.person]);
await call('companion/presence',{...evidence,region:'exit',wifi:null},{token});
eq((await call('companion',undefined,{token})).data.state,'in','a short absence is not a check-out');
eq((await own("select count(*)::int n from pulse.notification where person_id=$1 and event_type in ('attendance.departure','attendance.checkout','attendance.ask')",[roles.person]))[0].n,0,'no "Leaving for the day?" and no question');
eq((await own("select count(*)::int n from pulse.attendance_regularisation where person_id=$1",[roles.person]))[0].n,0,'no correction proposed by Pulse');
await call('companion/presence',{...evidence,region:'enter',wifi:{ssid:'Synth-Office',bssid:'a4:2b:b0:11:22:33'}},{token});
const lunch=(await own("select client,round(extract(epoch from ended_at-started_at)/60)::int minutes from pulse.attendance_break where entry_id=$1",[day.entry.id]))[0];
eq([lunch?.client?.via,lunch?.minutes>=24],['auto',true],'back at the office: the time away became a break');
await own("update pulse.hr_policy set presence_auto_checkout=true,presence_question=true where org_id=$1",[process.env.PULSE_ORG_ID]);
await call('companion/presence',{consent:false,autoConsent:false},{token});
const withdrawn=(await own('select * from pulse.companion_presence where device_id=$1',[deviceId]))[0];eq([withdrawn.consent,withdrawn.region_inside,withdrawn.wifi_strength,withdrawn.ip_matched,withdrawn.last_present_at],[false,false,0,false,null],'withdrawal clears current signals and stops automation');
eq((await call('companion/presence',undefined,{token})).data.enabled,false,'withdrawal is visible to the next native sensor guard');
// The laptop app's report names no office (apps/desktop presence.rs): the registered access point finds it, from any network.
const laptop=await call('companion/presence',{consent:true,autoConsent:false,wifi:{ssid:'Synth-Office',bssid:'A4-2B-B0-11-22-33'}},{token,ip:'198.51.100.7'});
eq([laptop.data.officeId,laptop.data.score>=70],[officeId,true],'an office access point names its office without officeId or the office IP');
eq((await call('companion/presence',{consent:true,autoConsent:false,wifi:{ssid:'Synth-Office',bssid:'02:00:00:00:00:99'}},{token,ip:'198.51.100.7'})).data.score<60,true,'the office Wi-Fi name from another access point stays weak');
await call('companion/presence',{consent:false,autoConsent:false},{token});

// A resumed queued check-in remains idempotent even if a second device checks out before its retry.
const resume={mode:'office',via:'desktop',at:new Date().toISOString(),queueId:'q-resume-desktop-15'};
eq((await call('attendance/check-out',{via:'desktop'},{token})).status,200,'close synthetic day before resume replay');
resume.at=new Date().toISOString();
eq((await call('attendance/check-in',resume,{token})).data.resumed,true,'queued check-in resumes the same day');
eq((await call('attendance/check-out',{via:'desktop'},{token})).status,200,'another command can finish the resumed day');
eq((await call('attendance/check-in',resume,{token})).data.replayed,true,'late resumed check-in retry uses the original receipt');
eq((await call('companion',undefined,{token})).data.state,'done','late replay never reopens a finished day');
eq(Number((await own("select count(*) n from pulse.attendance_break where person_id=$1 and client->>'queueId'=$2",[roles.person,resume.queueId]))[0].n),1,'resumed queued check-in records one break gap');

// Revocation from Settings → Devices signs the app out.
eq((await call('devices/'+deviceId+'/revoke',{})).status,200,'the person revokes the app');
eq((await call('companion',undefined,{token})).status,401,'a revoked app is signed out');
eq((await call('native/refresh',{refreshToken:paired.refreshToken},{anonymous:true})).status,401,'its refresh credential is dead too');

await writeFile(process.env.TEST_REPORT,JSON.stringify({checks,receipts},null,2));
await app.close();await pool.end();await owner.end();await worker.end();
console.log(`companion: ${checks} checks passed`);
