import assert from 'node:assert/strict';
import {createApp} from '../dist/app.js';
import {Pool} from 'pg';
import {spawn} from 'node:child_process';
import {chromium} from '../../../tests/e2e/node_modules/@playwright/test/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {testMail} from '../dist/auth-mail.js';
import {setTimeout as delay} from 'node:timers/promises';
import {randomBytes,createHash} from 'node:crypto';
let browserChecks=0;
// CHAT-SHELL (9883eb5f, 22 Oct 2026): a computer opens Pulse on the chat; phones and the Accountant on the dashboard.
const HOME = /\/(chats|dashboard)(\?|$)/;
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG));const app=createApp(pool,pool);let apiChecks=0;
const call=async(path,body,token)=>{apiChecks++;const r=await app.inject({method:body===undefined?'GET':'POST',url:'/api/v0/'+path,headers:{'x-pulse-client-ip':'198.51.100.12',...(token?{'x-pulse-session':token}:{})},...(body===undefined?{}:{payload:body})});return {status:r.statusCode,data:r.json()};};
try{
 const beforeMail=testMail.length;
 // Real database interaction: disabled and recipient-failed recovery cannot destroy an admin invite.
 const invite=randomBytes(32).toString('base64url'),c=await pool.connect();
 try{
  await c.query('begin');
  await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)",[process.env.PULSE_ORG_ID,process.env.TEST_ADMIN]);
  await c.query("select pulse.auth_admin('staff',$1,'invite',$2)",[process.env.TEST_PERSON,JSON.stringify({hash:createHash('sha256').update(invite).digest('hex')})]);
  await c.query('commit');
 }finally{await c.query('rollback');c.release();}
 const mailKeys=['PULSE_CI','NODE_ENV','PULSE_AUTH_MAIL_MODE','PULSE_GMAIL_SEND_ENABLED','PULSE_PUBLIC_URL'];
 const mailEnv=Object.fromEntries(mailKeys.map(k=>[k,process.env[k]]));
 try{
  Object.assign(process.env,{PULSE_CI:'0',NODE_ENV:'production',PULSE_AUTH_MAIL_MODE:'disabled',PULSE_GMAIL_SEND_ENABLED:'0',PULSE_PUBLIC_URL:'https://pulse-staging.estateautopilots.com'});
  const unavailable=await call('auth/forgot',{username:'auth.person'});
  assert.equal(unavailable.status,503);assert.equal(unavailable.data.code,'MAIL_UNAVAILABLE');
  assert.deepEqual(await call('auth/forgot',{username:'absent.unavailable'}),unavailable);
  process.env.PULSE_GMAIL_SEND_ENABLED='1'; // staging blocks this synthetic recipient before transport
  const failed=await call('auth/forgot',{username:'auth.person'});
  assert.equal(failed.status,200);assert.match(failed.data.message,/mail delivery is available/);
  assert.deepEqual(await call('auth/forgot',{username:'absent.unavailable'}),failed);
  await delay(150);assert.equal(testMail.length,beforeMail);
 }finally{for(const k of mailKeys)if(mailEnv[k]===undefined)delete process.env[k];else process.env[k]=mailEnv[k];}
 assert.equal((await call('auth/set-password',{token:invite,password:'Fresh invited violet cedar!'})).status,200);
 assert.equal((await call('auth/set-password',{token:invite,password:'Fresh invited violet cedar!'})).status,400);
 const unactivated=await call('auth/forgot',{username:'auth.unactivated.admin'});
 assert.equal(unactivated.status,200);
 await delay(150);
 const activation=testMail.slice(beforeMail).find(m=>m.title==='Reset your Pulse password'&&m.to==='unactivated@example.test');assert.ok(activation,'Unactivated admin must receive a recovery email');
 const activationToken=new URL(activation.body.match(/https:\/\/\S+/)[0]).hash.slice(1);
 assert.equal((await call('auth/set-password',{token:activationToken,password:'Fresh activated admin cedar!'})).status,200);
 assert.equal((await call('auth/set-password',{token:activationToken,password:'Fresh activated admin cedar!'})).status,400);
 assert.equal((await call('auth/sign-in',{username:'auth.unactivated.admin',password:'Fresh activated admin cedar!'})).status,200);
 const unknown=await call('auth/forgot',{username:'absent'}),known=await call('auth/forgot',{username:'auth.person'});assert.deepEqual(known,unknown);
 assert.deepEqual(unactivated,unknown);
 for(let i=0;i<6;i++)assert.deepEqual(await call('auth/forgot',{username:'absent'}),unknown);
 await delay(150);const mail=testMail.find(m=>m.title==='Reset your Pulse password'&&m.to==='personal@gmail.example');assert.ok(mail);
 const token=new URL(mail.body.match(/https:\/\/\S+/)[0]).hash.slice(1);assert.equal(token.length,43);
 assert.equal((await call('auth/set-password',{token:'invalid',password:'Fresh HTTP violet cedar!'})).status,400);
 assert.equal((await call('auth/set-password',{token,password:'password123'})).status,400);
 const reset=await call('auth/set-password',{token,password:'Fresh HTTP violet cedar!'});assert.equal(reset.status,200);const session=reset.data.token;
 assert.equal((await call('auth/set-password',{token,password:'Fresh HTTP violet cedar!'})).status,400);
 assert.equal((await call('auth/account',undefined,session)).status,200);
 const old=await call('auth/sign-in',{username:'auth.person',password:'Synthetic-account-2026!'});assert.equal(old.status,401);
 const current=await call('auth/sign-in',{username:'auth.person',password:'Fresh HTTP violet cedar!',remember:true});assert.equal(current.status,200);assert.equal(current.data.maxAge,2592000);
 assert.equal((await call('auth/change-password',{current:'wrong',next:'Fresh changed HTTP violet!'},session)).status,400);
 assert.equal((await call('auth/change-password',{current:'Fresh HTTP violet cedar!',next:'Fresh changed HTTP violet!'},session)).status,200);
 assert.equal((await call('auth/account',undefined,current.data.token)).status,401);
 assert.equal((await call('auth/account',{action:'email-start',email:'new@example.test',current:'wrong'},session)).status,400);
 const username=await call('auth/forgot-username',{email:'absent@example.test'});assert.deepEqual(username,unknown);
 const admin=await call('auth/sign-in',{username:'auth.admin',password:'Synthetic-account-2026!'});assert.equal(admin.status,200);
 // SIGNIN-OFFICE (28 Oct 2026): every call here comes from one address, like an office. Forty mistyped names from it
 // are each refused for themselves (401, never the address's 429), the next person still signs in, and the work
 // e-mail on file signs in like the username.
 for(let i=0;i<40;i++){const miss=await call('auth/sign-in',{username:`office.typo.${i}`,password:'Not their password 1!'});assert.equal(miss.status,401,`office try ${i+1}`);assert.match(String(miss.data.error??miss.data.message??''),/work e-mail/);}
 assert.equal((await call('auth/sign-in',{username:' Admin@Example.TEST ',password:'Synthetic-account-2026!'})).status,200);
 assert.equal((await call('auth/change-password',{current:'Synthetic-account-2026!',next:'Fresh admin HTTP violet!'},admin.data.token)).status,200);
 const target=process.env.TEST_PERSON;
 assert.equal((await call('people/'+target+'/login',{action:'unlock'},session)).status,403);
 assert.equal((await call('people/'+target+'/login',{action:'copy'},admin.data.token)).status,400);
 assert.equal((await call('people/'+target+'/login',{action:'two-step-reset',confirmed:true,reason:'x'},admin.data.token)).status,400);
 assert.equal((await call('people/'+target+'/login',{action:'copy',confirmed:true},admin.data.token)).status,200);
 assert.equal((await call('admin/auth-history/'+target,undefined,admin.data.token)).status,200);
 assert.equal((await call('people/'+target+'/login',{action:'disable'},admin.data.token)).status,200);
 assert.equal((await call('auth/account',undefined,session)).status,401);
 assert.equal((await call('people/'+target+'/login',{action:'enable'},admin.data.token)).status,200);
 const newer=await call('auth/sign-in',{username:'auth.person',password:'Fresh changed HTTP violet!'});assert.equal(newer.status,200);
 assert.equal((await call('people/'+target+'/login',{action:'sign-out-all'},admin.data.token)).status,200);
 assert.equal((await call('auth/account',undefined,newer.data.token)).status,401);
 assert.equal((await call('admin/auth-policy',undefined,newer.data.token)).status,401);
 assert.equal((await call('auth-review',undefined,admin.data.token)).status,200);
 assert.equal((await call('admin/invite-current',{},admin.data.token)).status,410);
 if(process.env.PULSE_AUTH_BROWSER==='1')await browserFlows();
 await writeFile(process.env.PULSE_AUTH_REPORT,JSON.stringify({apiChecks,browserChecks,mailSink:true}));
}finally{await app.close();await pool.end();}

async function browserFlows(){
 const screenshotDir=process.env.PAPERCLIP_RUN_SCRATCH_DIR;
 if(screenshotDir)await mkdir(screenshotDir,{recursive:true});
 const address=await app.listen({host:'127.0.0.1',port:0});
 const net=await import('node:net');const probe=net.createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));
 const base=`http://127.0.0.1:${port}`;
 const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{cwd:'../../apps/web',env:{...process.env,PULSE_API_URL:address,PULSE_PUBLIC_URL:base,NODE_ENV:'production'},stdio:'ignore'});
 let browser;
 try{
  for(let i=0;i<400;i++){try{if((await fetch(base+'/login')).ok)break;}catch{}await delay(300);if(i===399)throw new Error('Auth browser web server did not start');}
  browser=await chromium.launch({headless:true});
  const admin=await call('auth/sign-in',{username:'auth.admin',password:'Fresh admin HTTP violet!'});
  const orgProfile=await call('me',undefined,admin.data.token);
  assert.equal(orgProfile.status,200);
  assert.equal(orgProfile.data.orgName,'Northwind Studio');
  const copied=await call('people/'+process.env.TEST_OTHER+'/login',{action:'copy',confirmed:true},admin.data.token);
  assert.equal((await call('auth/set-password',{token:new URL(copied.data.link).hash.slice(1),password:'Fresh changed HTTP violet!'})).status,200);

  for(const width of [1440,390]){
   const username=width===1440?'auth.person':'auth.noemail';let password='Fresh changed HTTP violet!';
   const context=await browser.newContext({viewport:{width,height:900},ignoreHTTPSErrors:true});const page=await context.newPage();
   const check=(condition,detail='')=>{browserChecks++;assert.ok(condition,`Browser auth flow check${detail?`: ${detail}`:''}`);};
   const loginResponse=await page.goto(base+'/login');
   const loginHeading=page.getByRole('heading',{name:'Sign in to Pulse',exact:true});
   try{await loginHeading.waitFor({state:'visible',timeout:10000});}catch{}
   const loginHeadingCount=await loginHeading.count();
   check(loginHeadingCount===1,`login status ${loginResponse?.status()}, title ${await page.title()}, body ${(await page.locator('body').innerText()).slice(0,500)}`);
   check(await page.getByText('for Northwind Studio',{exact:true}).isVisible(),`brand byline at ${width}px`);
   check(await page.title()==='Pulse · Northwind Studio',`brand title at ${width}px: ${await page.title()}`);
   if(width===1440&&screenshotDir)await page.screenshot({path:join(screenshotDir,'northwind-real-database-sign-in.png'),fullPage:true});
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
   await page.getByRole('button',{name:'Forgot your password?',exact:true}).click();await page.locator('input[name=username]').fill('absent.browser');await page.getByRole('button',{name:'Send reset link',exact:true}).click();await page.locator('p[role=status]').waitFor();check((await page.locator('p[role=status]').textContent()).includes('If an eligible account matches'));
   const unavailableKeys=['PULSE_CI','NODE_ENV','PULSE_AUTH_MAIL_MODE','PULSE_GMAIL_SEND_ENABLED'];
   const availableEnv=Object.fromEntries(unavailableKeys.map(k=>[k,process.env[k]]));
   try{
    Object.assign(process.env,{PULSE_CI:'0',NODE_ENV:'production',PULSE_AUTH_MAIL_MODE:'disabled',PULSE_GMAIL_SEND_ENABLED:'0'});
    await page.locator('input[name=username]').fill('absent.mail-disabled');
    await page.getByRole('button',{name:'Send reset link',exact:true}).click();
    await page.getByText('Mail is unavailable; ask your admin for a new link.',{exact:true}).waitFor();
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'mail-unavailable phone width');
    if(screenshotDir)for(const theme of ['light','dark']){
     await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
     await page.screenshot({path:join(screenshotDir,`mail-unavailable-${width}-${theme}.png`),fullPage:true});
    }
   }finally{for(const k of unavailableKeys)if(availableEnv[k]===undefined)delete process.env[k];else process.env[k]=availableEnv[k];}
   await page.getByRole('button',{name:'Forgot your username?',exact:true}).click();check(await page.getByRole('heading',{name:'Find your username'}).count()===1);
   await page.goto(base+'/login');await page.locator('input[name=username]').fill(username);await page.locator('input[name=password]').fill(password);await page.locator('input[name=remember]').check();await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(HOME);
   check((await context.cookies()).some(c=>c.name==='pulse_session'&&c.httpOnly&&c.sameSite==='Lax'));
   await page.goto(base+'/account');await page.getByRole('tab',{name:'Sessions',exact:true}).click();await page.getByText('· This device',{exact:false}).waitFor();check(await page.getByText('Kept signed in',{exact:false}).count()>0);
   const other=await call('auth/sign-in',{username,password});check(other.status===200);
   await page.getByRole('button',{name:'Sign out all others',exact:true}).click();await page.locator('p[role=status]').waitFor();check((await call('auth/account',undefined,other.data.token)).status===401);
   await page.getByRole('tab',{name:'Password',exact:true}).click();await page.locator('input[name=current]').fill(password);password='Browser violet river '+width+'!';await page.locator('input[name=next]').fill(password);await page.locator('input[name=again]').fill(password);await page.getByRole('button',{name:'Change password',exact:true}).click();await page.locator('p[role=status]').waitFor();check((await page.locator('p[role=status]').textContent()).includes('Saved'));
   await page.getByRole('tab',{name:'Delivery email',exact:true}).click();await page.locator('input[name=current]').fill(password);await page.locator('input[name=email]').fill('browser'+width+'@example.test');await page.getByRole('button',{name:'Send confirmation link',exact:true}).click();await page.locator('p[role=status]').waitFor();check((await page.locator('p[role=status]').textContent()).includes('confirmation link'));
   const email=testMail.findLast(m=>m.title==='Confirm your Pulse delivery email');check(!!email);const emailToken=new URL(email.body.match(/https?:\/\/\S+/)[0]).hash.slice(1);
   await page.goto(base+'/login/confirm-email#'+emailToken);await page.getByRole('button',{name:'Confirm email',exact:true}).click();await page.getByText('Your delivery email is confirmed.',{exact:true}).waitFor();check(await page.evaluate(()=>!window.location.hash));
   await page.goto(base+'/account');await page.getByRole('tab',{name:'Two-step verification',exact:true}).click();await page.getByRole('radio',{name:/^Use an authenticator app/}).click();await page.getByRole('button',{name:'Continue',exact:true}).click();await page.locator('input[name=current]').fill(password);await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('button',{name:'Can’t scan?',exact:true}).click();await page.locator('code').waitFor();check((await page.locator('code').textContent()).replace(/\s/g,'').length===32);
   const base32=(await page.locator('code').textContent()).replace(/\s/g,'');const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0,value=0,bytes=[];for(const c of base32){value=(value<<5)|alphabet.indexOf(c);bits+=5;if(bits>=8){bytes.push((value>>>(bits-8))&255);bits-=8;}}const key=Buffer.from(bytes);
   const {createHmac}=await import('node:crypto');const step=Math.floor(Date.now()/30000),counter=Buffer.alloc(8);counter.writeBigInt64BE(BigInt(step));const mac=createHmac('sha1',key).update(counter).digest(),offset=mac[19]&15,code=String((mac.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
   await page.locator('input[name=code]').fill(code.slice(0,3)+' '+code.slice(3));await page.getByRole('button',{name:'Turn on two-step',exact:true}).click();await page.getByRole('heading',{name:'Save your backup codes'}).waitFor();const recovery=await page.locator('ul').last().locator('li').allTextContents();check(recovery.length===10);await page.getByLabel('I’ve saved my backup codes').check();await page.getByRole('button',{name:'Done',exact:true}).click();
   await context.clearCookies();await page.goto(base+'/login');await page.locator('input[name=username]').fill(username);await page.locator('input[name=password]').fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.locator('input[name=code]').waitFor();check(await page.getByRole('heading',{name:'Verify it’s you'}).count()===1);await page.locator('input[name=code]').fill(recovery[0]);await page.getByRole('button',{name:'Verify and sign in',exact:true}).click();await page.waitForURL(HOME);
   await page.goto(base+'/account');await page.getByRole('tab',{name:'Two-step verification',exact:true}).click();await page.locator('input[name=current]').fill(password);await page.locator('input[name=code]').fill(recovery[1]);const disabling=page.waitForResponse(r=>r.url().endsWith('/auth/account')&&r.request().method()==='POST');await page.getByRole('button',{name:'Turn off two-step',exact:true}).click();const disableResponse=await disabling;assert.equal(disableResponse.status(),200,'Two-step disable: '+(await disableResponse.json()).error);await page.getByRole('heading',{name:'Turn on two-step verification'}).waitFor();check(true);
   await page.getByRole('tab',{name:'Activity',exact:true}).click();check(await page.getByText('two step enabled',{exact:true}).count()>0);check(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
   const target=width===1440?process.env.TEST_PERSON:process.env.TEST_OTHER;
   const firstLink=await call('people/'+target+'/login',{action:'copy',confirmed:true},admin.data.token),secondLink=await call('people/'+target+'/login',{action:'copy',confirmed:true},admin.data.token);
   const olderSession=await call('auth/sign-in',{username,password});check(olderSession.status===200);
   await context.clearCookies();await page.goto(base+'/login/set-password#'+new URL(firstLink.data.link).hash.slice(1));await page.locator('input[name=password]').fill('Recovered browser cedar '+width+'!');await page.locator('input[name=again]').fill('Recovered browser cedar '+width+'!');await page.getByRole('button',{name:'Set password and start',exact:true}).click();await page.locator('form p[role=alert]').waitFor();{const errorText=await page.locator('form p[role=alert]').textContent();browserChecks++;assert.ok(errorText.includes('unavailable'),'Link rejection: '+errorText);}
   const finalCapability=new URL(secondLink.data.link).hash.slice(1);
   await page.goto(base+'/login/set-password#'+finalCapability);await page.locator('input[name=password]').fill('Recovered browser cedar '+width+'!');await page.locator('input[name=again]').fill('Recovered browser cedar '+width+'!');await page.getByRole('button',{name:'Set password and start',exact:true}).click();await page.waitForURL(HOME);check((await call('auth/account',undefined,olderSession.data.token)).status===401);
   await page.goto(base+'/login/set-password#'+finalCapability);await page.locator('input[name=password]').fill('Recovered browser cedar '+width+'!');await page.locator('input[name=again]').fill('Recovered browser cedar '+width+'!');await page.getByRole('button',{name:'Set password and start',exact:true}).click();await page.locator('form p[role=alert]').waitFor();{const errorText=await page.locator('form p[role=alert]').textContent();browserChecks++;assert.ok(errorText.includes('unavailable'),'Link rejection: '+errorText);}
   await context.clearCookies();await page.goto(base+'/login');await page.locator('input[name=username]').fill('auth.admin');await page.locator('input[name=password]').fill('Fresh admin HTTP violet!');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(HOME);
   const profile=await call('people/'+target,undefined,admin.data.token);assert.equal(profile.status,200,'Profile API: '+profile.data.error);await page.goto(base+'/people/'+target);await page.getByRole('button',{name:'Account access',exact:true}).first().click();await page.getByRole('button',{name:'Unlock',exact:true}).click();await page.locator('p[role=status]').filter({hasText:'Saved.'}).waitFor();check(true);
   await page.getByRole('button',{name:'Copy link (no email)',exact:true}).click();await page.getByRole('button',{name:'Confirm copy',exact:true}).click();await page.getByRole('button',{name:'Copy private link',exact:true}).waitFor();check(await page.getByText('Shown once.',{exact:false}).count()>0);
   await context.close();
  }
  const created=await call('delivery/client-access/issue',{username:'auth.browser.client',name:'Synthetic browser client'},admin.data.token);assert.equal(created.status,200);
  const context=await browser.newContext({viewport:{width:390,height:900}}),page=await context.newPage();
  await page.goto(base+'/portal/set-password#'+new URL(created.data.link).hash.slice(1));await page.locator('input[name=password]').fill('Client browser river cedar!');await page.locator('input[name=again]').fill('Client browser river cedar!');await page.getByRole('button',{name:'Set password and start',exact:true}).click();await page.waitForURL(base+'/portal');browserChecks++;
  assert.ok((await context.cookies()).some(c=>c.name==='pulse_client_session'));browserChecks++;
  await page.goto(base+'/portal/account');await page.getByRole('tab',{name:'Sessions',exact:true}).click();await page.getByText('· This device',{exact:false}).waitFor();browserChecks++;
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));browserChecks++;
  await context.clearCookies();await page.goto(base+'/portal/login');await page.getByRole('button',{name:'Forgot your password?',exact:true}).click();await page.locator('input[name=username]').fill('absent.client');await page.getByRole('button',{name:'Send reset link',exact:true}).click();await page.locator('p[role=status]').waitFor();browserChecks++;
  await context.close();
 }finally{await browser?.close();server.kill('SIGTERM');}
}
