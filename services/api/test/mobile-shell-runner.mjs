// MOBILE-SHELL on a disposable database: the phone app signs in with the normal web sign-in, then registers itself
// through the existing pairing model approved by that web session (no code typed). The device and the web session
// are bound: signing out of the web revokes the device, revoking the device ends the session. Synthetic only.
import assert from 'node:assert/strict';import {Pool} from 'pg';import {writeFile} from 'node:fs/promises';import {createApp} from '../dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),owner=new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG)),app=createApp(pool,pool);const roles=JSON.parse(process.env.TEST_ROLES);
let checks=0;const receipts=[];
const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;receipts.push({label,passed:true});};
const ok=(v,label)=>{assert.ok(v,label);checks++;receipts.push({label,passed:true});};
async function call(path,body,{token,session,role,anonymous=false}={}){
 const headers=anonymous?{}:token?{authorization:'Bearer '+token}:session?{'x-pulse-session':session}:{'cf-access-authenticated-user-email':(role??'person')+'@shell.example'};
 const r=await app.inject({url:'/api/v0/'+path,method:body===undefined?'GET':'POST',headers:{'x-pulse-client-ip':'198.51.100.70',...headers,...(body===undefined?{}:{'content-type':'application/json'})},payload:body===undefined?undefined:JSON.stringify(body)});
 let data=null;try{data=r.json();}catch{data=r.body;}return {status:r.statusCode,data};
}
async function own(sql,args=[]){const c=await owner.connect();try{await c.query('begin');await c.query('set local role pulse_owner');await c.query("select set_config('pulse.org_id',$1,true)",[process.env.PULSE_ORG_ID]);const r=await c.query(sql,args);await c.query('commit');return r.rows;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
const password='Synthetic shell harbour 2026!';
for(const role of ['person','other']){
 await own("update pulse.people_profile set username=$2 where person_id=$1",[roles[role],'shell.'+role]);
 await own("insert into pulse.login_credential(org_id,person_id,password_hash,must_change,status) values($1,$2,crypt($3,gen_salt('bf',4)),false,'active') on conflict do nothing",[process.env.PULSE_ORG_ID,roles[role],password]);
}
const signIn=async role=>{const r=await call('auth/sign-in',{username:'shell.'+role,password,remember:true},{anonymous:true});assert.equal(r.status,200,'sign-in '+role);return r.data.token;};
// What the shell does natively: ask for a pairing request (the poll secret never leaves the phone).
const start=async(platform='android')=>(await call('native/pair/start',{platform,name:'Pulse app · Synthetic phone'},{anonymous:true})).data;
const poll=async s=>(await call('native/pair/poll',{pairId:s.pairId,pollSecret:s.pollSecret},{anonymous:true})).data;

// 1. Sign in normally, then the page approves the shell's own request.
const web=await signIn('person');
eq((await call('me',undefined,{session:web})).data.person,roles.person,'the normal web sign-in works in the phone app');
const first=await start();
eq((await call('native/shell/enroll',{code:first.code},{role:'person'})).status,403,'an Access/browser identity without a phone sign-in cannot register a shell');
eq((await call('native/shell/enroll',{code:first.code,expectedPersonId:roles.other},{session:web})).status,403,'a changed web account cannot approve the former phone registration');
const enrolled=await call('native/shell/enroll',{code:first.code,expectedPersonId:roles.person},{session:web});
eq(enrolled.status,200,'the signed-in page registers its own phone app');eq(enrolled.data.status,'approved','approved without typing a code');
const tokens=await poll(first);
eq(tokens.status,'approved','the shell collects its device credential once');ok(/^[A-Za-z0-9_-]{43}$/.test(tokens.refreshToken)&&tokens.deviceId===enrolled.data.deviceId,'a rotating device credential for that device');
eq((await poll(first)).status,'expired','the pairing request cannot be redeemed twice');
const devices=(await call('devices',undefined,{session:web})).data.devices;
ok(devices.some(d=>d.id===tokens.deviceId&&d.platform==='android'&&!d.revokedAt),'it appears in Settings → Devices');
eq((await own('select shell from pulse.native_device where id=$1',[tokens.deviceId]))[0].shell,true,'marked as the phone app shell');
eq((await own('select native_device_id from pulse.login_session where native_device_id=$1 and revoked_at is null',[tokens.deviceId])).length,1,'bound to the web session that registered it');
eq((await call('companion/updates',undefined,{token:tokens.accessToken})).status,200,'the background check uses the device credential');

// 2. Refusals: wrong platform, someone else's code, device credentials, reuse.
const laptop=await start('windows');
eq((await call('native/shell/enroll',{code:laptop.code},{session:web})).status,403,'a computer’s code cannot be approved this way');
eq((await call('native/shell/enroll',{code:first.code},{session:web})).status,404,'a used request cannot be approved again');
const viaDevice=await start();
eq((await call('native/shell/enroll',{code:viaDevice.code},{token:tokens.accessToken})).status,403,'a device credential cannot register another device');
eq((await call('native/shell/enroll',{code:'NOT-REAL'},{session:web})).status,400,'malformed codes refused');

// 3. Registering again from the same signed-in app replaces the earlier entry; nothing piles up in Devices.
const second=await start();
const again=await call('native/shell/enroll',{code:second.code,replaces:tokens.deviceId},{session:web});
eq(again.status,200,'a new install registers again');const tokens2=await poll(second);
eq((await call('companion/updates',undefined,{token:tokens.accessToken})).status,401,'the replaced device credential stops working');
ok((await own('select revoked_at from pulse.native_device where id=$1',[tokens.deviceId]))[0].revoked_at,'the replaced device is revoked');
eq((await call('me',undefined,{session:web})).status,200,'the web session stays signed in');

// 4. Signing out of the web revokes the phone app's device.
eq((await call('auth/sign-out',{},{session:web})).status,200,'sign out on the web');
eq((await call('companion/updates',undefined,{token:tokens2.accessToken})).status,401,'signing out of the web revokes the shell device');
ok((await own('select revoked_at from pulse.native_device where id=$1',[tokens2.deviceId]))[0].revoked_at,'and it shows as revoked in Devices');
eq((await call('native/refresh',{refreshToken:tokens2.refreshToken},{anonymous:true})).status,401,'its refresh credential is dead too');

// 5. Revoking the device in Devices ends the phone's web session.
const web2=await signIn('person');const third=await start();
eq((await call('native/shell/enroll',{code:third.code},{session:web2})).status,200,'sign in again and the app registers again');const tokens3=await poll(third);
eq((await call(`devices/${tokens3.deviceId}/revoke`,{},{session:web2})).status,200,'revoke the phone in Settings → Devices');
eq((await call('me',undefined,{session:web2})).status,401,'revoking the device ends the phone’s web session');

// 6. Other people and desktop windows are untouched.
const other=await signIn('other');const theirs=await start();
eq((await call('native/shell/enroll',{code:theirs.code,replaces:tokens3.deviceId},{session:other})).status,200,'another person registers their phone');
const otherTokens=await poll(theirs);
eq((await own('select person_id from pulse.native_device where id=$1',[otherTokens.deviceId]))[0].person_id,roles.other,'their device is theirs');
const desk=await start('macos');await call('native/pair/decide',{code:desk.code,approve:true},{session:other});const deskTokens=await poll(desk);
const windowSession=await call('native/web-session',{},{token:deskTokens.accessToken});eq(windowSession.status,200,'a desktop window session (R15d)');
eq((await call('auth/sign-out',{},{session:windowSession.data.token})).status,200,'signing out inside the desktop window');
eq((await call('companion/updates',undefined,{token:deskTokens.accessToken})).status,200,'never revokes the computer (only phone shells are bound)');
eq((await call('companion/updates',undefined,{token:otherTokens.accessToken})).status,200,'nor another session’s phone');
const events=await own("select action from pulse_priv.auth_event where actor=$1 order by at",[roles.person]);
ok(events.some(e=>e.action==='native_paired')&&events.some(e=>e.action==='native_revoked'),'Account → Security history shows the pairing and the sign-out');

await writeFile(process.env.TEST_REPORT,JSON.stringify({checks,receipts},null,2));
await pool.end();await owner.end();console.log('mobile-shell checks',checks);
