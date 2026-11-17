import type {FastifyInstance} from 'fastify';
import {registerLeadMedia} from './lead-media.js';
import {fail,work,type Tx,type Open} from './routes.js';
import {normalizeLead,envelope,revealContact,nextAction,verifyTransport,googleLead,managedKeys,retryDelay,quarantineLead,protectContact,type Obj} from './acquisition-model.js';
import {createHash,createHmac} from 'node:crypto';
import {cohortReport} from './acquisition-report.js';
import {probeSource,documentProposal,type ProbeConfig} from './acquisition-sources.js';
const id=(v:unknown)=>/^[0-9a-f-]{36}$/.test(String(v))?String(v):fail(400,'Choose a valid acquisition record');
const safe=<T>(run:()=>T)=>{try{return run();}catch(e){return fail(400,e instanceof Error?e.message:'Invalid source input');}};
const body={type:'object',additionalProperties:true,maxProperties:80} as const;
const readConfig=(name:string):unknown[]=>{try{const p=JSON.parse(process.env[name]??'[]');if(!Array.isArray(p))throw new Error();return p;}catch{return fail(503,'Selected provider configuration is unavailable');}};
export function registerAcquisitionRoutes(app:FastifyInstance,{tx,open}:{tx:Tx;open:Open}){
 registerLeadMedia(app,tx);
 app.get<{Querystring:Obj}>('/api/v0/acquisition',req=>tx(req,async(c,v)=>{
 work(v);const state=(await c.query('select pulse.acq_state() d')).rows[0].d;
 const projects=(await c.query('select id,coalesce(title,name) title,client_id "clientId" from pulse.project where pulse.acq_can(id) order by coalesce(title,name)')).rows;
 const people=(await c.query("select id,display_name name from pulse.person where side='staff' and status='active' order by display_name")).rows;
 const now=new Date().toISOString();const actions=(state.leads as Obj[]).map(l=>nextAction(l,(state.sources as Obj[]).find(s=>s.id===l.sourceId)??{state:l.sourceState},now)).sort((a,b)=>b.rank-a.rank||b.elapsedMs-a.elapsedMs);
 return {...state,report:cohortReport(state,req.query),synthetic:false,projects,people,permissions:{write:['admin','leadership','manager','pgs'].includes(v.role),finance:(await c.query("select pulse.money_can('money.amount.read') and pulse.money_can('money.plan.write') ok")).rows[0].ok,admin:v.role==='admin'},viewer:v.person,org:v.org,now,actions,identityReady:safe(()=>managedKeys()).length>0};
 }));
 app.post<{Body:Obj}>('/api/v0/acquisition/source',{schema:{body}},req=>tx(req,async c=>(await c.query('select pulse.acq_source_save($1) id',[JSON.stringify(req.body)])).rows[0]));
 app.post<{Body:Obj}>('/api/v0/acquisition/intake',{schema:{body}},req=>tx(req,async c=>{
 const p=req.body,sourceId=id(p.sourceId),source=(await c.query('select pulse.acq_state() d')).rows[0].d.sources.find((s:Obj)=>s.id===sourceId);if(!source)fail(403,'Select an authorized source');
 const normalized=safe(()=>normalizeLead(p,{controller:source.controller,path:source.path,namespace:String(source.body.namespace??sourceId)}));
 const receipt=(await c.query('select pulse.acq_receive($1,$2) d',[sourceId,JSON.stringify(envelope(p,normalized))])).rows[0].d;
 // Manual review is explicit; provider delivery is always acknowledged after its restricted envelope is committed.
 if(p.reviewed===true)return {...receipt,...(await c.query('select pulse.acq_resolve($1) d',[receipt.id])).rows[0].d};return receipt;
 }));
 app.post<{Body:Obj}>('/api/v0/acquisition/resolve',{schema:{body}},req=>tx(req,async c=>(await c.query('select pulse.acq_resolve($1) d',[id(req.body.id)])).rows[0].d));
 app.post<{Body:Obj}>('/api/v0/acquisition/stage',{schema:{body}},req=>tx(req,async c=>(await c.query('select pulse.acq_stage_add($1) id',[JSON.stringify(req.body)])).rows[0]));
 app.post<{Body:Obj}>('/api/v0/acquisition/correction',{schema:{body}},req=>tx(req,async c=>{const p=req.body;const clean:Obj=Object.fromEntries(['id','revision','ownerId','consent','optOut','reason'].filter(k=>p[k]!==undefined).map(k=>[k,p[k]]));if(p.phone!==undefined||p.email!==undefined){const state=(await c.query('select pulse.acq_state() d')).rows[0].d;const lead=state.leads.find((l:Obj)=>l.id===p.id);if(!lead)return fail(403,'Assigned buyer scope unavailable');const old=(await c.query('select pulse.acq_contact($1) d',[id(p.id)])).rows[0].d;const decoded=safe(()=>revealContact(old));const contact=safe(()=>protectContact(lead.controller,lead.path,{...decoded,phone:p.phone??decoded.phone,email:p.email??decoded.email}));Object.assign(clean,{protectedContact:contact.contact,aliases:contact.aliases,phoneAvailable:contact.phoneAvailable});}await c.query('select pulse.acq_edit($1)',[JSON.stringify(clean)]);return {ok:true};}));
 app.post<{Body:Obj}>('/api/v0/acquisition/withdraw',{schema:{body}},req=>tx(req,async c=>{await c.query('select pulse.acq_withdraw($1,$2)',[id(req.body.id),String(req.body.reason??'')]);return {ok:true};}));
 app.get<{Params:{id:string}}>('/api/v0/acquisition/contact/:id',req=>tx(req,async c=>{const data=(await c.query('select pulse.acq_contact($1) d',[id(req.params.id)])).rows[0].d;return safe(()=>revealContact(data));}));
 // Reuse the disabled incoming-adapter seam. Each adapter is explicitly pinned to a source/account in operator config.
 // Capture bytes in this encapsulated plugin, verify before parsing, never log payloads or secrets.
 app.register(async ingress=>{
 ingress.addContentTypeParser('application/json',{parseAs:'buffer',bodyLimit:65536},(_req,raw,done)=>done(null,raw));
 ingress.post<{Params:{source:string}}>('/api/v0/acquisition/webhook/:source',async(req,reply)=>{
 const configs=readConfig('PULSE_ACQUISITION_WEBHOOKS') as {sourceId:string;kind:string;secret:string;namespace:string;controller:string;path:string;notice:string;consent:boolean;account:string}[];
 const cfg=configs.find(s=>s.sourceId===req.params.source)??fail(404,'Incoming adapter is disabled');
 const raw=req.body as Buffer;let parsed:Obj;
 if(cfg.kind==='google_forms'){parsed=safe(()=>JSON.parse(raw.toString('utf8')));if(!verifyTransport(cfg.kind,raw,String(parsed.google_key??''),cfg.secret))fail(401,'Transport verification failed');}
 else {if(!verifyTransport(cfg.kind,raw,String(req.headers['x-pulse-signature']??''),cfg.secret))fail(401,'Transport verification failed');parsed=safe(()=>JSON.parse(raw.toString('utf8')));}
 // This adapter accepts a signed normalized landing/transport lead, not arbitrary Meta notifications or chat payloads.
 if(!['landing','google_forms','crm'].includes(cfg.kind))fail(400,'Selected provider parser is not connected');
 if(cfg.kind!=='google_forms'&&parsed.account!==cfg.account)fail(401,'Source account mismatch');
 const p=cfg.kind==='google_forms'?{...googleLead(parsed),notice:cfg.notice,consent:cfg.consent}:parsed;
 const scope={controller:cfg.controller,path:cfg.path,namespace:cfg.namespace};let normalized:Obj,quarantined=false;try{normalized=normalizeLead(p,scope);}catch(e){normalized=quarantineLead(p,scope,e instanceof Error?e.message:'Source schema needs review');quarantined=true;}
 const receivedInput=quarantined?{...p,occurred:new Date().toISOString(),objectId:p.objectId??p.leadId??('invalid:'+createHmac('sha256',cfg.secret).update(raw).digest('hex'))}:p;
 const result=await open(async c=>(await c.query('select pulse.acq_receive($1,$2) d',[id(cfg.sourceId),JSON.stringify(envelope(receivedInput,normalized))])).rows[0].d);
 return reply.code(200).send(result);
 });
 });
 app.post<{Body:Obj}>('/api/v0/acquisition/source-control',{schema:{body}},req=>tx(req,async c=>{
 const p=req.body,s=id(p.id);let control:Obj={revision:p.revision,reason:p.reason,state:'revoked'};
 if(p.action==='probe'){
 const cfg=(readConfig('PULSE_ACQUISITION_PROBES') as ProbeConfig[]).find(x=>x.sourceId===s);if(!cfg)return fail(409,'No selected provider read configuration. Source remains in setup.');
 const source=(await c.query('select pulse.acq_state() d')).rows[0].d.sources.find((x:Obj)=>x.id===s);if(!source)return fail(403,'Scoped source unavailable');
 if(source.kind!==cfg.kind)return fail(400,'Selected provider configuration does not match source');
 // Probe outside mutations; failure preserves the last cursor/cutoff and creates one reconnect task.
 try{control={...await probeSource(cfg),revision:p.revision,reason:p.reason,state:'authorized'};}catch(e){control={revision:p.revision,state:'failed',reason:e instanceof Error?e.message:'Source endpoint test failed'};}
 }else if(p.action!=='revoke')return fail(400,'Choose a minimal read or revoke action');
 await c.query('select pulse.acq_source_control($1,$2)',[s,JSON.stringify(control)]);return {ok:true,state:control.state,reason:control.reason};
 }));
 app.post<{Body:Obj}>('/api/v0/acquisition/manual-close',{schema:{body}},req=>tx(req,async c=>{await c.query('select pulse.acq_manual_close($1,$2)',[id(req.body.id),JSON.stringify(req.body)]);return {ok:true};}));
 app.post<{Body:Obj}>('/api/v0/acquisition/recovery',{schema:{body}},req=>tx(req,async c=>{await c.query('select pulse.acq_queue_recover($1,$2)',[id(req.body.id),String(req.body.reason??'')]);return {ok:true};}));
 app.post('/api/v0/acquisition/process',req=>tx(req,async c=>{
 const state=(await c.query('select pulse.acq_state() d')).rows[0].d;const results=[];
 for(const item of (state.reviews as Obj[]).filter(r=>r.kind==='lead'&&r.state!=='dead_letter'&&Date.parse(String(r.nextAt))<=Date.now()).slice(0,25)){
 await c.query('savepoint acq_item');try{const result=(await c.query('select pulse.acq_resolve($1) d',[item.id])).rows[0].d;results.push({id:item.id,...result});}catch{
 await c.query('rollback to savepoint acq_item');const delay=Math.min(21600,Math.ceil(retryDelay(Number(item.attempts))/1000));await c.query('select pulse.acq_retry($1,$2,$3)',[item.id,'Scoped parser or identity review failed',delay]);results.push({id:item.id,quarantined:true});}
 }
 return {processed:results.length,results,bounded:25};
 }));
 app.post<{Body:Obj}>('/api/v0/acquisition/spend',{schema:{body}},req=>tx(req,async c=>{const p=req.body;const fields=['day','adId','creativeId','vintage','supersedes','basis','minor','currency','scale','window','evidence','cohortFrom','cohortTo','comparable','coverage'];const clean=Object.fromEntries(fields.filter(k=>p[k]!==undefined).map(k=>[k,p[k]]));await c.query('select pulse.acq_spend_add($1,$2)',[id(p.sourceId),JSON.stringify(clean)]);return {ok:true};}));
 app.post<{Body:Obj}>('/api/v0/acquisition/link',{schema:{body}},req=>tx(req,async c=>(await c.query('select pulse.acq_link_add($1) id',[JSON.stringify(req.body)])).rows[0]));
 app.post<{Body:Obj}>('/api/v0/acquisition/snapshot',{schema:{body}},req=>tx(req,async c=>{await c.query('select pulse.acq_snapshot_apply($1,$2)',[id(req.body.sourceId),JSON.stringify(req.body)]);return {ok:true};}));
 app.post<{Body:Obj}>('/api/v0/acquisition/work-review',{schema:{body}},req=>tx(req,async c=>{await c.query('select pulse.acq_snapshot_review($1,$2,$3)',[id(req.body.sourceId),String(req.body.objectId),JSON.stringify(req.body.decision)]);return {ok:true};}));
 app.post<{Body:Obj}>('/api/v0/acquisition/document',{schema:{body}},req=>tx(req,async c=>{
 const p=req.body,proposal=safe(()=>documentProposal(p,process.env.PULSE_FINANCE_SCANNER_SECRET??'',String(req.headers['x-pulse-scanner-signature']??'')));
 const normalized={...proposal};const item={objectId:p.objectId,vintage:p.vintage??'v1',occurred:p.occurred,batchHash:createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),normalized};
 return (await c.query('select pulse.acq_receive($1,$2) d',[id(p.sourceId),JSON.stringify(item)])).rows[0].d;
 }));
 app.post<{Body:Obj}>('/api/v0/acquisition/document-review',{schema:{body}},req=>tx(req,async c=>(await c.query('select pulse.acq_document_certify($1,$2) id',[id(req.body.id),JSON.stringify(req.body)])).rows[0]));
 app.get('/api/v0/acquisition/contracts',req=>tx(req,async(_c,v)=>{work(v);return {incomingEnabled:!!process.env.PULSE_ACQUISITION_WEBHOOKS,identityReady:safe(()=>managedKeys()).length>0,providerWrites:false,metaLeadRetrieval:false,workspacePolling:false,financeAttachmentScanner:false,chatIsolation:true,contractHash:createHash('sha256').update('pulse-acquisition-envelope-v1').digest('hex')};}));
}
