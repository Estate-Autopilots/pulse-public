import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { OutboundError, safeOutbound } from './safe-outbound.js';

export function eventHeaders(body:string,attempt:number,keyId:string,secret:string,timestamp=String(Math.floor(Date.now()/1000))){
 const event=JSON.parse(body) as {id:string;type:string};
 return {'Pulse-Event-Id':event.id,'Pulse-Event-Type':event.type,'Pulse-Delivery-Attempt':String(attempt),
  'Pulse-Timestamp':timestamp,'Pulse-Key-Id':keyId,'Pulse-Signature':`v1=${createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex')}`};
}
// PostgreSQL autocommit gives each single statement its own transaction: the definer's local org ends there.
// This pool is dedicated to delivery; no tenant transaction or checked-out connection spans a network request.
async function call(pool:Pool,sql:string,values:unknown[]=[]){
 return (await pool.query({text:sql,values})).rows[0]?.result;
}
export async function deliverInstallEvents(pool:Pool,send=safeOutbound,now=()=>performance.now()){
 const deadline=now()+30000;
 let sent=0;
 for(let n=0;n<10&&now()<deadline-10000;n++){
  const jobs=await call(pool,'select pulse.install_event_due(1) result') as {id:string;lease:string}[];
  const job=jobs[0];if(!job)break;
  const delivery=await call(pool,'select pulse.install_event_dispatch($1,$2) result',[job.id,job.lease]);
  if(!delivery)continue;
  const start=now();let status:number|null=null,error:string|null=null;
  try{status=(await send(delivery.url,delivery.body,eventHeaders(delivery.body,delivery.attempt,delivery.keyId,delivery.secret),3000)).status;
   if(status<200||status>=300)error='http';
  }catch(e){error=e instanceof OutboundError?e.kind:'network';}
  await call(pool,'select pulse.install_event_attempt($1,$2,$3,$4,$5) result',[job.id,job.lease,status,Math.round(now()-start),error]);
  sent++;
 }
 return sent;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const pool=new Pool({connectionString:process.env.PULSE_DATABASE_URL_WORKER,max:1,connectionTimeoutMillis:1000,query_timeout:1000,options:'-c statement_timeout=1000'});
 try{if(!process.env.PULSE_DATABASE_URL_WORKER)throw new Error('worker binding missing');await deliverInstallEvents(pool);}
 catch{console.error('Install event delivery unavailable');process.exitCode=1;}finally{await pool.end();}
}
