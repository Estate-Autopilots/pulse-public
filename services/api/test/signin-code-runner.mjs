// SIGNIN-CODE: the HTTP side of "E-mail me a sign-in code", run by tests/core/test_signin_code.py against a synthetic
// tenant (auth.person, personal@gmail.example) with the mail sink: nothing leaves the machine.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {createApp} from '../dist/app.js';
import {testMail} from '../dist/auth-mail.js';

const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG));const app=createApp(pool,pool);let apiChecks=0;
const call=async(path,body,token,ip='198.51.100.41')=>{apiChecks++;const r=await app.inject({method:body===undefined?'GET':'POST',url:'/api/v0/'+path,headers:{'x-pulse-client-ip':ip,...(token?{'x-pulse-session':token}:{})},...(body===undefined?{}:{payload:body})});return {status:r.statusCode,data:r.json()};};
const codeMails=()=>testMail.filter(m=>m.title==='Your Pulse sign-in code');
try{
 // Five wrong passwords lock the password; the refusal points at the code.
 let refused;for(let i=0;i<5;i++)refused=await call('auth/sign-in',{username:'auth.person',password:'Wrong synthetic '+i});
 assert.equal(refused.status,401);assert.match(refused.data.error,/E-mail me a sign-in code/);assert.doesNotMatch(refused.data.error,/ask HR/);
 assert.equal((await call('auth/sign-in',{username:'auth.person',password:'Synthetic-account-2026!'})).status,401);
 // Asking answers the same whether or not anyone matched; only the real person gets mail.
 const before=codeMails().length;
 const known=await call('auth/sign-in-code',{username:'auth.person'}),unknown=await call('auth/sign-in-code',{username:'nobody.synthetic'});
 const noMail=await call('auth/sign-in-code',{username:'auth.noemail'}),email=await call('auth/sign-in-code',{username:'nobody@example.test'});
 assert.equal(known.status,200);assert.deepEqual(unknown,known);assert.deepEqual(noMail,known);assert.deepEqual(email,known);
 await delay(200);
 const mails=codeMails().slice(before);assert.equal(mails.length,1,'one code e-mail, to the person on record');
 const mail=mails[0];assert.equal(mail.to,'personal@gmail.example');
 assert.match(mail.body,/expires in 10 minutes/);assert.match(mail.body,/If this wasn't you, ignore this e-mail/);
 const code=mail.body.match(/sign-in code is (\d{6})/)[1];
 // Asking again within the minute answers the same and sends nothing.
 assert.deepEqual(await call('auth/sign-in-code',{username:'auth.person'}),known);await delay(150);assert.equal(codeMails().length,before+1);
 // A wrong code, then the right one typed the way phones paste it, keeping the device signed in.
 const wrong=await call('auth/code-sign-in',{username:'auth.person',code:code==='000000'?'111111':'000000'});assert.equal(wrong.status,401);
 assert.equal((await call('auth/code-sign-in',{username:'auth.person',code:'12'})).status,401);
 const ok=await call('auth/code-sign-in',{username:'auth.person',code:code.slice(0,3)+' '+code.slice(3),remember:true});
 assert.equal(ok.status,200,JSON.stringify(ok.data));assert.equal(ok.data.maxAge,2592000);assert.match(ok.data.token,/^[A-Za-z0-9_-]{43}$/);
 assert.equal(ok.data.actor,undefined);assert.equal(ok.data.delivery,undefined);
 assert.equal((await call('auth/account',undefined,ok.data.token)).status,200);
 assert.equal((await call('auth/code-sign-in',{username:'auth.person',code})).status,401,'a code works once');
 // The lock is over: the password works again.
 assert.equal((await call('auth/sign-in',{username:'auth.person',password:'Synthetic-account-2026!'})).status,200);
 await writeFile(process.env.PULSE_AUTH_REPORT,JSON.stringify({apiChecks}));
}finally{await app.close().catch(()=>{});await pool.end().catch(()=>{});}
