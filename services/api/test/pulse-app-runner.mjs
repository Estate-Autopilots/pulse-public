// R15d on a disposable database: the Pulse window's web session (tied to its device and revoked with it), app
// feedback (own or app team only), the tester list, devices & tracking health for admin/leadership only, and a test
// office that applies only to its named people. Synthetic identities only.
import assert from 'node:assert/strict';import {Pool} from 'pg';import {writeFile} from 'node:fs/promises';import {randomBytes} from 'node:crypto';import {createApp} from '../dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),owner=new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG)),app=createApp(pool,pool);const roles=JSON.parse(process.env.TEST_ROLES);
let checks=0;const receipts=[];
const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;receipts.push({label,passed:true});};
const ok=(v,label)=>{assert.ok(v,label);checks++;receipts.push({label,passed:true});};
async function call(path,body,{role='person',token,session,ip,anonymous=false}={}){
 const headers=anonymous?{}:token?{authorization:'Bearer '+token}:session?{'x-pulse-session':session}:{'cf-access-authenticated-user-email':role+'@app.example'};if(ip)headers['x-pulse-client-ip']=ip;
 const r=await app.inject({url:'/api/v0/'+path,method:body===undefined?'GET':'POST',headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'})},payload:body===undefined?undefined:JSON.stringify(body)});
 let data=null;try{data=r.json();}catch{data=r.body;}return {status:r.statusCode,data,raw:r};
}
async function own(sql,args=[]){const c=await owner.connect();try{await c.query('begin');await c.query('set local role pulse_owner');await c.query("select set_config('pulse.org_id',$1,true)",[process.env.PULSE_ORG_ID]);const r=await c.query(sql,args);await c.query('commit');return r.rows;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
await own('select pulse.hr_defaults()');await own('update pulse.hr_policy set attendance_enabled=true');
// Today is a working day whatever day CI runs (check-in refuses a weekly off): no change Monday to Saturday.
await own("update pulse.hr_policy set work_days=array(select distinct d from unnest(work_days||extract(isodow from now() at time zone 'Asia/Kolkata')::int) d order by d)");
async function pair(role,platform){
 const start=(await call('native/pair/start',{platform,name:`Synthetic ${platform}`},{anonymous:true})).data;
 await call('native/pair/decide',{code:start.code,approve:true},{role});
 return (await call('native/pair/poll',{pairId:start.pairId,pollSecret:start.pollSecret},{anonymous:true})).data;
}
for(const role of ['person','admin'])await own("insert into pulse.login_credential(org_id,person_id,password_hash,must_change,status) values($1,$2,crypt($3,gen_salt('bf',4)),false,'active') on conflict do nothing",[process.env.PULSE_ORG_ID,roles[role],randomBytes(24).toString('base64url')]);

// 1. The Pulse window session.
const laptop=await pair('person','macos');ok(/^[A-Za-z0-9_-]{43}$/.test(laptop.accessToken),'the laptop is paired');
const phone=await pair('person','android');
eq((await call('native/web-session',{},{role:'person'})).status,403,'a browser session cannot mint a window session');
eq((await call('native/web-session',{},{token:phone.accessToken})).status,403,'phones do not get a desktop window session');
const web=await call('native/web-session',{},{token:laptop.accessToken});
eq(web.status,200,'a paired laptop opens its Pulse window without a second sign-in');ok(/^[A-Za-z0-9_-]{43}$/.test(web.data.token)&&web.data.maxAge===2592000,'a 30-day window session');
eq((await call('me',undefined,{session:web.data.token})).data.person,roles.person,'the window session is the same person');
const sessions=(await own("select device,native_device_id from pulse.login_session where person_id=$1 and revoked_at is null",[roles.person]));
ok(sessions.some(s=>s.native_device_id===laptop.deviceId&&s.device.startsWith('Pulse app ·')),'Account → Security lists it as the Pulse app on that computer');
const again=await call('native/web-session',{},{token:laptop.accessToken});
eq((await call('me',undefined,{session:web.data.token})).status,401,'a new window session ends the previous one');
eq((await call('me',undefined,{session:again.data.token})).status,200,'the newest window session works');
eq((await call(`devices/${laptop.deviceId}/revoke`,{},{token:laptop.accessToken})).status,200,'signing the laptop out revokes its device');
eq((await call('me',undefined,{session:again.data.token})).status,401,'revoking the device ends its window session too');
eq((await call('native/web-session',{},{token:laptop.accessToken})).status,401,'a revoked device cannot open a window');

// 2. Feedback.
const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),randomBytes(64)]).toString('base64');
const desk=await pair('person','windows');
const sent=await call('feedback',{text:'The new panel is lovely',screenshot:`data:image/png;base64,${png}`,appVersion:'1.0.0',page:'desktop-settings'},{token:desk.accessToken});
eq(sent.status,200,'feedback with a screenshot from the Windows app');
eq((await call('feedback',{text:' '},{token:desk.accessToken})).status,400,'empty feedback refused');
eq((await call('feedback',{text:'x',screenshot:'data:text/html;base64,PGgxPg=='},{token:desk.accessToken})).status,400,'only real images are accepted');
eq((await call('feedback',{text:'From the browser',platform:'web'})).status,200,'feedback from the web');
eq((await call('feedback',undefined)).status,403,'members cannot read the team feedback list');
eq((await call('feedback',undefined,{token:desk.accessToken})).status,403,'a device credential cannot read feedback');
const list=(await call('feedback',undefined,{role:'admin'})).data.rows;
ok(list.some(f=>f.body==='The new panel is lovely'&&f.platform==='windows'&&f.hasScreenshot&&f.appVersion==='1.0.0'),'the app team sees it with platform, version and screenshot flag');
const shot=await call(`feedback/${sent.data.id}/screenshot`,undefined,{role:'admin'});
eq(shot.status,200,'the team can open the screenshot');eq(shot.raw.headers['content-type'],'image/png','as the image it is');
eq((await call(`feedback/${sent.data.id}/screenshot`,undefined,{role:'outsider'})).status,403,'others cannot');
eq((await call(`feedback/${sent.data.id}/status`,{status:'done'},{role:'admin'})).status,200,'the team marks it done');
const pings=(await own("select count(*)::int n from pulse.notification where person_id=$1 and title like 'New Pulse app feedback%'",[roles.admin]))[0].n;
ok(pings>=2,'admins get an inbox item for new feedback');

// 3. Testers.
eq((await call('testers',{personId:roles.outsider,platforms:['macos','android']})).status,403,'members cannot invite testers');
eq((await call('testers',{personId:roles.outsider,platforms:['toaster']},{role:'admin'})).status,400,'unknown platform refused');
eq((await call('testers',{personId:roles.outsider,platforms:['macos','android'],note:'Leadership pilot'},{role:'admin'})).status,200,'admin invites a tester');
const testers=(await call('testers',undefined,{role:'admin'})).data;
ok(testers.testers.some(t=>t.personId===roles.outsider&&t.platforms.includes('macos')&&t.note==='Leadership pilot'),'the tester list shows platforms and note');
ok(testers.people.length>=3,'the invite list offers staff');
eq((await call(`testers/${roles.outsider}/remove`,{},{role:'admin'})).status,200,'and can remove a tester');

// 4. Devices & tracking health.
eq((await call('devices/health')).status,403,'members cannot see others’ devices');
eq((await call('devices/health',undefined,{token:desk.accessToken})).status,403,'device credentials cannot either');
await call(`devices/${desk.deviceId}/health`,{health:'healthy',appVersion:'1.0.0',capabilities:{push:'healthy'}},{token:desk.accessToken});
await call('attendance/check-in',{mode:'office',via:'desktop'},{token:desk.accessToken});
const health=(await call('devices/health',undefined,{role:'admin'})).data;
const row=health.devices.find(d=>d.deviceId===desk.deviceId);
ok(row,'admin sees the person’s Windows app');eq([row.platform,row.appVersion,row.connected,row.attendance],['windows','1.0.0','connected','working'],'connected, version and attendance from the app');
eq(row.activity.state,'off','work activity off');ok(['Not opted in','Notice not published'].includes(row.activity.why),'and says why');
ok(!health.devices.some(d=>d.deviceId===laptop.deviceId),'revoked devices are not listed');
ok(!JSON.stringify(health).match(/"(data|body|lat|lng|ssid|bssid)"/),'no activity contents, messages or locations');

// 5. A test office applies only to its people.
await own("insert into pulse.presence_office(org_id,name,lat,lng,radius_m,wifi,public_ip_ranges,audience) values($1,'Synthetic test office',28.5,77.1,150,$2,'{203.0.113.0/24}',$3)",[process.env.PULSE_ORG_ID,JSON.stringify([{ssid:'Synth-Test',bssids:['a4:2b:b0:aa:bb:cc']}]),[roles.person]]);
const mine=(await call('companion',undefined,{token:desk.accessToken})).data.presence;
ok(mine.offices.some(o=>o.name==='Synthetic test office'&&o.test),'the test office reaches its person');eq(mine.autoCheckIn,true,'and allows trying automatic check-in');
const outsider=await pair('outsider','windows');
const theirs=(await call('companion',undefined,{token:outsider.accessToken})).data.presence;
ok(!theirs.offices.some(o=>o.name==='Synthetic test office'),'nobody else sees it');
const p=await call('companion/presence',{consent:true,autoConsent:true,wifi:{ssid:'Synth-Test',bssid:'a4:2b:b0:aa:bb:cc'}},{token:outsider.accessToken,ip:'203.0.113.9'});
eq([p.status,p.data.score],[200,0],'its Wi-Fi and IP count for nobody else');
const q=await call('companion/presence',{consent:true,autoConsent:true,wifi:{ssid:'Synth-Test',bssid:'a4:2b:b0:aa:bb:cc'}},{token:desk.accessToken,ip:'203.0.113.9'});
eq(q.status,200,'the laptop reports office Wi-Fi');ok(q.data.score>=65,'access point and office IP together are strong evidence');
const hr=(await call('hr/presence',undefined,{role:'hr'})).data;
ok(hr.offices.some(o=>o.name==='Synthetic test office'&&o.testFor?.length===1),'HR sees it marked as a test office');

// 6. Time wallet, your day, and late-mark protection: the person's own data only.
const w=await call('companion/wallet',undefined,{token:desk.accessToken});
eq(w.status,200,'the time wallet answers the person');ok(Array.isArray(w.data.wallet.balances),'leave balances are listed');
ok(w.data.day&&w.data.day.workedMinutes>=0&&w.data.day.office==='Synthetic test office','today is written up, with the office Pulse saw');
ok(!JSON.stringify(w.data).includes(roles.outsider),'nobody else’s data');
if(!w.data.late)eq((await call('companion/late-dispute',{},{token:desk.accessToken})).status,400,'without a late mark there is nothing to dispute');
else ok(w.data.late.disputable===false||typeof w.data.late.arrivedAt==='string','a late mark carries Pulse’s own office evidence');
eq((await call('companion/wallet',undefined,{token:outsider.accessToken})).data.day,null,'someone who has not checked in has no day yet');
await writeFile(process.env.TEST_REPORT,JSON.stringify({checks,receipts},null,2));
await pool.end();await owner.end();console.log(`pulse app: ${checks} checks passed`);
