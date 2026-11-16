// TWO-STEP-FACTORS (owner, 30 Oct 2026: "add a passkey adder ... two-step can also be an email code they get ... getting
// in should be easy"): adding a passkey (signed in, with the password once), and finishing a sign-in's second step with
// a passkey or an e-mailed code. The finish itself goes through POST /auth/two-step (method passkey or email), the one
// answer the web proxy turns into the session cookie.
import {randomBytes} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {PoolClient} from 'pg';
import {fail,sessionHash,type Open} from './routes.js';
import {companyOrigin} from './tenant-context.js';
import {answerChallenge,authenticationOptions,registrationOptions,verifyAssertion,verifyRegistration,type KnownPasskey} from './webauthn.js';

type Body=Record<string,unknown>;
type Begin={actor:string;name:string;display:string;credentials:KnownPasskey[]};
type Deps={open:Open;account:<T>(req:FastifyRequest,r:string,run:(c:PoolClient)=>Promise<T>)=>Promise<T>;allow:(req:FastifyRequest,key:string,limit:number)=>Promise<boolean>;
 clientHash:(req:FastifyRequest,r:string)=>string;mailReady:(c:PoolClient)=>Promise<boolean>;mail:(to:string,title:string,body:string)=>Promise<boolean>;codeLimit:number};
const body={type:'object',maxProperties:8,additionalProperties:true} as const;
const LOGIN=/^[A-Za-z0-9_-]{43}$/;

/** The relying party is the address the person is on (a company's own address, or the shared one). */
function relyingParty(){const origin=companyOrigin();return {origin,rpID:new URL(origin).hostname};}
/** d***@example.com: enough to recognise the address, not to read it out. */
export const maskEmail=(e:string)=>{const [u,d]=e.split('@');return d?`${u.slice(0,1)}***@${d}`:'your delivery email';};

/** The ways a waiting sign-in can finish; e-mail only where this organisation can send mail. */
export function twoStepMethods(open:Open,mailReady:(c:PoolClient)=>Promise<boolean>,h:string){
 return open(async c=>{const m=((await c.query('select pulse.auth_challenge_methods($1,$2) d',['staff',h])).rows[0].d??{}) as Record<string,boolean>;
  return {authenticator:!!m.authenticator,passkey:!!m.passkey,email:!!m.email&&await mailReady(c)};});
}

/** POST /auth/two-step with method passkey: the WebAuthn answer checked against the passkey of this waiting sign-in. */
export async function finishPasskey(open:Open,req:FastifyRequest<{Body:Body}>,challenge:string,token:string){
 const response=req.body.response,ch=answerChallenge(response),id=(response as {id?:unknown}|null)?.id;
 if(!ch||typeof id!=='string'||id.length>1024)return null;
 const {origin,rpID}=relyingParty(),h=sessionHash(challenge);
 const k=await open(async c=>(await c.query('select pulse.auth_passkey_for($1,$2,$3,$4) d',['staff',ch,h,id])).rows[0].d) as {publicKey:string;counter:number;transports:string[]}|null;
 if(!k)return null;
 const count=await verifyAssertion({response,challenge:ch,origin,rpID,credential:{id,...k}});
 if(count===null)return null;
 return open(async c=>(await c.query('select pulse.auth_challenge_finish_passkey($1,$2,$3,$4,$5,$6) d',['staff',h,ch,id,count,sessionHash(token)])).rows[0].d);
}

export function registerTwoStepFactors(app:FastifyInstance,d:Deps){
 // A sign-in waiting for its second step: the passkey request, or an e-mailed code (three per 15 minutes).
 app.post<{Body:Body}>('/api/v0/auth/two-step-start',{schema:{body}},async req=>{
  if(!await d.allow(req,'staff-otp',d.codeLimit))fail(429,'Too many attempts. Try again in 15 minutes.');
  const challenge=String(req.body.challenge??'');if(!LOGIN.test(challenge))fail(401,'Verification is unavailable');
  const h=sessionHash(challenge);
  if(req.body.method==='passkey'){
   const bytes=randomBytes(32);
   const begin=await d.open(async c=>(await c.query('select pulse.auth_passkey_begin($1,$2,$3,$4) d',['staff','two-step',h,bytes.toString('base64url')])).rows[0].d) as Begin|null;
   if(!begin)return fail(401,'There is no passkey for this sign-in. Use another way.');
   return authenticationOptions({rpID:relyingParty().rpID,challenge:bytes,allow:begin.credentials});
  }
  if(req.body.method!=='email')return fail(400,'Choose passkey or email');
  const code=await d.open(async c=>{
   if(!await d.mailReady(c))return 'unavailable' as const;
   return (await c.query('select pulse.auth_email_code($1,$2) d',['staff',h])).rows[0].d as {delivery:string;code:string;error?:string}|null;
  });
  if(code==='unavailable')return fail(503,'E-mail is not set up for this organisation yet. Use your passkey, authenticator or a backup code.');
  if(!code)return fail(401,'E-mailed codes are not on for this sign-in. Use another way.');
  if(code.error)return fail(429,code.error);
  const sent=await d.mail(code.delivery,'Your Pulse sign-in code',`Your Pulse sign-in code is ${code.code}\n\nIt works once, for 10 minutes. If you did not try to sign in, change your Pulse password and tell HR.`);
  if(!sent)return fail(503,'The code could not be sent just now. Use your passkey, authenticator or a backup code.');
  return {sent:true,to:maskEmail(code.delivery)};
 });
 // Adding a passkey: the password once, then the browser's own passkey sheet, then the checked answer.
 app.post<{Body:Body}>('/api/v0/auth/passkey-options',{schema:{body}},async req=>{
  const ok=await d.account(req,'staff',async c=>(await c.query('select pulse.auth_account_action($1,$2,$3,$4) d',['staff','passkey-begin',JSON.stringify({current:String(req.body.current??'').slice(0,200)}),d.clientHash(req,'staff')])).rows[0].d) as {error?:string}|null;
  if(!ok||ok.error)return fail(400,ok?.error??'Account security is unavailable.');
  const bytes=randomBytes(32);
  const begin=await d.account(req,'staff',async c=>(await c.query('select pulse.auth_passkey_begin($1,$2,$3,$4) d',['staff','register',null,bytes.toString('base64url')])).rows[0].d) as Begin|null;
  if(!begin)return fail(403,'Sign in again to add a passkey.');
  return registrationOptions({rpID:relyingParty().rpID,challenge:bytes,userId:begin.actor,name:begin.name,display:begin.display,exclude:begin.credentials});
 });
 // The session is checked first (signed out: 401), then the WebAuthn answer, then the challenge it was made for.
 app.post<{Body:Body}>('/api/v0/auth/passkey-register',{schema:{body}},async req=>{
  const r=await d.account(req,'staff',async c=>{
   const ch=answerChallenge(req.body.response);if(!ch)return {error:'This passkey answer could not be read. Try again.'};
   const {origin,rpID}=relyingParty();
   const cred=await verifyRegistration({response:req.body.response,challenge:ch,origin,rpID});
   if(!cred)return {error:'This passkey could not be checked. Try again.'};
   return (await c.query('select pulse.auth_passkey_add($1,$2,$3) d',['staff',ch,JSON.stringify({...cred,name:String(req.body.name??'').slice(0,60)})])).rows[0].d as {error?:string;recoveryCodes?:string[]};
  });
  if(r.error)return fail(400,r.error);
  return {ok:true,...(r.recoveryCodes?{recoveryCodes:r.recoveryCodes}:{})};
 });
 // Each way this person can do the second step, and whether this organisation can send e-mail.
 app.get('/api/v0/auth/factors',req=>d.account(req,'staff',async c=>({...((await c.query('select pulse.auth_factors() d')).rows[0].d??{}),mailReady:await d.mailReady(c)})));
}
