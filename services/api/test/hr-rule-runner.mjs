import assert from 'node:assert/strict';
import {enableAttendanceForWebFixture} from './attendance-enabled-web-fixture.mjs';
import {Pool} from 'pg';
import {createApp} from '../dist/app.js';
import {proposals} from '../dist/hr-rules.js';
import {spawn} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),owner=new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG)),app=createApp(pool,pool);enableAttendanceForWebFixture(app);
const member=process.env.TEST_MEMBER,person=process.env.TEST_MEMBER_ID,other=process.env.TEST_OTHER_ID;
let apiChecks=0,browserChecks=0,browser,server,page;
const call=async(path,body,role='hr',expected=200)=>{apiChecks++;const r=await app.inject({url:'/api/v0/'+path,method:body===undefined?'GET':'POST',headers:{'cf-access-authenticated-user-email':role==='hr'?'hr@estateautopilots.com':member},...(body===undefined?{}:{payload:body})});assert.equal(r.statusCode,expected,`${path}: ${r.body}`);return r.json();};
const own=async(sql,params=[])=>{const c=await owner.connect();try{await c.query('begin');await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id','',true)",[process.env.PULSE_ORG_ID]);const r=await c.query(sql,params);await c.query('commit');return r.rows;}catch(e){await c.query('rollback');throw e;}finally{c.release();}};
await own('select pulse.hr_defaults()');await own('update pulse.hr_policy set attendance_enabled=true');
const shift=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const titles={late_marks:'Late marks → leave deduction',half_day:'Automatic half-day attendance',advance_notice:'Advance notice for leave',emergency:'Emergency leave',special_routing:'Special leave routing',leave_balance:'Leave year and monthly balances',professional_tax:'Maharashtra Professional Tax',exit:'Notice period and exit'};
try{
 const off=await call('hr/rules');assert.equal(off.versions.length,0);const today=off.today;
 await call('hr/rules',undefined,'member',403);
 await call('people/'+person+'/salary',{month:today.slice(0,7),amount:26000,kind:'current'},'hr');
 // R43: before HR issues one, the employee has no payslip (never a projection from salary records); HR reviews the projection.
 await call('hr/payslip/'+person,undefined,'member',404);await call('hr/payslip/'+person+'?projection=1',undefined,'member',404);
 const noTax=await call('hr/payslip/'+person);assert.equal(noTax.projection,true);assert.equal(noTax.professionalTax,0);assert.equal(noTax.net,26000);
 await call('hr/payslip/'+person,{month:today.slice(0,7),previewHash:noTax.previewHash,confirm:true},'member',403);
 await call('hr/payslip/'+person,{month:today.slice(0,7),previewHash:noTax.previewHash,confirm:true});
 assert.equal((await call('hr/payslip/'+person,undefined,'member')).projection,false);
 await call('hr/payslip/'+other,undefined,'member',403);
 await call('hr/employment/'+person,{probationFrom:shift(today,-30),probationTo:shift(today,60),noticeFrom:null,noticeTo:null,lastWorkingDay:shift(today,14),settlementTarget:null,handover:[{label:'Return company assets',done:false}],ptCategory:'women',ptState:'MH',ptExempt:false});
 assert.equal((await call('hr/rules')).people.find(p=>p.id===person).settlementTarget,null);
 await call('hr/employment/'+person,{handover:[]},'member',403);
 await call('leave/emergency',{fromDate:today,returnDate:shift(today,1),reason:'Synthetic emergency'},'member',403);
 const noticeOff=await call('leave/notice?from='+shift(today,1)+'&to='+shift(today,1),undefined,'member');assert.equal(noticeOff.flag,null);
 await own("insert into pulse.attendance_entry(org_id,person_id,work_date,checked_in_at,checked_out_at,late_minutes) values($1,$2,$3,($3::date+time '13:01') at time zone 'Asia/Kolkata',($3::date+time '17:30') at time zone 'Asia/Kolkata',181)",[process.env.PULSE_ORG_ID,person,today]);
 const selfOff=await call('hr/self',undefined,'member');assert.equal(selfOff.month.days.find(d=>d.date===today).automaticHalfDay,false);assert.equal(selfOff.rules.late,null);
 if(process.env.PULSE_AUTH_BROWSER==='1'){
  const {chromium,expect}=await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
  const origin=await app.listen({host:'127.0.0.1',port:0}),net=await import('node:net'),probe=net.createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));const base=`http://127.0.0.1:${port}`;
  server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{cwd:'../../apps/web',env:{...process.env,PULSE_API_URL:origin,NODE_ENV:'production'},stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/login')).ok)break;}catch{}await delay(250);if(i===99)throw Error('Web did not start');}
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:900},extraHTTPHeaders:{'cf-access-authenticated-user-email':'hr@estateautopilots.com'}});await page.goto(base+'/hr?tab=policies&view=rules');
  await expect(page.getByText('Off — awaiting HR confirmation',{exact:true})).toHaveCount(8);browserChecks+=8;
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));browserChecks++;
  if(process.env.PULSE_R19B_SHOTS){await mkdir(process.env.PULSE_R19B_SHOTS,{recursive:true});await page.screenshot({path:process.env.PULSE_R19B_SHOTS+'/rules-off-phone.png',fullPage:true});}
  page.expect=expect;
 }
 const oldBalance=selfOff.leave.balances.find(b=>b.key==='annual').available;
 // R51: the API's proposals carry the company's zone in the half-day rule.
 const zoned=(await call('hr/rules')).proposals;assert.equal(zoned.half_day.timezone,'Asia/Kolkata');
 for(const [key,config] of Object.entries(zoned)){
  await call('hr/rules/confirm',{key,config,effectiveFrom:today,version:0},'hr',400);
  await call('hr/rules/confirm',{key,config,effectiveFrom:today,version:0,confirm:true},'member',403);
  if(page){
   const card=page.locator('section').filter({has:page.getByRole('heading',{name:titles[key]})}).last();
   await card.getByRole('button',{name:'Confirm and turn on',exact:true}).click();const sheet=page.getByRole('dialog');await page.expect(sheet).toBeVisible();browserChecks++;
   if(key==='leave_balance'){await page.expect(sheet.getByRole('table')).toBeVisible();await page.expect(sheet.getByRole('row')).toHaveCount(off.people.length+1);browserChecks++;}
   console.log('Browser confirms',key);const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/hr/rules/confirm')&&r.request().method()==='POST'),sheet.getByRole('button',{name:'Confirm and turn on',exact:true}).click()]);assert.equal(response.status(),200,await response.text());await page.expect(sheet).toHaveCount(0);browserChecks++;
  }else{
   let hash;if(key==='leave_balance'){const preview=await call('hr/rules/preview',{key,config,effectiveFrom:today});assert.equal(preview.rows.length,off.people.length);hash=preview.hash;await call('hr/rules/confirm',{key,config,effectiveFrom:today,version:0,confirm:true,previewHash:'stale'},'hr',409);}
   await call('hr/rules/confirm',{key,config,effectiveFrom:today,version:0,confirm:true,previewHash:hash});
  }
  assert.equal((await call('hr/rules')).versions.find(v=>v.key===key).version,1);
  if(key==='half_day')assert.equal((await call('hr/self',undefined,'member')).month.days.find(d=>d.date===today).automaticHalfDay,true);
  if(key==='late_marks'){const self=await call('hr/self',undefined,'member');assert.equal(self.rules.late.count,1);assert.equal(self.leave.balances.find(b=>b.key==='annual').available,oldBalance);}
  if(key==='advance_notice'){
   const n=await call('leave/notice?from='+shift(today,1)+'&to='+shift(today,1),undefined,'member');assert.equal(n.flag.late,true);assert.equal(n.flag.required,3);
   const exact=await call('leave/notice?from='+shift(today,3)+'&to='+shift(today,3),undefined,'member');assert.equal(exact.flag.given,3);assert.equal(exact.flag.late,false);
   const short=await call('leave/notice?from='+shift(today,2)+'&to='+shift(today,2),undefined,'member');assert.equal(short.flag.given,2);assert.equal(short.flag.late,true);
  }
  if(key==='professional_tax'){
   const slip=await call('hr/payslip/'+person+'?projection=1');assert.equal(slip.professionalTax,200);assert.equal(slip.net,25800);
   assert.equal((await call('hr/payslip/'+person+'?projection=1',undefined,'member')).projection,false);
   assert.equal((await call('hr/payslip/'+person,undefined,'member')).professionalTax,0);
   await call('hr/payslip/'+person,{month:today.slice(0,7),previewHash:'stale',confirm:true},'hr',409);
   await call('hr/payslip/'+person,{month:today.slice(0,7),previewHash:slip.previewHash,confirm:true});
   assert.equal((await call('hr/payslip/'+person,undefined,'member')).professionalTax,200);
  }
 }
 await call('hr/rules/confirm',{key:'half_day',config:{...zoned.half_day,netMinutes:0},effectiveFrom:today,version:1,confirm:true},'hr',400);
 const emergency=await call('leave/emergency',{fromDate:today,returnDate:shift(today,1),reason:'Synthetic emergency'},'member');
 const alerts=await own("select title,person_id from pulse.notification where href=$1 and title like 'Emergency leave:%'",['/people/'+person]);
 const head=(await own('select pulse.hr_head($1) id',[person]))[0].id;
 assert.ok(alerts.some(n=>!head||n.person_id===head));assert.ok(alerts.every(n=>n.title.includes(today)&&n.title.includes(shift(today,1))));
 const recorded=await call('leave',{kind:'annual',fromDate:today,toDate:today,reason:'Recording emergency',emergencyId:emergency.id},'member');
 assert.ok(recorded.flowId);const flow=(await call('hr/flows')).rows.find(f=>f.id===recorded.flowId);assert.equal(flow.details.advanceNotice.late,true);
 assert.ok((await call('leave/emergencies',undefined,'member')).rows.find(e=>e.id===emergency.id).leaveId);
 const leaveFrom=shift(today,20),unpaid=await call('leave',{kind:'unpaid',fromDate:leaveFrom,toDate:shift(leaveFrom,5),reason:'Long unpaid exception'},'member');assert.equal((await call('hr/flows')).rows.find(f=>f.id===unpaid.flowId).stage,'cofounder');
 const adjacentFrom=shift(today,6);
 const two=await call('leave',{kind:'annual',fromDate:adjacentFrom,toDate:shift(adjacentFrom,1),reason:'First probation spell'},'member');
 assert.ok(!(await call('hr/flows')).rows.find(f=>f.id===two.flowId).needsHr.includes('probation leave'));
 const adjacent=await call('leave',{kind:'annual',fromDate:shift(adjacentFrom,2),toDate:shift(adjacentFrom,2),reason:'Adjacent probation spell'},'member');
 assert.ok((await call('hr/flows')).rows.find(f=>f.id===adjacent.flowId).needsHr.includes('probation leave'));
 await call('hr/employment/'+person,{probationFrom:shift(today,-30),probationTo:shift(today,60),noticeFrom:today,lastWorkingDay:shift(today,14),handover:[{label:'Return assets',done:true}],ptCategory:'women',ptState:'MH'});
 const employment=(await call('hr/rules')).people.find(p=>p.id===person);assert.equal(employment.noticeTo,shift(today,14));assert.equal(employment.settlementTarget,shift(today,59));assert.equal(employment.handover[0].done,true);
 const noticeLeave=await call('leave',{kind:'annual',fromDate:shift(today,2),toDate:shift(today,2),reason:'Notice period request'},'member');assert.ok((await call('hr/flows')).rows.find(f=>f.id===noticeLeave.flowId).needsHr.includes('leave during notice period'));
 await own('update pulse.hr_emergency set record_by=$1 where id=$2',[shift(today,-1),emergency.id]);assert.equal((await call('hr/rules')).emergencies.find(e=>e.id===emergency.id).overdue,false);
 const unrecorded=await call('leave/emergency',{fromDate:shift(today,10),returnDate:shift(today,11),reason:'Synthetic unrecorded emergency'},'member');
 await own('update pulse.hr_emergency set record_by=$1 where id=$2',[shift(today,-1),unrecorded.id]);
 const mailBefore=(await own('select count(*)::int n from pulse.hr_mail_outbox'))[0].n;
 assert.equal((await call('hr/rules')).emergencies.find(e=>e.id===unrecorded.id).overdue,true);
 const reminders=(await own("select count(*)::int n from pulse.notification where title='Emergency leave recording is overdue' and telegram_status='disabled'"))[0].n;assert.ok(reminders>0);
 await call('hr/rules');assert.equal((await own("select count(*)::int n from pulse.notification where title='Emergency leave recording is overdue'"))[0].n,reminders);
 assert.equal((await own('select count(*)::int n from pulse.hr_mail_outbox'))[0].n,mailBefore);
 assert.equal((await call('hr/payslip/'+person+'?month='+String(Number(today.slice(0,4))+1)+'-02')).professionalTax,300);
 await call('hr/payslip/'+person+'?month='+String(Number(today.slice(0,4))+1)+'-02',undefined,'member',404);
 if(page){
  await page.reload();await page.expect(page.getByText('On',{exact:true})).toHaveCount(8);browserChecks+=8;
  if(process.env.PULSE_R19B_SHOTS)await page.screenshot({path:process.env.PULSE_R19B_SHOTS+'/rules-on-phone.png',fullPage:true});
  await page.setExtraHTTPHeaders({'cf-access-authenticated-user-email':member});await page.goto(new URL('/me?tab=attendance',page.url()).href);await page.expect(page.getByText(/1\s+late marks? this month/)).toBeVisible();await page.goto(new URL('/me?tab=attendance&section=Day%20by%20day',page.url()).href);await page.expect(page.getByRole('button',{name:'Correct half day'})).toBeVisible();browserChecks+=2;
  await page.getByRole('button',{name:'Correct half day'}).click();await page.expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'Cancel',exact:true}).click();browserChecks++;
  await page.goto(new URL('/me?tab=leave',page.url()).href);await page.expect(page.getByRole('button',{name:'Emergency: notify team head now'})).toBeVisible();await page.getByRole('button',{name:'Apply for leave',exact:true}).click();await page.expect(page.getByText(/Apply at least 3 working days ahead/)).toBeVisible();browserChecks+=2;
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();
  await page.goto(new URL('/me?tab=overview',page.url()).href);await page.getByRole('button',{name:'View payslip',exact:true}).click();
  const slip=page.getByRole('dialog',{name:'Payslip',exact:true});await page.expect(slip.getByText('₹25,800.00',{exact:true})).toBeVisible();browserChecks++;
  await page.emulateMedia({media:'print'});await page.expect(page.locator('body > .pulse-print-root')).toBeVisible();browserChecks++;
  await page.emulateMedia({media:'screen'});await slip.getByRole('button',{name:'Close',exact:true}).click();
  await page.setExtraHTTPHeaders({'cf-access-authenticated-user-email':'hr@estateautopilots.com'});await page.setViewportSize({width:1440,height:900});await page.goto(new URL('/hr?tab=policies&view=rules',page.url()).href);
  await page.expect(page.getByText('On',{exact:true})).toHaveCount(8);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));browserChecks+=2;
  if(process.env.PULSE_R19B_SHOTS)await page.screenshot({path:process.env.PULSE_R19B_SHOTS+'/rules-on-desktop.png',fullPage:true});
 }
 await assert.rejects(own("update pulse_priv.hr_payslip set snapshot='{}' where person_id=$1",[person]),e=>e.code==='42501');
 for(const [category,amount,expected] of [['men',7500,0],['men',7501,175],['men',10000,175],['men',10001,200],['women',25000,0],['women',25001,200]]) {
  await call('hr/employment/'+person,{handover:[],ptCategory:category,ptState:'MH',ptExempt:false});
  await call('people/'+person+'/salary',{month:today.slice(0,7),amount,kind:'current'});
  assert.equal((await call('hr/payslip/'+person+'?projection=1')).professionalTax,expected);
 }
 await call('hr/employment/'+person,{handover:[],ptCategory:'women',ptState:'MH',ptExempt:true});
 assert.equal((await call('hr/payslip/'+person+'?projection=1')).professionalTax,0);
 await call('hr/employment/'+person,{handover:[],ptCategory:null,ptState:'MH',ptExempt:false});
 const review=await call('hr/payslip/'+person+'?projection=1');assert.equal(review.net,null);assert.equal(review.ptReview,true);
 await call('hr/payslip/'+person,{month:today.slice(0,7),previewHash:review.previewHash,confirm:true},'hr',400);
 // Source and tax-input edits do not rewrite an issued payslip.
 assert.equal((await call('hr/payslip/'+person,undefined,'member')).net,25800);
 await call('hr/rules/confirm',{key:'late_marks',config:{...proposals.late_marks,window:'calendar_week'},effectiveFrom:today,version:1,confirm:true});
 const weekly=(await call('hr/self',undefined,'member')).rules.late;assert.equal(weekly.window,'calendar_week');assert.equal(weekly.count,1);
 if(page){await page.setExtraHTTPHeaders({'cf-access-authenticated-user-email':member});await page.goto(new URL('/me?tab=attendance',page.url()).href);await page.expect(page.getByText(/1\s+late marks? this week/)).toBeVisible();browserChecks++;}
 const receipt={apiChecks,browserChecks,syntheticOnly:true,liveChanges:false};await writeFile(process.env.PULSE_R19B_REPORT,JSON.stringify(receipt));console.log(JSON.stringify(receipt));
}catch(e){if(page&&process.env.PULSE_R19B_SHOTS){await page.screenshot({path:process.env.PULSE_R19B_SHOTS+'/failure.png',fullPage:true});console.error('Synthetic failure screen:',await page.locator('body').innerText());}throw e;}finally{await browser?.close();server?.kill('SIGTERM');await app.close();await pool.end();await owner.end();}
