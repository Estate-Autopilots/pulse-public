// LOGIN-OTP: the HTTP side, run by tests/core/test_login_email_codes.py against synthetic organisations with the mail
// sink (nothing leaves the machine), at the shared address:
// 1. an account whose seat uses an authenticator signs in with its handle and password, then its authenticator (here a
//    backup) code: no "use your organisation's address", a 30-day account session, the challenge works once;
// 2. a merged account's linked e-mail gets the sign-in code; an unknown e-mail gets the same answer and no mail.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {createApp} from '../dist/app.js';
import {testMail} from '../dist/auth-mail.js';

const E=process.env,pool=new Pool(JSON.parse(E.TEST_API_CONFIG)),app=createApp(pool,pool);let apiChecks=0;
const call=async(path,body,{token,ip='198.51.100.78'}={})=>{apiChecks++;const r=await app.inject({method:body===undefined?'GET':'POST',url:'/api/v0/'+path,
 headers:{'x-pulse-client-ip':ip,...(token?{'x-pulse-session':token}:{})},...(body===undefined?{}:{payload:body})});return {status:r.statusCode,data:r.json()};};
const codeOf=(m)=>m.body.match(/Pulse sign-in code is (\d{6})/)[1];
try{
 // 1. Two-step at the shared address.
 const wrongPw=await call('auth/account-sign-in',{login:E.TEST_2S_HANDLE,password:'Not-the-password-2026!'});
 assert.equal(wrongPw.status,401);assert.equal(wrongPw.data.challenge,undefined);
 const first=await call('auth/account-sign-in',{login:E.TEST_2S_HANDLE,password:E.TEST_2S_PASSWORD});
 assert.equal(first.status,200,JSON.stringify(first.data));assert.equal(first.data.twoStep,true);assert.match(first.data.challenge,/^[A-Za-z0-9_-]{43}$/);
 assert.equal(first.data.token,undefined,'no session before the second step');
 assert.equal((await call('auth/two-step',{challenge:first.data.challenge,code:'wrong-backup'})).status,401);
 const done=await call('auth/two-step',{challenge:first.data.challenge,code:E.TEST_2S_BACKUP});
 assert.equal(done.status,200,JSON.stringify(done.data));assert.equal(done.data.org,E.TEST_2S_ORG);assert.equal(done.data.maxAge,2592000);
 assert.match(done.data.token,/^[A-Za-z0-9_-]{43}$/);
 assert.equal((await call('auth/two-step',{challenge:first.data.challenge,code:E.TEST_2S_BACKUP2})).status,401,'a challenge works once');
 const me=await call('account',undefined,{token:done.data.token});assert.equal(me.status,200,JSON.stringify(me.data));assert.equal(me.data.account.handle,E.TEST_2S_HANDLE);
 // The e-mailed account code for the same account also asks for the authenticator next.
 const before2=testMail.length;
 assert.equal((await call('auth/sign-in-code',{username:E.TEST_2S_HANDLE})).status,200);await delay(200);
 const m2=testMail.slice(before2).find(m=>m.title==='Your Pulse sign-in code');assert.ok(m2,'a code for the two-step account');
 const viaCode=await call('auth/code-sign-in',{username:E.TEST_2S_HANDLE,code:codeOf(m2)});
 assert.equal(viaCode.status,200,JSON.stringify(viaCode.data));assert.equal(viaCode.data.twoStep,true);assert.match(viaCode.data.challenge,/^[A-Za-z0-9_-]{43}$/);
 const done2=await call('auth/two-step',{challenge:viaCode.data.challenge,code:E.TEST_2S_BACKUP2});
 assert.equal(done2.status,200,JSON.stringify(done2.data));assert.equal(done2.data.org,E.TEST_2S_ORG);

 // 2. The merged account's linked e-mail, and an unknown e-mail.
 const before=testMail.length;
 const linked=await call('auth/sign-in-code',{username:E.TEST_LINKED},{ip:'198.51.100.79'});
 const unknown=await call('auth/sign-in-code',{username:'nobody.'+Date.now()+'@gmail.example'},{ip:'198.51.100.79'});
 assert.equal(linked.status,200);assert.deepEqual(unknown,linked,'the same answer for an unknown e-mail');
 await delay(200);
 const sent=testMail.slice(before);assert.equal(sent.length,1,'one e-mail, to the linked address only');assert.equal(sent[0].to,E.TEST_LINKED);
 const ok=await call('auth/code-sign-in',{username:E.TEST_LINKED,code:codeOf(sent[0])},{ip:'198.51.100.79'});
 assert.equal(ok.status,200,JSON.stringify(ok.data));assert.equal(ok.data.maxAge,2592000);
 const who=await call('account',undefined,{token:ok.data.token});assert.equal(who.status,200,JSON.stringify({status:who.status,data:who.data,ok:{org:ok.data.org,home:ok.data.home}}));assert.equal(who.data.account.handle,E.TEST_KEEP_HANDLE,'into the merged (kept) account');
 await writeFile(E.PULSE_AUTH_REPORT,JSON.stringify({apiChecks}));
}finally{await app.close().catch(()=>{});await pool.end().catch(()=>{});}
