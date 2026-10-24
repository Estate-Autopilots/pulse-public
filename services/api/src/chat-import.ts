import type { FastifyInstance } from 'fastify';
import { decodeExport, displayLabel, ExportError, importKeys, LIMITS, PARSER, parseWhatsAppExport, participantKey, sha256Hex, type ExportMessage } from '@pulse/chat-export';
import { admin, fail, type Tx, type Viewer } from './routes.js';
// R47: past WhatsApp chats from a text export. The preview runs in the browser (the file is not sent until the import);
// the import reads the same file again with the same reader, checks it is the file previewed, applies the sender
// decisions and writes through pulse.chat_import (0350), which decides who may import where. Real imports are off until
// PULSE_CHAT_IMPORT=1 (owner errands E08/E15). Message text is never logged or audited; only members read it.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id=(raw:unknown)=>UUID.test(String(raw))?String(raw):fail(400,'Choose a valid conversation');
type Body=Record<string,unknown>;
const enabled=()=>process.env.PULSE_CHAT_IMPORT==='1';
const member=(v:Viewer)=>{if(!v.person)fail(403,'Chats requires your individual employee account');};
const importer=(v:Viewer)=>{member(v);if(!admin(v))fail(403,'Only an admin imports chat history: the owner operates real imports');};
const text=(raw:unknown,min:number,max:number,what:string)=>{const s=String(raw??'').trim();return s.length>=min&&s.length<=max?s:fail(400,what);};
const iso=(t:unknown)=>t instanceof Date?t.toISOString():String(t);
export function registerChatImportRoutes(app:FastifyInstance,{tx}:{tx:Tx}){
 const body={type:'object'} as const;
 // The import page: whether real imports are on, the company's time zone, the conversations the viewer may import into
 // (with who will read the history), colleagues to map senders to, and every import's provenance (never its text).
 app.get('/api/v0/chats/imports',req=>tx(req,async(c,v)=>{
  importer(v);
  const targets=(await c.query(`select ch.id,ch.kind,case when ch.kind='direct' then coalesce((select p.display_name from pulse.chat_member o join pulse.person p on p.id=o.person_id where o.channel_id=ch.id and o.person_id<>$1 limit 1),'Direct message') else ch.name end name,
   coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.display_name) order by p.display_name) from pulse.chat_member o join pulse.person p on p.id=o.person_id where o.channel_id=ch.id and pulse.chat_current(p.id)),'[]') readers
   from pulse.chat_channel ch join pulse.chat_member mine on mine.channel_id=ch.id and mine.person_id=$1 where ch.kind in ('custom','direct') order by ch.kind<>'custom',3`,[v.person])).rows;
  const people=(await c.query(`select p.id,p.display_name name,p.status='active' current from pulse.person p where p.side='staff' order by p.display_name`)).rows;
  return {enabled:enabled(),parser:PARSER,limits:LIMITS,timeZone:(await c.query('select pulse.org_time_zone() z')).rows[0].z,targets,people,batches:(await c.query('select pulse.chat_import_batches() b')).rows[0].b};
 }));
 // Approve and import in one step: the approval (where the owner's decision is recorded, the retention proposal) is
 // stored with the batch it approves.
 app.post<{Body:Body}>('/api/v0/chats/imports',{schema:{body},bodyLimit:12000000},req=>tx(req,async(c,v)=>{
  importer(v);
  if(!enabled())fail(404,'Importing WhatsApp history is off on this server. The preview works; real imports wait for the owner’s approval.');
  const b=req.body,channel=id(b.channelId);
  const refusal=(await c.query('select pulse.chat_import_refusal($1) r',[channel])).rows[0].r;if(refusal)fail(403,refusal);
  const raw=String(b.file??'');if(!raw||!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)||raw.length>Math.ceil(LIMITS.bytes/3)*4)fail(400,'Choose the exported .txt file, up to 8 MB');
  const bytes=new Uint8Array(Buffer.from(raw,'base64')),sha=await sha256Hex(bytes);
  if(sha!==b.fileSha256)fail(409,'This is not the file you previewed. Preview it again.');
  const approvalRef=text(b.approvalRef,3,200,'Say where the owner’s approval is recorded, in 3 to 200 characters');
  const retentionNote=text(b.retentionNote,3,300,'Write the retention proposal, in 3 to 300 characters');
  const order=String(b.dateOrder??'');if(!['dmy','mdy','ymd'].includes(order))fail(400,'Choose how dates are written in the export');
  let parsed;try{parsed=parseWhatsAppExport(decodeExport(bytes),{timeZone:String(b.timeZone??''),dateOrder:order as 'dmy'});}catch(e){if(e instanceof ExportError)fail(400,e.message);throw e;}
  if(parsed.stats.messages!==Number(b.expectMessages))fail(409,'The export reads differently here than in the preview. Preview it again.');
  // Every sender needs a decision: a colleague, kept as written (not in Pulse), or skipped (not a person).
  const decided=new Map<string,{personId:string|null;skip:boolean}>();
  for(const d of Array.isArray(b.participants)?b.participants as Body[]:[]){const key=String(d.key??'');if(/^[0-9a-f]{64}$/.test(key))decided.set(key,{personId:d.personId?id(d.personId):null,skip:d.skip===true});}
  const bySender=new Map<string,{personId:string|null;skip:boolean}>(),participants=[];
  for(const p of parsed.participants){
   const key=await participantKey(p.label),d=decided.get(key);
   if(!d)return fail(400,`Decide who “${p.display}” is before importing`);
   if(d.skip&&d.personId)return fail(400,`“${p.display}” is either a colleague or skipped, not both`);
   bySender.set(p.label,d);participants.push({display:p.display,messages:p.messages,decision:d.skip?'skip':d.personId?'person':'kept',personId:d.skip?null:d.personId});
  }
  const kept=parsed.messages.filter((m):m is ExportMessage&{sender:string}=>(m.kind==='text'||m.kind==='media')&&m.sender!==null&&!bySender.get(m.sender)?.skip);
  const keys=await importKeys(kept);
  const messages=kept.map((m,i)=>({key:keys[i],at:m.at,local:m.local,exact:m.time==='exact',line:m.line,author:bySender.get(m.sender)?.personId??null,label:displayLabel(m.sender),kind:m.kind,body:m.body,edited:m.edited}));
  const stats={...parsed.stats,kept:messages.length,skipped:parsed.stats.text+parsed.stats.media-messages.length,warnings:parsed.warnings.map(w=>w.code)};
  return (await c.query('select pulse.chat_import($1,$2,$3) r',[channel,JSON.stringify({parser:PARSER,fileSha256:sha,fileBytes:bytes.length,timeZone:parsed.timeZone,dateOrder:parsed.dateOrder,stats,participants,approvalRef,retentionNote}),JSON.stringify(messages)])).rows[0].r;
 }));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/imports/:id/withdraw',{schema:{body}},req=>tx(req,async(c,v)=>{
  importer(v);await c.query('select pulse.chat_import_withdraw($1,$2)',[id(req.params.id),String(req.body.note??'')]);return {ok:true};
 }));
 // A conversation's imported history, newest page first (cursor: "<sent at>|<seq>"), for its current members only.
 app.get<{Params:{id:string}}>('/api/v0/chats/:id/history',req=>tx(req,async(c,v)=>{
  member(v);const cid=id(req.params.id);await c.query('select pulse.chat_refresh()');
  // Membership itself: an admin moderating a group does not read its imported history.
  if(!(await c.query('select pulse.chat_history_reader($1) ok',[cid])).rows[0].ok)fail(404,'Conversation unavailable');
  await c.query("select pulse.audit_write('restricted_read','chat_history',$1)",[cid]);
  const [at,seq]=String((req.query as {before?:string}).before??'').split('|');const before=at?new Date(at):null;
  if(before&&(!Number.isFinite(before.getTime())||!/^\d{1,19}$/.test(seq??'')))fail(400,'Invalid history cursor');
  const rows=(await c.query('select * from pulse.chat_history($1,$2,$3,61)',[cid,before?before.toISOString():null,before?seq:null])).rows;
  return {messages:rows.slice(0,60).reverse().map(r=>({id:r.id,at:iso(r.sent_at),local:r.local_time,exact:r.time_exact,authorId:r.author_id,name:r.author_name??r.author_label,label:r.author_label,kind:r.kind,body:r.body,edited:r.edited,batchId:r.batch_id,cursor:`${iso(r.sent_at)}|${r.seq}`})),
   hasMore:rows.length>60,batches:(await c.query('select pulse.chat_import_batches($1) b',[cid])).rows[0].b};
 }));
}
