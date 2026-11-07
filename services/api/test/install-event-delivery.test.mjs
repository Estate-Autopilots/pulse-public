import assert from 'node:assert/strict';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {eventHeaders,deliverInstallEvents} from '../dist/install-event-delivery.js';
import {publicAddress,safeOutbound,OutboundError} from '../dist/safe-outbound.js';
const secret='example-signing-secret-not-real-0001';
const body='{"id":"0b8c6c1e-5f0e-4c43-9d55-2f0f4a1d7e21","type":"quotation.accepted","version":1,"occurredAt":"2026-11-02T09:41:07Z","sequence":118,"subject":{"kind":"quotation","id":"6f1d2a7e-3b9c-4e8a-a1d4-0c5e9b7f2a10"},"data":{"status":"accepted","clientId":"2c4e6a80-1b3d-4f5a-9c7e-8d0f1a2b3c4d","leadId":null,"acceptedVia":"customer_link"}}';
test('constant signing vector and synthetic receiver deduplication, clock, key and per-subject ordering',()=>{
 const headers=eventHeaders(body,1,'k1',secret,'1793612470');
 assert.equal(headers['Pulse-Signature'],'v1=59c485ec3c45fe9a78201fb5100fc54478ec3372eea709def101573e796b5683');
 const ids=new Set(),highest=new Map();let following=true;
 const receive=(raw,h)=>{
  if(!/^v1=[0-9a-f]{64}$/.test(h['Pulse-Signature'])||!/^\d+$/.test(h['Pulse-Timestamp']))return false;
  if(h['Pulse-Key-Id']!=='k1'||Math.abs(1793612470-Number(h['Pulse-Timestamp']))>300)return false;
  const sig=Buffer.from(h['Pulse-Signature'].slice(3),'hex'),want=createHmac('sha256',secret).update(`${h['Pulse-Timestamp']}.${raw}`).digest();
  if(sig.length!==want.length||!timingSafeEqual(sig,want))return false;
  const e=JSON.parse(raw);if(ids.has(e.id)||e.sequence<=(highest.get(e.subject.id)??0))return false;
  ids.add(e.id);highest.set(e.subject.id,e.sequence);if(['accepted','converted'].includes(e.data.status))following=false;return true;
 };
 for(const [n,status] of ['sent','accepted','converted'].entries()){
  const raw=JSON.stringify({...JSON.parse(body),id:`synthetic-${n}`,type:`quote.${status}`,sequence:n+1,data:{status}});
  const h=eventHeaders(raw,1,'k1',secret,'1793612470');assert.equal(receive(raw,h),true);assert.equal(receive(raw,h),false);
  assert.equal(following,n===0);
 }
 assert.equal(receive(body,headers),true);
 for(const h of [{...headers,'Pulse-Signature':headers['Pulse-Signature'].replace('v1=','v2=')},{...headers,'Pulse-Timestamp':'1793612471'},{...headers,'Pulse-Timestamp':'0'},{...headers,'Pulse-Key-Id':'another-install'},eventHeaders(body,1,'k1','another-install-secret','1793612470')])assert.equal(receive(body,h),false);
 assert.equal(receive(body+' ',headers),false);
 const stale=JSON.stringify({...JSON.parse(body),id:'stale',sequence:1});assert.equal(receive(stale,eventHeaders(stale,1,'k1',secret,'1793612470')),false);
});
test('SSRF: reserved IPv4/IPv6, credentials, ports, mixed DNS; checked address pinned without redirect',async()=>{
 for(const ip of ['0.0.0.0','10.0.0.1','100.64.0.1','127.1.2.3','169.254.169.254','172.16.1.2','192.168.1.1','198.18.0.1','224.1.2.3','255.255.255.255','::1','::ffff:8.8.8.8','fe80::1','fc00::1','ff00::1','2001:db8::1','2002:0808:0808::'])assert.equal(publicAddress(ip),false,ip);
 for(const ip of ['8.8.8.8','2606:4700:4700::1111'])assert.equal(publicAddress(ip),true,ip);
 let calls=0;
 const dns=async()=>[{address:'8.8.8.8',family:4}];
 const transport=(status,bytes=0)=>(_url,opts,cb)=>{
  calls++;assert.equal(opts.agent,false);assert.equal(opts.rejectUnauthorized,true);
  opts.lookup('rebound.invalid',{},(_e,ip)=>assert.equal(ip,'8.8.8.8'));
  const req=new EventEmitter();req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=status;res.destroy=()=>{};cb(res);res.emit('data',Buffer.alloc(bytes));res.emit('end');});return req;
 };
 for(const url of ['http://public.example','https://u:p@public.example','https://public.example:444','https://public.example/#fragment','https://127.1','https://[::1]'])await assert.rejects(safeOutbound(url,'{}',{},3000,dns,transport(204)),{kind:'destination'});
 await assert.rejects(safeOutbound('https://public.example','{}',{},3000,async()=>[...await dns(),{address:'10.0.0.1',family:4}],transport(204)),{kind:'destination'});assert.equal(calls,0);
 assert.deepEqual(await safeOutbound('https://public.example/hook','{}',{},3000,dns,transport(204)),{status:204,host:'public.example'});
 await assert.rejects(safeOutbound('https://public.example','{}',{},3000,dns,transport(302)),{kind:'redirect'});
 await assert.rejects(safeOutbound('https://public.example','{}',{},3000,dns,transport(200,16385)),{kind:'response_size'});
 await assert.rejects(safeOutbound('https://public.example','{}',{},5,()=>new Promise(()=>{}),transport(200)),{kind:'timeout'});
 const stalled=(_u,opts)=>{const req=new EventEmitter();req.end=()=>opts.signal.addEventListener('abort',()=>req.emit('error',new Error('aborted')));return req;};
 await assert.rejects(safeOutbound('https://public.example','{}',{},5,dns,stalled),{kind:'timeout'});
});
test('dedicated transactions, bounded drain and redacted outcomes for 2xx, 429/5xx and timeout',async()=>{
 for(const outcome of [204,429,503,'timeout']){
  let open=false,claims=0,finishes=0;
  const pool={query:async({text:sql,values:args})=>{
   assert.equal(open,false);open=true;
   const result=sql.includes('install_event_due')?(claims++<12?[{id:'event',lease:'lease'}]:[]):sql.includes('dispatch')?{url:'https://public.example',body,attempt:1,keyId:'k1',secret}:null;
   if(sql.includes('install_event_attempt')){finishes++;assert.equal(args[2],outcome==='timeout'?null:outcome);assert.equal(args[4],outcome===204?null:outcome==='timeout'?'timeout':'http');}
   open=false;return {rows:[{result}]};
  }};
  const count=await deliverInstallEvents(pool,async(_url,raw,h)=>{assert.equal(open,false);assert.equal(raw,body);assert.equal(h['Pulse-Event-Id'],JSON.parse(body).id);if(outcome==='timeout')throw new OutboundError('timeout');return {status:outcome};});
  assert.equal(count,10);assert.equal(finishes,10);
  let time=0;assert.equal(await deliverInstallEvents(pool,undefined,()=>time+=30000),0);
 }
});
