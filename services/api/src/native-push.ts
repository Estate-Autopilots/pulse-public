/** Worker entry point. Root supplies provider key paths; credentials and payloads never enter logs. */
import {readFile} from 'node:fs/promises';
import {createPrivateKey,sign} from 'node:crypto';
import {connect as http2Connect} from 'node:http2';
import {Pool} from 'pg';
import {drainNotificationChannel,providerOutcome} from './notification-outbox.js';
const encode=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString('base64url');
function jwt(header:unknown,claims:unknown,key:string,alg:'RSA-SHA256'|'sha256'){const input=encode(header)+'.'+encode(claims);return input+'.'+sign(alg,Buffer.from(input),{key:createPrivateKey(key),...(alg==='sha256'?{dsaEncoding:'ieee-p1363' as const}:{})}).toString('base64url');}
async function apns(token:string,notificationId:string,expiresAt:string){const team=process.env.PULSE_APNS_TEAM_ID,keyId=process.env.PULSE_APNS_KEY_ID,topic=process.env.PULSE_APNS_TOPIC,keyFile=process.env.PULSE_APNS_KEY_FILE;if(!team||!keyId||!topic||!keyFile)throw Error('Provider unavailable');if(!/^[a-f0-9]{64}$/i.test(token))return 410;
 const key=await readFile(keyFile,'utf8');const auth=jwt({alg:'ES256',kid:keyId},{iss:team,iat:Math.floor(Date.now()/1000)},key,'sha256');const client=http2Connect(process.env.PULSE_APNS_SANDBOX==='1'?'https://api.sandbox.push.apple.com':'https://api.push.apple.com');
 return new Promise<number>((resolve,reject)=>{let finished=false;const finish=(status?:number)=>{if(finished)return;finished=true;client.close();status?resolve(status):reject(Error('Provider unavailable'));};client.on('error',()=>finish());const req=client.request({':method':'POST',':path':`/3/device/${token}`,authorization:`bearer ${auth}`,'apns-topic':topic,'apns-push-type':'alert','apns-priority':'10','apns-id':notificationId,'apns-collapse-id':notificationId,'apns-expiration':String(Math.floor(Date.parse(expiresAt)/1000))});req.setTimeout(15000,()=>{req.close();finish();});let status=0;req.on('response',h=>{status=Number(h[':status']);});req.on('data',()=>{});req.on('end',()=>finish(status));req.on('error',()=>finish());req.end(JSON.stringify({notificationId,aps:{alert:{title:'Pulse',body:'A new work update is ready'},sound:'default'}}));});
}
// POLISH-2: the channel is the one the phone shell creates (Notifier.UPDATES), else Android files it under "Miscellaneous".
// CHAT-VOICE: an incoming call goes at high priority on the Calls channel (Notifier.CALLS) with the caller's name.
async function fcm(token:string,notificationId:string,expiresAt:string,call?:{title:string;href:string;eventType:string}){const file=process.env.PULSE_FCM_SERVICE_ACCOUNT_FILE;if(!file)throw Error('Provider unavailable');const sa=JSON.parse(await readFile(file,'utf8'));const now=Math.floor(Date.now()/1000);const assertion=jwt({alg:'RS256',typ:'JWT'},{iss:sa.client_email,scope:'https://www.googleapis.com/auth/firebase.messaging',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600},sa.private_key,'RSA-SHA256');
 const auth=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}),signal:AbortSignal.timeout(15000)});if(!auth.ok)throw Error('Provider unavailable');const {access_token}=await auth.json() as {access_token:string};const r=await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`,{method:'POST',headers:{authorization:`Bearer ${access_token}`,'content-type':'application/json'},body:JSON.stringify({message:{token,data:{notificationId,...(call?{eventType:call.eventType,href:call.href}:{})},notification:{title:call?.title??'Pulse',body:call?(call.eventType==='chat.call'?'Tap to answer':'Tap to call back'):'A new work update is ready'},android:{priority:call?.eventType==='chat.call'?'high':'normal',ttl:Math.max(0,Math.min(120,Math.floor((Date.parse(expiresAt)-Date.now())/1000)))+'s',notification:{channel_id:call?'pulse-calls':'pulse-updates',tag:notificationId}}}}),signal:AbortSignal.timeout(15000)});return r.status;
}
export async function drainNativePush(pool:Pool){
 if(process.env.PULSE_NATIVE_PUSH_ENABLED!=='1')return {enabled:false,sent:0,failed:0};
 const sink=process.env.PULSE_CI==='1'||process.env.PULSE_NOTIFICATION_MODE==='sink';
 const result=await drainNotificationChannel(pool,'native',async payload=>{
  const {platform,token}=payload.destination;
  // macOS/Windows/Chrome require their own adapters; none may enter the Android branch.
  if(!token||!['ios','android'].includes(platform??''))return 'failed';
  if(sink)return 'accepted';
  if(platform==='ios'&&!process.env.PULSE_APNS_KEY_FILE||platform==='android'&&!process.env.PULSE_FCM_SERVICE_ACCOUNT_FILE)return 'retry';
  return providerOutcome(await (platform==='ios'?apns(token,payload.id,payload.expiresAt):fcm(token,payload.id,payload.expiresAt,payload.eventType==='chat.call'||payload.eventType==='chat.missed_call'?{title:payload.title,href:payload.href,eventType:payload.eventType}:undefined)));
 });
 return {enabled:true,...result};
}
if(import.meta.url===`file://${process.argv[1]}`){const pool=new Pool({connectionString:process.env.PULSE_DATABASE_URL_WORKER??process.env.DATABASE_URL,...(!process.env.PULSE_DATABASE_URL_WORKER?{options:'-c role=pulse_worker'}:{})});try{console.log(JSON.stringify(await drainNativePush(pool)));}catch{console.error('Native push worker unavailable');process.exitCode=1;}finally{await pool.end();}}
