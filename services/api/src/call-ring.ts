// CALLS-NATIVE: a Pulse call rings like a phone call on every device the person has (1240_calls_native.sql).
//
// The API process runs three small loops on one worker connection (no provider credentials, no loop):
// * native pushes from the outbox every 1.5 s (rings must not wait): Android through FCM (data, high priority: the
//   phone's own code rings full screen), an iPhone through APNs (a VoIP push CallKit shows);
// * "stop ringing" to every device a finished ring reached (answered elsewhere, declined, missed, the caller hung up);
// * unanswered rings end as missed calls on the server, even when no Pulse is open anywhere (a missed-call
//   notification and the chat line "Missed voice call" follow, as before).
import webpush from 'web-push';
import type {Pool,PoolClient} from 'pg';
import {pushEndpoint} from './notification-policy.js';
import {providerOutcome} from './notification-outbox.js';
import {vapidSubject,webPushConfig} from './web-push-config.js';
import {drainNativePush,nativeReady,sendNative} from './native-push.js';

type Stop={id:string;personId:string;callId:string|null;destination:{endpoint?:string;keys?:{auth:string;p256dh:string};token?:string;platform?:string}};
async function each<T>(pool:Pool,run:(c:PoolClient)=>Promise<T>){
 const orgs=(await pool.query('select pulse.list_active_orgs() org')).rows.map(r=>r.org as string);
 const out:T[]=[];
 for(const org of orgs){const c=await pool.connect();try{await c.query('begin');await c.query("select set_config('pulse.org_id',$1,true)",[org]);out.push(await run(c));await c.query('commit');}catch(e){await c.query('rollback').catch(()=>{});throw e;}finally{c.release();}}
 return out;
}
const sink=()=>process.env.PULSE_CI==='1'||process.env.PULSE_NOTIFICATION_MODE==='sink';

/** A web push that only closes a ring (the service worker closes the notification tagged with the call). */
export async function webStop(d:Stop['destination'],personId:string,callId:string){
 const config=await webPushConfig();if(!config||!d.endpoint||!d.keys)return 'failed' as const;
 try{pushEndpoint(d.endpoint);await webpush.sendNotification({endpoint:d.endpoint,keys:d.keys},JSON.stringify({stop:callId,personId}),
  {vapidDetails:{subject:vapidSubject(),publicKey:config.publicKey,privateKey:config.privateKey},TTL:60,timeout:10000,urgency:'high'});return 'accepted' as const;}
 catch(e){return providerOutcome((e as {statusCode?:number}).statusCode??0);}
}
/** Stop the rings that are over, on the devices they reached. */
export async function drainCallStops(pool:Pool){
 let sent=0;
 for(const channel of ['web','native'] as const){
  if(channel==='native'&&!nativeReady())continue;
  const stops=(await each(pool,async c=>(await c.query('select pulse.call_ring_stops($1) s',[channel])).rows[0].s as Stop[])).flat();
  for(const s of stops){
   if(!s.callId||sink()){sent++;continue;}
   try{const r=channel==='web'?await webStop(s.destination,s.personId,s.callId):await sendNative(s.destination,s.id,new Date(Date.now()+60000).toISOString(),{kind:'stop',notificationId:s.id,callId:s.callId});if(r==='accepted')sent++;}catch{/* a stop is best effort: the phone's ring also asks and times out */}
  }
 }
 return {sent};
}
export async function expireRings(pool:Pool){await each(pool,async c=>{await c.query('select pulse.chat_call_expire()');});}

/** "Test my ringing": a test ring to every device of mine, sent now (not through the inbox). */
export type RingTargets={personId:string;ringAllowed:boolean;phones:number;web:{endpoint:string;keys:{auth:string;p256dh:string}}[];native:{id:string;name:string;platform:string;token:string|null;voip:string|null}[]};
export async function sendRingTest(t:RingTargets,testId:string){
 const results:{device:string;platform:string;result:string}[]=[];
 const expiresAt=new Date(Date.now()+30000).toISOString();
 const config=t.web.length&&!sink()?await webPushConfig():null;
 for(const w of t.web){
  let result='not set up on this server';
  if(sink())result='accepted';
  else if(config){try{pushEndpoint(w.endpoint);await webpush.sendNotification({endpoint:w.endpoint,keys:w.keys},JSON.stringify({ringTest:testId,personId:t.personId}),{vapidDetails:{subject:vapidSubject(),publicKey:config.publicKey,privateKey:config.privateKey},TTL:30,timeout:10000,urgency:'high'});result='accepted';}catch(e){result=providerOutcome((e as {statusCode?:number}).statusCode??0);}}
  results.push({device:'browser',platform:'web',result});
 }
 for(const d of t.native){
  let result='not set up on this server';
  if(sink())result='accepted';
  else if(nativeReady()){try{result=await sendNative({platform:d.platform,token:d.token,voip:d.voip},testId,expiresAt,{kind:'test',notificationId:testId,callId:testId,title:'Pulse test call',caller:'Pulse test call',video:false,href:'/settings?tab=devices&ringtest='+testId,expiresAt});}catch{result='uncertain';}}
  results.push({device:d.name,platform:d.platform,result});
 }
 return results;
}

/** The loops, started by server.ts. Returns a stop function. */
export function startCallRing(pool:Pool,log:{warn:(m:string)=>void}){
 let pushing=false,stopping=false,expiring=false;
 const push=setInterval(()=>{if(pushing||!nativeReady())return;pushing=true;void drainNativePush(pool).catch(()=>log.warn('Phone push delivery unavailable')).finally(()=>{pushing=false;});},1500);
 const stops=setInterval(()=>{if(stopping)return;stopping=true;void drainCallStops(pool).catch(()=>log.warn('Call ring stops unavailable')).finally(()=>{stopping=false;});},2000);
 const expire=setInterval(()=>{if(expiring)return;expiring=true;void expireRings(pool).catch(()=>log.warn('Call ring expiry unavailable')).finally(()=>{expiring=false;});},5000);
 return ()=>{clearInterval(push);clearInterval(stops);clearInterval(expire);};
}
