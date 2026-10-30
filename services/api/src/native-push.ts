/** Worker entry point. Root supplies provider key paths; credentials and payloads never enter logs. */
import {readFile} from 'node:fs/promises';
import {createPrivateKey,sign} from 'node:crypto';
import {connect as http2Connect} from 'node:http2';
import {Pool} from 'pg';
import {drainNotificationChannel,providerOutcome,type NotificationPayload} from './notification-outbox.js';
const encode=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString('base64url');
function jwt(header:unknown,claims:unknown,key:string,alg:'RSA-SHA256'|'sha256'){const input=encode(header)+'.'+encode(claims);return input+'.'+sign(alg,Buffer.from(input),{key:createPrivateKey(key),...(alg==='sha256'?{dsaEncoding:'ieee-p1363' as const}:{})}).toString('base64url');}

/** CALLS-NATIVE: what a phone needs to ring with Pulse closed (or to stop ringing). Strings only: FCM data is strings. */
export type CallPush={kind:'call'|'missed'|'stop'|'test';notificationId:string;callId?:string;title?:string;caller?:string;video?:boolean;ai?:boolean;href?:string;expiresAt?:string};
/** Seconds a ring may still ring (Pulse stops a ring at 45 s), at least 1. */
export const ringSeconds=(expiresAt?:string,now=Date.now())=>Math.max(1,Math.min(45,Math.floor(((expiresAt?Date.parse(expiresAt):now+45000)-now)/1000)||45));
export function callData(p:CallPush):Record<string,string>{
 const out:Record<string,string>={pulseType:'call.'+p.kind,notificationId:p.notificationId};
 for(const [k,v] of Object.entries({callId:p.callId,title:p.title,caller:p.caller,href:p.href,expiresAt:p.expiresAt}))if(typeof v==='string'&&v)out[k]=v.slice(0,300);
 if(p.video!==undefined)out.video=p.video?'1':'0';
 if(p.ai!==undefined)out.ai=p.ai?'1':'0';
 return out;
}
/** FCM v1 message: a ring, a stop and a missed call are data only and high priority, so the phone's own code rings
 *  (full screen, the ringtone until answered) even when Pulse is closed; anything else stays a plain notification. */
export function fcmMessage(token:string,notificationId:string,expiresAt:string,call?:CallPush){
 const ttl=Math.max(0,Math.min(120,Math.floor((Date.parse(expiresAt)-Date.now())/1000)));
 if(call)return {message:{token,data:callData(call),android:{priority:'high',ttl:(call.kind==='missed'?Math.max(ttl,60):Math.min(ttl||45,60))+'s',...(call.kind==='call'||call.kind==='test'?{collapse_key:'call-'+(call.callId??notificationId)}:{})}}};
 return {message:{token,data:{notificationId},notification:{title:'Pulse',body:'A new work update is ready'},android:{priority:'normal',ttl:ttl+'s',notification:{channel_id:'pulse-updates',tag:notificationId}}}};
}
/** APNs: a ring to an iPhone's VoIP token is a PushKit push (CallKit shows it); everything else an ordinary alert. */
export function apnsRequest(notificationId:string,expiresAt:string,call?:CallPush,voip=false){
 if(call&&voip&&(call.kind==='call'||call.kind==='test'))return {pushType:'voip' as const,priority:'10',expiration:Math.floor(Date.now()/1000)+ringSeconds(call.expiresAt??expiresAt),
  body:{notificationId,...callData(call),aps:{}}};
 const title=call?.title??'Pulse',body=call?call.kind==='missed'?'Tap to call back':'Tap to answer in Pulse':'A new work update is ready';
 return {pushType:'alert' as const,priority:'10',expiration:Math.floor(Date.parse(expiresAt)/1000),body:{notificationId,...(call?callData(call):{}),aps:{alert:{title,body},sound:'default'}}};
}
async function apns(token:string,notificationId:string,expiresAt:string,call?:CallPush,voip=false){const team=process.env.PULSE_APNS_TEAM_ID,keyId=process.env.PULSE_APNS_KEY_ID,topic=process.env.PULSE_APNS_TOPIC,keyFile=process.env.PULSE_APNS_KEY_FILE;if(!team||!keyId||!topic||!keyFile)throw Error('Provider unavailable');if(!/^[a-f0-9]{64}$/i.test(token))return 410;
 const r=apnsRequest(notificationId,expiresAt,call,voip);
 const key=await readFile(keyFile,'utf8');const auth=jwt({alg:'ES256',kid:keyId},{iss:team,iat:Math.floor(Date.now()/1000)},key,'sha256');const client=http2Connect(process.env.PULSE_APNS_SANDBOX==='1'?'https://api.sandbox.push.apple.com':'https://api.push.apple.com');
 return new Promise<number>((resolve,reject)=>{let finished=false;const finish=(status?:number)=>{if(finished)return;finished=true;client.close();status?resolve(status):reject(Error('Provider unavailable'));};client.on('error',()=>finish());const req=client.request({':method':'POST',':path':`/3/device/${token}`,authorization:`bearer ${auth}`,'apns-topic':r.pushType==='voip'?topic+'.voip':topic,'apns-push-type':r.pushType,'apns-priority':r.priority,'apns-id':notificationId,'apns-collapse-id':notificationId,'apns-expiration':String(r.expiration)});req.setTimeout(15000,()=>{req.close();finish();});let status=0;req.on('response',h=>{status=Number(h[':status']);});req.on('data',()=>{});req.on('end',()=>finish(status));req.on('error',()=>finish());req.end(JSON.stringify(r.body));});
}
// Google's access token lasts an hour: one per service account, renewed five minutes early (a ring must not wait on it).
let fcmAuth:{file:string;token:string;until:number;project:string}|null=null;
async function fcmToken(){const file=process.env.PULSE_FCM_SERVICE_ACCOUNT_FILE;if(!file)throw Error('Provider unavailable');
 if(fcmAuth&&fcmAuth.file===file&&fcmAuth.until>Date.now())return fcmAuth;
 const sa=JSON.parse(await readFile(file,'utf8'));const now=Math.floor(Date.now()/1000);const assertion=jwt({alg:'RS256',typ:'JWT'},{iss:sa.client_email,scope:'https://www.googleapis.com/auth/firebase.messaging',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600},sa.private_key,'RSA-SHA256');
 const auth=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}),signal:AbortSignal.timeout(15000)});if(!auth.ok)throw Error('Provider unavailable');const {access_token,expires_in}=await auth.json() as {access_token:string;expires_in?:number};
 fcmAuth={file,token:access_token,project:String(sa.project_id),until:Date.now()+Math.max(60,(expires_in??3600)-300)*1000};return fcmAuth;
}
// POLISH-2: the channel is the one the phone shell creates (Notifier.UPDATES), else Android files it under "Miscellaneous".
async function fcm(token:string,notificationId:string,expiresAt:string,call?:CallPush){const a=await fcmToken();
 const r=await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(a.project)}/messages:send`,{method:'POST',headers:{authorization:`Bearer ${a.token}`,'content-type':'application/json'},body:JSON.stringify(fcmMessage(token,notificationId,expiresAt,call)),signal:AbortSignal.timeout(15000)});
 if(r.status===401)fcmAuth=null;return r.status;
}
export function nativeReady(){return process.env.PULSE_NATIVE_PUSH_ENABLED==='1';}
/** The call part of an outbox payload (1240 adds callId, caller, video, ai to a ring). */
export function callOf(payload:NotificationPayload&{callId?:string;caller?:string;video?:boolean;ai?:boolean}):CallPush|undefined{
 if(payload.eventType==='chat.call')return {kind:'call',notificationId:payload.id,callId:payload.callId,title:payload.title,caller:payload.caller,video:payload.video,ai:payload.ai,href:payload.href,expiresAt:payload.expiresAt};
 if(payload.eventType==='chat.missed_call')return {kind:'missed',notificationId:payload.id,title:payload.title,href:payload.href};
 return undefined;
}
/** One push to one phone: Android through FCM, an iPhone through APNs (a ring to its VoIP token when it has one). */
export async function sendNative(destination:{token?:string|null;platform?:string;voip?:string|null},notificationId:string,expiresAt:string,call?:CallPush){
 const {platform,token,voip}=destination;
 if(platform==='ios'){const useVoip=!!voip&&(call?.kind==='call'||call?.kind==='test');const t=useVoip?voip!:token;if(!t)return 'failed' as const;
  // A stop needs no push on an iPhone: CallKit's ring asks Pulse every few seconds whether it is still ringing.
  if(call?.kind==='stop')return 'accepted' as const;
  if(!process.env.PULSE_APNS_KEY_FILE)return 'retry' as const;return providerOutcome(await apns(t,notificationId,expiresAt,call,useVoip));}
 if(platform==='android'){if(!token)return 'failed' as const;if(!process.env.PULSE_FCM_SERVICE_ACCOUNT_FILE)return 'retry' as const;return providerOutcome(await fcm(token,notificationId,expiresAt,call));}
 return 'failed' as const;
}
export async function drainNativePush(pool:Pool){
 if(!nativeReady())return {enabled:false,sent:0,failed:0};
 const sink=process.env.PULSE_CI==='1'||process.env.PULSE_NOTIFICATION_MODE==='sink';
 const result=await drainNotificationChannel(pool,'native',async payload=>{
  const d=payload.destination as {token?:string;platform?:string;voip?:string};
  // macOS/Windows/Chrome require their own adapters; none may enter the Android branch.
  if(!(d.token||d.voip)||!['ios','android'].includes(d.platform??''))return 'failed';
  if(sink)return 'accepted';
  return sendNative(d,payload.id,payload.expiresAt,callOf(payload));
 });
 return {enabled:true,...result};
}
if(import.meta.url===`file://${process.argv[1]}`){const pool=new Pool({connectionString:process.env.PULSE_DATABASE_URL_WORKER??process.env.DATABASE_URL,...(!process.env.PULSE_DATABASE_URL_WORKER?{options:'-c role=pulse_worker'}:{})});try{console.log(JSON.stringify(await drainNativePush(pool)));}catch{console.error('Native push worker unavailable');process.exitCode=1;}finally{await pool.end();}}
