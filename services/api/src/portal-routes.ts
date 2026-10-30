import type {FastifyInstance,FastifyRequest} from 'fastify';import type {PoolClient} from 'pg';
import {createHash} from 'node:crypto';import {createReadStream,createWriteStream} from 'node:fs';import {mkdir,open,stat,rename} from 'node:fs/promises';import {pipeline} from 'node:stream/promises';import {join} from 'node:path';
import {fail,work,sessionHash,type Tx,type Open} from './routes.js';
import {parseRange} from './review-media.js';
const uuid=(v:unknown)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(String(v))?String(v):fail(400,'Choose a valid project or released artifact');
const body={type:'object',additionalProperties:true} as const;const root=()=>process.env.PULSE_REVIEW_MEDIA_ROOT??'/home/eadev/.local/share/pulse-review';
export function registerPortalRoutes(app:FastifyInstance,{tx,open:tenant}:{tx:Tx;open:Open}){
 const client=<T>(req:FastifyRequest,run:(c:PoolClient,me:{id:string;name:string;mustChange:boolean},org:string)=>Promise<T>)=>tenant(async(c,org)=>{
  const token=req.headers['x-pulse-client-session'];if(typeof token!=='string'||!/^[A-Za-z0-9_-]{40,64}$/.test(token))fail(401,'Sign in to your client portal');
  const me=(await c.query('select pulse.portal_auth($1) me',[sessionHash(String(token))])).rows[0].me;
  await c.query('select pulse.auth_portal_touch($1)',[sessionHash(String(token))]);
  if(me.mustChange&&!['/api/v0/portal/me','/api/v0/portal/auth/change-password','/api/v0/portal/auth/sign-out'].includes(req.url.split('?')[0]))fail(403,'Change your issued password before opening client work');return run(c,me,org);
 });
 app.post('/api/v0/portal/auth/sign-out',req=>client(req,async c=>{await c.query("select pulse.auth_logout('client',$1)",[sessionHash(String(req.headers['x-pulse-client-session']))]);return {ok:true};}));
 app.get('/api/v0/portal/me',req=>client(req,async(_c,me)=>me));
 app.get<{Querystring:{project?:string}}>('/api/v0/portal',req=>client(req,async(c,me)=>{
  const projects=(await c.query('select pulse.portal_projects() rows')).rows[0].rows;const project=req.query.project?uuid(req.query.project):projects[0]?.id;
  const d=project?(await c.query('select pulse.portal_project($1) d',[project])).rows[0].d:{project:{id:'',title:'No authorized project',package:'Access pending',templateVersion:0},releases:[],feedback:[],documents:[],support:[],signer:false};
  return {...d,projects,synthetic:false,viewer:me.name,tasks:[],edges:[],people:[],permissions:{write:false,review:false},sourceHealth:'Released project evidence only',agent:{enabled:false,reason:'Not available in the client portal'},templates:{version:0,phases:[],defaults:''}};
 }));
 app.get<{Querystring:{project:string}}>('/api/v0/portal/acquisition',req=>client(req,async c=>(await c.query('select pulse.portal_acquisition($1) d',[uuid(req.query.project)])).rows[0].d));
 app.get<{Params:{id:string}}>('/api/v0/portal/releases/:id',req=>client(req,async c=>(await c.query('select pulse.portal_release_read($1) release',[uuid(req.params.id)])).rows[0]));
 app.post<{Params:{id:string};Body:Record<string,unknown>}>('/api/v0/portal/releases/:id/feedback',{schema:{body}},req=>client(req,async c=>{const b=req.body;const p={requestKey:String(b.requestKey??''),versionId:uuid(b.versionId),fingerprint:String(b.fingerprint??''),text:String(b.text??'').slice(0,4000),seconds:b.seconds??null,rangeEnd:b.rangeEnd??null,timebase:'seconds',frame:b.frame??null};return (await c.query('select pulse.portal_feedback_add($1,$2,$3) id',[uuid(req.params.id),b.kind,JSON.stringify(p)])).rows[0];}));
 app.post<{Body:Record<string,unknown>}>('/api/v0/portal/support',{schema:{body}},req=>client(req,async c=>(await c.query('select pulse.portal_support_add($1,$2,$3) id',[uuid(req.body.projectId),req.body.kind,JSON.stringify({text:String(req.body.text??'').slice(0,4000),links:Array.isArray(req.body.links)?req.body.links.slice(0,10):[]})])).rows[0]));
 app.post<{Body:Record<string,unknown>}>('/api/v0/portal/policy/ack',{schema:{body}},req=>client(req,async c=>{await c.query('select pulse.portal_policy_ack($1)',[uuid(req.body.policyId)]);return {ok:true};}));
 app.get<{Params:{id:string}}>('/api/v0/portal/documents/:id',async(req,reply)=>{const d=await client(req,async c=>(await c.query('select pulse.portal_document_read($1) document',[uuid(req.params.id)])).rows[0].document);return reply.header('content-disposition',`attachment; filename="pulse-${d.kind}-${d.id}.json"`).header('cache-control','private, no-store').send(d);});
 app.post<{Body:Record<string,unknown>}>('/api/v0/portal/refund-request',{schema:{body}},req=>client(req,async c=>(await c.query('select pulse.portal_refund_request($1,$2,$3) id',[uuid(req.body.projectId),uuid(req.body.invoiceId),JSON.stringify(req.body)])).rows[0]));
 app.post<{Body:Record<string,unknown>}>('/api/v0/delivery/commerce',{schema:{body}},req=>tx(req,async c=>(await c.query('select pulse.portal_document_add($1) id',[JSON.stringify(req.body)])).rows[0]));
 app.get<{Querystring:{project:string}}>('/api/v0/delivery/support',req=>tx(req,async c=>({rows:(await c.query('select pulse.portal_support_staff($1) rows',[uuid(req.query.project)])).rows[0].rows})));
 app.post<{Body:Record<string,unknown>}>('/api/v0/delivery/support',{schema:{body}},req=>tx(req,async c=>({rows:(await c.query('select pulse.portal_support_staff($1,$2) rows',[uuid(req.body.projectId),JSON.stringify(req.body)])).rows[0].rows})));
 app.get('/api/v0/delivery/client-access',req=>tx(req,async c=>(await c.query('select pulse.portal_staff_state() d')).rows[0].d));
 app.post<{Body:Record<string,unknown>}>('/api/v0/delivery/client-access/grant',{schema:{body}},req=>tx(req,async c=>{await c.query('select pulse.portal_grant_save($1,$2,$3,$4,$5)',[uuid(req.body.principalId),uuid(req.body.projectId),req.body.signer===true||req.body.signer==='yes',req.body.active===true||req.body.active==='yes',String(req.body.reason??'')]);return {ok:true};}));
 app.post<{Body:Record<string,unknown>}>('/api/v0/delivery/client-access/deactivate',{schema:{body}},req=>tx(req,async c=>{await c.query('select pulse.portal_deactivate($1)',[uuid(req.body.id)]);return {ok:true};}));
 app.post<{Body:Record<string,unknown>}>('/api/v0/delivery/release',{schema:{body}},req=>tx(req,async c=>{
  const b=req.body;const p={projectId:uuid(b.projectId),taskId:uuid(b.taskId),versionId:uuid(b.versionId),fingerprint:String(b.fingerprint??''),title:String(b.title??'').slice(0,240),duration:Number(b.duration),mime:String(b.mime??'video/mp4'),timebase:'seconds',rightsConfirmed:b.rightsConfirmed===true||b.rightsConfirmed==='yes',rights:String(b.rights??''),sourceHash:String(b.sourceHash??''),sourceRevision:String(b.sourceRevision??''),mediaState:String(b.mediaState??'awaiting_copy'),mapping:b.mapping??{offsetSeconds:0,scale:1}};
  if(!/^[a-f0-9]{64}$/.test(p.fingerprint)||!Number.isFinite(p.duration)||!['video/mp4','video/webm','video/quicktime'].includes(p.mime))fail(400,'Retained fingerprint duration and video type required');
  return (await c.query('select pulse.portal_release_add($1) id',[JSON.stringify(p)])).rows[0];
 }));
 app.post<{Body:Record<string,unknown>}>('/api/v0/delivery/release/withdraw',{schema:{body}},req=>tx(req,async c=>{await c.query('select pulse.portal_release_withdraw($1,$2)',[uuid(req.body.id),String(req.body.reason??'')]);return {ok:true};}));
 app.post<{Body:Record<string,unknown>}>('/api/v0/delivery/policy',{schema:{body}},req=>tx(req,async c=>(await c.query('select pulse.portal_policy_publish($1) id',[JSON.stringify(req.body)])).rows[0]));
 app.post<{Body:Record<string,unknown>}>('/api/v0/delivery/publication',{schema:{body}},req=>tx(req,async c=>{await c.query('select pulse.portal_publish($1,$2)',[uuid(req.body.projectId),JSON.stringify(req.body)]);return {ok:true};}));
 // Large media has a separate resumable upload contract. Each bounded chunk rechecks project authority.
 app.post<{Body:Record<string,unknown>}>('/api/v0/delivery/media/start',{schema:{body}},req=>tx(req,async(c,v)=>{const b=req.body;if(!v.person||!Number.isSafeInteger(Number(b.total)))fail(400,'Integer byte length required');const r=(await c.query('select pulse.review_upload_save($1) upload',[JSON.stringify({projectId:uuid(b.projectId),total:Number(b.total)})])).rows[0].upload;await mkdir(join(root(),v.org),{recursive:true,mode:0o700});const f=await open(join(root(),v.org,r.id+'.part'),'wx',0o600);await f.close();return r;}));
 app.post<{Body:Record<string,unknown>}>('/api/v0/delivery/media/chunk',{schema:{body},bodyLimit:6200000},req=>tx(req,async(c,v)=>{
  const b=req.body,uid=uuid(b.id),pr=uuid(b.projectId),offset=Number(b.offset);if(!Number.isSafeInteger(offset)||offset<0||!/^[A-Za-z0-9+/]+={0,2}$/.test(String(b.bytes))||String(b.bytes).length>6000000)fail(400,'A valid bounded media chunk and offset are required');const bytes=Buffer.from(String(b.bytes),'base64');if(!bytes.length)fail(400,'A non-empty chunk is required');
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['review-file:'+uid]);await c.query('select pulse.delivery_access($1,true)',[pr]);
  const upload=(await c.query('select pulse.review_upload_save($1) upload',[JSON.stringify({id:uid,projectId:pr,offset,received:offset+bytes.length})])).rows[0].upload;
  const path=join(root(),v.org,uid+'.part');const f=await open(path,'r+');try{const current=await f.stat();if(current.size<offset)fail(409,'Resume at the available upload offset');await f.write(bytes,0,bytes.length,offset);await f.truncate(offset+bytes.length);}finally{await f.close();}
  return upload;
 }));
 app.get<{Params:{id:string};Querystring:{project:string}}>('/api/v0/delivery/media/:id',req=>tx(req,async c=>(await c.query('select pulse.review_upload_info($1,$2) upload',[uuid(req.params.id),uuid(req.query.project)])).rows[0].upload));
 app.post<{Body:Record<string,unknown>}>('/api/v0/delivery/media/finish',{schema:{body}},req=>tx(req,async(c,v)=>{
  const uid=uuid(req.body.id),pr=uuid(req.body.projectId),path=join(root(),v.org,uid+'.part');await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['review-file:'+uid]);await c.query('select pulse.delivery_access($1,true)',[pr]);
  await c.query('select pulse.review_upload_info($1,$2)',[uid,pr]);const size=(await stat(path)).size,hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);const digest=hash.digest('hex');
  const r=(await c.query('select pulse.review_upload_save($1) upload',[JSON.stringify({id:uid,projectId:pr,offset:size,received:size,complete:true,digest})])).rows[0].upload;
  // A retained artifact name is derived from verified bytes; clients never provide a path.
  const target=join(root(),v.org,digest);try{await stat(target);}catch{await pipeline(createReadStream(path),createWriteStream(target,{flags:'wx',mode:0o400}));}await rename(path,path+'.complete');return r;
 }));
 app.get('/api/v0/delivery/demo-media',async(req,reply)=>{await tx(req,async(_c,v)=>work(v));const path=join(root(),'synthetic.webm');let size:number;try{size=(await stat(path)).size;}catch{return fail(409,'Synthetic review media is not prepared; an operator can regenerate the fixture');}const range=parseRange(typeof req.headers.range==='string'?req.headers.range:undefined,size);reply.header('cache-control','private, no-store').header('accept-ranges','bytes').header('etag','"pulse-synthetic-v1"').type('video/webm');if(!range)return reply.code(416).header('content-range','bytes */'+size).send();if(range.partial)reply.code(206).header('content-range',`bytes ${range.start}-${range.end}/${size}`);reply.header('content-length',String(range.end-range.start+1));return reply.send(createReadStream(path,{start:range.start,end:range.end}));});
 app.get<{Params:{id:string}}>('/api/v0/portal/media/:id',async(req,reply)=>{
  const {release,org}=await client(req,async(c,_me,org)=>({release:(await c.query('select pulse.portal_release_read($1) d',[uuid(req.params.id)])).rows[0].d,org}));
  if(release.mediaState!=='ready')fail(409,release.mediaState==='unsupported_codec'?'This codec needs an authorized derived preview':'The retained review copy or source permission needs support from your project team');
  const path=join(root(),org,release.fingerprint);let size;try{size=(await stat(path)).size;}catch{fail(409,'Retained review copy unavailable; contact your project owner');}
  const etag='"'+release.fingerprint+'"',range=parseRange(typeof req.headers.range==='string'&&(req.headers['if-range']===undefined||req.headers['if-range']===etag)?req.headers.range:undefined,size!);
  reply.header('cache-control','private, no-store').header('x-content-type-options','nosniff').header('accept-ranges','bytes').header('etag',etag).type(release.mime??'video/mp4');
  if(range===null)return reply.code(416).header('content-range','bytes */'+size).header('content-length','0').send();
  if(range.partial)reply.code(206).header('content-range',`bytes ${range.start}-${range.end}/${size}`);reply.header('content-length',String(range.end-range.start+1));return reply.send(createReadStream(path,{start:range.start,end:range.end}));
 });
}
