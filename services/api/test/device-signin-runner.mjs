// MOBILE-READY (1260) acceptance on a disposable tenant with synthetic people only (tests/core/test_device_signin.py):
// "Sign in this device". Only an admin makes a code, for their own account; it works once, for 10 minutes, by its 6
// digits or its QR token; a newer code or Cancel ends it; a demoted admin's code stops working; two-step is kept;
// typed guesses are limited per address; every step is in the sign-in events; the table is closed to the API role.
import assert from 'node:assert/strict';import {Pool} from 'pg';import {writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {createApp} from '../dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),owner=new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
const app=createApp(pool,pool);const R=JSON.parse(process.env.TEST_ROLES);const ORG=process.env.PULSE_ORG_ID;
let checks=0;const receipts=[];let ipN=1;
const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;receipts.push(label);};
const ok=(v,label)=>{assert.ok(v,label);checks++;receipts.push(label);};
async function call(path,body,{role='person',token,anon,ip}={}){
 const addr=ip??`198.51.100.${ipN++}`;
 const headers=anon?{'x-pulse-client-ip':addr}:token?{'x-pulse-session':token,'x-pulse-client-ip':addr}:{'cf-access-authenticated-user-email':role+'@people.example'};
 const r=await app.inject({url:'/api/v0/'+path,method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{payload:body})});
 let data;try{data=r.json();}catch{data=r.rawPayload;}return {status:r.statusCode,data};
}
async function own(sql,args=[]){const c=await owner.connect();try{await c.query('begin');await c.query('set local role pulse_owner');await c.query("select set_config('pulse.org_id',$1,true)",[ORG]);const r=await c.query(sql,args);await c.query('commit');return r.rows;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
async function asApi(viewer,sql,args=[]){const c=await pool.connect();try{await c.query('begin');await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)",[ORG,viewer]);const r=await c.query(sql,args);await c.query('rollback');return {rows:r.rows};}catch(e){await c.query('rollback');return {error:e.code};}finally{c.release();}}
const hash=(t)=>createHash('sha256').update(t).digest('hex');
const make=async()=>{const r=await call('auth/device-code',{},{role:'admin'});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
const tokenOf=(url)=>new URL(url).hash.slice(1);
try{
for(const role of ['person','hr','leadership'])eq((await call('auth/device-code',{},{role})).status,403,`${role} cannot make a device code`);
eq((await call('auth/device-code',undefined,{role:'person'})).status,403,'nor read one');
const first=await make();
ok(/^\d{6}$/.test(first.code),'an admin gets a 6-digit code');
eq(new URL(first.url).pathname,'/login/device','and a QR link to the code sign-in page');
ok(/^[A-Za-z0-9_-]{43}$/.test(tokenOf(first.url)),'whose token is in the fragment');
const ms=Date.parse(first.expiresAt)-Date.now();ok(ms<=10*60*1000+5000&&ms>9*60*1000,'it lasts 10 minutes');
const live=(await call('auth/device-code',undefined,{role:'admin'})).data;
eq([live.id,live.code,live.url],[first.id,undefined,undefined],'reading the live code never returns the code');
const stored=(await own('select code_hash,token_hash,actor from pulse_priv.device_signin_code where id=$1',[first.id]))[0];
ok(/^[a-f0-9]{64}$/.test(stored.code_hash)&&/^[a-f0-9]{64}$/.test(stored.token_hash)&&!JSON.stringify(stored).includes(first.code),'only hashes are stored');
eq(stored.actor,R.admin,'for the admin’s own account');
const wrong=String((Number(first.code)+1)%1000000).padStart(6,'0');
eq((await call('auth/device-sign-in',{code:wrong},{anon:true})).status,400,'a wrong code does not sign in');
eq((await call('auth/device-sign-in',{code:'12ab'},{anon:true})).status,400,'a malformed code is refused');
const signed=await call('auth/device-sign-in',{code:first.code},{anon:true});
eq(signed.status,200,'the code signs the phone in: '+JSON.stringify(signed.data));ok(signed.data.token,'with a session');
eq(signed.data.maxAge,2592000,'kept for 30 days, like Keep me signed in');
eq((await call('me',undefined,{token:signed.data.token})).data.person,R.admin,'as that admin');
eq((await call('auth/device-sign-in',{code:first.code},{anon:true})).status,400,'it works once');
eq((await own('select remembered from pulse.login_session where person_id=$1 and token_hash=$2',[R.admin,hash(signed.data.token)])).map((r)=>r.remembered),[true],'the phone is an ordinary signed-in device, signed out from the devices list');
// A newer code replaces the older one; the QR token works on its own.
const a=await make(),b=await make();
eq((await call('auth/device-sign-in',{code:a.code},{anon:true})).status,400,'a newer code cancels the older one');
eq((await call('auth/device-sign-in',{token:tokenOf(b.url)},{anon:true})).status,200,'the QR token signs in without typing');
eq((await call('auth/device-sign-in',{code:b.code},{anon:true})).status,400,'and uses the code up');
// Expiry and Cancel.
const late=await make();await own("update pulse_priv.device_signin_code set expires_at=now()-interval '1 minute' where id=$1",[late.id]);
eq((await call('auth/device-sign-in',{code:late.code},{anon:true})).status,400,'after 10 minutes it no longer works');
const c=await make();
eq((await call(`auth/device-code/${c.id}/cancel`,{},{role:'person'})).status,403,'a member cannot cancel it');
eq((await call(`auth/device-code/${c.id}/cancel`,{},{role:'admin'})).status,200,'the admin cancels it');
eq((await call('auth/device-sign-in',{code:c.code},{anon:true})).status,400,'a cancelled code does not sign in');
// No longer an admin: the code stops working.
const d=await make();
await own("update pulse.role_assignment set valid_to=current_date-1 where person_id=$1 and role_key='admin'",[R.admin]);
eq((await call('auth/device-sign-in',{code:d.code},{anon:true})).status,400,'a code made by someone who is no longer an admin does not sign in');
await own("update pulse.role_assignment set valid_to=null where person_id=$1 and role_key='admin'",[R.admin]);
// Two-step stays.
await own('insert into pulse_priv.auth_key values($1,gen_random_bytes(32)) on conflict do nothing',[ORG]);
await own("insert into pulse_priv.auth_account(org_id,realm,actor,totp) select $1,'staff',$2,pgp_sym_encrypt_bytea(gen_random_bytes(20),encode(key,'hex')) from pulse_priv.auth_key where org_id=$1 on conflict(org_id,realm,actor) do update set totp=excluded.totp",[ORG,R.admin]);
const e=await make();
eq((await call('auth/device-sign-in',{code:e.code},{anon:true})).data,{twoStep:true,failed:false},'with two-step on, the phone asks for the authenticator code');
eq((await call('auth/device-sign-in',{code:e.code,otp:'000000'},{anon:true})).data,{twoStep:true,failed:true},'a wrong authenticator code does not sign in');
eq((await own('select used_at from pulse_priv.device_signin_code where id=$1',[e.id]))[0].used_at,null,'and does not use the code up');
await own('delete from pulse_priv.auth_account where actor=$1',[R.admin]);
// An admin without a Pulse password is told why.
eq((await call('auth/device-code',{},{role:'nopass'})).status,400,'an admin with no Pulse password gets a clear refusal');
// Guessing is limited per address.
const g=await make();let last=0;const guess=g.code==='000000'?'000001':'000000';
for(let i=0;i<11;i++)last=(await call('auth/device-sign-in',{code:guess},{anon:true,ip:'203.0.113.9'})).status;
eq(last,429,'the 11th typed code from one address in 15 minutes is refused');
eq((await call('auth/device-sign-in',{code:g.code},{anon:true,ip:'203.0.113.9'})).status,429,'even the right one, from that address');
// Audit and closure.
const events=(await own("select action from pulse_priv.auth_event where org_id=$1 and action like 'device_code%'",[ORG])).map((r)=>r.action);
for(const k of ['device_code_created','device_code_used','device_code_failed','device_code_cancelled','device_code_two_step_failed'])ok(events.includes(k),'sign-in events record '+k);
eq((await asApi(R.admin,'select * from pulse_priv.device_signin_code')).error,'42501','the API role cannot read the codes table');
eq((await asApi(R.person,"select pulse.device_code_create(repeat('a',64),repeat('b',64),'x')")).error,'42501','a member cannot make a code in SQL either');
}finally{await app.close();await pool.end();await owner.end();}
await writeFile(process.env.TEST_REPORT,JSON.stringify({checks,receipts},null,1));
console.log(`device-signin: ${checks} checks passed`);
