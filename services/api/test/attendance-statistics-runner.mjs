import assert from 'node:assert/strict';
import {enableAttendanceForWebFixture} from './attendance-enabled-web-fixture.mjs';
import {Pool} from 'pg';
import {createApp} from '../dist/app.js';
import {attendanceStatistics,attendanceSummary} from '../dist/attendance-statistics.js';
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),owner=new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
const app=createApp(pool,pool),id=process.env.TEST_MEMBER_ID,org=process.env.PULSE_ORG_ID;enableAttendanceForWebFixture(app);
let apiChecks=0,browserChecks=0;const eq=(a,b,msg)=>{apiChecks++;assert.deepEqual(a,b,msg);};
const call=async(path,role='member',body,expected=200)=>{apiChecks++;const r=await app.inject({url:'/api/v0/'+path,method:body===undefined?'GET':'POST',headers:{'cf-access-authenticated-user-email':role==='member'?process.env.TEST_MEMBER:'hr@estateautopilots.com'},...(body===undefined?{}:{payload:body})});assert.equal(r.statusCode,expected,`${path}: ${r.body}`);return r.json();};
const own=async(sql,params=[])=>{const c=await owner.connect();try{await c.query('begin');await c.query("select set_config('pulse.org_id',$1,true)",[org]);const r=await c.query(sql,params);await c.query('commit');return r.rows;}catch(e){await c.query('rollback');throw e;}finally{c.release();}};
await own('select pulse.hr_defaults()');await own('update pulse.hr_policy set attendance_enabled=true');
const shift=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
let browser,server;
try{
 const today=(await call('hr/policy')).today,base=shift(today,-12),rows=[];
 const add=async(offset,start,end,extra={})=>{const date=shift(base,offset);const input={in:`${date}T${start}:00+05:30`,out:`${date}T${end}:00+05:30`,...extra};const result=await own("insert into pulse.attendance_entry(org_id,person_id,work_date,checked_in_at,checked_out_at,missed_out) values($1,$2,$3,$4,$5,$6) returning id",[org,id,date,input.in,input.out,input.missedOut??false]);const row={id:result[0].id,personId:id,date,missedOut:input.missedOut??false,in:input.in,out:input.out,breaks:[],worked:Math.max(0,Math.round((Date.parse(input.out)-Date.parse(input.in))/60000)),pendingCorrection:input.pendingCorrection??false};rows.push(row);return row;};
 await add(0,'09:00','04:00',{out:`${shift(base,2)}T04:00:00+05:30`});
 await add(2,'09:00','13:00');await add(2,'12:00','16:00');
 await add(3,'22:00','06:00',{out:`${shift(base,4)}T06:00:00+05:30`});
 await add(4,'09:00','12:00');await add(4,'13:00','16:00');
 const withBreak=await add(5,'09:00','17:00');const overlapBreak=await add(6,'09:00','17:00');const outsideBreak=await add(7,'09:00','17:00');
 const br=async(row,start,end)=>{const b={in:`${row.date}T${start}:00+05:30`,out:`${row.date}T${end}:00+05:30`};await own('insert into pulse.attendance_break(org_id,entry_id,person_id,started_at,ended_at) values($1,$2,$3,$4,$5)',[org,row.id,id,b.in,b.out]);row.breaks.push(b);row.worked-=Math.round((Date.parse(b.out)-Date.parse(b.in))/60000);};
 await br(withBreak,'12:00','13:00');await br(overlapBreak,'12:00','14:00');await br(overlapBreak,'13:00','15:00');await br(outsideBreak,'08:00','09:00');
 await add(8,'09:00','09:00',{missedOut:true});await add(9,'09:00','17:00',{pendingCorrection:true});await add(10,'09:00','17:00');
 const pending=await call('hr/regularisations','member',{kind:'missed_punch',date:shift(base,9),inTime:'09:00',outTime:'17:00',reason:'Synthetic correction awaiting review'});
 const original=await own('select id,checked_in_at,checked_out_at,missed_out from pulse.attendance_entry where person_id=$1 order by id',[id]);
 const originalBreaks=await own('select * from pulse.attendance_break where person_id=$1 order by id',[id]);
 const stats=attendanceStatistics(rows);eq([...stats.days.values()].filter(d=>d.eligible).length,4);
 const months=[...new Set(rows.map(r=>r.date.slice(0,7)))];
 for(const month of months){const self=await call('hr/self?month='+month),profile=await call(`hr/person/${id}?month=${month}`,'hr'),team=await call('hr/attendance?month='+month,'hr');const person=team.people.find(p=>p.id===id),expected=attendanceSummary([...stats.days.values()].filter(d=>d.date.startsWith(month)),self.month.from,self.month.to);
  for(const [key,value] of Object.entries(expected)){eq(self.month.summary[key],value,'self '+key);eq(profile.month.summary[key],value,'profile '+key);eq(person.summary[key],value,'team '+key);}
  for(const d of self.month.days.filter(d=>d.attendance)){eq(d.attendance,stats.days.get(`${id}:${d.date}`),'day '+d.date);}
  const empty=team.people.find(p=>p.id===process.env.TEST_EMPTY_ID);eq(empty.summary.averageMinutes,null);eq(empty.summary.coverage,null);eq(empty.summary.eligibleDays,0);
 }
 await call('hr/attendance','member',undefined,403);await call('hr/desk','member',undefined,403);
 const desk=await call('hr/desk','hr'),expected=attendanceSummary([...stats.days.values()],shift(today,-13),today);eq(desk.attendance,expected,'dashboard parity');assert.ok(desk.anomalies.some(a=>a.personId===id&&a.date===base&&a.type==='statistics_excluded'));
 eq(await own('select id,checked_in_at,checked_out_at,missed_out from pulse.attendance_entry where person_id=$1 order by id',[id]),original,'reads preserve punches');eq(await own('select * from pulse.attendance_break where person_id=$1 order by id',[id]),originalBreaks,'reads preserve breaks');
 // An active roster timer uses all recorded session minutes; eligibility totals include closed days only.
 await own("insert into pulse.attendance_entry(org_id,person_id,work_date,checked_in_at) values($1,$2,(now() at time zone 'Asia/Kolkata')::date,now()-interval '30 minutes')",[org,process.env.TEST_EMPTY_ID]);
 const active=(await call('hr/desk','hr')).people.find(p=>p.id===process.env.TEST_EMPTY_ID);eq(active.status,'in');eq(active.attendance.recordedMinutes,0);eq(active.sessions[0].worked,30);
 if(process.env.PULSE_AUTH_BROWSER==='1'){
  // Mark this disposable tenant's setup notifications read so transient notices cannot obscure captures.
  await own('update pulse.notification set read_at=now() where org_id=$1',[org]);
  const {chromium,expect}=await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
  const origin=await app.listen({host:'127.0.0.1',port:0});const net=await import('node:net'),probe=net.createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));const baseUrl=`http://127.0.0.1:${port}`;
  server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{cwd:'../../apps/web',env:{...process.env,PULSE_API_URL:origin,NODE_ENV:'production'},stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(baseUrl+'/login')).ok)break;}catch{}await delay(250);if(i===99)throw Error('Attendance web did not start');}
  browser=await chromium.launch({headless:true});
  for(const width of [390,1440])for(const theme of ['light','dark']){
   for(const role of ['member','hr']){const ctx=await browser.newContext({viewport:{width,height:900},colorScheme:theme,extraHTTPHeaders:{'cf-access-authenticated-user-email':role==='member'?process.env.TEST_MEMBER:'hr@estateautopilots.com'}});await ctx.addInitScript(t=>localStorage.setItem('pulse.theme',t),theme);const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    const month=base.slice(0,7);await page.goto(baseUrl+(role==='member'?`/me?tab=attendance&section=Your%20month&month=${month}`:`/hr?tab=attendance&view=totals&month=${month}`));const coverage=page.locator('[data-attendance-statistics]').first();await expect(coverage).toContainText('eligible');await expect(coverage).toContainText('flagged sessions');await expect(coverage).toContainText('Provisional');browserChecks+=3;await expect(page.locator('html')).toHaveAttribute('data-theme',theme);browserChecks++;
    if(process.env.PULSE_ATTENDANCE_REPORT){/* The card re-renders as its data settles ("Element is not attached to the DOM" mid-screenshot): wait for it to be stable and take it again. */const path=join(dirname(process.env.PULSE_ATTENDANCE_REPORT),`attendance-${role}-${width}-${theme}.png`);await expect(async()=>{await coverage.waitFor({state:'visible',timeout:5000});await coverage.screenshot({path,timeout:5000,animations:'disabled'})}).toPass({timeout:30000})};
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'page fits '+width);browserChecks++;assert.equal(errors.length,0);browserChecks++;
    if(role==='member'){await page.goto(baseUrl+`/me?tab=attendance&section=Day%20by%20day&month=${shift(base,9).slice(0,7)}`);await expect(page.getByText('Correction awaiting a decision',{exact:false}).first()).toBeVisible();await page.getByRole('button',{name:'Request correction',exact:true}).first().click();await expect(page.getByRole('dialog')).toBeVisible();browserChecks+=2;}
    // Owner workbench (21 Oct 2026): the team's averages moved from HR desk's day view to Attendance → Totals (checked
    // above); the day view keeps who is in.
    if(role==='hr')for(const path of [`/people/${id}?tab=attendance&month=${month}`,'/hr?tab=attendance&view=today']){
     await page.goto(baseUrl+path);if(!path.includes('view=today')){const shared=page.locator('[data-attendance-statistics]').first();await expect(shared).toContainText('flagged sessions');await expect(shared).toContainText('Provisional');browserChecks+=2;}
     assert.equal(errors.length,0);browserChecks++;
     if(path.includes('view=today')){const who=page.locator('li').filter({has:page.locator(`a[href="/people/${process.env.TEST_EMPTY_ID}?tab=attendance"]`)}).first(),text=await who.innerText(),elapsed=text.match(/(\d+) min so far/);assert.ok(elapsed&&Number(elapsed[1])>=30,`open-session minutes should be at least 30: ${text}`);browserChecks+=2;}
    }
    await ctx.close();
   }
  }
 }
 // Reuse the accepted HR correction engine: it alone may reconcile a record after review.
 await call('hr/regularisations/'+pending.id,'hr',{decision:'approved',note:'Synthetic acceptance decision'});
 const corrected=await call('hr/self?month='+shift(base,9).slice(0,7));eq(corrected.month.days.find(d=>d.date===shift(base,9)).attendance.eligible,true);
 const report={apiChecks,browserChecks,originalsUnchanged:true,syntheticOnly:true,emailsSent:0,fixtures:['43 hours','overlapping sessions','valid overnight','multiple same-day punches','valid break','overlapping breaks','break outside session','missed out','pending correction','zero eligible days'],correctionEngineReused:true};
 if(process.env.PULSE_ATTENDANCE_REPORT)await writeFile(process.env.PULSE_ATTENDANCE_REPORT,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser?.close();server?.kill('SIGTERM');await app.close();await pool.end();await owner.end();}
