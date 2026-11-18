import type { FastifyInstance } from 'fastify';
import { fail, type Tx, type Viewer } from './routes.js';
import { parseRange } from './review-media.js';
// WA-AUDIO (1112): a colleague listens to a test set of imported voice notes and corrects the machine draft, so the
// speech engines can be scored against what was really said. Admins, leadership and the assignee of the set's task
// review (pulse.wa_review_can decides, in the database); the audio streams only for clips of the set. Transcript text is
// never logged or audited: saving writes an audit line with the set and the file only.
const SET=/^[a-z0-9][a-z0-9-]{2,39}$/;
const SHA=/^[0-9a-f]{64}$/;
const PART=1048576;
const set=(raw:unknown)=>SET.test(String(raw??''))?String(raw):fail(400,'Choose a valid review set');
const sha=(raw:unknown)=>SHA.test(String(raw??''))?String(raw):fail(400,'Choose a valid clip');
const member=(v:Viewer)=>{if(!v.person)fail(403,'Reviewing needs your individual employee account');};
const AUDIO=/^(audio\/(ogg|mp4|mpeg|aac|webm|wav|x-m4a)|video\/(mp4|webm|quicktime))$/;
export function registerWaAudioReviewRoutes(app:FastifyInstance,{tx}:{tx:Tx}){
 // The sets the viewer may review, with how far they are.
 app.get('/api/v0/chats/whatsapp/review',req=>tx(req,async(c,v)=>{
  member(v);return {sets:(await c.query('select pulse.wa_review_sets() r')).rows[0].r};
 }));
 // One set: its clips, drafts, other versions and the viewer's own reviews.
 app.get<{Params:{set:string}}>('/api/v0/chats/whatsapp/review/:set',req=>tx(req,async(c,v)=>{
  member(v);const s=set(req.params.set);
  const can=(await c.query('select pulse.wa_review_can($1) ok',[s])).rows[0].ok as boolean;
  if(!can)fail(404,'This review set is not available to you');
  return {set:s,items:(await c.query('select pulse.wa_review_items($1) r',[s])).rows[0].r};
 }));
 // Save what the viewer heard in one clip (again replaces it).
 app.post<{Params:{set:string;sha:string};Body:Record<string,unknown>}>('/api/v0/chats/whatsapp/review/:set/:sha',{schema:{body:{type:'object'}}},req=>tx(req,async(c,v)=>{
  member(v);const s=set(req.params.set),f=sha(req.params.sha),b=req.body??{};
  const text=typeof b.text==='string'?b.text:'';if(text.length>20000)fail(400,'The transcript is too long');
  const status=b.status==='done'||b.status==='skipped'?b.status:fail(400,'Mark the clip done or skipped');
  const langs=Array.isArray(b.languages)?b.languages.filter((x):x is string=>typeof x==='string'):[];
  const body={text,status,languages:langs,speakers:Number.isInteger(b.speakers)?b.speakers:null,audio:typeof b.audio==='string'?b.audio:null,
   note:typeof b.note==='string'?b.note.slice(0,2000):null,seconds:Number.isFinite(b.seconds)?Math.round(Number(b.seconds)):0};
  try{
   const r=(await c.query('select pulse.wa_review_save($1,$2,$3) r',[s,f,JSON.stringify(body)])).rows[0].r;
   await c.query("select pulse.audit_write('wa_transcript_review','wa_file',$1)",[f]);
   return r;
  }catch(e){const code=(e as {code?:string}).code;if(code==='42501')fail(403,'This review set is not available to you');if(code==='P0002')fail(404,'This clip is not in the set');if(code==='22023')fail(400,'Mark the clip done or skipped');throw e;}
 }));
 // A clip's audio for its reviewers, with range requests (players seek).
 app.get<{Params:{set:string;sha:string}}>('/api/v0/chats/whatsapp/review/:set/:sha/audio',async(req,reply)=>{
  // Who asks is checked before what they ask for, as in the routes above: signed out is 401, not 400 (access matrix).
  const out=await tx(req,async(c,v)=>{
   member(v);
   const s=set(req.params.set),f=sha(req.params.sha);
   const meta=(await c.query('select pulse.wa_review_file($1,$2) f',[s,f])).rows[0].f as {mime:string;size:number;parts:number}|null;
   if(!meta)return null;
   const range=req.headers.range?parseRange(String(req.headers.range),meta.size):{start:0,end:Math.max(0,meta.size-1),partial:false};
   if(meta.size>0&&range===null)return {meta,range:null,bytes:Buffer.alloc(0)};
   const start=range?.start??0,end=meta.size?Math.min(range!.end,range!.partial?start+8*PART-1:meta.size-1):-1;
   const chunks:Buffer[]=[];
   for(let p=Math.floor(start/PART);meta.size&&p<=Math.floor(end/PART);p+=64){
    for(const r of (await c.query('select part,data from pulse.wa_review_file_parts($1,$2,$3,$4)',[s,f,p,Math.min(p+63,Math.floor(end/PART))])).rows)chunks.push(r.data);
   }
   const all=Buffer.concat(chunks),from=start-Math.floor(start/PART)*PART;
   return {meta,range:range?{...range,end}:null,bytes:meta.size?all.subarray(from,from+end-start+1):Buffer.alloc(0)};
  });
  if(!out)fail(404,'Clip unavailable');
  const {meta,range,bytes}=out!;
  reply.header('content-security-policy','sandbox').header('cache-control','private, max-age=86400').header('etag',`"${req.params.sha}"`).header('accept-ranges','bytes')
   .header('x-content-type-options','nosniff').header('content-disposition','inline').type(AUDIO.test(meta.mime)?meta.mime:'application/octet-stream');
  if(meta.size&&!range)return reply.code(416).header('content-range',`bytes */${meta.size}`).send();
  if(range?.partial)reply.code(206).header('content-range',`bytes ${range.start}-${range.end}/${meta.size}`);
  reply.header('content-length',String(bytes.length));
  return reply.send(bytes);
 });
}
