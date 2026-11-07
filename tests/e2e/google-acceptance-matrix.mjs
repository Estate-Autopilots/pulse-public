// Recovered EST-1941 assertions; only canonical staging transport and reusable inputs changed.
import assert from 'node:assert/strict';
import {stagingRequest,malformedCallback,hostEcho} from '../../services/api/test/google-acceptance-transport.mjs';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHmac,createHash} from 'node:crypto';
const tree=process.env.MATRIX_TREE, scratch=process.env.PULSE_HARNESS_SCRATCH, out=process.env.PULSE_GOOGLE_MATRIX_OUT;
assert.ok(process.env.PULSE_GOOGLE_MATRIX_REASON?.trim(),'a concrete freshness reason is required');
assert.ok(tree&&scratch&&out,'invoke tools/google-acceptance.sh <sha> --matrix');
const m=JSON.parse(readFileSync(scratch+'/manifest.json')), credentials=JSON.parse(readFileSync(m.credentialsFile));
const require=createRequire(tree+'/tests/e2e/package.json');
const {chromium,request:pwRequest}=require('@playwright/test');
const {Pool}=createRequire(tree+'/services/api/package.json')('pg');
const {routeGoogle}=await import(pathToFileURL(tree+'/services/api/test/google-harness.mjs'));
const receipt={label:'exact staging build, synthetic Google harness',sha:m.sha,startedAt:new Date().toISOString(),node:process.version,freshnessReason:process.env.PULSE_GOOGLE_MATRIX_REASON,workers:1,checks:[],limits:['No live-provider round trip: staging has no Google client (EST-127 item 34); Willow Lane uses its own client.']};
const save=()=>writeFileSync(out+'/matrix-results.json',JSON.stringify(receipt,null,2)+'\n');
const check=async(name,fn)=>{try{const detail=await fn();receipt.checks.push({name,passed:true,...(detail?{detail}:{})});console.log('PASS '+name);}catch(e){receipt.checks.push({name,passed:false,error:String(e.message).slice(0,1000)});console.log('FAIL '+name+': '+String(e.message).slice(0,180));}save();};
const db=new Pool({connectionString:`postgresql://postgres@/pulse_ci?host=${scratch}/pg&port=55439`,max:1,statement_timeout:15000,connectionTimeoutMillis:10000});
const browser=await chromium.launch({headless:true});
const anon=await pwRequest.newContext({ignoreHTTPSErrors:true});
const select=async(identity,session)=>{const r=await fetch(m.googleOrigin+'/session',{method:'POST',body:JSON.stringify({identity,session})});assert.equal(r.status,200);};
const context=async()=>{const c=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});await routeGoogle(c,m.googleOrigin);c.setDefaultTimeout(15000);c.setDefaultNavigationTimeout(20000);return c;};
const post=(c,path,data={})=>c.request.post(m.origin+path,{headers:{origin:m.origin},data});
const me=c=>c.request.get(m.origin+'/api/v0/me');
const go=async(p,mode,next)=>{await p.goto(m.origin+'/api/v0/auth/google/start?'+new URLSearchParams({mode,...(next?{next}:{})}));};
const signedIn=async(c,identity='linked',next=m.links.task)=>{await select(identity,true);const p=await c.newPage();await go(p,'signin',next);assert.equal((await me(c)).status(),200);return p;};
const reason=(p,value)=>{assert.equal(new URL(p.url()).origin,m.origin);assert.equal(new URL(p.url()).searchParams.get('google'),value);};
const cookie=async c=>(await c.cookies()).find(x=>x.name==='pulse_session');
const count=async sql=>Number((await db.query(sql)).rows[0].n);
let adminContext;
try {
 await check('staging same runtime SHA and signed-out fail-closed probes',async()=>{
  const headers={host:'pulse-staging.estateautopilots.com'};
  await hostEcho();
  let r=await stagingRequest('/healthz',{headers});assert.equal(r.status,200);assert.equal((await r.json()).release,m.sha);
  r=await stagingRequest('/api/v0/auth/branding',{headers});assert.equal(r.status,200);assert.equal((await r.json()).google,false);
  const probes=[];
  for(const [method,path,status] of [['GET','/api/v0/me',401],['GET','/api/v0/auth/account',401],['GET','/api/v0/admin/sign-in/google',401],['PUT','/api/v0/admin/sign-in/google',401],['POST','/api/v0/auth/google/unlink',401],['POST','/api/v1/service/quotes/00000000-0000-0000-0000-000000000001/ready-notice',401]]){
   const h={...headers,...(method!=='GET'?{'content-type':'application/json',origin:'https://pulse-staging.estateautopilots.com'}:{})};
   r=await stagingRequest(path,{method,headers:h,...(method!=='GET'?{body:'{}'}:{}),redirect:'manual'});assert.equal(r.status,status,method+' '+path);assert.ok(!/pulse_session=[^;]/.test(r.headers.get('set-cookie')??''));probes.push({method,path,status:r.status});
  }
  for(const mode of ['signin','silent','link']){r=await stagingRequest('/api/v0/auth/google/start?'+new URLSearchParams({mode,next:'//outside.example.test'}),{headers,redirect:'manual'});assert.equal(r.status,302);assert.ok((r.headers.get('location')??'').startsWith(mode==='link'?'/account?google=provider_error':'/login?'));assert.ok(!/pulse_session=[^;]/.test(r.headers.get('set-cookie')??''));probes.push({mode,status:r.status,sessionIssued:false});}
  await malformedCallback();
  return {runtimeSha:m.sha,google:false,probes,invalidCallbackRefused:true,accessPath:'loopback staging HTTP with canonical Host; public HTTPS remains behind Cloudflare Access'};
 });
 await check('staging signed-out login screenshot and password fallback',async()=>{const c=await browser.newContext({serviceWorkers:'block'});try{await c.route('https://pulse-staging.estateautopilots.com/**',async route=>{const u=new URL(route.request().url());const r=await stagingRequest(u.pathname+u.search,{method:route.request().method(),headers:route.request().headers(),body:route.request().postDataBuffer()??undefined});await route.fulfill({status:r.status,headers:Object.fromEntries(r.headers),body:r.body});});const p=await c.newPage();await p.goto('https://pulse-staging.estateautopilots.com/login?out=1');await p.getByRole('textbox',{name:'Username',exact:true}).waitFor();await p.getByRole('button',{name:'Sign in',exact:true}).waitFor();assert.equal(await p.getByRole('link',{name:'Continue with Google',exact:true}).count(),0);await p.screenshot({path:out+'/staging-google-disabled-login.png',fullPage:true});return {passwordFallbackVisible:true,googleHidden:true,signedOutOnly:true,transport:'canonical public origin routed to existing loopback staging; Cloudflare credentials unused'};}finally{await c.close();}});
 await check('harness exact SHA, credentials permissions and policy defaults',async()=>{
  assert.equal(m.sha,process.env.PULSE_GOOGLE_MATRIX_SHA);assert.equal(statSync(m.credentialsFile).mode&0o777,0o600);
  const d=(await db.query('select trust_google_2_step from pulse_priv.google_settings where org_id=$1',[m.orgs.a])).rows[0];assert.equal(d.trust_google_2_step,false);
  const pol=(await db.query('select coalesce((select required from pulse_priv.auth_policy where org_id=$1),false) required',[m.orgs.a])).rows[0];assert.equal(pol.required,false);
  return {trustGoogle2Step:false,pulseTwoStepEnforced:false,syntheticProviderDoesNotAssertGoogleTwoStep:true};
 });
 await check('linked-only Google sign-in issues a secure Pulse session',async()=>{const c=await context();try{const p=await signedIn(c);assert.equal(new URL(p.url()).pathname,m.links.task);const ck=await cookie(c);assert.ok(ck?.secure&&ck.httpOnly&&ck.sameSite==='Lax');assert.ok(!(await c.cookies()).some(x=>x.name==='pulse_oidc'));assert.ok(!/code=|token=/.test(p.url()));const row=(await db.query('select via from pulse.login_session where token_hash=$1',[createHash('sha256').update(ck.value).digest('hex')])).rows[0];assert.equal(row.via,'google');return {me:200,via:'google',secure:true,httpOnly:true,sameSite:'Lax'};}finally{await c.close();}});
 for(const [identity,expected] of [['unlinked','not_linked'],['disabled','account_disabled'],['wrong-domain','domain_not_allowed'],['other-org','not_linked'],['unverified','provider_error']]){
  await check(identity+' Google identity refused without a session or person creation',async()=>{const n=await count('select count(*) n from pulse.person'),c=await context();try{await select(identity,true);const p=await c.newPage();await go(p,'signin',m.links.task);reason(p,expected);assert.equal((await me(c)).status(),401);assert.equal(!!await cookie(c),false);assert.equal(await count('select count(*) n from pulse.person'),n);return {reason:expected,me:401,peopleUnchanged:true};}finally{await c.close();}});
 }
 await check('first Google link through Account, sign-in, unlink and existing-session revocation',async()=>{
  const c=await context(),other=await context();try{
   const p=await c.newPage();await p.goto(m.origin+'/login?out=1');await p.getByRole('textbox',{name:'Username',exact:true}).fill(m.people.unlinked.username);await p.getByLabel('Password',{exact:true}).fill(credentials.password);await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.waitForURL(u=>!u.pathname.startsWith('/login'));
   await select('unlinked',false);await p.goto(m.origin+'/account');await p.getByRole('tab',{name:'Google',exact:true}).click();await p.getByRole('link',{name:'Link Google',exact:true}).click();await p.getByText('Google account linked. You can now use Continue with Google on the sign-in page.',{exact:true}).waitFor();
   const linked=await db.query('select 1 from pulse_priv.google_identity where org_id=$1 and person_id=$2',[m.orgs.a,m.people.unlinked.id]);assert.equal(linked.rowCount,1);
   await signedIn(other,'unlinked',m.links.task);
   let r=await post(c,'/api/v0/auth/google/unlink');assert.equal(r.status(),200);assert.equal((await me(other)).status(),401);assert.equal((await me(c)).status(),200);
   await post(c,'/api/v0/auth/sign-out');await select('unlinked',true);await go(p,'signin');reason(p,'not_linked');assert.equal((await me(c)).status(),401);
   return {linked:true,subsequentGoogleSignIn:200,unlink:200,nextGoogleSessionRequest:401,passwordSessionRetained:true};
  }finally{await other.close();await c.close();}
 });
 await check('quiet sign-in fallback occurs once and password/Google choices remain usable',async()=>{const c=await context();try{await select('linked',false);let attempts=0;const p=await c.newPage();p.on('request',r=>{const u=new URL(r.url());if(u.pathname==='/api/v0/auth/google/start'&&u.searchParams.get('mode')==='silent')attempts++;});await p.goto(m.origin+'/login?'+new URLSearchParams({next:m.links.task}));await p.waitForURL(u=>u.searchParams.get('google')==='silent_failed');await p.getByRole('textbox',{name:'Username',exact:true}).waitFor();await p.getByRole('link',{name:'Continue with Google',exact:true}).waitFor();assert.equal(attempts,1);assert.equal((await me(c)).status(),401);await p.reload();await p.getByRole('button',{name:'Sign in',exact:true}).waitFor();await p.goto(m.origin+'/login?'+new URLSearchParams({next:m.links.task}));await p.getByRole('textbox',{name:'Username',exact:true}).waitFor();assert.equal(attempts,1);return {silentAttempts:attempts,me:401,reloadAndReentryDoNotLoop:true};}finally{await c.close();}});
 await check('quiet sign-in succeeds and returns to the requested document',async()=>{const c=await context();try{await select('linked',true);let attempts=0;const p=await c.newPage();p.on('request',r=>{const u=new URL(r.url());if(u.pathname==='/api/v0/auth/google/start'&&u.searchParams.get('mode')==='silent')attempts++;});await p.goto(m.origin+'/login?'+new URLSearchParams({next:m.links.document}));await p.waitForURL(u=>u.pathname===m.links.document);assert.equal((await me(c)).status(),200);assert.equal(attempts,1);return {silentAttempts:1,me:200,return:'document'};}finally{await c.close();}});
 for(const kind of ['client','task','document','quote'])await check(kind+' deep-link return preserves the exact target',async()=>{const c=await context();try{const p=await signedIn(c,'linked',m.links[kind]);assert.equal(new URL(p.url()).origin,m.origin);assert.equal(new URL(p.url()).pathname,m.links[kind]);assert.equal((await p.request.get(p.url())).status(),200);return {target:kind,httpStatus:200};}finally{await c.close();}});
 for(const [label,value] of [['absolute','https://outside.example.test'],['protocol-relative','//outside.example.test'],['encoded-control','/%09/outside.example.test'],['backslash','/\\outside.example.test'],['api-return','/api/v0/me'],['login-return','/login']])await check('unsafe '+label+' return is rejected',async()=>{const c=await context();try{const p=await signedIn(c,'linked',value);assert.equal(new URL(p.url()).origin,m.origin);assert.ok(['/','/dashboard'].includes(new URL(p.url()).pathname),'unsafe target did not fall back to home');return {sameOriginHome:true};}finally{await c.close();}});
 await check('local logout revokes the old Pulse session and leaves synthetic Google signed in',async()=>{const c=await context();try{const p=await signedIn(c),ck=await cookie(c);let r=await post(c,'/api/v0/auth/sign-out');assert.equal(r.status(),200);assert.equal((await me(c)).status(),401);r=await anon.get(m.origin+'/api/v0/me',{headers:{cookie:'pulse_session='+ck.value}});assert.equal(r.status(),401);let attempts=0;p.on('request',r=>{const u=new URL(r.url());if(u.pathname==='/api/v0/auth/google/start'&&u.searchParams.get('mode')==='silent')attempts++;});await p.goto(m.origin+'/login?out=1');await p.getByRole('textbox',{name:'Username',exact:true}).waitFor();assert.equal(attempts,0);await go(p,'silent',m.links.client);assert.equal((await me(c)).status(),200);assert.equal(new URL(p.url()).pathname,m.links.client);return {logout:200,nextRequest:401,oldCookieReplay:401,automaticAttemptsAfterLogout:0,explicitQuietGoogleStillSucceeds:true};}finally{await c.close();}});
 await check('Pulse TOTP is required with Trust Google 2-step OFF and enforcement OFF',async()=>{
  adminContext=await context();await select('admin',true);const p=await adminContext.newPage();await go(p,'signin',m.links.quote);reason(p,'two_step');assert.equal((await me(adminContext)).status(),401);assert.equal(!!await cookie(adminContext),false);
  const challenge=(await adminContext.cookies()).find(x=>x.name==='pulse_two_step');assert.ok(challenge?.httpOnly&&challenge.secure);assert.ok(!/challenge=|token=|code=/.test(p.url()));
  await p.getByLabel('Authenticator or recovery code').waitFor();await p.screenshot({path:out+'/synthetic-google-totp.png'});
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const mac=createHmac('sha1',Buffer.from(credentials.adminTotpHex,'hex')).update(counter).digest(),offset=mac[mac.length-1]&15,code=String((mac.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
  await p.getByLabel('Authenticator or recovery code').fill(code);await p.getByRole('button',{name:'Verify and sign in',exact:true}).click();await p.waitForURL(u=>u.pathname===m.links.quote);assert.equal((await me(adminContext)).status(),200);assert.ok(!(await adminContext.cookies()).some(x=>x.name==='pulse_two_step'));
  const r=await adminContext.request.get(m.origin+'/api/v0/admin/sign-in/google');assert.equal(r.status(),200);assert.equal((await r.json()).trustGoogle2Step,false);
  const row=(await db.query('select second_factor_verified,via from pulse.login_session where token_hash=$1',[createHash('sha256').update((await cookie(adminContext)).value).digest('hex')])).rows[0];assert.equal(row.second_factor_verified,true);assert.equal(row.via,'google');
  return {trustGoogle2Step:false,pulseTwoStepEnforced:false,beforeTotp:401,afterTotp:200,secondFactorVerified:true,via:'google'};
 });
 await check('admin end-all-sessions rejects the next request from both Google sessions',async()=>{assert.ok(adminContext,'admin TOTP sign-in must succeed');const a=await context(),b=await context();try{await signedIn(a);await signedIn(b);const r=await post(adminContext,'/api/v0/people/'+m.people.linked.id+'/login',{action:'sign-out-all'});assert.equal(r.status(),200);assert.equal((await me(a)).status(),401);assert.equal((await me(b)).status(),401);return {adminAction:200,nextRequestA:401,nextRequestB:401};}finally{await a.close();await b.close();}});
 await check('staging runtime still matches the tested build at matrix completion',async()=>{const r=await stagingRequest('/healthz');assert.equal(r.status,200);const sha=(await r.json()).release;assert.equal(sha,m.sha);return {runtimeSha:sha};});
 await check('policy remains Trust Google 2-step OFF and enforcement OFF',async()=>{const d=(await db.query('select trust_google_2_step from pulse_priv.google_settings where org_id=$1',[m.orgs.a])).rows[0];assert.equal(d.trust_google_2_step,false);assert.equal((await db.query('select coalesce((select required from pulse_priv.auth_policy where org_id=$1),false) required',[m.orgs.a])).rows[0].required,false);return {trustGoogle2Step:false,pulseTwoStepEnforced:false};});
}finally{if(adminContext)await adminContext.close();await anon.dispose();await browser.close();await db.end();receipt.endedAt=new Date().toISOString();receipt.passed=receipt.checks.every(x=>x.passed);receipt.passedChecks=receipt.checks.filter(x=>x.passed).length;receipt.totalChecks=receipt.checks.length;save();}
console.log(`Independent Google matrix ${receipt.passed?'PASS':'ADVERSE'}: ${receipt.passedChecks}/${receipt.totalChecks} @ ${m.sha}`);
process.exitCode=receipt.passed?0:1;
