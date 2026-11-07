import type {FastifyInstance} from 'fastify';
import {chatAdapter} from './chat-adapters.js';
import {protectContact,whatsappCapability,type Obj} from './acquisition-model.js';
import {fail,type Tx,type Open} from './routes.js';
const id=(v:unknown)=>/^[0-9a-f-]{36}$/.test(String(v))?String(v):fail(400,'Choose a valid conversation binding');
const body={type:'object',additionalProperties:true} as const;
export function registerWhatsAppIngress(app:FastifyInstance,{tx,open}:{tx:Tx;open:Open}){
 app.post<{Body:Obj}>('/api/v0/chats/provider-mapping',{schema:{body}},req=>tx(req,async(c,v)=>{
 const p=req.body;let aliases;try{aliases=protectContact(v.org+'|'+String(p.accountRef),'chat',{phone:String(p.participantPhone)}).aliases;}catch{return fail(409,'Protected participant identity service must be configured');}
 return (await c.query('select pulse.chat_provider_bind($1) id',[JSON.stringify({id:p.id,channelId:id(p.channelId),personId:id(p.personId),accountRef:String(p.accountRef),authority:String(p.authority??''),aliases,active:p.active!==false,capabilities:whatsappCapability(p)})])).rows[0];
 }));
 app.get('/api/v0/chats/provider-capabilities',req=>tx(req,async c=>({bindings:(await c.query('select pulse.chat_provider_states() d')).rows[0].d,existingHistory:false,groupPilot:'Selected OBA number and tested invite-only entitlement required',providerSends:false})));
 app.register(async ingress=>{
 ingress.addContentTypeParser('application/json',{parseAs:'buffer',bodyLimit:131072},(_req,raw,done)=>done(null,raw));
 ingress.post<{Params:{binding:string}}>('/api/v0/chats/whatsapp-webhook/:binding',req=>{
 if(process.env.PULSE_WHATSAPP_CHAT_ENABLED!=='1')return fail(404,'Incoming WhatsApp adapter is disabled');
 let configs:{bindingId:string;number:string;waba:string;secret:string}[];try{configs=JSON.parse(process.env.PULSE_WHATSAPP_BINDINGS??'[]');}catch{return fail(503,'Provider mapping configuration unavailable');}
 const cfg=configs.find(c=>c.bindingId===req.params.binding)??fail(404,'Selected WhatsApp mapping is unavailable');
 const adapter=chatAdapter('whatsapp',{PULSE_WHATSAPP_CHAT_ENABLED:'1',PULSE_WHATSAPP_APP_SECRET:cfg.secret})!;const raw=req.body as Buffer;
 if(!adapter.verify(raw,String(req.headers['x-hub-signature-256']??'')))return fail(401,'Provider signature verification failed');
 let payload:Obj;try{payload=JSON.parse(raw.toString('utf8'));}catch{return fail(400,'Invalid provider schema');}
 const entries=Array.isArray(payload.entry)?payload.entry as Obj[]:[];
 if(!entries.length||entries.some(e=>e.id!==cfg.waba||!Array.isArray(e.changes)||(e.changes as Obj[]).some(ch=>((ch.value as Obj)?.metadata as Obj)?.phone_number_id!==cfg.number)))return fail(401,'Selected WABA or business number mismatch');
 if(entries.some(e=>(e.changes as Obj[]).some(ch=>{const value=ch.value as Obj;return !!value.group_id||(Array.isArray(value.messages)&&(value.messages as Obj[]).some(m=>!!m.group_id));})))return fail(400,'Selected group webhook capability is not connected; use the portal fallback');
 const messages=adapter.messages(payload);if(messages.length>50)return fail(413,'Bounded provider batch required');
 return open(async(c,org)=>{const receipts=[];for(const m of messages){let aliases;try{aliases=protectContact(org+'|'+cfg.number,'chat',{phone:'+'+m.senderRef}).aliases;}catch{return fail(403,'Verified protected participant identity required');}
 const receipt=(await c.query('select pulse.chat_provider_receive($1,$2) d',[id(cfg.bindingId),JSON.stringify({...m,aliases,accountRef:cfg.number})])).rows[0].d;receipts.push(receipt);}return {durable:true,receipts,businessEvents:0};});
 });
 });
}
