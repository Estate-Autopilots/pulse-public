import type { FastifyInstance } from 'fastify';
import { admin, fail, type Tx, type Viewer } from './routes.js';
import { parseRange } from './review-media.js';
// WA-IMPORT (owner, 25 Oct 2026): WhatsApp groups imported whole (tools/wa-import.py, migration 1015). Each group is a
// Pulse chat; its history is read-only and read by the chat's staff members and admins (pulse.wa_reader decides, in the
// database). Media streams from Postgres in 1 MiB parts with range requests. Message text is never logged or audited:
// opening a chat writes a restricted-read audit line with the chat id only.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA=/^[0-9a-f]{64}$/;
const PART=1048576;
const id=(raw:unknown,what='Choose a valid chat')=>UUID.test(String(raw??''))?String(raw):fail(400,what);
const optional=(raw:unknown)=>raw===undefined||raw===''?null:id(raw,'Choose a valid person, client, project or message');
const member=(v:Viewer)=>{if(!v.person)fail(403,'Chats requires your individual employee account');};
// Shown inline: what a browser draws or plays itself. Everything else downloads (sandboxed), a PDF opens beside the chat.
const INLINE=/^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime)|audio\/(ogg|mp4|mpeg|aac|webm|wav))$/;
type Q=Record<string,string|undefined>;
export function registerWaChatRoutes(app:FastifyInstance,{tx}:{tx:Tx}){
 const body={type:'object'} as const;
 // Imported chats the viewer reads: all of them, or a person's (as a participant), a client's or a project's; words of
 // the title. Newest activity first.
 app.get('/api/v0/chats/whatsapp',req=>tx(req,async(c,v)=>{
  member(v);const q=req.query as Q;
  const filter={person:optional(q.person),client:optional(q.client),project:optional(q.project),q:(q.q??'').slice(0,100),
   limit:Math.min(500,Math.max(1,Number(q.limit)||100)),offset:Math.max(0,Number(q.offset)||0)};
  return {...(await c.query('select pulse.wa_chats($1) r',[JSON.stringify(filter)])).rows[0].r,canWithdraw:admin(v)};
 }));
 // WA-IMPORT (1016): what the chats say, structured. Signals across chats (complaints, churn risk, upsell …) for admins
 // and leadership; aggregates per client, project, person or the company (a person also reads their own).
 app.get('/api/v0/chats/whatsapp/signals',req=>tx(req,async(c,v)=>{
  member(v);const q=req.query as Q;
  const kinds=['complaint','churn_risk','upsell','renewal','referral','payment','invoice','quotation','approval','delay','lead_quality'];
  const filter={kind:q.kind&&kinds.includes(q.kind)?q.kind:undefined,client:optional(q.client)??undefined,since:q.since&&/^\d{4}-\d{2}-\d{2}$/.test(q.since)?q.since:undefined,limit:Math.min(1000,Math.max(1,Number(q.limit)||200))};
  const rows=(await c.query('select pulse.wa_signals($1) r',[JSON.stringify(filter)])).rows[0].r;if(rows===null)fail(403,'Signals are for admins and leadership');
  return {signals:rows};
 }));
 app.get('/api/v0/chats/whatsapp/insight',req=>tx(req,async(c,v)=>{
  member(v);const q=req.query as Q;
  const subject=['client','project','person','company'].includes(String(q.subject))?String(q.subject):fail(400,'Choose client, project, person or company');
  const sid=subject==='company'?v.org:id(q.id,'Choose a valid client, project or person');
  return {insight:(await c.query('select pulse.wa_insight($1,$2) r',[subject,sid])).rows[0].r};
 }));
 // Imports for an admin (provenance, never text).
 app.get('/api/v0/chats/whatsapp/batches',req=>tx(req,async(c,v)=>{
  member(v);if(!admin(v))fail(403,'Only an admin sees every import');
  return {batches:(await c.query('select pulse.wa_import_batches() b')).rows[0].b};
 }));
 app.post<{Params:{id:string};Body:Record<string,unknown>}>('/api/v0/chats/whatsapp/batches/:id/withdraw',{schema:{body}},req=>tx(req,async(c,v)=>{
  member(v);await c.query('select pulse.wa_import_withdraw($1,$2)',[id(req.params.id,'Choose a valid import'),String(req.body.note??'')]);return {ok:true};
 }));
 // A file of an imported chat (or its poster / browser copy): inline when a browser shows it, else a sandboxed download.
 // Range requests read only the parts they need.
 app.get<{Params:{sha:string}}>('/api/v0/chats/whatsapp/files/:sha',async(req,reply)=>{
  const q=req.query as Q;let sha='';
  const out=await tx(req,async(c,v)=>{
   member(v);sha=SHA.test(req.params.sha)?req.params.sha:fail(400,'Choose a valid file');
   const f=(await c.query('select pulse.wa_file_open($1) f',[sha])).rows[0].f as {mime:string;size:number;parts:number;name:string|null}|null;
   if(!f)return null;
   const range=req.headers.range?parseRange(String(req.headers.range),f.size):{start:0,end:Math.max(0,f.size-1),partial:false};
   if(f.size>0&&range===null)return {f,range:null,bytes:Buffer.alloc(0)};
   const start=range?.start??0,end=f.size?Math.min(range!.end,range!.partial?start+8*PART-1:f.size-1):-1;
   const chunks:Buffer[]=[];
   for(let p=Math.floor(start/PART);f.size&&p<=Math.floor(end/PART);p+=64){
    for(const r of (await c.query('select part,data from pulse.wa_file_parts($1,$2,$3)',[sha,p,Math.min(p+63,Math.floor(end/PART))])).rows)chunks.push(r.data);
   }
   const all=Buffer.concat(chunks),from=start-Math.floor(start/PART)*PART;
   return {f,range:range?{...range,end}:null,bytes:f.size?all.subarray(from,from+end-start+1):Buffer.alloc(0)};
  });
  if(!out)fail(404,'File unavailable');
  const {f,range,bytes}=out!;
  const inline=INLINE.test(f.mime)||(q.inline==='1'&&f.mime==='application/pdf');
  if(f.mime!=='application/pdf'||!inline)reply.header('content-security-policy','sandbox');
  const name=(f.name??`${sha.slice(0,12)}`).replace(/[\r\n"]/g,'');
  reply.header('cache-control','private, max-age=86400').header('etag',`"${sha}"`).header('accept-ranges','bytes').header('x-content-type-options','nosniff')
   .header('content-disposition',`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`).type(inline?f.mime:'application/octet-stream');
  if(f.size&&!range)return reply.code(416).header('content-range',`bytes */${f.size}`).send();
  if(range?.partial)reply.code(206).header('content-range',`bytes ${range.start}-${range.end}/${f.size}`);
  reply.header('content-length',String(bytes.length));
  return reply.send(bytes);
 });
 // One chat: title, client, project, counts, everyone in it and its imports.
 app.get<{Params:{id:string}}>('/api/v0/chats/whatsapp/:id',req=>tx(req,async(c,v)=>{
  member(v);const cid=id(req.params.id);
  const chat=(await c.query('select pulse.wa_chat($1) r',[cid])).rows[0].r;if(!chat)fail(404,'Chat unavailable');
  await c.query("select pulse.audit_write('restricted_read','wa_chat',$1)",[cid]);
  return chat;
 }));
 // A page of messages: the newest, before or after a message, or around one (a link to it).
 app.get<{Params:{id:string}}>('/api/v0/chats/whatsapp/:id/messages',req=>tx(req,async(c,v)=>{
  member(v);const q=req.query as Q;
  const page=(await c.query('select pulse.wa_messages($1,$2,$3,$4,$5) r',[id(req.params.id),optional(q.before),optional(q.after),optional(q.around),Math.min(300,Math.max(1,Number(q.limit)||80))])).rows[0].r;
  if(!page)fail(404,'Chat unavailable');
  return page;
 }));
 // What a voice note says (local Whisper), for whoever may open the note.
 app.get<{Params:{sha:string}}>('/api/v0/chats/whatsapp/files/:sha/transcript',req=>tx(req,async(c,v)=>{
  member(v);const sha=SHA.test(req.params.sha)?req.params.sha:fail(400,'Choose a valid file');
  const t=(await c.query('select pulse.wa_transcript_read($1) r',[sha])).rows[0].r;if(!t)fail(404,'Transcript unavailable');return t;
 }));
 // A chat's structure for its readers: service stages, answer times by side, signals, places, sentiment by month.
 app.get<{Params:{id:string}}>('/api/v0/chats/whatsapp/:id/insights',req=>tx(req,async(c,v)=>{
  member(v);const r=(await c.query('select pulse.wa_chat_insights($1) r',[id(req.params.id)])).rows[0].r;if(!r)fail(404,'Chat unavailable');return r;
 }));
 app.get<{Params:{id:string}}>('/api/v0/chats/whatsapp/:id/search',req=>tx(req,async(c,v)=>{
  member(v);const words=String((req.query as Q).q??'').trim();if(words.length<2||words.length>100)fail(400,'Search for 2 to 100 characters');
  return {hits:(await c.query('select pulse.wa_search($1,$2) r',[id(req.params.id),words])).rows[0].r};
 }));
}
