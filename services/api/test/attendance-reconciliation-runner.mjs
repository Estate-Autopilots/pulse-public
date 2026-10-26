import assert from 'node:assert/strict';
import {enableAttendanceForWebFixture} from './attendance-enabled-web-fixture.mjs';
import {Pool} from 'pg';
import {dirname,join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {writeFile} from 'node:fs/promises';
import {createApp} from '../dist/app.js';
import {attendanceDryRun} from '../dist/attendance-reconciliation.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),owner=new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG)),app=createApp(pool,pool);enableAttendanceForWebFixture(app);
const org=process.env.PULSE_ORG_ID,person=process.env.TEST_MEMBER_ID,emails={member:process.env.TEST_MEMBER,hr:'hr@estateautopilots.com'};let apiChecks=0,browserChecks=0;
const call=async(path,body,role='member',expected=200)=>{apiChecks++;const r=await app.inject({url:'/api/v0/'+path,method:body===undefined?'GET':'POST',headers:{'cf-access-authenticated-user-email':emails[role]},...(body===undefined?{}:{payload:body})});assert.equal(r.statusCode,expected,path+': '+r.body);return r.json();};
const own=async(sql,params=[])=>{const c=await owner.connect();try{await c.query('begin');await c.query("select set_config('pulse.org_id',$1,true)",[org]);const r=await c.query(sql,params);await c.query('commit');return r.rows;}catch(e){await c.query('rollback');throw e;}finally{c.release();}};
await own('select pulse.hr_defaults()');await own('update pulse.hr_policy set attendance_enabled=true');
const equal=(a,b,m)=>{apiChecks++;assert.deepEqual(a,b,m);};
try{
 const today=(await call('hr/policy')).today;
 await own("update pulse.hr_policy set work_days='{1,2,3,4,5,6,7}'");
 const [receipt]=await own("insert into pulse.attendance_entry(org_id,person_id,work_date,checked_in_at,client) values($1,$2,$3::date-1,($3::date-1+time '10:00') at time zone 'Asia/Kolkata','{\"via\":\"synthetic\"}') returning id",[org,person,today]);
 const original=await own("select to_jsonb(e)-'reconciled_open' receipt from pulse.attendance_entry e where id=$1",[receipt.id]);
 const before=await own('select count(*)::int n from pulse.attendance_provisional_close');
 const client=await pool.connect();try{await client.query('begin read only');await client.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true),set_config('pulse.role','member',true)",[org,person]);const dry=await attendanceDryRun(client,person);equal(dry.dryRun,true);equal(dry.automaticClosureEnabled,false);await client.query('rollback');}finally{client.release();}
 equal(await own('select count(*)::int n from pulse.attendance_provisional_close'),before,'dry run creates no records');
 const taps=await Promise.all([call('attendance/check-in',{queueId:'r19-next-device',via:'web'}),call('attendance/check-in',{queueId:'r19-next-device',via:'web'})]);equal(taps[0].id,taps[1].id,'duplicate devices yield one attendance identity');
 await call('attendance/check-in',{via:'web'},'member',409);
 equal(await own("select to_jsonb(e)-'reconciled_open' receipt from pulse.attendance_entry e where id=$1",[receipt.id]),original,'next check-in preserves original punches');
 equal((await own('select count(*)::int n from pulse.attendance_provisional_close where entry_id=$1',[receipt.id]))[0].n,1,'one provisional result');
 let self=await call('hr/self');equal(self.reconciliation.automaticClosureEnabled,false);equal(self.reconciliation.queue.find(q=>q.id===receipt.id).proposedEnd!==null,true);
 equal(self.month.days.find(d=>d.date===new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10)).attendance.eligible,false);
 const yesterday=new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10);
 const request=await call('hr/regularisations',{entryId:receipt.id,kind:'missed_punch',date:yesterday,inTime:'10:00',outTime:'18:00',reason:'Synthetic self correction of missed check-out'});
 const flow=(await call('hr/flows')).rows.find(f=>f.sourceId===request.id);
 await call('hr/flows/'+flow.id+'/decision',{action:'approved'},'member',403);
 await call('hr/flows/'+flow.id+'/decision',{action:'ask',note:'Please confirm finish time'},'hr');
 await call('hr/flows/'+flow.id+'/decision',{action:'reply',note:'Confirmed eight hours with no break'});
 await call('hr/flows/'+flow.id+'/decision',{action:'approved',note:'Independent review confirms times'},'hr');
 equal((await call('hr/self')).month.days.find(d=>d.date===yesterday).attendance.minutes,480);
 await call('hr/flows/'+flow.id+'/decision',{action:'approved',note:'Idempotent reprocessing'},'hr');
 equal((await own('select count(*)::int n from pulse.attendance_correction_time where regularisation_id=$1',[request.id]))[0].n,1);
 equal(await own("select to_jsonb(e)-'reconciled_open' receipt from pulse.attendance_entry e where id=$1",[receipt.id]),original,'review preserves punches');
 await call('hr/flows/'+flow.id+'/decision',{action:'rejected',note:'Correction disputed after appeal'},'hr');
 equal((await call('hr/self')).month.days.find(d=>d.date===yesterday).attendance.eligible,false,'appeal restores unresolved exclusion');
 await call('hr/flows/'+flow.id+'/decision',{action:'approved',note:'Appeal resolved with same accepted times'},'hr');
 equal((await call('hr/self')).month.days.find(d=>d.date===yesterday).attendance.minutes,480);
 await call('hr/attendance-close-policy',{promptMinutes:120,capMinutes:960,minimumDays:10,timezone:'Asia/Kolkata',longShiftRule:'HR independently reviews long overnight shifts'},'member',403);
 const p=await call('hr/attendance-close-policy',{promptMinutes:120,capMinutes:960,minimumDays:10,timezone:'Asia/Kolkata',longShiftRule:'HR independently reviews long overnight shifts'},'hr');equal(p.automaticClosureEnabled,false);equal(p.approved,false);
 await own("insert into pulse.hr_month_history(org_id,source_key,person_label,month_label,month,leave_days) values($1,'unknown-r19','Unknown synthetic','October 2026','2026-10-01',30)",[org]);
 self=await call('hr/self');equal(self.reconciliation.historicalMonthly.rows.length,0,'unknown ownership does not enter personal baseline');equal(self.reconciliation.baseline.sampleDays,1);equal(self.reconciliation.baseline.minutes,null);
 await call('attendance/check-out',{via:'web'});
 equal(await own("select to_jsonb(e)-'reconciled_open' receipt from pulse.attendance_entry e where id=$1",[receipt.id]),original,'all operations preserve original punches');
 if(process.env.PULSE_AUTH_BROWSER==='1')await browserProof();
 // Exercise the real SQL-to-API sample boundary as well as the pure median calculator.
 for(let offset=2;offset<=9;offset++){
  const date=new Date(Date.parse(today+'T00:00:00Z')-offset*86400000).toISOString().slice(0,10),minutes=offset*60;
  await own(`insert into pulse.attendance_entry(org_id,person_id,work_date,checked_in_at,checked_out_at) values($1,$2,$3,($3::date+time '10:00') at time zone 'Asia/Kolkata',(($3::date+time '10:00') at time zone 'Asia/Kolkata')+make_interval(mins=>$4))`,[org,person,date,minutes]);
 }
 const sampled=(await call('hr/self')).reconciliation.baseline;
 equal(sampled.sampleDays,10);equal(sampled.medianMinutes,330);equal(sampled.source,'accepted_comparable_shifts');equal(sampled.coverage,10/28);
 const [long]=await own("insert into pulse.attendance_entry(org_id,person_id,work_date,checked_in_at,checked_out_at) values($1,$2,$3::date-12,($3::date-12+time '10:00') at time zone 'Asia/Kolkata',(($3::date-12+time '10:00') at time zone 'Asia/Kolkata')+interval '43 hours') returning id",[org,person,today]);
 const flagged=(await call('hr/self')).reconciliation;
 equal(flagged.baseline.sampleDays,10);equal(flagged.queue.some(q=>q.id===long.id&&q.reasons.includes('Over the provisional 12-hour session bound')),true,'closed 43-hour receipts enter the same needs-checking queue');
 equal(await own("select to_jsonb(e)-'reconciled_open' receipt from pulse.attendance_entry e where id=$1",[receipt.id]),original);
 await writeFile(process.env.PULSE_RECONCILIATION_REPORT,JSON.stringify({apiChecks,browserChecks,originalsUnchanged:true,workerReadOnly:true,unknownMonthlyExcluded:true,syntheticOnly:true,emailsSent:0}));console.log(JSON.stringify({apiChecks}));
}finally{await app.close();await pool.end();await owner.end();}

async function browserProof(){
 const {chromium,expect}=await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
 const origin=await app.listen({host:'127.0.0.1',port:0}),net=await import('node:net'),probe=net.createServer();
 await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));const base=`http://127.0.0.1:${port}`;
 const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{cwd:'../../apps/web',env:{...process.env,PULSE_API_URL:origin,NODE_ENV:'production'},stdio:'ignore'});let browser;
 try{
  for(let i=0;i<100;i++){try{if((await fetch(base+'/login')).ok)break;}catch{}await delay(250);if(i===99)throw Error('Reconciliation web did not start');}
  browser=await chromium.launch({headless:true});
  for(const width of [390,1440])for(const theme of ['light','dark']){
   const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme,extraHTTPHeaders:{'cf-access-authenticated-user-email':emails.member}});await context.addInitScript(t=>localStorage.setItem('pulse.theme',t),theme);const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+'/me?tab=attendance&section=Needs%20checking%20%26%20baseline');
   const panel=page.locator('#main-content [data-attendance-reconciliation]:visible').first();await expect(panel).toBeVisible();await expect(panel).toContainText('Automatic closure is off');await expect(panel).toContainText('Current 28-day baseline');await expect(panel).toContainText('2 accepted comparable days');await expect(panel).toContainText('Minimum 10 days');await expect(page.locator('html')).toHaveAttribute('data-theme',theme);browserChecks+=6;
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));assert.equal(errors.length,0);browserChecks+=2;
   // Dismiss the synthetic review notifications through their real controls before capturing the panel.
   await page.waitForTimeout(500);
   for(let i=0;i<20;i++){
    const ping=page.getByRole('button',{name:'Dismiss notification',exact:true}).first();
    if(await ping.isVisible()){await ping.click();continue;}
    const review=page.getByRole('button',{name:'Dismiss',exact:true}).first();
    if(!await review.count())break;
    // Both notices are non-modal. Keyboard activation remains available if a newly arrived ping overlaps it.
    await review.press('Enter');
   }
   await panel.screenshot({path:join(dirname(process.env.PULSE_RECONCILIATION_REPORT),`reconciliation-${width}-${theme}.png`)});
   await panel.locator('summary').click();const monthly=panel.locator('[data-monthly-hours]');await monthly.scrollIntoViewIfNeeded();await expect(monthly).toBeVisible();browserChecks++;
   await monthly.screenshot({path:join(dirname(process.env.PULSE_RECONCILIATION_REPORT),`reconciliation-monthly-${width}-${theme}.png`)});
   await context.close();
  }
 }finally{await browser?.close();server.kill('SIGTERM');}
}
