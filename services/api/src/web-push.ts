import webpush from 'web-push';
import type {Pool} from 'pg';
import {pushEndpoint} from './notification-policy.js';
import {drainNotificationChannel,providerOutcome} from './notification-outbox.js';
import {webPushConfig} from './web-push-config.js';

export async function drainWebPush(pool:Pool){
 const sink=process.env.PULSE_CI==='1'||process.env.PULSE_NOTIFICATION_MODE==='sink';
 const config=sink?null:await webPushConfig();
 if(!sink&&!config)return {enabled:false,sent:0};
 const result=await drainNotificationChannel(pool,'web',async payload=>{
  if(sink)return 'accepted';
  const {endpoint,keys}=payload.destination;
  if(!endpoint||!keys)return 'failed';
  try{
   pushEndpoint(endpoint);
   await webpush.sendNotification({endpoint,keys},JSON.stringify({id:payload.id,personId:payload.personId}),
    {vapidDetails:{subject:'https://pulse.estateautopilots.com',publicKey:config!.publicKey,privateKey:config!.privateKey},
     TTL:Math.max(0,Math.min(120,Math.floor((Date.parse(payload.expiresAt)-Date.now())/1000))),timeout:10000,urgency:payload.priority==='urgent'?'high':'normal'});
   return 'accepted';
  }catch(e){return providerOutcome((e as {statusCode?:number}).statusCode??0);}
 });
 return {enabled:true,...result};
}
