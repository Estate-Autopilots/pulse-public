// ACCOUNT-CODE: the HTTP side of personal accounts' e-mailed codes, run by tests/core/test_account_code.py against
// synthetic organisations with the mail sink (nothing leaves the machine). TEST_PHASE=shared: the shared address
// (sign-in code for an account, the same answer for anyone, the account session, passwordless sign-up to the account
// home) and a company's own address with personal accounts off. TEST_PHASE=company: the same company after it allowed
// personal accounts (the test switched it on and rewound the ration).
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {createApp} from '../dist/app.js';
import {testMail} from '../dist/auth-mail.js';

const E=process.env,pool=new Pool(JSON.parse(E.TEST_API_CONFIG)),app=createApp(pool,pool);let apiChecks=0;
const call=async(path,body,{token,host,ip='198.51.100.77'}={})=>{apiChecks++;const r=await app.inject({method:body===undefined?'GET':'POST',url:'/api/v0/'+path,
 headers:{'x-pulse-client-ip':ip,...(token?{'x-pulse-session':token}:{}),...(host?{'x-pulse-host':host}:{})},...(body===undefined?{}:{payload:body})});return {status:r.statusCode,data:r.json()};};
const mails=(title,to)=>testMail.filter(m=>m.title===title&&(!to||m.to===to));
const codeOf=(m,kind='sign-in')=>m.body.match(new RegExp(`Pulse ${kind} code is (\\d{6})`))[1];
const company={host:E.TEST_COMPANY_HOST};
try{
 if(E.TEST_PHASE==='company'){
  assert.equal((await call('auth/branding',undefined,company)).data.signup,true,'the company now allows personal accounts');
  // Signing up at the company's own address is open now (it was 404 before the company allowed it).
  assert.equal((await call('auth/signup-code',{name:'Synthetic Person',email:'co.'+E.TEST_SIGNUP_EMAIL},company)).status,200);
  const before=mails('Your Pulse sign-in code',E.TEST_EMAIL).length;
  assert.equal((await call('auth/sign-in-code',{username:E.TEST_HANDLE})).status,200);await delay(150);
  const code=codeOf(mails('Your Pulse sign-in code',E.TEST_EMAIL).slice(before)[0]);
  const ok=await call('auth/code-sign-in',{username:E.TEST_HANDLE,code},company);
  assert.equal(ok.status,200,JSON.stringify(ok.data));assert.equal(ok.data.org,E.TEST_COMPANY_ORG);assert.equal(ok.data.hostOwn,true);assert.equal(ok.data.maxAge,2592000);
 }else{
  // Where personal accounts are on: the shared address yes, a company's own address no (until it allows them).
  assert.equal((await call('auth/branding')).data.signup,true);
  assert.equal((await call('auth/branding',undefined,company)).data.signup,false);
  assert.equal((await call('auth/signup-code',{name:'Synthetic Person',email:E.TEST_SIGNUP_EMAIL},company)).status,404);
  assert.equal((await call('auth/signup-confirm',{name:'Synthetic Person',email:E.TEST_SIGNUP_EMAIL,code:'123456'},company)).status,404);

  // 1. Account code sign-in: asking answers the same whether or not anything matched; only the account gets mail.
  const before=testMail.length;
  const known=await call('auth/sign-in-code',{username:'@'+E.TEST_HANDLE}),unknown=await call('auth/sign-in-code',{username:'nobody.synthetic'});
  const byEmail=await call('auth/sign-in-code',{username:E.TEST_EMAIL}),unknownEmail=await call('auth/sign-in-code',{username:'nobody@gmail.example'});
  assert.equal(known.status,200);assert.deepEqual(unknown,known);assert.deepEqual(byEmail,known);assert.deepEqual(unknownEmail,known);
  await delay(200);
  const sent=testMail.slice(before);assert.equal(sent.length,1,'one code e-mail, to the account (the second ask is inside the minute)');
  const mail=sent[0];assert.equal(mail.to,E.TEST_EMAIL);assert.equal(mail.title,'Your Pulse sign-in code');
  assert.match(mail.body,new RegExp('@'+E.TEST_HANDLE));assert.match(mail.body,/expires in 10 minutes/);assert.match(mail.body,/If this wasn't you, ignore this e-mail/);
  const code=codeOf(mail);
  // Off at the company's own address: the right code does nothing there (and stays usable here).
  assert.equal((await call('auth/code-sign-in',{username:E.TEST_HANDLE,code},company)).status,401);
  const wrong=await call('auth/code-sign-in',{username:E.TEST_HANDLE,code:code==='000000'?'111111':'000000'});assert.equal(wrong.status,401);
  assert.equal((await call('auth/code-sign-in',{username:'nobody.synthetic',code})).data.error,wrong.data.error,'one refusal for a wrong code and nobody');
  assert.equal((await call('auth/code-sign-in',{username:E.TEST_HANDLE,code:'12'})).status,401);
  const ok=await call('auth/code-sign-in',{username:E.TEST_EMAIL,code:code.slice(0,3)+' '+code.slice(3)});
  assert.equal(ok.status,200,JSON.stringify(ok.data));assert.equal(ok.data.maxAge,2592000);assert.match(ok.data.token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(ok.data.org,E.TEST_COMPANY_ORG,'into the organisation the account holds a seat in');assert.equal(ok.data.home,'/');
  assert.equal(ok.data.account,undefined);assert.equal(ok.data.delivery,undefined);
  const me=await call('account',undefined,{token:ok.data.token});assert.equal(me.status,200);assert.equal(me.data.account.handle,E.TEST_HANDLE);
  assert.equal((await call('auth/code-sign-in',{username:E.TEST_HANDLE,code})).status,401,'a code works once');

  // 2. Passwordless sign-up: checks first, then one answer whether the address is new or already has an account.
  assert.equal((await call('auth/signup-code',{name:'S',email:E.TEST_SIGNUP_EMAIL})).status,400);
  assert.equal((await call('auth/signup-code',{name:'Synthetic New',email:E.TEST_SIGNUP_EMAIL,handle:E.TEST_HANDLE})).status,409);
  const fresh=await call('auth/signup-code',{name:'Synthetic New',email:E.TEST_SIGNUP_EMAIL}),taken=await call('auth/signup-code',{name:'Synthetic New',email:E.TEST_EMAIL});
  assert.equal(fresh.status,200);assert.deepEqual(taken,fresh);await delay(200);
  assert.equal(mails('You already have a Pulse account',E.TEST_EMAIL).length,1);assert.equal(mails('Your Pulse sign-up code',E.TEST_EMAIL).length,0);
  const signupMail=mails('Your Pulse sign-up code',E.TEST_SIGNUP_EMAIL);assert.equal(signupMail.length,1);
  const signupCode=codeOf(signupMail[0],'sign-up');
  const details={name:'Synthetic New',email:E.TEST_SIGNUP_EMAIL,handle:'',orgName:''};
  assert.equal((await call('auth/signup-confirm',{...details,code:signupCode==='000000'?'111111':'000000'})).status,401);
  assert.equal((await call('auth/signup-confirm',{...details,code:signupCode,password:'short'})).status,400,'a password, when chosen, follows the rules');
  const made=await call('auth/signup-confirm',{...details,code:signupCode});
  assert.equal(made.status,200,JSON.stringify(made.data));assert.equal(made.data.personal,true);assert.equal(made.data.home,'/orgs');
  assert.equal(made.data.maxAge,2592000);assert.match(made.data.token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal((await call('auth/signup-confirm',{...details,code:signupCode})).status,401,'a sign-up code works once');
  // The account home: the new account, signed in, its own workspace (Start your own Pulse is there).
  const home=await call('account',undefined,{token:made.data.token});
  assert.equal(home.status,200);assert.equal(home.data.account.email,E.TEST_SIGNUP_EMAIL);assert.equal(home.data.account.hasPassword,false);
  assert.deepEqual(home.data.orgs.map(o=>[o.id,o.current]),[[made.data.org,true]]);
  // Later, from the account home: Start your own Pulse (the confirmed e-mail lets it).
  const started=await call('account/start',{name:'Synthetic Later Co'},{token:made.data.token});
  assert.equal(started.status,200,JSON.stringify(started.data));assert.notEqual(started.data.org,made.data.org);
  // And it signs in again later with an e-mailed code, into the organisation it used last (the company it just started).
  const n=mails('Your Pulse sign-in code',E.TEST_SIGNUP_EMAIL).length;
  assert.deepEqual(await call('auth/sign-in-code',{username:'@'+home.data.account.handle}),known);await delay(150);
  const again=codeOf(mails('Your Pulse sign-in code',E.TEST_SIGNUP_EMAIL)[n]);
  const back=await call('auth/code-sign-in',{username:E.TEST_SIGNUP_EMAIL,code:again});assert.equal(back.status,200);assert.equal(back.data.org,started.data.org);
 }
 await writeFile(E.PULSE_AUTH_REPORT,JSON.stringify({apiChecks}));
}finally{await app.close().catch(()=>{});await pool.end().catch(()=>{});}
