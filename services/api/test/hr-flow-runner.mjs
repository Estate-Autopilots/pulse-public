import assert from 'node:assert/strict';
import {enableAttendanceForWebFixture} from './attendance-enabled-web-fixture.mjs';
import {Pool} from 'pg';
import {createApp} from '../dist/app.js';
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),owner=new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
const app=createApp(pool,pool);let apiChecks=0,browserChecks=0;enableAttendanceForWebFixture(app);
const emails={member:process.env.TEST_MEMBER,head:'head@hrflow.example.test',hr:'hr@estateautopilots.com',co:'admin@estateautopilots.com'};
const ids={member:process.env.TEST_MEMBER_ID,head:process.env.TEST_HEAD_ID,hr:process.env.TEST_HR_ID,co:process.env.TEST_CO_ID};
const call=async(path,body,role='member',expected=200)=>{
 apiChecks++;const r=await app.inject({url:'/api/v0/'+path,method:body===undefined?'GET':'POST',headers:{'cf-access-authenticated-user-email':emails[role]},...(body===undefined?{}:{payload:body})});
 assert.equal(r.statusCode,expected,`${role} ${path}: ${r.body}`);return r.json();
};
const own=async(sql,params=[])=>{const c=await owner.connect();try{await c.query('begin');await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id','',true)",[process.env.PULSE_ORG_ID]);const r=await c.query(sql,params);await c.query('commit');return r.rows;}catch(e){await c.query('rollback');throw e;}finally{c.release();}};
await own('select pulse.hr_defaults()');await own('update pulse.hr_policy set attendance_enabled=true');
const shift=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const flow=async(sourceId,role='member')=>(await call('hr/flows',undefined,role)).rows.find(f=>f.sourceId===sourceId);
try{
 const today=(await call('hr/policy')).today;
 let monday=shift(today,7);while(new Date(monday+'T00:00:00Z').getUTCDay()!==1)monday=shift(monday,1);
 await call('hr/flow-settings',undefined,'member',403);
 await call('hr/flow-settings',{max_leave_days:3,comp_credit:1,comp_expiry_days:30,reminder_hours:24},'hr');
 await call('hr/pod-heads',{name:'Pod 1',headId:ids.head,members:[ids.member,ids.head]},'member',403);
 await call('hr/pod-heads',{name:'Pod 1',headId:ids.head,members:[ids.member,ids.head]},'hr');
 await call('hr/cofounders',{personId:ids.co},'hr');
 const setup=await call('hr/flow-settings',undefined,'hr');assert.equal(setup.pods[0].headId,ids.head);
 await call('hr/leave-adjustments',{personId:ids.member,kind:'annual',days:10,reason:'Synthetic opening allowance'},'hr');
 const normal=await call('leave',{kind:'annual',fromDate:monday,toDate:monday,reason:'Within policy'});
 let f=await flow(normal.id);assert.equal(f.stage,'pod_head');assert.equal(f.needsHr.length,0);
 await call(`hr/flows/${f.id}/decision`,{action:'approved'},'member',403);
 assert.ok((await call('hr/flows',undefined,'head')).rows.find(q=>q.id===f.id).canDecide);
 await call(`hr/flows/${f.id}/decision`,{action:'approved'},'head');
 await call(`hr/flows/${f.id}/decision`,{action:'rejected'},'hr',400);
 await call(`hr/flows/${f.id}/decision`,{action:'rejected',note:'HR override with a reason'},'hr');
 f=await flow(normal.id);assert.equal(f.status,'rejected');assert.ok(f.history.some(h=>h.note==='HR override with a reason'));
 const unpaid=await call('leave',{kind:'unpaid',fromDate:shift(monday,1),toDate:shift(monday,1),reason:'private emergency note'});
 f=await flow(unpaid.id);assert.equal(f.stage,'hr');assert.ok(f.needsHr.includes('unpaid leave'));
 await call(`leave/${unpaid.id}/decision`,{decision:'approved'},'head',403);
 await call(`hr/flows/${f.id}/decision`,{action:'forward',note:'Please decide this exception'},'head',403);
 await call(`hr/flows/${f.id}/decision`,{action:'forward',note:'Please decide this exception'},'hr');
 await call(`hr/flows/${f.id}/decision`,{action:'approved',note:'HR cannot decide after forwarding'},'hr',403);
 await call(`hr/flows/${f.id}/decision`,{action:'ask',note:'Please confirm the dates'},'co');
 await call(`hr/flows/${f.id}/decision`,{action:'reply',note:'These dates are confirmed'},'member');
 await call(`hr/flows/${f.id}/decision`,{action:'approved',note:'Approved by co-founder'},'co');
 assert.equal((await flow(unpaid.id)).history.at(-1).by,'Pod Manager');
 const extra=await call('leave',{kind:'sick',fromDate:shift(monday,2),toDate:shift(monday,5),reason:'Beyond current balance'});f=await flow(extra.id);assert.ok(f.needsHr.includes('beyond balance'));assert.ok(f.needsHr.includes('long leave'));await call(`hr/flows/${f.id}/decision`,{action:'rejected',note:'Synthetic extra leave declined'},'hr');
 const special=await call('leave',{kind:'annual',fromDate:shift(monday,8),toDate:shift(monday,8),reason:'Emergency',special:true});f=await flow(special.id);assert.equal(f.stage,'hr');assert.ok(f.needsHr.includes('special or emergency leave'));
 const headOwn=await call('leave',{kind:'annual',fromDate:monday,toDate:monday,reason:'Head own'},'head');f=await flow(headOwn.id,'head');assert.equal(f.stage,'hr');
 await call(`leave/${headOwn.id}/decision`,{decision:'approved'},'member',403);
 await call(`hr/flows/${f.id}/decision`,{action:'approved'},'head',403);
 const hrOwn=await call('leave',{kind:'annual',fromDate:monday,toDate:monday,reason:'HR own'},'hr');f=await flow(hrOwn.id,'hr');assert.equal(f.stage,'cofounder');await call(`hr/flows/${f.id}/decision`,{action:'approved'},'hr',403);await call('hr/cofounders',{personId:ids.member},'hr');await call(`hr/flows/${f.id}/decision`,{action:'approved'},'member');
 const coCorrection=await call('hr/regularisations',{kind:'missed_punch',date:shift(today,-3),inTime:'10:00',outTime:'19:00',reason:'HR own attendance correction'},'hr');f=await flow(coCorrection.id,'hr');assert.equal(f.stage,'cofounder');await call(`hr/flows/${f.id}/decision`,{action:'approved'},'member');assert.ok((await call('hr/self?month='+shift(today,-3).slice(0,7),undefined,'hr')).month.days.find(d=>d.date===shift(today,-3)).entry);
 const payroll=await call('hr/tickets',{category:'payroll',subject:'Salary-affecting request',body:'Please review payroll'});f=await flow(payroll.id);assert.equal(f.stage,'hr');assert.ok(f.needsHr.includes('salary affecting'));await call(`hr/flows/${f.id}/decision`,{action:'forward',note:'Please review salary impact'},'hr');await call(`hr/tickets/${payroll.id}`,{status:'closed'},'hr',403);await call(`hr/flows/${f.id}/decision`,{action:'rejected',note:'Not approved'},'co');assert.equal((await flow(payroll.id)).status,'rejected');
 const correction=await call('hr/regularisations',{kind:'missed_punch',date:shift(today,-1),inTime:'10:00',outTime:'19:00',reason:'Synthetic missed attendance'});f=await flow(correction.id);assert.equal(f.stage,'pod_head');await call(`hr/flows/${f.id}/decision`,{action:'approved'},'head');assert.equal((await call('hr/self')).regularisations.find(r=>r.id===correction.id).status,'approved');
 await call(`hr/flows/${f.id}/decision`,{action:'rejected',note:'HR reverses incorrect attendance'},'hr');
 const undone=await call('hr/self?month='+shift(today,-1).slice(0,7));assert.equal(undone.month.days.find(d=>d.date===shift(today,-1)).entry,null);
 await call(`hr/flows/${f.id}/decision`,{action:'approved',note:'HR restores the correction'},'hr');
 await call('hr/holidays',{day:today,name:'Synthetic holiday'},'hr');
 await call('attendance/check-in',{},'member',403);
 const work=await call('hr/work-days',{day:today,note:'I will work today'});await call('hr/work-days',{day:today},'member',409);
 await call(`hr/flows/${work.id}/decision`,{action:'approved'},'member',403);
 await call(`hr/flows/${work.id}/decision`,{action:'approved'},'head');
 const offCompanion=await call('companion');assert.equal(offCompanion.shift.workingDay,true);assert.equal(offCompanion.state,'out');await call('attendance/check-in',{});await call('attendance/check-out',{});await call('attendance/check-in',{});await call('attendance/check-out',{});
 const cal=await call('hr/work-calendar');assert.equal(cal.credits.length,1);assert.equal(cal.credits[0].remaining,1);assert.equal(cal.days[0].working,true);
 assert.equal((await call('hr/self')).month.days.find(d=>d.date===today).status,'present');
 const comp=await call('leave',{kind:'comp_off',fromDate:shift(monday,3),toDate:shift(monday,3),reason:'Use earned comp-off'});f=await flow(comp.id);await call(`hr/flows/${f.id}/decision`,{action:'approved'},'head');assert.equal((await call('hr/work-calendar')).credits[0].remaining,0);
 await call('leave',{kind:'comp_off',fromDate:shift(monday,4),toDate:shift(monday,4),reason:'Credit already consumed'},'member',400);
 await call(`hr/flows/${f.id}/decision`,{action:'cancelled'},'member');assert.equal((await call('hr/work-calendar')).credits[0].remaining,1);
 await call('leave',{kind:'comp_off',fromDate:shift(today,100),toDate:shift(today,100),reason:'Expired credit'},'member',400);
 const equipment=await call('hr/tickets',{category:'equipment',subject:'A spare monitor',body:'Within pod'});f=await flow(equipment.id);await call(`hr/flows/${f.id}/decision`,{action:'approved',note:'Pod head approved'},'head');assert.equal((await flow(equipment.id)).status,'approved');
 const sunday=shift(monday,6),patternStart=shift(monday,14);
 const sun=await call('hr/work-days',{day:sunday,note:'Sunday work'});assert.equal((await call('hr/flows')).rows.find(q=>q.id===sun.id).stage,'pod_head');await call(`hr/flows/${sun.id}/decision`,{action:'approved'},'head');
 await call('hr/work-patterns',{personId:ids.member,workDays:[2,3,4,5,6,7],fromDate:patternStart,toDate:shift(patternStart,30),reason:'Regular Sunday pattern'},'member',403);
 await call('hr/work-patterns',{personId:ids.member,workDays:[2,3,4,5,6,7],fromDate:patternStart,toDate:shift(patternStart,30),reason:'Regular Sunday pattern'},'hr');
 const pc=await call('hr/work-calendar');assert.equal(pc.days.find(d=>d.day===patternStart).working,false);assert.equal(pc.days.find(d=>d.day===shift(patternStart,6)).working,true);
 await call('hr/work-days',{day:shift(patternStart,6)},'member',400);
 await call('hr/holidays',{day:shift(patternStart,7),name:'Holiday on moved off'},'hr');
 const after=await call('hr/self?month='+patternStart.slice(0,7));assert.equal(after.month.days.find(d=>d.date===patternStart).status,'off');
 const regularMonth=await call('hr/attendance?month='+patternStart.slice(0,7),undefined,'hr');assert.equal(regularMonth.people.find(p=>p.id===ids.member).days[Number(patternStart.slice(8))-1].status,'off');
 await own("update pulse.hr_flow set updated_at=now()-interval '25 hours' where status='pending'");
 // ATT (0860): the reminder is one daily digest per approver, sent on a working day after 10:30 company time. Today is
 // this run's synthetic holiday (above), which made it never fire: the holiday is marked optional for this check, and
 // outside the sending window the digest must wait (no reminder at all) instead of failing by the clock.
 await own("update pulse.holiday set optional=true where org_id=pulse.current_org() and day=$1::date and name='Synthetic holiday'",[today]);
 const sending=(await own(`select (clock_timestamp() at time zone pulse.org_time_zone(pulse.current_org()))::time>=time '10:30'
   and pulse.hr_working(null,(clock_timestamp() at time zone pulse.org_time_zone(pulse.current_org()))::date,(select work_days from pulse.hr_policy where org_id=pulse.current_org())) open`))[0].open;
 const remind=await own('select pulse.hr_flow_remind() count');assert.ok(sending?remind[0].count>0:remind[0].count===0,`digest ${remind[0].count} while ${sending?'sending':'waiting'}`);assert.equal((await own('select pulse.hr_flow_remind() count'))[0].count,0);
 if(sending){const outbox=await own('select count(*)::int n from pulse.hr_mail_outbox');assert.ok(outbox[0].n>0);}
 await call('hr/work-patterns',{personId:ids.head,workDays:[2,3,4,5,6,7],fromDate:today,toDate:shift(today,7),reason:'Current pattern preserves earlier calendar'},'hr');let pastSunday=shift(today,-1);while(new Date(pastSunday+'T00:00:00Z').getUTCDay()!==0)pastSunday=shift(pastSunday,-1);const historicHead=await call('hr/self?month='+pastSunday.slice(0,7),undefined,'head');assert.equal(historicHead.month.days.find(d=>d.date===pastSunday).status,'off');
 if(process.env.PULSE_AUTH_BROWSER==='1')await browserFlows(today,monday);
 const receipt=JSON.stringify({apiChecks,browserChecks,notificationSink:true});await writeFile(process.env.PULSE_HRFLOW_REPORT,receipt);if(process.env.PULSE_HRFLOW_RECEIPT)await writeFile(process.env.PULSE_HRFLOW_RECEIPT,receipt);
 console.log(JSON.stringify({apiChecks,browserChecks}));
}finally{await app.close();await pool.end();await owner.end();}
async function browserFlows(today,monday){
 const {chromium,expect}=await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
 const origin=await app.listen({host:'127.0.0.1',port:0});const net=await import('node:net');const probe=net.createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));
 const base=`http://127.0.0.1:${port}`,server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{cwd:'../../apps/web',env:{...process.env,PULSE_API_URL:origin,NODE_ENV:'production',PULSE_PUBLIC_LOGIN_ENABLED:'0'},stdio:'ignore'});
 let browser;const check=(condition,msg)=>{browserChecks++;assert.ok(condition,msg);};
 // Nothing runs sideways: a sub-pixel width from the runner's fonts is not overflow (1 px, as the other runners allow),
 // and a failure names what reaches past the window (it failed on GitHub runners only, with nothing to go on).
 const fits=async(page,msg)=>{const r=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,w:innerWidth,past:[...document.querySelectorAll('main *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>`${e.tagName.toLowerCase()}${e.getAttribute('aria-label')?`[${e.getAttribute('aria-label')}]`:''} ${(e.textContent||'').trim().slice(0,30)} → ${Math.round(e.getBoundingClientRect().right)}`).slice(0,5)}));check(r.sw<=r.w+1,`${msg}: ${r.sw} px wide in ${r.w}: ${r.past.join(' | ')}`);};
 try{
  for(let i=0;i<100;i++){try{if((await fetch(base+'/login')).ok)break;}catch{}await delay(250);if(i===99)throw Error('HR browser web did not start');}
  browser=await chromium.launch({headless:true});
  for(const width of [1440,390]){
   const contexts={};for(const role of ['member','head','hr','co'])contexts[role]=await browser.newContext({viewport:{width,height:900},extraHTTPHeaders:{'cf-access-authenticated-user-email':emails[role]}});
   try{
    const p=await contexts.member.newPage();await p.goto(base+'/me?tab=attendance');try{await p.getByRole('button',{name:'Work on a day off…'}).click();await expect(p.getByRole('heading',{name:'Working on a day off?'})).toBeVisible();}catch(e){console.error('Synthetic browser desk:',await p.locator('body').innerText());throw e;}await fits(p,'phone attendance fits');if(process.env.PULSE_HRFLOW_SCREENSHOTS)await p.screenshot({path:process.env.PULSE_HRFLOW_SCREENSHOTS+'/my-desk-'+width+'.png',fullPage:true});
    const widget=p.getByRole('dialog',{name:'Working on a day off?'});const btn=widget.getByRole('button',{name:/I'll work on/});const response=p.waitForResponse(r=>r.url().includes('/api/v0/hr/work-days')&&r.request().method()==='POST');await btn.click();check((await response).status()===200,'work request tap');
    await p.goto(base+'/me/approvals');await p.getByRole('button',{name:'My requests',exact:true}).click();check(await p.getByText('Nobody can decide their own request.',{exact:false}).count()>0,'self approval message');check(await p.locator('article').getByRole('button',{name:'Approve',exact:true}).count()===0,'own request has no approval button');
    const h=await contexts.head.newPage();await h.goto(base+'/me/approvals');await expect(h.getByRole('heading',{name:'Waiting for you',exact:true})).toBeVisible();browserChecks++;await fits(h,'head queue fits');
    const card=h.locator('article').filter({hasText:'Work on '}).first();await card.locator('summary').click();const approved=h.waitForResponse(r=>r.url().includes('/decision')&&r.request().method()==='POST');await card.getByRole('button',{name:'Approve',exact:true}).click();check((await approved).status()===200,'browser head approves');await expect(card).toHaveCount(0);
    const hr=await contexts.hr.newPage();await hr.goto(base+'/hr?tab=pods');await expect(hr.getByRole('button',{name:'Save pod assignments'})).toBeVisible();await fits(hr,'pod setup fits');
    await hr.getByRole('button',{name:'Save pod assignments'}).click();await expect(hr.getByText('Saved',{exact:true}).first()).toBeVisible();browserChecks++;
    await hr.goto(base+'/hr?tab=policies&view=approvals');await hr.getByRole('button',{name:'Save approval policy'}).click();await expect(hr.getByText('Saved',{exact:true})).toBeVisible();browserChecks++;await fits(hr,'policy fits');if(process.env.PULSE_HRFLOW_SCREENSHOTS)await hr.screenshot({path:process.env.PULSE_HRFLOW_SCREENSHOTS+'/policies-'+width+'.png',fullPage:true});
    await hr.goto(base+'/hr?tab=policies&view=patterns');await expect(hr.getByRole('button',{name:'Save working pattern'})).toBeVisible();browserChecks++;await hr.locator('select[name=personId]').selectOption(ids.member);await hr.locator('input[name=fromDate]').fill(shift(monday,35));await hr.locator('input[name=reason]').fill('Browser confirms regular Sunday pattern');const patterned=hr.waitForResponse(r=>r.url().endsWith('/hr/work-patterns')&&r.request().method()==='POST');await hr.getByRole('button',{name:'Save working pattern'}).click();check((await patterned).status()===200,'browser HR saves standing pattern');await fits(hr,'pattern phone form fits');
    await hr.goto(base+'/hr?tab=work-calendar');await expect(hr.getByRole('heading',{name:'Standing working patterns'})).toBeVisible();browserChecks++;
    const co=await contexts.co.newPage();const exception=await call('leave',{kind:'unpaid',fromDate:shift(monday,width===1440?10:11),toDate:shift(monday,width===1440?10:11),reason:'Browser exception'});const f=await flow(exception.id);
    await hr.goto(base+'/hr?tab=approvals');const exc=hr.locator('article[id="'+f.id+'"]');await exc.locator('summary').click();await exc.getByLabel('Decision note or question').fill('Please decide browser exception');const forwarded=hr.waitForResponse(r=>r.url().includes('/decision')&&r.request().method()==='POST');await exc.getByRole('button',{name:'Forward to co-founder'}).click();check((await forwarded).status()===200,'browser HR forwards');
    await co.goto(base+'/me/approvals?request='+f.id);const final=co.locator('article[id="'+f.id+'"]');await final.getByLabel('Decision note or question').fill('Co-founder browser approval');const decided=co.waitForResponse(r=>r.url().includes('/decision')&&r.request().method()==='POST');await final.getByRole('button',{name:'Approve',exact:true}).click();check((await decided).status()===200,'browser co-founder approves');await fits(co,'co-founder phone page fits');
    await hr.goto(base+'/hr?tab=approvals');await hr.getByRole('button',{name:'All visible requests',exact:true}).click();const over=hr.locator('article[id="'+f.id+'"]');await over.locator('summary').click();await over.getByLabel('Decision note or question').fill('HR override with browser reason');const overridden=hr.waitForResponse(r=>r.url().includes('/decision')&&r.request().method()==='POST');await over.getByRole('button',{name:'Override: reject',exact:true}).click();check((await overridden).status()===200,'browser HR override');
    await p.goto(base+'/me?tab=leave');await p.getByRole('button',{name:'Apply for leave',exact:true}).click();await expect(p.getByRole('dialog',{name:'Apply for leave'})).toBeVisible();await expect(p.locator('input[name=kind][value=comp_off]')).toHaveCount(1);browserChecks++;
    await p.locator('input[name=special]').check();browserChecks++;await p.locator('input[name=special]').uncheck();
    await p.locator('label',{has:p.locator('input[name=kind][value=comp_off]')}).click();await expect(p.locator('input[name=kind][value=comp_off]')).toBeChecked();const compDay=shift(monday,width===1440?3:4);await p.locator('input[name=fromDate]').fill(compDay);await p.locator('input[name=toDate]').fill(compDay);await p.locator('select[name=halfDay]').selectOption('first');await p.locator('textarea[name=reason]').fill('Browser earned comp-off');
    const applied=p.waitForResponse(r=>r.url().endsWith('/api/v0/leave')&&r.request().method()==='POST');await p.getByRole('button',{name:'Send request',exact:true}).click();const appliedResponse=await applied;check(appliedResponse.status()===200,'browser comp-off application');const appliedLeave=await appliedResponse.json();const cf=await flow(appliedLeave.id);
    await h.goto(base+'/me/approvals?request='+cf.id);const cc=h.locator('article[id="'+cf.id+'"]');const used=h.waitForResponse(r=>r.url().includes('/decision')&&r.request().method()==='POST');await cc.getByRole('button',{name:'Approve',exact:true}).click();check((await used).status()===200,'browser head approves comp-off');
    if(process.env.PULSE_HRFLOW_SCREENSHOTS){await co.screenshot({path:process.env.PULSE_HRFLOW_SCREENSHOTS+'/cofounder-'+width+'.png',fullPage:true});await hr.screenshot({path:process.env.PULSE_HRFLOW_SCREENSHOTS+'/approvals-'+width+'.png',fullPage:true});}

    await hr.goto(base+'/hr/help');await expect(hr.getByRole('heading',{name:'HR flow help'})).toBeVisible();browserChecks++;
   }finally{for(const c of Object.values(contexts))await c.close();}
  }
 }finally{await browser?.close();server.kill('SIGTERM');}
}
