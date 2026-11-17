import type {Pool,PoolClient} from 'pg';

export type DeliveryOutcome='accepted'|'retry'|'expired'|'failed'|'uncertain';
// CHAT-VOICE: eventType and priority say what a push is (an incoming call rings at high priority).
export type NotificationPayload={id:string;personId:string;title:string;href:string;expiresAt:string;eventType?:string;priority?:string;destination:{endpoint?:string;keys?:{auth:string;p256dh:string};token?:string;platform?:string}};
export function providerOutcome(status:number):DeliveryOutcome {
 if(status>=200&&status<300)return 'accepted';
 if(status===404||status===410)return 'expired';
 // A provider rejection can be retried; a missing response is ambiguous and must never be replayed.
 if(status===429||status===503)return 'retry';
 return status===0||status>=500?'uncertain':'failed';
}
async function tenant<T>(pool:Pool,org:string,run:(c:PoolClient)=>Promise<T>):Promise<T>{
 const c=await pool.connect();try{await c.query('begin');await c.query("select set_config('pulse.org_id',$1,true)",[org]);const result=await run(c);await c.query('commit');return result;}catch(e){await c.query('rollback');throw e;}finally{c.release();}
}
export async function drainNotificationChannel(pool:Pool,channel:'web'|'native',send:(payload:NotificationPayload)=>Promise<DeliveryOutcome>){
 let sent=0,failed=0,uncertain=0;
 // UX-TENANT: every active company's pushes, one company's transaction at a time.
 const orgs=(await pool.query('select pulse.list_active_orgs() org')).rows.map(r=>r.org as string);
 for(const org of orgs){
 const jobs=await tenant(pool,org,async c=>(await c.query('select * from pulse.notification_outbox_claim($1)',[channel])).rows);
 for(const job of jobs){
  const payload=await tenant(pool,org,async c=>(await c.query('select pulse.notification_outbox_dispatch($1,$2) payload',[job.id,job.lease_token])).rows[0].payload as NotificationPayload|null);
  if(!payload)continue;
  // No transaction or checked-out connection spans a provider request. Dispatch intent is already durable.
  let outcome:DeliveryOutcome='uncertain';try{outcome=await send(payload);}catch{/* Mask credentials, payloads and provider responses. */}
  await tenant(pool,org,async c=>{await c.query('select pulse.notification_outbox_finish($1,$2,$3)',[job.id,job.lease_token,outcome]);});
  if(outcome==='accepted')sent++;else if(outcome==='uncertain')uncertain++;else failed++;
 }
 }
 return {sent,failed,uncertain};
}
