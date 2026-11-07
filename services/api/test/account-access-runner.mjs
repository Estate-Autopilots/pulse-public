import assert from 'node:assert/strict';
import {createApp} from '../dist/app.js';
import {Pool} from 'pg';
import {spawn} from 'node:child_process';
import {chromium} from '../../../tests/e2e/node_modules/@playwright/test/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {testMail} from '../dist/auth-mail.js';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'node:net';
let apiChecks=0,browserChecks=0;
const layouts=[];
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),app=createApp(pool,pool);
const call=async(path,body,token)=>{apiChecks++;const r=await app.inject({method:body===undefined?'GET':'POST',url:'/api/v0/'+path,headers:{'x-pulse-client-ip':'198.51.100.44',...(token?{'x-pulse-session':token}:{})},...(body===undefined?{}:{payload:body})});return {status:r.statusCode,data:r.json()};};
const person=process.env.TEST_PERSON,other=process.env.TEST_OTHER;
let adminToken;
try{
 const admin=await call('auth/sign-in',{username:'auth.admin',password:'Synthetic-account-2026!'});assert.equal(admin.status,200);adminToken=admin.data.token;
 assert.equal((await call('auth/change-password',{current:'Synthetic-account-2026!',next:'Account drawer admin river!'},adminToken)).status,200);
 const self=await call('auth/sign-in',{username:'auth.person',password:'Synthetic-account-2026!'});assert.equal(self.status,200);
 assert.equal((await call('auth/change-password',{current:'Synthetic-account-2026!',next:'Account drawer person river!'},self.data.token)).status,200);
 for(const target of [person,other])assert.equal((await call(`people/${target}/login`,{action:'email-work-save',email:'denied@example.test'},self.data.token)).status,403);
 assert.equal((await call(`people/${other}/login`,{action:'email-delivery-save',email:'denied@example.test'})).status,401);
 for(const email of ['invalid','admin@example.test'])for(const action of ['email-work-save','email-delivery-save'])assert.equal((await call(`people/${other}/login`,{action,email},adminToken)).status,400);
 assert.equal((await call(`people/${other}/login`,{action:'email-delivery-verify'},adminToken)).status,400);
 await delay(150);const mailCount=testMail.length;
 const previous=(await call(`admin/auth-history/${person}`,undefined,adminToken)).data;
 assert.equal((await call(`people/${person}/login`,{action:'email-delivery-save',email:'draft-api@example.test'},adminToken)).status,200);
 assert.equal(testMail.length,mailCount,'Save sends no mail');
 let state=(await call(`admin/auth-history/${person}`,undefined,adminToken)).data;
 assert.equal(state.delivery,previous.delivery);assert.equal(state.draftDelivery,'draft-api@example.test');assert.equal(state.emailPending,null);
 assert.equal((await call(`people/${other}/login`,{action:'email-delivery-save',email:'DRAFT-API@example.test'},adminToken)).status,400);
 // Exercise the configured mail gate, never real fallback. Then retry through the in-memory sink.
 const saved={ci:process.env.PULSE_CI,mode:process.env.PULSE_AUTH_MAIL_MODE,node:process.env.NODE_ENV,enabled:process.env.PULSE_GMAIL_SEND_ENABLED};
 try{process.env.PULSE_CI='0';process.env.PULSE_AUTH_MAIL_MODE='disabled';process.env.NODE_ENV='production';process.env.PULSE_GMAIL_SEND_ENABLED='0';const failedDelivery=await call(`people/${person}/login`,{action:'email-delivery-verify'},adminToken);assert.equal(failedDelivery.status,503);assert.ok(failedDelivery.data.error.startsWith('Address saved, but confirmation email could not be delivered.'));assert.equal(testMail.length,mailCount);}
 finally{for(const [key,value] of Object.entries({PULSE_CI:saved.ci,PULSE_AUTH_MAIL_MODE:saved.mode,NODE_ENV:saved.node,PULSE_GMAIL_SEND_ENABLED:saved.enabled})){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
 assert.equal((await call(`admin/auth-history/${person}`,undefined,adminToken)).data.draftDelivery,'draft-api@example.test');
 assert.equal((await call(`people/${person}/login`,{action:'email-delivery-verify'},adminToken)).status,200);
 state=(await call(`admin/auth-history/${person}`,undefined,adminToken)).data;assert.ok(state.emailPending);assert.equal(state.delivery,previous.delivery);
 const confirmation=testMail.findLast(m=>m.title==='Confirm your Pulse delivery email');assert.ok(confirmation);const token=new URL(confirmation.body.match(/https?:\/\/\S+/)[0]).hash.slice(1);
 assert.equal((await call('auth/confirm-email',{token})).status,200);assert.equal((await call('auth/confirm-email',{token})).status,400);
 state=(await call(`admin/auth-history/${person}`,undefined,adminToken)).data;assert.equal(state.verifiedDelivery,'draft-api@example.test');assert.equal(state.draftDelivery,null);
 assert.equal((await call('auth/account',undefined,self.data.token)).status,200,'Email save/verification keeps ordinary session usable');
 if(process.env.PULSE_AUTH_BROWSER==='1')await browserFlows();
 await writeFile(process.env.PULSE_AUTH_REPORT,JSON.stringify({apiChecks,browserChecks,mailSink:true,realEmailsSent:0,layouts},null,2));
}finally{await app.close();await pool.end();}

async function browserFlows(){
 const address=await app.listen({host:'127.0.0.1',port:0}),probe=createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));const base=`http://127.0.0.1:${port}`;
 const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{cwd:'../../apps/web',env:{...process.env,PULSE_API_URL:address,PULSE_PUBLIC_URL:base,NODE_ENV:'production'},stdio:'ignore'});
 let browser;
 const check=(condition,label)=>{browserChecks++;assert.ok(condition,label);};
 try{
  for(let i=0;i<400;i++){try{if((await fetch(base+'/login')).ok)break;}catch{}await delay(200);if(i===399)throw new Error('Account drawer test server did not start');}
  browser=await chromium.launch({headless:true});
  for(const [width,theme,target] of [[390,'light',other],[1440,'dark',person],[320,'dark',other],[1440,'light',person]]){
   const context=await browser.newContext({viewport:{width,height:740},colorScheme:theme}),page=await context.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));await context.addCookies([{name:'pulse_session',value:adminToken,url:base,httpOnly:true,sameSite:'Lax'}]);await page.addInitScript(t=>localStorage.setItem('pulse.theme',t),theme);
   await page.goto(base+'/people/'+target);
   let failLoad=true;
   if(width===390)await page.route(`**/api/v0/admin/auth-history/${target}`,async route=>{if(!failLoad){await route.continue();return;}failLoad=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Account details unavailable. Retry.'})});});
   await page.getByRole('button',{name:'Account access',exact:true}).first().click();const drawer=page.getByRole('dialog',{name:'Account access',exact:true});
   if(width===390){await drawer.getByRole('button',{name:'Retry account details'}).click();}
   await drawer.getByLabel('Work email',{exact:true}).waitFor();
   if(width===390){check((await drawer.getByText('Missing',{exact:true}).count())===1,'Missing address guidance');check(await drawer.getByRole('button',{name:'Send password reset link',exact:true}).isDisabled(),'Missing address prevents send');}
   check(await drawer.getByRole('heading',{name:'Account status',exact:true}).count()===1,'Status group');
   check(await drawer.getByRole('heading',{name:'Sessions and security',exact:true}).count()===1,'Security group');
   await drawer.getByLabel('Work email',{exact:true}).fill('invalid');await drawer.getByRole('button',{name:'Save work email'}).click();await drawer.getByRole('alert').filter({hasText:'Enter a valid email address.'}).waitFor();check(true,'Inline invalid address');
   await drawer.getByLabel('Work email',{exact:true}).fill('admin@example.test');await drawer.getByRole('button',{name:'Save work email'}).click();await drawer.getByRole('alert').filter({hasText:'already assigned'}).waitFor();check(true,'Inline duplicate address');
   await drawer.getByLabel('Work email',{exact:true}).fill(`work-${width}-${theme}@example.test`);let mailCount=testMail.length;await drawer.getByRole('button',{name:'Save work email'}).click();await drawer.getByRole('status').filter({hasText:'Work identity saved.'}).waitFor();check(testMail.length===mailCount,'Work save never sends');
   await drawer.getByLabel('Delivery address',{exact:true}).fill(`delivery-${width}-${theme}@example.test`);
   let failSave=true;
   await page.route(`**/api/v0/people/${target}/login`,async route=>{if(failSave&&route.request().postDataJSON().action==='email-delivery-save'){failSave=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Save unavailable. Retry.'})});}else await route.continue();});
   await drawer.getByRole('button',{name:'Save delivery email'}).click();await drawer.getByRole('alert').filter({hasText:'Save unavailable'}).waitFor();check((await drawer.getByLabel('Delivery address',{exact:true}).inputValue()).startsWith('delivery-'),'Error preserves input');
   mailCount=testMail.length;await drawer.getByRole('button',{name:'Save delivery email'}).click();await drawer.getByRole('status').filter({hasText:'Address saved, unverified.'}).waitFor();check(testMail.length===mailCount,'Delivery save never sends');check(await drawer.getByText('Saved, unverified',{exact:true}).count()===1,'Saved state');
   await drawer.getByRole('button',{name:'Send confirmation link',exact:true}).click();await drawer.getByRole('status').filter({hasText:'Confirmation link sent.'}).waitFor();check(await drawer.getByText('Pending confirmation',{exact:true}).count()===1,'Pending state');
   const mail=testMail.findLast(m=>m.title==='Confirm your Pulse delivery email'),token=new URL(mail.body.match(/https?:\/\/\S+/)[0]).hash.slice(1);
   check((await call('auth/confirm-email',{token})).status===200,'Existing confirmation endpoint');await drawer.getByRole('button',{name:'Refresh verification status'}).click();await drawer.getByText('Verified',{exact:true}).waitFor();check(true,'Verified state');
   check(await drawer.getByRole('button',{name:'Send password reset link',exact:true}).isEnabled(),'Recovery remains usable');
   // Every control can be brought completely into view in the dedicated scroll region.
   const fit=await drawer.evaluate(async d=>{const scroll=d.querySelector('[data-drawer-body], [class*="drawerScroll"]');let clipped=0;for(const el of d.querySelectorAll('button,input')){el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect(),s=scroll.getBoundingClientRect();if(r.left<0||r.right>innerWidth+1||r.width>innerWidth||r.height>innerHeight)clipped++;if(scroll.contains(el)&&(r.top<s.top-1||r.bottom>s.bottom+1))clipped++;}return {overflow:document.documentElement.scrollWidth>innerWidth+1,clipped,scrollable:scroll.scrollHeight>scroll.clientHeight};});
   if(fit.overflow||fit.clipped){console.error('Drawer geometry',JSON.stringify({width,theme,...fit,documentSize:await page.evaluate(()=>({width:document.documentElement.scrollWidth,body:document.body.scrollWidth,tabs:[...document.querySelectorAll('nav[class*=__tabs]')].map(el=>({class:el.className,rect:{width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right},overflow:getComputedStyle(el).overflow,position:getComputedStyle(el).position,parent:el.parentElement.className}))})),offenders:await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(el=>el.getClientRects().length&&el.getBoundingClientRect().right>innerWidth+1).map(el=>({tag:el.tagName,class:el.className?.toString(),right:el.getBoundingClientRect().right})).slice(0,15))}));if(process.env.PULSE_ACCOUNT_SCREENSHOTS)await page.screenshot({path:process.env.PULSE_ACCOUNT_SCREENSHOTS+'/failure-'+width+'.png'});}
   check(!fit.overflow,'No page overflow');check(fit.clipped===0,'No clipped controls');check(fit.scrollable,'All sections reachable by scrolling');
   if(process.env.PULSE_ACCOUNT_SCREENSHOTS){await mkdir(process.env.PULSE_ACCOUNT_SCREENSHOTS,{recursive:true});await drawer.getByRole('heading',{name:'Account status',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:`${process.env.PULSE_ACCOUNT_SCREENSHOTS}/${theme}-${width}-account-access.png`});}
   await drawer.getByRole('button',{name:'Sign out everywhere',exact:true}).click();await drawer.getByRole('button',{name:'Confirm sign out all',exact:true}).waitFor();check(true,'Session confirmation reachable');await drawer.getByRole('button',{name:'Cancel',exact:true}).click();
   const unlockResponse=page.waitForResponse(r=>r.url().endsWith(`/api/v0/people/${target}/login`)&&r.request().method()==='POST'&&r.request().postDataJSON()?.action==='unlock'&&r.ok());await drawer.getByRole('button',{name:'Unlock',exact:true}).click();await unlockResponse;check(true,'Recovery action succeeds');
   check(errors.length===0,'No browser errors');layouts.push({width,height:740,theme,...fit,browserErrors:errors});
   await page.keyboard.press('Escape');check(await drawer.count()===0,'Escape closes drawer');await context.close();
  }
 }finally{await browser?.close();server.kill('SIGTERM');}
}
