import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {createApp} from '../dist/app.js';

const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const owner=new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
const worker=new Pool(JSON.parse(process.env.TEST_WORKER_CONFIG));
const app=createApp(pool,pool),org=process.env.PULSE_ORG_ID,person=process.env.TEST_MEMBER_ID;
const other=process.env.TEST_OTHER_ID,hr='hr@estateautopilots.com',admin='admin@estateautopilots.com';
let checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;};
const call=async(path,role='member',body)=>{
 const headers={'cf-access-authenticated-user-email':role==='member'?process.env.TEST_MEMBER:role==='manager'||role==='pgs'?process.env.TEST_OTHER:role==='hr'?hr:admin};
 const r=await app.inject({url:'/api/v0/'+path,method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{payload:body})});
 let data;try{data=r.json();}catch{data=null;}return {status:r.statusCode,data,raw:r.body};
};
const own=async(sql,args=[])=>{const c=await owner.connect();try{await c.query('begin');await c.query("select set_config('pulse.org_id',$1,true)",[org]);const r=await c.query(sql,args);await c.query('commit');return r.rows;}catch(e){await c.query('rollback');throw e;}finally{c.release();}};
const amount=async(table)=>Number((await own(`select count(*)::int n from pulse.${table} where org_id=$1 and person_id=any($2::uuid[])`,[org,[person,other]]))[0].n);
const day=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
try{
 const today=(await call('hr/policy')).data.today,yesterday=day(today,-1);
 await own('select pulse.hr_defaults()');
 await own("update pulse.hr_policy set attendance_enabled=false,work_days='{1,2,3,4,5,6,7}',presence_auto_checkin=true,presence_leave_minutes=1 where org_id=$1",[org]);
 const [seed]=await own("insert into pulse.attendance_entry(org_id,person_id,work_date,mode,checked_in_at) values($1,$2,$3::date-1,'office',($3::date-1+time '10:13:47') at time zone 'Asia/Kolkata') returning id,checked_in_at",[org,person,today]);
 const [reg]=await own("insert into pulse.attendance_regularisation(org_id,person_id,work_date,kind,in_time,out_time,reason) values($1,$2,$3::date-2,'missed_punch','10:00','19:00','Synthetic attendance gate decision') returning id",[org,person,today]);
 const [flow]=await own("select id from pulse.hr_flow where org_id=$1 and kind='correction' and source_id=$2",[org,reg.id]);
 const [office]=await own("insert into pulse.presence_office(org_id,name,lat,lng,radius_m) values($1,'Synthetic gate test',18.52,73.86,150) returning id",[org]);
 const [device1]=await own("insert into pulse.native_device(org_id,person_id,name,platform) values($1,$2,'Synthetic open session','windows') returning id",[org,person]);
 const [device2]=await own("insert into pulse.native_device(org_id,person_id,name,platform) values($1,$2,'Synthetic auto check-in','windows') returning id",[org,other]);
 await own("insert into pulse.attendance_break(org_id,entry_id,person_id,started_at) values($1,$2,$3,now()-interval '15 minutes')",[org,seed.id,person]);
 await own("insert into pulse.companion_presence(org_id,device_id,person_id,office_id,consent,auto_consent,region_inside,region_at,wifi_strength,wifi_at,dwell_started_at,last_present_at,left_at) values($1,$2,$3,$4,true,false,false,now()-interval '1 hour',0,null,null,now()-interval '20 minutes',now()-interval '10 minutes'),($1,$5,$6,$4,true,true,true,now(),40,now(),now()-interval '10 minutes',now(),null)",[org,device1.id,person,office.id,device2.id,other]);

 const noticeBody={version:'synthetic-native-v1',purpose:'optional_work_context',dataItems:['work_app_category','focus_idle_aggregate','render_export_metadata','structural_edit_delta','authorized_project_id','explicit_shoot_wrap'],apps:['premiere'],domains:['drive.google.com'],workWindow:{start:'00:00',end:'23:59',timezone:'UTC'},audience:'Self only; metadata never published',rightsContact:'Synthetic rights owner',withdrawalFlow:'Devices → withdraw',rawDays:7,derivedDays:30,deletionTest:'passed'};
 const notice=await call('fair-work/notice-approve','admin',noticeBody);
 check(notice.status===200,'synthetic native notice is approved');
 check((await call(`devices/${device1.id}/consent`,'member',{purposes:['work_evidence'],notice:notice.data.id})).status===200,'synthetic device has versioned consent');
 const resume=await call(`devices/${device1.id}/resume`,'member',{endsAt:new Date(Date.now()+3600000).toISOString()});
 check(resume.status===200&&resume.data.ok===true,'attendance-off resume ignores an open attendance break');

 const before={entries:await amount('attendance_entry'),regularisations:await amount('attendance_regularisation'),seed:(await own('select to_jsonb(e) row from pulse.attendance_entry e where id=$1',[seed.id]))[0].row};
 const workerClient=await worker.connect();try{await workerClient.query('begin');await workerClient.query("select set_config('pulse.org_id',$1,true)",[org]);await workerClient.query('select pulse.companion_presence_tick(null)');await workerClient.query('commit');}catch(e){await workerClient.query('rollback');throw e;}finally{workerClient.release();}
 const afterTick={entries:await amount('attendance_entry'),regularisations:await amount('attendance_regularisation')};
 check(afterTick.entries===before.entries&&afterTick.regularisations===before.regularisations,'off presence tick creates neither attendance nor missed-punch rows');
 check((await own('select to_jsonb(e) row from pulse.attendance_entry e where id=$1',[seed.id]))[0].row.checked_in_at===before.seed.checked_in_at,'presence tick preserves the seeded row');

 const reads=[
  ['hr/attendance','hr'],['hr/desk','hr'],['hr/self','member'],[`hr/person/${person}`,'hr'],['me/hr','member'],
  ['companion','member'],['companion/wallet','member'],['home','member'],['insights','admin'],['people','hr'],
  [`people/${person}`,'hr'],['performance','member'],['devices/health','admin'],['attendance','hr'],
 ];
 const readBodies={};
 for(const [path,role] of reads){
  const r=await call(path,role);check(r.status===200,`${path} reads while attendance is off`);
  readBodies[path]=r.data;
  check(r.data?.attendanceEnabled===false,`${path} declares attendance off`);
  const json=JSON.stringify(r.data);
  check(!json.includes(seed.id)&&!json.includes(new Date(seed.checked_in_at).toISOString()),`${path} omits the seeded entry and timestamp`);
  const statuses=[];const walk=x=>{if(Array.isArray(x))return x.forEach(walk);if(x&&typeof x==='object'){for(const [k,v] of Object.entries(x)){if((k==='status'||k==='state')&&typeof v==='string')statuses.push(v);walk(v);}}};walk(r.data);
  check(!statuses.some(s=>['in','break','done','not_in','absent','untracked','late'].includes(s)),`${path} has no attendance status`);
 }
 const month=await call('hr/attendance','hr');check(month.data.people.length===0,'off HR month has no people');
 const desk=await call('hr/desk','hr');check(desk.data.attendance===null&&desk.data.trend.length===0&&desk.data.pending.regularisations.length===0,'off HR desk hides attendance aggregates');
 check(['in','onBreak','done','wfh','late','notIn'].every(k=>desk.data.counts[k]===null),'off HR desk attendance counts are null');
 check(desk.data.people.every(p=>p.entry===null&&p.sessions.length===0&&p.attendance===null&&[null,'leave','holiday','off'].includes(p.status)),'off HR desk retains only leave and non-working status');
 const selfOff=readBodies['hr/self'],personOff=readBodies[`hr/person/${person}`],companionOff=readBodies.companion,walletOff=readBodies['companion/wallet'];
 check(selfOff.now.entry===null&&selfOff.month.days.length===0&&selfOff.month.summary===null&&selfOff.rules.late===null&&selfOff.reconciliation===null,'off self bundle has no attendance details');
 check(selfOff.performance!==null&&selfOff.leave.trackingFrom===selfOff.policy.trackingFrom,'off self bundle retains delivery performance and leave tracking date');
 check(personOff.now.entry===null&&personOff.month.days.length===0&&personOff.reconciliation===null,'off person bundle has no attendance details');
 check(companionOff.entry===null&&companionOff.streak.onTime===0&&companionOff.streak.firstCheckIn===false&&['out','leave','holiday','off'].includes(companionOff.state),'off companion uses leave-only state');
 const managerCompanionOff=await call('companion','manager');
 check(managerCompanionOff.status===200&&managerCompanionOff.data.attendanceEnabled===false&&managerCompanionOff.data.waiting===null,'manager companion hides pending attendance correction from waiting count');
 check((await own("select status='pending' pending from pulse.hr_flow where id=$1",[flow.id]))[0].pending,'synthetic attendance correction remains pending while hidden');
 check(walletOff.wallet.month.present===null&&walletOff.wallet.month.late===null&&walletOff.wallet.month.extraMinutes===null&&walletOff.day===null&&walletOff.late===null,'off wallet hides time totals and late details');
 check(readBodies.home.attendance===null,'off home hides attendance summary');
 check(readBodies.insights.attendance.length===0&&readBodies.insights.people.inToday===null&&readBodies.insights.hrQueue.corrections===null,'off insights hide attendance totals');
 check(readBodies.people.people.every(p=>p.checkedIn===false),'off people list does not show checked-in state');
 check(readBodies[`people/${person}`].attendance.length===0,'off person record has no attendance rows');
 check(readBodies.performance.people.every(p=>p.attendanceDays===null),'off performance hides attendance primitive');
 check(readBodies['devices/health'].devices.every(d=>d.lastAttendance===null&&d.attendance===null),'off device health hides attendance fields');
 check(readBodies.attendance.ownOpen===false&&readBodies.attendance.entries.length===0,'off legacy attendance has no entries');

 const noWrite=async(path,role,body)=>{const r=await call(path,role,body);check(r.status===403&&r.data?.error==='Attendance is off for your organisation.',`${path} refuses with exact 403`);};
 const beforeWrites={entries:await amount('attendance_entry'),breaks:await amount('attendance_break'),regularisations:await amount('attendance_regularisation'),seed:(await own('select to_jsonb(e) row from pulse.attendance_entry e where id=$1',[seed.id]))[0].row,reg:(await own('select to_jsonb(r) row from pulse.attendance_regularisation r where id=$1',[reg.id]))[0].row,flow:(await own('select to_jsonb(f) row from pulse.hr_flow f where id=$1',[flow.id]))[0].row};
 await noWrite('attendance/check-in','member',{mode:'office'});await noWrite('attendance/check-out','member',{});await noWrite('attendance/break','member',{action:'start'});
 for(const kind of ['missed_punch','wfh','on_duty','late'])await noWrite('hr/regularisations','member',{kind,date:today,inTime:'10:00',outTime:'19:00',reason:'Synthetic request'});
 await noWrite(`hr/regularisations/${reg.id}`,'hr',{decision:'approved'});await noWrite(`hr/flows/${flow.id}/decision`,'hr',{action:'approved'});
 await noWrite('companion/late-dispute','member',{reason:'Synthetic dispute'});
 await noWrite('performance/events','admin',{primitive:'attendance',personId:person,observedAt:new Date().toISOString(),source:'synthetic',sourceRef:'attendance-gate'});
 const afterWrites={entries:await amount('attendance_entry'),breaks:await amount('attendance_break'),regularisations:await amount('attendance_regularisation'),seed:(await own('select to_jsonb(e) row from pulse.attendance_entry e where id=$1',[seed.id]))[0].row,reg:(await own('select to_jsonb(r) row from pulse.attendance_regularisation r where id=$1',[reg.id]))[0].row,flow:(await own('select to_jsonb(f) row from pulse.hr_flow f where id=$1',[flow.id]))[0].row};
 check(afterWrites.entries===beforeWrites.entries&&afterWrites.breaks===beforeWrites.breaks&&afterWrites.regularisations===beforeWrites.regularisations,'refused captures write no attendance or correction rows');
 check(JSON.stringify(afterWrites)===JSON.stringify(beforeWrites),'refused captures leave existing attendance rows unchanged');

 await own('update pulse.attendance_entry set checked_out_at=now() where id=$1',[seed.id]);
 await own('update pulse.hr_policy set attendance_enabled=true where org_id=$1',[org]);
 const monthKey=yesterday.slice(0,7);
 const enabled=await call(`hr/attendance?month=${monthKey}`,'hr');check(enabled.status===200&&enabled.data.attendanceEnabled===true,'HR attendance is available when enabled');
 const enabledPerson=await call(`hr/person/${person}?month=${monthKey}`,'hr');
 check(enabledPerson.status===200&&enabledPerson.data.attendanceEnabled===true,'HR person attendance is available when enabled');
 check(enabledPerson.data.month.days.some(d=>d.date===yesterday&&d.entry?.id===seed.id),'enabled HR person detail shows the seeded entry');
 check((await call('attendance/check-in','member',{mode:'office',via:'desktop'})).status===200,'enabled check-in remains available');
 for(const [role,status] of [['hr',200],['admin',200],['member',403],['manager',403],['pgs',403]])check((await call('hr/attendance',role)).status===status,`${role} HR attendance access remains correct`);
 const self=await call('hr/self','member');check(self.status===200&&self.data.attendanceEnabled===true,'person retains own HR detail when enabled');
 console.log(JSON.stringify({checks,syntheticOnly:true,attendanceEnabledOff:true,attendanceEnabledOn:true,seededRowPreserved:true}));
}finally{await app.close();await pool.end();await owner.end();await worker.end();}
