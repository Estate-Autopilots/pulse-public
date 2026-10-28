import { companyOrigin, hostCompany } from './tenant-context.js';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {PoolClient} from 'pg';
import {fail,normalizedOrgName,sessionHash,type Tx,type Open} from './routes.js';
import {authMail,authMailAvailable,passwordNotice} from './auth-mail.js';
import {companyMailboxReady,hostedMailCompany,mailRefusal} from './mailbox.js';
import {base32,deviceLabel,passwordError} from './auth-policy.js';
import {googleConfigured,readGooglePolicy,registerGoogleSignIn} from './google-sign-in.js';
import {googleOwnAddress,type GoogleConfiguration} from './google-sign-in-flow.js';
type Body=Record<string,unknown>;
const body={type:'object',maxProperties:15,additionalProperties:true} as const;
const secret=()=>randomBytes(32).toString('base64url');
const neutral={ok:true,message:'If an eligible account matches and mail delivery is available, a recovery email may arrive. Check spam or ask your admin for a new link.'};
const text=(v:unknown,max=254)=>String(v??'').slice(0,max);
const clientHash=(req:FastifyRequest,r:string)=>sessionHash(String(req.headers[r==='staff'?'x-pulse-session':'x-pulse-client-session']??''));
export const authIp=(req:FastifyRequest)=>String(req.headers['x-pulse-client-ip']??req.ip);
const device=(req:FastifyRequest)=>deviceLabel(String(req.headers['x-pulse-device-agent']??req.headers['user-agent']??''));
function link(r:string,k:string,token:string){const url=new URL(r==='staff'?k==='email'?'/login/confirm-email':k==='signin'?'/login/link':'/login/set-password':k==='email'?'/portal/confirm-email':'/portal/set-password',companyOrigin());url.hash=token;return url.href;}
// PEOPLE-CONTACTS: a one-time sign-in link (HR's "Send sign-in link") signs the person in once, within 15 minutes.
export async function sendLink(r:string,k:string,token:string,result:Body,google=false){
 // ONBOARD: an invitation to an allowed Workspace address is a Continue with Google invitation (no password to choose).
 if(k==='invite'&&r==='staff'&&google)return authMail(result.delivery,'Your Pulse sign-in link',googleInviteBody(String(result.delivery??''),link(r,k,token)));
 if(k==='signin')return authMail(result.delivery,'Sign in to Pulse',`Your Pulse username: ${result.username}\n\nSign in: ${link(r,k,token)}\n\nHR sent you this private link. It signs you in once and expires in 15 minutes; if you use two-step verification, Pulse still asks for your code. If you did not expect it, ignore this email and tell HR.`);
 return authMail(result.delivery,k==='email'?'Confirm your Pulse delivery email':k==='invite'?'Your Pulse sign-in link':'Reset your Pulse password',`Your Pulse username: ${result.username}\n\n${k==='email'?'Confirm email':k==='invite'?'Choose your password':'Reset password'}: ${link(r,k,token)}\n\nThis private link works once and expires in ${k==='invite'?'7 days':'60 minutes'}. If you did not request it, ignore this email.`);}
/** "asha.rao@example.com" → "as•••@example.com": where a link went, without repeating the address on screen. */
const masked=(e:unknown)=>{const [n,d]=String(e??'').split('@');return d?`${n.slice(0,2)}•••@${d}`:'';};
/** ONBOARD: whether an invitation to this address can be accepted with Google here: sign-in with Google is configured and
 *  on, and the address is on one of the organisation's allowed Workspace domains. */
export function googleInvitable(policy:{enabled?:unknown;allowedDomains?:unknown},address:unknown){
 const a=String(address??'').trim().toLowerCase(),domains=Array.isArray(policy.allowedDomains)?policy.allowedDomains:[];
 return googleConfigured()&&policy.enabled===true&&/^[^\s@]+@[^\s@]+$/.test(a)&&domains.includes(a.split('@')[1]);
}
/** ONBOARD: the invitation e-mail's words when the company Google account is the Pulse login. */
export const googleInviteBody=(address:string,url:string,name?:string)=>`${name?`Hello ${name},\n\n`:''}Your company Google account (${address}) is your Pulse login.\n\nOpen this private link and press Continue with Google: ${url}\n\nThere is no Pulse password to choose: you sign in with Google, the same account as your company e-mail. The link works once and expires in 7 days. Forgot your Google password? Reset it at Google, or ask the admin.\n\nHow you get into Pulse: ${new URL('/login/how',companyOrigin()).href}`;
export function registerAccountSecurity(app:FastifyInstance,{tx,open,google}:{tx:Tx;open:Open;google?:GoogleConfiguration}){
 registerGoogleSignIn(app,tx,open,(result,d,id)=>void noticeNew('staff',result,d,id),google);
 const account=<T>(req:FastifyRequest,r:string,run:(c:PoolClient)=>Promise<T>)=>r==='staff'?tx(req,async(c,v)=>{if(v.via!=='password'||v.nativeDevice)fail(403,'Use your browser account session');return run(c);}):open(async c=>{const t=req.headers['x-pulse-client-session'];if(typeof t!=='string')fail(401,'Sign in to your client portal');await c.query('select pulse.portal_auth($1)',[sessionHash(String(t))]);return run(c);});
 const allow=(req:FastifyRequest,key:string,limit:number)=>open(async c=>(await c.query('select pulse.auth_allow($1,$2) ok',[sessionHash(key+':'+authIp(req)),limit])).rows[0].ok);
 const brandingResponse={type:'object',additionalProperties:false,required:['name','google'],properties:{name:{type:'string'},google:{type:'boolean'}}} as const;
 app.get('/api/v0/auth/branding',{schema:{response:{200:brandingResponse}}},req=>open(async(c,org)=>{
  const row=(await c.query('select name from pulse.org where id=$1',[org])).rows[0] as {name?:string}|undefined;
  // EST-1399's login page shows Continue with Google from this: configured and switched on for the org, nothing else.
  return {name:normalizedOrgName(row?.name),google:googleConfigured()&&googleOwnAddress(req)&&(await readGooglePolicy(c)).enabled===true};
 }));
 for(const r of ['staff','client']){
  const prefix='/api/v0/'+(r==='staff'?'auth':'portal/auth');
  app.post<{Body:Body}>(prefix+'/sign-in',{schema:{body}},async req=>{
   const accountAllowed=await open(async c=>(await c.query('select pulse.auth_allow($1,20) ok',[sessionHash(r+'-login-account:'+text(req.body.username,60).trim().toLowerCase())])).rows[0].ok);
   if(!await allow(req,r+'-login',30)||!accountAllowed)fail(429,'Too many attempts. Try again in 15 minutes.');
   const token=secret(),challenge=secret();
   const result=await open(async c=>(await c.query('select pulse.auth_login($1,$2,$3,$4,$5,$6,$7) d',[r,text(req.body.username,60),text(req.body.password,200),sessionHash(challenge),sessionHash(token),req.body.remember===true||req.body.remember==='on',device(req)])).rows[0].d);
   if(!result||result.failed){if(result?.delivery)void sendNotice(r,result,'Pulse account temporarily locked','Your account is locked for 15 minutes after unsuccessful attempts. Wait, use Forgot your password, or ask HR to Unlock your account.').catch(()=>{});fail(401,'Sign-in details are unavailable or temporarily locked. Wait 15 minutes, use Forgot your password, or ask HR to unlock your account.');}
   if(result.twoStep)return {twoStep:true,challenge};
   // AUTH-UNIFY (1291): at the shared address, a person with a Pulse account lands in the workspace they used last (the
   // same session moves there). An issued password to change, or two-step to set up, keeps them here first.
   if(r==='staff'&&!result.mustChange&&!result.enrollmentRequired&&!hostCompany()){const landed=await open(async c=>(await c.query('select pulse.account_land($1) d',[sessionHash(token)])).rows[0].d).catch(()=>null);if(landed)result.org=landed.org;}
   // First sign-in on each browser/OS is a new-device notice, without IP or personal location data.
   void noticeNew(r,result,device(req),String(req.headers['x-pulse-device-id']??sessionHash(String(req.headers['user-agent']??'API'))));delete result.actor;delete result.delivery;return {...result,token};
  });
  app.post<{Body:Body}>(prefix+'/two-step',{schema:{body}},async req=>{
   if(!await allow(req,r+'-otp',15))fail(429,'Too many attempts. Try again in 15 minutes.');
   const challenge=text(req.body.challenge,64);if(!/^[A-Za-z0-9_-]{43}$/.test(challenge))fail(401,'Verification is unavailable');
   const token=secret();const result=await open(async c=>(await c.query('select pulse.auth_challenge_finish($1,$2,$3,$4) d',[r,sessionHash(challenge),text(req.body.code,40),sessionHash(token)])).rows[0].d);
   if(!result)fail(401,'Code or challenge is unavailable. Use a fresh code, recovery code, or ask HR for help.');void noticeNew(r,result,device(req),String(req.headers['x-pulse-device-id']??sessionHash(String(req.headers['user-agent']??'API'))));delete result.actor;delete result.delivery;return {...result,token};
  });
  for(const k of ['reset','username'])app.post<{Body:Body}>(prefix+(k==='reset'?'/forgot':'/forgot-username'),{schema:{body}},async(req,reply)=>{
   const started=Date.now(),token=secret(),input=text(req.body.username??req.body.email).trim().toLowerCase();
   const result=await open(async c=>{
    const ip=(await c.query('select pulse.auth_allow($1,10) ok',[sessionHash(r+'-recovery:'+authIp(req))])).rows[0].ok;
    const key=(await c.query('select pulse.auth_allow($1,5) ok',[sessionHash(r+'-recovery-input:'+input)])).rows[0].ok;
    // MAILBOX: another company's recovery mail goes out from its own connected mailbox; without one it is counted.
    if(!authMailAvailable()&&!(await companyMailboxReady(c))){if(hostedMailCompany())await c.query('select pulse.org_mail_blocked_note()');return {mailUnavailable:true};}
    return ip&&key?(await c.query('select pulse.auth_recover($1,$2,$3,$4) d',[r,input,k,sessionHash(token)])).rows[0].d:null;
   });
   if(result?.mailUnavailable)return reply.code(503).send({code:'MAIL_UNAVAILABLE',error:'Mail is unavailable; ask your admin for a new link.'});
   // Delivery does not change response timing or content. Nothing containing a capability is persisted.
   if(result)setImmediate(()=>{void (k==='username'?authMail(result.delivery,'Your Pulse username',`Your Pulse username: ${result.username}\n\nSign in at ${companyOrigin()}${r==='client'?'/portal/login':'/login'}.`):sendLink(r,k,token,result)).then(ok=>recordMail(r,result.actor,ok)).catch(()=>{});});
   await new Promise(done=>setTimeout(done,Math.max(0,350-(Date.now()-started))));return neutral;
  });
  app.post<{Body:Body}>(prefix+'/set-password',{schema:{body}},async req=>{
   if(!await allow(req,r+'-redeem',10))fail(429,'Too many attempts. Try again in 15 minutes.');
   const token=text(req.body.token,64),password=text(req.body.password,200),error=passwordError(password);if(error)fail(400,error);
   const permitted=await open(async c=>(await c.query('select pulse.auth_allow($1,5) ok',[sessionHash('redeem-link:'+sessionHash(token))])).rows[0].ok);if(!permitted)fail(429,'Too many attempts. Try again in 15 minutes.');
   if(!/^[A-Za-z0-9_-]{43}$/.test(token))fail(400,'This link is unavailable. Request a fresh link.');
   const session=secret();const result=await open(async c=>(await c.query('select pulse.auth_redeem($1,$2,$3,$4,$5,$6) d',[r,sessionHash(token),password,text(req.body.code,40),sessionHash(session),device(req)])).rows[0].d);
   if(!result)fail(400,'This link is unavailable. Request a fresh link.');if(result.twoStep)return {twoStep:true};
   void sendNotice(r,result,'Pulse password changed',passwordNotice);delete result.actor;delete result.delivery;return {...result,token:session};
  });
  app.post<{Body:Body}>(prefix+'/confirm-email',{schema:{body}},async req=>{
   if(!await allow(req,r+'-email-confirm',10))fail(429,'Too many attempts. Try again in 15 minutes.');
   const token=text(req.body.token,64);if(!/^[A-Za-z0-9_-]{43}$/.test(token))fail(400,'Confirmation link unavailable');
   const result=await open(async c=>(await c.query('select pulse.auth_email_confirm($1,$2) d',[r,sessionHash(token)])).rows[0].d);if(!result)fail(400,'Confirmation link unavailable');
   for(const to of new Set([result.oldDelivery,result.delivery]))void sendNotice(r,{...result,delivery:to},'Pulse delivery email changed','Your Pulse delivery email was changed. HR can see this change in your account history. If this was not you, contact HR immediately.');return {ok:true};
  });
  app.get(prefix+'/account',req=>account(req,r,async c=>({...((await c.query('select pulse.auth_account_action($1,\'state\',\'{}\',$2) d',[r,clientHash(req,r)])).rows[0].d),...(r==='staff'?{googleLink:(await c.query('select pulse.google_link_state() d')).rows[0].d}:{})})));
  app.post<{Body:Body}>(prefix+'/account',{schema:{body}},async req=>{
   await account(req,r,async()=>{});
   const op=text(req.body.action,30);if(!['session-end','sign-out-others','email-start','totp-start','totp-enable','totp-disable'].includes(op))fail(400,'Choose an account action');
   const token=secret(),b={...req.body,hash:sessionHash(token)};
   const result=await account(req,r,async c=>(await c.query('select pulse.auth_account_action($1,$2,$3,$4) d',[r,op,JSON.stringify(b),clientHash(req,r)])).rows[0].d);
   if(result.error)fail(400,result.error);
   if(result.secretHex){const setupKey=base32(result.secretHex);delete result.secretHex;return {setupKey,uri:`otpauth://totp/Pulse:${r}?secret=${setupKey}&issuer=Pulse&algorithm=SHA1&digits=6&period=30`};}
   if(op==='email-start'){const sent=await sendLink(r,'email',token,result);if(!sent)await mailRefusal('Email delivery is unavailable. HR can help.');}return {ok:true,...(result.recoveryCodes?{recoveryCodes:result.recoveryCodes}:{})};
  });
  app.post<{Body:Body}>(prefix+'/change-password',{schema:{body}},async req=>{
   await account(req,r,async()=>{});
   const next=text(req.body.next,200),error=passwordError(next);if(error)fail(400,error);
   const result=await account(req,r,async c=>(await c.query('select pulse.auth_account_action($1,\'change-password\',$2,$3) d',[r,JSON.stringify({...req.body,next}),clientHash(req,r)])).rows[0].d);
   if(result.error)fail(400,result.error);void sendNotice(r,result,'Pulse password changed',passwordNotice);return {ok:true};
  });
 }
 // ONBOARD: the set-password page asks once (the token in the body, never a URL) whether its link is an open invitation
 // that may use Google. Google is offered for an invitation to an allowed Workspace address while sign-in with Google is
 // on here; the answer carries the invited address and a 15-minute ticket for one Google attempt (google/start).
 app.post<{Body:Body}>('/api/v0/auth/invite-peek',{schema:{body}},async req=>{
  if(!await allow(req,'staff-invite-peek',30))fail(429,'Too many attempts. Try again in 15 minutes.');
  const token=text(req.body.token,64);if(!/^[A-Za-z0-9_-]{43}$/.test(token))fail(400,'This link is unavailable. Request a fresh link.');
  const ticket=secret(),result=await open(async c=>(await c.query('select pulse.google_invite_peek($1,$2) d',[sessionHash(token),sessionHash(ticket)])).rows[0].d);
  if(!result)return {invite:false,google:false};
  return result.google===true&&googleConfigured()&&googleOwnAddress(req)?{invite:true,google:true,email:result.email,ticket}:{invite:true,google:false};
 });
 // PEOPLE-CONTACTS: redeeming a one-time sign-in link (staff only). The token arrives in the page's fragment, so it
 // never reaches access logs; the person presses "Sign in" (mail scanners that open links do not use it up).
 app.post<{Body:Body}>('/api/v0/auth/link-sign-in',{schema:{body}},async req=>{
  if(!await allow(req,'staff-signin-link',10))fail(429,'Too many attempts. Try again in 15 minutes.');
  const token=text(req.body.token,64);if(!/^[A-Za-z0-9_-]{43}$/.test(token))fail(400,'This sign-in link is unavailable. Ask HR for a fresh one.');
  const permitted=await open(async c=>(await c.query('select pulse.auth_allow($1,5) ok',[sessionHash('signin-link:'+sessionHash(token))])).rows[0].ok);if(!permitted)fail(429,'Too many attempts. Try again in 15 minutes.');
  const session=secret();
  const result=await open(async c=>(await c.query('select pulse.auth_link_sign_in($1,$2,$3,$4,$5) d',['staff',sessionHash(token),text(req.body.code,40),sessionHash(session),device(req)])).rows[0].d);
  if(!result)fail(400,'This sign-in link is unavailable: it was used, expired, or replaced by a newer one. Ask HR for a fresh one.');
  if(result.twoStep)return {twoStep:true,failed:result.failed===true};
  void noticeNew('staff',result,device(req),String(req.headers['x-pulse-device-id']??sessionHash(String(req.headers['user-agent']??'API'))));delete result.actor;delete result.delivery;return {...result,token:session};
 });
 const adminAction=async(req:FastifyRequest<{Params:{id:string};Body:Body}>,realm='staff',reply?:FastifyReply)=>{
  const op=text(req.body.action,30),token=secret();
  if(realm==='staff'&&op==='google-unlink'){if(Object.keys(req.body).some(k=>k!=='action'))fail(400,'Unknown Google unlink field');return tx(req,async c=>{if(!(await c.query("select pulse.viewer_is('admin') ok")).rows[0].ok)fail(403,'Admin required');return (await c.query('select pulse.google_unlink($1) d',[req.params.id])).rows[0].d;});}
  // Links go out only on an explicit, confirmed click (owner, 11 Oct 2026).
  if(op==='signin'&&req.body.confirmed!==true)fail(400,'Confirm sending the sign-in link first');
  const emailAction=realm==='staff'&&['email-work-save','email-delivery-save','email-delivery-verify'].includes(op);
  const result=await tx(req,async c=>emailAction
   ?(await c.query('select pulse.auth_admin_email($1,$2,$3) d',[req.params.id,op,JSON.stringify({...req.body,hash:sessionHash(token)})])).rows[0].d
   :(await c.query('select pulse.auth_admin($1,$2,$3,$4) d',[realm,req.params.id,op,JSON.stringify({...req.body,hash:sessionHash(token)})])).rows[0].d);
  if(op==='email-delivery-verify'&&emailAction){const sent=await sendLink(realm,'email',token,result);await recordMail(realm,req.params.id,sent);if(!sent)return reply!.code(503).send({error:'Address saved, but confirmation email could not be delivered. Retry when email delivery is available.'});return {ok:true,sent:true};}
  if(['invite','reset'].includes(op)){const sent=await sendLink(realm,op,token,result,op==='invite'&&realm==='staff'&&googleInvitable(await open(readGooglePolicy),result.delivery));await recordMail(realm,req.params.id,sent);if(!sent)await mailRefusal('Email could not be delivered. Check the address, or use Copy link for private delivery.');return {ok:true,sent:true};}
  if(op==='signin'){const sent=await sendLink(realm,'signin',token,result);await recordMail(realm,req.params.id,sent);if(!sent)await mailRefusal('The sign-in link could not be e-mailed. Check the delivery address, or send a password reset link later.');return {ok:true,sent:true,to:masked(result.delivery),expiresAt:result.expiresAt};}
  if(op==='copy')return {link:link(realm,'reset',token),warning:'Shown once. This private link gives access to this account. Deliver only after checking identity; never post it in a group chat.',expiresAt:result.expiresAt};
  return result;
 };
 app.post<{Params:{id:string};Body:Body}>('/api/v0/people/:id/login',{schema:{body}},(req,reply)=>adminAction(req,'staff',reply));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/admin/client-accounts/:id',{schema:{body}},req=>adminAction(req,'client'));
 app.get('/api/v0/admin/client-accounts',req=>tx(req,async c=>({people:(await c.query("select pulse.auth_admin_state('client') d")).rows[0].d})));
 app.post<{Body:Body}>('/api/v0/delivery/client-access/issue',{schema:{body}},async req=>{
  if(req.body.id)fail(410,'Use the client account link controls');
  const token=secret(),result=await tx(req,async c=>(await c.query('select pulse.auth_client_create($1,$2,$3,$4) d',[text(req.body.username,60),text(req.body.name,160),text(req.body.email),sessionHash(token)])).rows[0].d);
  if(result.delivery){const sent=await sendLink('client','invite',token,result);await recordMail('client',result.actor,sent);if(!sent)await mailRefusal('Client account created, but email failed. Use Account access to resend.');return {id:result.actor,sent:true};}
  return {id:result.actor,link:link('client','invite',token),warning:'Shown once. Deliver privately after checking identity. Never post in a group chat.'};
 });
 app.post<{Body:Body}>('/api/v0/admin/resend-expired',async req=>{
  const rows=await tx(req,async c=>(await c.query("select pulse.auth_admin_state('staff') d")).rows[0].d);let sent=0,failed=0;
  // Never in bulk without confirmation (owner, 11 Oct 2026): the caller first sees how many would get a link.
  const due=rows.filter((p:Body)=>p.authStatus==='link expired'&&p.delivery);
  if(req.body?.confirmed!==true)return {confirm:true,count:due.length};
  for(const row of due){
   const token=secret();try{const result=await tx(req,async c=>(await c.query("select pulse.auth_admin('staff',$1,'invite',$2) d",[row.id,JSON.stringify({hash:sessionHash(token)})])).rows[0].d);const ok=await sendLink('staff','invite',token,result,googleInvitable(await open(readGooglePolicy),result.delivery));await recordMail('staff',row.id,ok);if(ok)sent++;else failed++;}catch{failed++;}
  }return {sent,failed};
 });
 app.get<{Params:{id:string}}>('/api/v0/admin/auth-history/:id',req=>tx(req,async c=>{
  const state=(await c.query("select pulse.auth_admin('staff',$1,'history','{}') d",[req.params.id])).rows[0].d;
  return {...state,...(await c.query("select pulse.auth_admin_email($1,'email-state','{}') d",[req.params.id])).rows[0].d};
 }));
 app.get('/api/v0/auth-review',req=>tx(req,async(c,v)=>({people:(await c.query('select pulse.auth_stuck() d')).rows[0].d,canManage:['admin','hr'].includes(v.role)})));
 app.get('/api/v0/admin/auth-policy',req=>tx(req,async c=>(await c.query('select pulse.auth_policy_save() d')).rows[0].d));
 app.post<{Body:Body}>('/api/v0/admin/auth-policy',{schema:{body}},req=>tx(req,async c=>(await c.query('select pulse.auth_policy_save($1) d',[JSON.stringify(req.body)])).rows[0].d));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/admin/reset-requests/:id',{schema:{body}},async req=>{
  const row=await tx(req,async(c,v)=>{if(!['admin','hr'].includes(v.role))fail(403,'HR or admin required');return (await c.query('select person_id from pulse.password_reset_request where id=$1 and status=\'pending\'',[req.params.id])).rows[0];});if(!row)fail(409,'This request is already closed');
  if(req.body.action==='dismiss'||!row.person_id){await tx(req,async(c,v)=>c.query("update pulse.password_reset_request set status='dismissed',resolved_by=$1,resolved_at=now() where id=$2",[v.person,req.params.id]));return {ok:true};}
  const token=secret(),result=await tx(req,async c=>(await c.query("select pulse.auth_admin('staff',$1,'reset',$2) d",[row.person_id,JSON.stringify({hash:sessionHash(token)})])).rows[0].d);
  const sent=await sendLink('staff','reset',token,result);await recordMail('staff',row.person_id,sent);if(!sent)await mailRefusal('Email delivery unavailable. Use the person account controls.');
  await tx(req,async(c,v)=>c.query("update pulse.password_reset_request set status='resolved',resolved_by=$1,resolved_at=now() where id=$2",[v.person,req.params.id]));return {ok:true};
 });
 async function sendNotice(r:string,result:Body,title:string,message:string){const actor=String(result.actor??''),recipient=result.delivery;const ok=await authMail(recipient,title,message);await recordMail(r,actor,ok);}
 async function recordMail(r:string,a:string,ok:boolean){await open(async c=>c.query('select pulse.auth_mail_event($1,$2,$3)',[r,a,ok])).catch(()=>{});}
 async function noticeNew(r:string,result:Body,d:string,id:string){result={...result};const fresh=await open(async c=>(await c.query('select pulse.auth_new_device($1,$2,$3,$4) fresh',[r,result.actor,d,id])).rows[0].fresh).catch(()=>false);if(fresh)await sendNotice(r,result,'New device signed in to Pulse',`A new ${d} device signed in to Pulse. Review Account / Security to sign out devices. If this was not you, contact HR immediately.`);}
}
