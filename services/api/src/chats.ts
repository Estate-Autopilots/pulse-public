import { ORG_TZ } from './org-time.js';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { admin, fail, leadership, type Tx, type Viewer } from './routes.js';
import { markDuplicateChannels } from './chat-list-model.js';
import { moduleOff, readModules } from './modules.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id=(raw:unknown)=>UUID.test(String(raw))?String(raw):fail(400,'Choose a valid conversation or message');
const ids=(raw:unknown,max=256)=>{if(raw===undefined||raw===null)return [];if(!Array.isArray(raw)||raw.length>max)fail(400,'Choose up to '+max+' people');return [...new Set((raw as unknown[]).map(id))];};
type Body=Record<string,unknown>;
const member=(v:Viewer)=>{if(!v.person)fail(403,'Chats requires your individual employee account');};
const PHOTO=(alias:string)=>`(select ph.updated_at from pulse.person_photo ph where ph.person_id=${alias}.id)`;
// EST-1733: an AI employee's permanent ID beside its name (null for people); its model stays on its profile.
const EMPLOYEE_ID=(person:string)=>`(select am.employee_id from pulse.agent_member am where am.person_id=${person})`;
// Edit and delete windows (enforced by chat_edit and chat_remove); the UI offers the actions only inside them.
// Operator-configured board UI base; never infer an external destination from message text.
const boardUrl = /^https:\/\/[^\s]+$/.test(process.env.PULSE_PAPERCLIP_URL ?? '') ? process.env.PULSE_PAPERCLIP_URL!.replace(/\/$/,'') : null;
export const CHAT_POLICY={editMinutes:15,removeHours:48};
// Inline previews only for raster images; everything else downloads, sandboxed.
const PREVIEW=new Set(['image/png','image/jpeg','image/gif','image/webp']);
// FEATURES-1024 (CHAT-SHELL "non-image chat files are not opened in the panel"): a PDF or plain text opens beside the chat too.
// A PDF goes without the sandbox (Chrome's PDF viewer draws nothing in a sandboxed document; tasks.ts sendFile does the same).
const DOC_PREVIEW=new Set(['application/pdf','text/plain']);
// CHAT-V3 (speed): the quoted message is looked up by `q.id=(select coalesce(...))`. Written as `q.id=coalesce(...)`
// Postgres could not use the key under row security and read every message of the company for each row (7 s to open a
// conversation once a company had ~1,500 messages); the scalar sub-select makes it one index read (7 ms).
// WA-NATIVE (1051): a WhatsApp guest reads "name (WhatsApp)"; imported messages carry `imported` (the chat has one marker,
// the bubbles none); `mentioned` names the people of mentions[] (a client contact has no username to highlight).
const GUEST=(m:string,p:string)=>`coalesce((select g.label||' (WhatsApp)' from pulse.chat_guest g where g.id=${m}.guest_id),${p}.display_name)`;
const MESSAGE=`m.id,m.channel_id "channelId",m.author_id "authorId",${GUEST('m','p')} name,m.import_ref is not null imported,m.guest_id is not null guest,
 case when cardinality(m.mentions)>0 then (select jsonb_agg(jsonb_build_object('id',x.id,'name',x.display_name,'username',xp.username)) from pulse.person x left join pulse.people_profile xp on xp.person_id=x.id where x.id=any(m.mentions)) end mentioned,p.side='agent' "byAgent",${EMPLOYEE_ID('m.author_id')} "employeeId",(select jsonb_build_object('lane',r.lane,'model',r.model,'tokens',r.tokens,'seconds',r.seconds,'state',r.state) from pulse.agent_output o join pulse.agent_run r on r.id=o.run_id where o.subject_type='message' and o.subject_id=m.id) "agentRun",(select jsonb_build_object('state',e.state,'reason',e.reason,'agent',ap.display_name,'runtimeState',am.runtime_state,'runtimeUntil',am.runtime_until) from pulse.agent_event e join pulse.person ap on ap.id=e.agent_id join pulse.agent_member am on am.person_id=e.agent_id where e.subject_type='message' and e.subject_id=m.id order by e.created_at desc limit 1) "agentAsk",(select jsonb_build_object('id',h.id,'title',h.title,'details',h.details,'state',h.state,'reason',h.reason,'boardRef',h.board_ref) from pulse.agent_handoff h where h.message_id=m.id) "handoff",(select jsonb_build_object('state',u.state,'boardRef',h.board_ref) from pulse.agent_handoff_update u join pulse.agent_handoff h on h.id=u.handoff_id where u.message_id=m.id) "handoffUpdate",(select jsonb_build_object('id',pr.id,'kind',pr.kind,'taskId',pr.task_id,'on',case when pr.dm_message_id=m.id or pr.escalation_message_id=m.id then 'ask' else 'sent' end,'state',pr.state,'body',pr.body,'sentBody',pr.sent_body,'why',pr.why,'mine',pr.approver_id=pulse.current_viewer() or pr.escalated_to=pulse.current_viewer(),'urgent',pr.urgent,'reminded',pr.reminded_at is not null,'escalatedTo',(select display_name from pulse.person where id=pr.escalated_to and pr.escalation_message_id is not null),'askedOfMe',pr.escalated_to=pulse.current_viewer(),'approver',(select display_name from pulse.person where id=pr.approver_id),'decidedBy',(select display_name from pulse.person where id=pr.decided_by),'decidedAt',pr.decided_at,'via',pr.decided_via,'channelId',pr.channel_id,'channelName',(select name from pulse.chat_channel where id=pr.channel_id),'postedMessageId',pr.posted_message_id) from pulse.agent_proposal pr where pr.dm_message_id=m.id or pr.posted_message_id=m.id or pr.escalation_message_id=m.id limit 1) "proposal",pp.username,${PHOTO('p')} "photoAt",m.body,m.parent_id "parentId",m.quote_id "quoteId",m.kind,case when m.author_id=pulse.current_viewer() then m.client_id end "clientId",to_char(m.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "createdAt",m.edited_at "editedAt",m.removed_at is not null removed,m.attachments,m.mentions,
 (select count(*)::int from pulse.chat_message r where r.org_id=m.org_id and r.parent_id=m.id) replies,
 (select jsonb_build_object('id',q.id,'authorId',q.author_id,'name',qp.display_name,'body',left(q.body,240),'removed',q.removed_at is not null,'attachments',jsonb_array_length(q.attachments))
  from pulse.chat_message q join pulse.person qp on qp.id=q.author_id where q.id=(select coalesce(m.quote_id,m.parent_id))) quote,
 coalesce((select jsonb_agg(r) from(select emoji,count(*)::int count,bool_or(person_id=pulse.current_viewer()) mine from pulse.chat_reaction where message_id=m.id group by emoji) r),'[]') reactions,
 -- CHAT-V3: pinned in this conversation, forwarded, saved by me, the thread's last reply, a comment's point on a picture, an approval.
 m.pinned_at "pinnedAt",m.forwarded,exists(select 1 from pulse.chat_star s where s.person_id=pulse.current_viewer() and s.message_id=m.id) starred,
 (select to_char(max(r.created_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') from pulse.chat_message r where r.org_id=m.org_id and r.parent_id=m.id) "lastReplyAt",
 (select jsonb_build_object('fileId',a.file_id,'x',a.x,'y',a.y,'resolved',a.resolved_at is not null) from pulse.chat_annotation a where a.message_id=m.id) annotation,
 (select jsonb_build_object('state',ap.state,'askedBy',ap.asked_by,'askedByName',(select display_name from pulse.person where id=ap.asked_by),'decidedBy',ap.decided_by,'decidedByName',(select display_name from pulse.person where id=ap.decided_by),'decidedAt',ap.decided_at,'note',ap.note,'rounds',ap.rounds) from pulse.chat_approval ap where ap.message_id=m.id) approval,
 -- CHAT-V5: a poll asked with this message: its choices and everyone's votes (counted in the browser).
 (select jsonb_build_object('options',pl.options,'multi',pl.multi,'closed',pl.closed_at is not null,'createdBy',pl.created_by,
   'votes',coalesce((select jsonb_agg(jsonb_build_array(v.choice,v.person_id) order by v.voted_at) from pulse.chat_poll_vote v where v.org_id=pl.org_id and v.poll_id=pl.id),'[]'))
  from pulse.chat_poll pl where pl.org_id=m.org_id and pl.message_id=m.id) poll,
 -- CHAT-V5: my own reminder waiting on this message (nobody else sees it).
 (select jsonb_build_object('id',x.id,'at',to_char(x.due_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')) from pulse.chat_reminder x where x.org_id=m.org_id and x.message_id=m.id and x.person_id=pulse.current_viewer() and x.fired_at is null and x.cancelled_at is null order by x.due_at limit 1) reminder,
 (m.import_ref is null and (p.status<>'active' or not exists(select 1 from pulse.chat_member fm where fm.channel_id=m.channel_id and fm.person_id=m.author_id))) former`;
const FROM=`pulse.chat_message m join pulse.person p on p.id=m.author_id left join pulse.people_profile pp on pp.person_id=p.id`;
// CHAT-V3 (live): one LISTEN connection per API process. NOTIFY pulse_chat ('org:channel', from every chat_event) wakes the
// streams of that company at once instead of their next poll; NOTIFY pulse_chat_typing carries who is typing where (never
// stored). Each stream passes on only conversations its person is in.
type ChatWake={channel:string;typing?:{person:string;name:string;on:boolean}};
class ChatHub{
 private subs=new Map<string,Set<(w:ChatWake)=>void>>();private client:PoolClient|null=null;private starting=false;private closed=false;
 constructor(private pool?:Pool){}
 close(){this.closed=true;const c=this.client;this.client=null;if(c){try{c.release(true);}catch{/* gone */}}}
 private async listen(){
  if(!this.pool||this.client||this.starting||this.closed)return;this.starting=true;
  try{
   const c=await this.pool.connect();
   c.on('notification',m=>{if(!m.payload)return;try{
    if(m.channel==='pulse_chat'){const [org,channel]=m.payload.split(':');if(org&&channel)this.wake(org,{channel});}
    else if(m.channel==='pulse_chat_typing'){const t=JSON.parse(m.payload) as {o:string;c:string;p:string;n:string;on:boolean};this.wake(t.o,{channel:t.c,typing:{person:t.p,name:t.n,on:!!t.on}});}
   }catch{/* a malformed payload is ignored */}});
   c.on('error',()=>this.drop(c));
   await c.query('listen pulse_chat');await c.query('listen pulse_chat_typing');
   if(this.closed){c.release(true);return;}this.client=c;
  }catch{if(!this.closed)setTimeout(()=>void this.listen(),5000).unref();}finally{this.starting=false;}
 }
 private drop(c:PoolClient){if(this.client!==c)return;this.client=null;try{c.release(true);}catch{/* gone */}if(!this.closed)setTimeout(()=>void this.listen(),2000).unref();}
 private wake(org:string,w:ChatWake){this.subs.get(org)?.forEach(f=>f(w));}
 on(org:string,f:(w:ChatWake)=>void){void this.listen();let s=this.subs.get(org);if(!s){s=new Set();this.subs.set(org,s);}s.add(f);return()=>{s!.delete(f);if(!s!.size)this.subs.delete(org);};}
}
const HAS=new Set(['image','file','link','voice','task']);
const HAS_SQL:Record<string,string>={image:"(a->>'mime') like 'image/%'",file:"a ? 'id' and coalesce(a->>'mime','') not like 'image/%' and not a ? 'voice'",link:"a ? 'url'",voice:"a ? 'voice'",task:"a ? 'task'"};
const DAY=/^\d{4}-\d{2}-\d{2}$/;
// CHAT-V5 (Threads inbox): the threads I am in ($1: I started it, replied in it or was mentioned in it) in conversations I
// am a member of, newest reply first; unread = replies by others after I last opened the thread (or, never opened, after
// my own latest message in it).
const THREADS=`with t as (
  select r.parent_id root,count(*)::int replies,max(r.created_at) last_at,bool_or(r.author_id=$1) replied,bool_or($1=any(r.mentions)) mentioned,max(r.created_at) filter (where r.author_id=$1) my_last
  from pulse.chat_message r where r.parent_id is not null and r.removed_at is null and r.kind='text' and r.channel_id in (select cm.channel_id from pulse.chat_member cm where cm.person_id=$1)
  group by r.parent_id)
 select t.root "rootId",m.channel_id "channelId",m.author_id "rootAuthorId",coalesce((select g.label||' (WhatsApp)' from pulse.chat_guest g where g.id=m.guest_id),rp.display_name) "rootName",left(regexp_replace(m.body,'\\s+',' ','g'),200) "rootBody",jsonb_array_length(m.attachments) "rootFiles",m.removed_at is not null "rootRemoved",
  t.replies,to_char(t.last_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "lastAt",lr.name "lastName",lr.author_id "lastAuthorId",lr.body "lastBody",
  (select count(*)::int from pulse.chat_message u where u.org_id=m.org_id and u.parent_id=t.root and u.author_id<>$1 and u.removed_at is null and u.kind='text'
    and u.created_at>coalesce(tr.read_through,greatest(t.my_last,case when m.author_id=$1 then m.created_at end),'-infinity')) unread
 from t join pulse.chat_message m on m.id=t.root join pulse.person rp on rp.id=m.author_id
 left join pulse.chat_thread_read tr on tr.person_id=$1 and tr.root_id=t.root
 left join lateral (select coalesce((select g.label||' (WhatsApp)' from pulse.chat_guest g where g.id=x.guest_id),p.display_name) name,x.author_id,left(regexp_replace(x.body,'\\s+',' ','g'),160) body from pulse.chat_message x join pulse.person p on p.id=x.author_id
  where x.org_id=m.org_id and x.parent_id=t.root and x.removed_at is null and x.kind='text' order by x.created_at desc limit 1) lr on true
 where m.author_id=$1 or t.replied or t.mentioned or $1=any(m.mentions)`;
const iso=(t:unknown)=>t instanceof Date&&Number.isFinite(t.getTime())?t.toISOString():null;
/** CHAT-V5: deliver what is due, one company's transaction at a time (the NOTIFY of each new message tells the chats). */
export async function runDue(pool:Pool){
 let n=0;
 const orgs=(await pool.query('select pulse.list_active_orgs() org')).rows.map(r=>r.org as string);
 for(const org of orgs){
  const c=await pool.connect();
  try{await c.query('begin');await c.query("select set_config('pulse.org_id',$1,true)",[org]);n+=(await c.query('select pulse.chat_due() n')).rows[0].n;await c.query('commit');}
  catch(e){await c.query('rollback').catch(()=>{});throw e;}finally{c.release();}
 }
 return n;
}
export function registerChatRoutes(app:FastifyInstance,{tx,pool}:{tx:Tx;pool?:Pool}){
 const hub=new ChatHub(pool);
 // CHAT-V5 (later): every few seconds, what is due in each active company: reminders ring, scheduled messages go.
 // CHAT-V6: and once right after start, so what fell due while the API was down or restarting goes at once (the worker's
 // minute tick delivers it too when the API is down; chat_due claims each row once, so the two never both send it).
 let dueBusy=false;
 const due=()=>{if(dueBusy||!pool)return;dueBusy=true;void runDue(pool).then(n=>{if(n)app.log.info({delivered:n},'Chat reminders and scheduled messages delivered');}).catch(()=>app.log.warn('Chat reminders and scheduled messages: delivery unavailable')).finally(()=>{dueBusy=false;});};
 const dueOn=!!pool&&process.env.PULSE_CHAT_DUE!=='0';
 const dueTick=dueOn?setInterval(due,10000):null,dueStart=dueOn?setTimeout(due,2000):null;
 dueTick?.unref();dueStart?.unref();
 app.addHook('onClose',async()=>{hub.close();if(dueTick)clearInterval(dueTick);if(dueStart)clearTimeout(dueStart);});
 const connections=async(c:Parameters<Parameters<Tx>[1]>[0],v:Viewer)=>{
  const a=(await c.query("select handle from pulse.account where handle=$1 and holder_person_id=$2 and provider='google' and not is_shared and purpose like 'Workspace%'",[v.email,v.person])).rows[0];
  return {email:{connected:!!a,sendEnabled:process.env.PULSE_GMAIL_SEND_ENABLED==='1'},telegram:{enabled:process.env.PULSE_TELEGRAM_CHAT_ENABLED==='1',connected:false},whatsapp:{enabled:process.env.PULSE_WHATSAPP_CHAT_ENABLED==='1',connected:false}};
 };
 app.get('/api/v0/chats/connections',req=>tx(req,async(c,v)=>{member(v);return connections(c,v);}));
 const body={type:'object'} as const;
 // The whole list in one read: conversations (with the other person of a DM, pin, last message), people and channel
 // connections. Loading it also marks everything so far as delivered to this person.
 app.get('/api/v0/chats',req=>tx(req,async(c,v)=>{
  member(v);await c.query('select pulse.chat_refresh_soon()');await c.query('select pulse.chat_delivered()');
  const channels=(await c.query(`select ch.id,mine.person_id is null "moderationOnly",case when ch.kind='direct' then coalesce(peer.name,'Direct message') else ch.name end name,ch.kind,ch.description,ch.address,
   ch.photo_at "photoAt",pulse.connect_chat_label(ch.id) "withOrg",peer.id "peerId",(peer.id is not null and not exists(select 1 from pulse.chat_member pm join pulse.person pa on pa.id=pm.person_id where pm.channel_id=ch.id and pm.person_id=peer.id and pulse.chat_current(pa.id))) "peerFormer",peer.photo_at "peerPhotoAt",coalesce(peer.agent,false) "peerAgent",peer.username "peerUsername",peer.department "peerDepartment",mine.pinned_at "pinnedAt",mine.role "myRole",mine.muted_until "mutedUntil",mine.archived_at "archivedAt",mine.marked_unread_at "markedUnread",(ch.kind<>'direct' and pulse.chat_client_facing(ch.id)) "clientFacing",
   -- CHAT-V3: a thread's replies are read in the thread, so they do not count as unread in the conversation.
   (select count(*)::int from pulse.chat_message m where m.channel_id=ch.id and m.author_id<>$1 and m.created_at>mine.read_through and m.removed_at is null and m.kind='text' and m.parent_id is null and m.import_ref is null) unread,
   (select count(*)::int from pulse.chat_message m where m.channel_id=ch.id and ($1=any(m.mentions) or m.broadcast='everyone' and m.author_id<>$1 and coalesce(mine.muted_until<=now(),true)) and m.created_at>mine.read_through and m.removed_at is null and m.import_ref is null) mentions,
   -- CHAT-V6: a muted chat's @everyone does not raise the @ badge (its notification already respects the mute); a mention by name still does.
   (select count(*)::int from pulse.chat_member cm join pulse.person p on p.id=cm.person_id where cm.channel_id=ch.id and pulse.chat_current(p.id)) members,
   -- WA-IMPORT: a chat imported from WhatsApp sorts by its last WhatsApp message until someone writes in Pulse.
   coalesce((select max(created_at) from pulse.chat_message where channel_id=ch.id),case when ch.key like 'wa:%' then (pulse.wa_channel(ch.id)->>'lastAt')::timestamptz end) "lastAt",
   -- CHAT-V5: reminders that rang here and are not seen yet, and my messages waiting to be sent here.
   (select count(*)::int from pulse.chat_reminder r where r.org_id=ch.org_id and r.person_id=$1 and r.channel_id=ch.id and r.fired_at is not null and r.seen_at is null and r.cancelled_at is null) reminders,
   (select count(*)::int from pulse.chat_scheduled s where s.org_id=ch.org_id and s.author_id=$1 and s.channel_id=ch.id and s.sent_at is null and s.cancelled_at is null) scheduled,
   -- R47: imported WhatsApp history this member can read (only groups people made and direct chats take any).
   case when ch.kind in ('custom','direct') and mine.person_id is not null then pulse.chat_history_count(ch.id) else 0 end imported,
   -- WA-IMPORT: the WhatsApp group this chat was made from ({chatId, messages, firstAt, lastAt}), for its members and admins;
   -- WA-NATIVE: native = its history is this chat's own messages now ({nativeMessages, guests}).
   case when ch.key like 'wa:%' then pulse.wa_native_channel(ch.id) end whatsapp,
   -- A one-line preview of the latest message, for members only (a moderation role never reads content here).
   last.body preview,last.name "previewAuthor",last.author_id "previewAuthorId",last.kind "previewKind",last.removed "previewRemoved",last.attachment "previewAttachment"
   from pulse.chat_channel ch
   left join pulse.chat_member mine on mine.channel_id=ch.id and mine.person_id=$1
   left join lateral (select * from (select p.id,p.display_name name,pp.username,pp.department,${PHOTO('p')} photo_at,p.side='agent' agent,0 o from pulse.chat_member cm join pulse.person p on p.id=cm.person_id left join pulse.people_profile pp on pp.person_id=p.id
    where ch.kind='direct' and cm.channel_id=ch.id and cm.person_id<>$1
    union all select p.id,p.display_name,pp.username,pp.department,${PHOTO('p')},p.side='agent',1 from pulse.chat_former_member f join pulse.person p on p.id=f.person_id left join pulse.people_profile pp on pp.person_id=p.id
    where ch.kind='direct' and f.channel_id=ch.id and f.person_id<>$1) x order by o limit 1) peer on true
   left join lateral (select left(regexp_replace(m.body,'\\s+',' ','g'),140) body,${GUEST('m','p')} name,m.author_id,m.kind,m.removed_at is not null removed,m.attachments->0 attachment
    from pulse.chat_message m join pulse.person p on p.id=m.author_id where m.channel_id=ch.id and mine.person_id is not null order by m.created_at desc limit 1) last on true
   -- WA-IMPORT: a WhatsApp group a moderator is not in stays out of their list (hundreds of them; /chats/whatsapp lists them all).
   where ($2::boolean=false or mine.person_id is not null) and not (mine.person_id is null and ch.key like 'wa:%') order by case ch.kind when 'pod' then 0 when 'team' then 1 when 'group' then 2 else 3 end,ch.name`,[v.person,!!v.nativeDevice])).rows;
  const everyone=(await c.query(`select p.id,p.display_name name,pp.username,pp.pod,pp.department team,${PHOTO('p')} "photoAt",pulse.lifecycle_possibly_left(p.id) quiet,p.side='agent' agent,${EMPLOYEE_ID('p.id')} "employeeId" from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id
   where (p.side='staff' or ($1 and p.side='agent' and exists(select 1 from pulse.agent_member am where am.person_id=p.id and am.disabled_at is null))) and pulse.chat_current(p.id)
     and ($2::boolean=false or exists(select 1 from pulse.chat_member a join pulse.chat_member b on b.channel_id=a.channel_id where a.person_id=$3 and b.person_id=p.id))
   order by p.side='agent',p.display_name`,[leadership(v),v.side==='client',v.person])).rows;
  // E2E-4P: a client of this organisation (a connected organisation's contact) saw its whole staff directory here; they
  // see only the people they share a conversation with, as CONNECT promises ("nothing else of ours is visible").
  const people=everyone.filter(p=>!p.quiet).map(({quiet:_,...p})=>p),searchOnly=everyone.filter(p=>p.quiet).map(({quiet:_,...p})=>p);
  // CHAT-V5: how many of my threads have replies I have not read (the Threads row's count).
  const threadsUnread=(await c.query(`select count(*) filter (where unread>0)::int n from (${THREADS}) x`,[v.person])).rows[0]?.n??0;
  return {boardUrl,channels:markDuplicateChannels(channels),people,searchOnly,viewer:v.person,threadsUnread,canModerate:admin(v),canLead:leadership(v),canImport:admin(v)&&!moduleOff(await readModules(c,v.org),'chat_import'),retentionDays:365,policy:CHAT_POLICY,connections:v.side==='client'?undefined:await connections(c,v)};
 }));
 app.post<{Body:Body}>('/api/v0/chats/direct',{schema:{body}},req=>tx(req,async(c,v)=>{member(v);return (await c.query('select pulse.chat_direct($1) id',[id(req.body.personId)])).rows[0];}));
 // CHAT-V3: search with filters: from a person, in a conversation, has a photo / file / link / voice note / task, between days.
 // Words match the text or a file's name; filters alone list what matches (all photos Asha sent last week).
 app.get('/api/v0/chats/search',req=>tx(req,async(c,v)=>{
  member(v);const query=req.query as {q?:string;from?:string;channel?:string;has?:string;after?:string;before?:string;older?:string};
  const q=String(query.q??'').trim().slice(0,200),from=query.from?id(query.from):null,channel=query.channel?id(query.channel):null,has=HAS.has(String(query.has))?String(query.has):null;
  const after=DAY.test(String(query.after??''))?String(query.after):null,before=DAY.test(String(query.before??''))?String(query.before):null;
  if(!q&&!from&&!channel&&!has&&!after&&!before)return {messages:[]};
  const where=['m.removed_at is null',"m.kind='text'",'m.channel_id in (select cm.channel_id from pulse.chat_member cm where cm.person_id=$1)'],args:unknown[]=[v.person];
  const arg=(x:unknown)=>{args.push(x);return '$'+args.length;};
  if(q){const t=arg(q),l=arg(q.replace(/[\\%_]/g,'\\$&'));where.push(`(to_tsvector('simple',m.body) @@ plainto_tsquery('simple',${t}) or m.body ilike '%'||${l}||'%' escape '\\' or exists(select 1 from jsonb_array_elements(m.attachments) a where a->>'name' ilike '%'||${l}||'%' escape '\\'))`);}
  if(from)where.push(`m.author_id=${arg(from)}`);
  if(channel)where.push(`m.channel_id=${arg(channel)}`);
  if(has)where.push(`exists(select 1 from jsonb_array_elements(m.attachments) a where ${HAS_SQL[has]})`);
  if(after)where.push(`m.created_at>=(${arg(after)}::date::timestamp at time zone ${ORG_TZ})`);
  if(before)where.push(`m.created_at<((${arg(before)}::date+1)::timestamp at time zone ${ORG_TZ})`);
  // CHAT-V6: the next 60 matches, older than the last one shown (find in a chat goes on past the first 60).
  const older=query.older&&Number.isFinite(Date.parse(query.older))?new Date(query.older).toISOString():null;
  if(older)where.push(`m.created_at<${arg(older)}::timestamptz`);
  return {messages:(await c.query(`select ${MESSAGE} from ${FROM} where ${where.join(' and ')} order by m.created_at desc limit 60`,args)).rows};
 }));
 // CHAT-V5 (later): remind me about a message; my reminders; a message sent later (edit, send now or cancel it until it goes).
 const at=(raw:unknown)=>{const t=Date.parse(String(raw??''));return Number.isFinite(t)?new Date(t).toISOString():fail(400,'Choose a time');};
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/messages/:id/remind',{schema:{body}},req=>tx(req,async(c,v)=>{member(v);return (await c.query('select pulse.chat_remind($1,$2) id',[id(req.params.id),at(req.body.at)])).rows[0];}));
 app.post<{Params:{id:string}}>('/api/v0/chats/reminders/:id/cancel',req=>tx(req,async(c,v)=>{member(v);await c.query('select pulse.chat_remind_cancel($1)',[id(req.params.id)]);return {ok:true};}));
 app.get('/api/v0/chats/reminders',req=>tx(req,async(c,v)=>{
  member(v);return {reminders:(await c.query(`select r.id,r.channel_id "channelId",r.message_id "messageId",m.parent_id "parentId",to_char(r.due_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') "at",r.fired_at is not null fired,
   ${GUEST('m','p')} name,m.author_id "authorId",left(regexp_replace(m.body,'\\s+',' ','g'),160) body from pulse.chat_reminder r join pulse.chat_message m on m.id=r.message_id join pulse.person p on p.id=m.author_id
   where r.person_id=$1 and r.cancelled_at is null and (r.fired_at is null or r.seen_at is null) and m.removed_at is null order by r.fired_at is null,r.due_at limit 100`,[v.person])).rows};
 }));
 const SCHEDULED=`select s.id,s.channel_id "channelId",s.body,s.attachments,s.quote_id "quoteId",s.parent_id "parentId",to_char(s.send_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') "at",s.error,s.failed_at is not null failed from pulse.chat_scheduled s`;
 app.get<{Params:{id:string}}>('/api/v0/chats/:id/scheduled',req=>tx(req,async(c,v)=>{member(v);return {scheduled:(await c.query(`${SCHEDULED} where s.author_id=$1 and s.channel_id=$2 and s.sent_at is null and s.cancelled_at is null order by s.send_at limit 100`,[v.person,id(req.params.id)])).rows};}));
 // CHAT-V6: every message I have waiting to be sent, in all my conversations (the "Reminders and scheduled" screen).
 app.get('/api/v0/chats/scheduled',req=>tx(req,async(c,v)=>{member(v);return {scheduled:(await c.query(`${SCHEDULED} where s.author_id=$1 and s.sent_at is null and s.cancelled_at is null order by s.failed_at is null,s.send_at limit 100`,[v.person])).rows};}));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/:id/scheduled',{schema:{body}},req=>tx(req,async(c,v)=>{
  member(v);const b=req.body;const attachments=b.attachments??[];if(!Array.isArray(attachments)||attachments.length>5)fail(400,'Attach up to five files or links');
  const sid=(await c.query('select pulse.chat_schedule($1,$2,$3,$4,$5,$6) id',[id(req.params.id),String(b.body??''),JSON.stringify(attachments),b.quoteId?id(b.quoteId):null,b.parentId?id(b.parentId):null,at(b.at)])).rows[0].id;
  return {id:sid,scheduled:(await c.query(`${SCHEDULED} where s.id=$1`,[sid])).rows[0]};
 }));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/scheduled/:id',{schema:{body}},req=>tx(req,async(c,v)=>{
  member(v);const b=req.body;await c.query('select pulse.chat_schedule_edit($1,$2,$3)',[id(req.params.id),b.body==null?null:String(b.body),b.at==null?null:at(b.at)]);
  return {scheduled:(await c.query(`${SCHEDULED} where s.id=$1`,[id(req.params.id)])).rows[0]};
 }));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/scheduled/:id/cancel',{schema:{body}},req=>tx(req,async(c,v)=>{
  member(v);const now=req.body.now===true;await c.query('select pulse.chat_schedule_cancel($1,$2)',[id(req.params.id),now]);
  // "Send now": delivered in this request, so the message is there when the answer comes back.
  if(now)await c.query('select pulse.chat_due()');
  return {ok:true};
 }));
 // CHAT-V5 (polls): ask a question with 2-10 choices; vote (again to change, none to take it back); close it.
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/:id/polls',{schema:{body}},req=>tx(req,async(c,v)=>{
  member(v);const b=req.body;const options=Array.isArray(b.options)?(b.options as unknown[]).slice(0,10).map(o=>String(o??'').slice(0,200)):fail(400,'Give 2 to 10 choices');
  const mid=(await c.query('select pulse.chat_poll_create($1,$2,$3,$4,$5) id',[id(req.params.id),String(b.question??''),options,b.multi===true,id(b.clientId)])).rows[0].id;
  return {id:mid,message:(await c.query(`select ${MESSAGE} from ${FROM} where m.id=$1`,[mid])).rows[0]};
 }));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/messages/:id/vote',{schema:{body}},req=>tx(req,async(c,v)=>{
  member(v);const choices=Array.isArray(req.body.choices)?(req.body.choices as unknown[]).slice(0,10).map(Number):fail(400,'Choose');
  if(choices.some(n=>!Number.isInteger(n)))fail(400,'Choose one of the poll\'s choices');
  await c.query('select pulse.chat_poll_vote($1,$2)',[id(req.params.id),choices]);return {ok:true};
 }));
 app.post<{Params:{id:string}}>('/api/v0/chats/messages/:id/poll-close',req=>tx(req,async(c,v)=>{member(v);await c.query('select pulse.chat_poll_close($1)',[id(req.params.id)]);return {ok:true};}));
 // CHAT-V5: the Threads inbox (unread first, then the latest reply), and a thread marked read when I open it.
 app.get('/api/v0/chats/threads',req=>tx(req,async(c,v)=>{
  member(v);return {threads:(await c.query(`select * from (${THREADS}) x order by (unread>0) desc,"lastAt" desc limit 60`,[v.person])).rows};
 }));
 app.post<{Params:{id:string}}>('/api/v0/chats/threads/:id/seen',req=>tx(req,async(c,v)=>{member(v);await c.query('select pulse.chat_thread_seen($1)',[id(req.params.id)]);return {ok:true};}));
 // CHAT-V3: what I saved for later, newest first, from every conversation I can still read.
 app.get('/api/v0/chats/starred',req=>tx(req,async(c,v)=>{
  member(v);return {messages:(await c.query(`select ${MESSAGE} from pulse.chat_star s join ${FROM} on m.id=s.message_id where s.person_id=$1 and m.removed_at is null order by s.at desc limit 100`,[v.person])).rows};
 }));
 // CHAT-V3: a conversation's photos, files, links and voice notes (the gallery), newest first, 90 at a time, with counts.
 app.get<{Params:{id:string}}>('/api/v0/chats/:id/media',req=>tx(req,async(c,v)=>{
  member(v);const cid=id(req.params.id);if(!(await c.query('select pulse.chat_has($1) ok',[cid])).rows[0].ok)fail(404,'Conversation unavailable');
  const query=req.query as {kind?:string;before?:string};const kind=['image','file','link','voice'].includes(String(query.kind))?String(query.kind):'image';
  const before=query.before&&Number.isFinite(Date.parse(query.before))?query.before:null;
  const items=(await c.query(`select m.id "messageId",m.author_id "authorId",${GUEST('m','p')} name,to_char(m.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "createdAt",a attachment
   from pulse.chat_message m join pulse.person p on p.id=m.author_id cross join lateral jsonb_array_elements(m.attachments) a
   where m.channel_id=$1 and m.removed_at is null and m.kind='text' and ${HAS_SQL[kind]} and ($2::timestamptz is null or m.created_at<$2) order by m.created_at desc limit 90`,[cid,before])).rows;
  const counts=(await c.query(`select ${Object.entries(HAS_SQL).filter(([k])=>k!=='task').map(([k,sql])=>`count(*) filter (where ${sql})::int ${k}`).join(',')}
   from pulse.chat_message m cross join lateral jsonb_array_elements(m.attachments) a where m.channel_id=$1 and m.removed_at is null and m.kind='text'`,[cid])).rows[0];
  return {kind,items,counts};
 }));
 // `flat=1` is the WhatsApp view: every message in order, a thread reply shown as quoting its root.
 app.get<{Params:{id:string}}>('/api/v0/chats/:id/messages',req=>tx(req,async(c,v)=>{
  member(v);const cid=id(req.params.id);await c.query('select pulse.chat_refresh_soon()');if(v.nativeDevice&&!(await c.query('select 1 from pulse.chat_member where channel_id=$1 and person_id=$2',[cid,v.person])).rows[0])fail(404,'You are not a member of this conversation');await c.query("select pulse.audit_write('restricted_read','chat_messages',$1)",[cid]);if(!(await c.query('select pulse.chat_has($1) ok',[cid])).rows[0].ok)fail(404,'Conversation unavailable');
  const q=req.query as {thread?:string;before?:string;flat?:string};const before=q.before?new Date(q.before):null;if(before&&!Number.isFinite(before.getTime()))fail(400,'Invalid message cursor');
  if(q.thread&&!(await c.query('select 1 from pulse.chat_message where id=$1 and channel_id=$2 and parent_id is null',[id(q.thread),cid])).rows[0])fail(404,'Thread unavailable');
  const flat=q.flat==='1'&&!q.thread;
  // CHAT-V6: `around=<message>` opens the page around a message however far back (search, a link, a reminder): 30 before
  // it, it and 30 after; `after=<time>` reads on towards the latest from there. A reply opens around its thread's first message.
  const x=req.query as {around?:string;after?:string;at?:string};
  // WA-NATIVE: `at=<day>` jumps to a date: the page around the first message of that day (the company's time), or the
  // last one before it when the chat went quiet then.
  if(x.at&&!x.around){
   if(!DAY.test(x.at))fail(400,'Choose a date');
   const t=(await c.query(`select coalesce((select m.id from pulse.chat_message m where m.channel_id=$1 and m.parent_id is null and m.created_at>=($2::date::timestamp at time zone ${ORG_TZ}) order by m.created_at limit 1),
     (select m.id from pulse.chat_message m where m.channel_id=$1 and m.parent_id is null order by m.created_at desc limit 1)) id`,[cid,x.at])).rows[0];
   if(!t?.id)return {messages:[],hasMore:false,hasNewer:false,target:null};
   x.around=t.id;
  }
  if(x.around||x.after){
   let from:Date|null=null,target:string|null=null;
   if(x.around){const t=(await c.query('select coalesce(case when $3 then null else r.id end,m.id) id,coalesce(case when $3 then null else r.created_at end,m.created_at) at from pulse.chat_message m left join pulse.chat_message r on r.id=m.parent_id where m.id=$1 and m.channel_id=$2',[id(x.around),cid,flat])).rows[0];if(!t)fail(404,'Message unavailable');target=t.id;from=t.at;}
   else{from=new Date(String(x.after));if(!Number.isFinite(from.getTime()))fail(400,'Invalid message cursor');}
   const scope=`m.channel_id=$1 and ($3 or m.parent_id is null)`;
   const older=x.around?(await c.query(`select ${MESSAGE} from ${FROM} where ${scope} and m.created_at<$2 order by m.created_at desc limit 31`,[cid,from,flat])).rows:[];
   const newer=(await c.query(`select ${MESSAGE} from ${FROM} where ${scope} and (m.created_at>$2 or ($4::uuid is not null and m.id=$4::uuid)) order by m.created_at limit 31`,[cid,from,flat,target])).rows;
   return {messages:[...older.slice(0,30).reverse(),...newer.slice(0,30)],hasMore:x.around?older.length>30:undefined,hasNewer:newer.length>30,target};
  }
  const rows=(await c.query(`select ${MESSAGE} from ${FROM} where m.channel_id=$1 and ($4 or m.parent_id is not distinct from $2::uuid) and ($3::timestamptz is null or m.created_at<$3) order by m.created_at desc limit 61`,[cid,q.thread?id(q.thread):null,q.before??null,flat])).rows;
  // SIM-CLIENTS R137: a client is listed under their company (their seat's profile reads "Client · <company>"), not "No department".
  const members=(await c.query(`select p.id,p.display_name name,p.side='agent' agent,${EMPLOYEE_ID('p.id')} "employeeId",pp.username,pp.pod,pp.department team,cm.role,${PHOTO('p')} "photoAt",
    case when p.side not in ('staff','agent') then coalesce(nullif(substring(pp.role from '^Client · (.+)$'),''),'Client') end company from pulse.chat_member cm join pulse.person p on p.id=cm.person_id left join pulse.people_profile pp on pp.person_id=p.id where cm.channel_id=$1 and pulse.chat_current(p.id) order by p.display_name`,[cid])).rows;
  // Ticks: delivered when every other member's Pulse has loaded it, read when every other member has seen it.
  const receipts=(await c.query(`select min(cm.read_through) "readThrough",min(greatest(cm.read_through,coalesce(r.delivered_through,'-infinity'))) "deliveredThrough"
   from pulse.chat_member cm join pulse.person p on p.id=cm.person_id left join pulse.chat_receipt r on r.channel_id=cm.channel_id and r.person_id=cm.person_id
   where cm.channel_id=$1 and cm.person_id<>$2 and pulse.chat_current(p.id)`,[cid,v.person])).rows[0];
  const formerMembers=(await c.query(`select distinct on (p.id) p.id,p.display_name name,${PHOTO('p')} "photoAt",f.left_at "leftAt",f.reason from pulse.chat_former_member f join pulse.person p on p.id=f.person_id
   where f.channel_id=$1 and not exists(select 1 from pulse.chat_member cm where cm.channel_id=f.channel_id and cm.person_id=f.person_id and pulse.chat_current(p.id)) order by p.id,f.left_at desc`,[cid])).rows;
  // CHAT-V3: who has read how far ("Seen by" in a group; small groups and direct chats only, as the ticks), and the
  // messages pinned on top of the conversation (with the newest page only).
  const readers=(await c.query(`select cm.person_id id,cm.read_through "at" from pulse.chat_member cm join pulse.person p on p.id=cm.person_id
   where cm.channel_id=$1 and cm.person_id<>$2 and pulse.chat_current(p.id) and cm.read_through>'-infinity'
   and (select ch.kind='direct' or (select count(*) from pulse.chat_member x where x.channel_id=ch.id)<=12 from pulse.chat_channel ch where ch.id=$1)`,[cid,v.person])).rows.map(r=>({id:r.id,at:iso(r.at)}));
  const pinned=q.before||q.thread?undefined:(await c.query(`select ${MESSAGE} from ${FROM} where m.channel_id=$1 and m.pinned_at is not null and m.removed_at is null order by m.pinned_at desc limit 3`,[cid])).rows;
  return {messages:rows.slice(0,60).reverse(),hasMore:rows.length>60,members,formerMembers,readers,pinned,receipts:{readThrough:iso(receipts?.readThrough),deliveredThrough:iso(receipts?.deliveredThrough)},root:q.thread?(await c.query(`select ${MESSAGE} from ${FROM} where m.id=$1`,[id(q.thread)])).rows[0]:null};
 }));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/:id/messages',{schema:{body}},req=>tx(req,async(c,v)=>{
  member(v);await c.query('select pulse.chat_refresh()');if(v.nativeDevice&&!(await c.query('select 1 from pulse.chat_member where channel_id=$1 and person_id=$2',[id(req.params.id),v.person])).rows[0])fail(403,'You are not a member of this conversation');const b=req.body;const attachments=b.attachments??[];if(!Array.isArray(attachments)||attachments.length>5)fail(400,'Attach up to five files or links');
  const mid=(await c.query('select pulse.chat_send($1,$2,$3,$4,$5,$6) id',[id(req.params.id),String(b.body??''),b.parentId?id(b.parentId):null,JSON.stringify(attachments),id(b.clientId),b.quoteId?id(b.quoteId):null])).rows[0].id;
  // The stored message comes back, so an optimistic bubble is replaced in place.
  return {id:mid,message:(await c.query(`select ${MESSAGE} from ${FROM} where m.id=$1`,[mid])).rows[0]};
 }));
 for(const operation of ['edit','remove','react'] as const)app.post<{Params:{id:string};Body:Body}>(`/api/v0/chats/messages/:id/${operation}`,{schema:{body}},req=>tx(req,async(c,v)=>{
  member(v);const value=operation==='edit'?String(req.body.body??''):operation==='remove'?String(req.body.reason??'Removed in Chats'):String(req.body.emoji??'');
  await c.query(`select pulse.chat_${operation}($1,$2)`,[id(req.params.id),value]);return {ok:true};
 }));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/:id/read',{schema:{body}},req=>tx(req,async(c,v)=>{
  member(v);await c.query('select pulse.chat_refresh()');if(v.nativeDevice&&!(await c.query('select 1 from pulse.chat_member where channel_id=$1 and person_id=$2',[id(req.params.id),v.person])).rows[0])fail(403,'You are not a member of this conversation');const through=String(req.body.through??'');const at=new Date(through);if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(through)||!Number.isFinite(at.getTime()))fail(400,'Invalid read cursor');await c.query('select pulse.chat_read($1,$2)',[id(req.params.id),through]);await c.query('select pulse.chat_mark_unread($1,false)',[id(req.params.id)]);await c.query('select pulse.chat_reminders_seen($1)',[id(req.params.id)]);return {ok:true};
 }));
 // CHAT-V3: typing (said to the others in the conversation, never stored), mute, archive; pin, save, forward a message.
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/:id/typing',{schema:{body}},req=>tx(req,async(c,v)=>{
  member(v);const cid=id(req.params.id);
  const who=(await c.query('select p.display_name name from pulse.chat_member cm join pulse.person p on p.id=cm.person_id where cm.channel_id=$1 and cm.person_id=$2',[cid,v.person])).rows[0];
  if(!who)fail(403,'You are not a member of this conversation');
  await c.query("select pg_notify('pulse_chat_typing',$1)",[JSON.stringify({o:v.org,c:cid,p:v.person,n:who.name,on:req.body.on!==false})]);return {ok:true};
 }));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/:id/mute',{schema:{body}},req=>tx(req,async(c,v)=>{
  member(v);const u=req.body.until;const until=u===null||u===undefined||u===''?null:u==='always'?'infinity':Number.isFinite(Date.parse(String(u)))?new Date(String(u)).toISOString():fail(400,'Choose how long to mute');
  await c.query('select pulse.chat_mute($1,$2)',[id(req.params.id),until]);return {ok:true};
 }));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/:id/archive',{schema:{body}},req=>tx(req,async(c,v)=>{member(v);if(typeof req.body.on!=='boolean')fail(400,'Archive or unarchive');await c.query('select pulse.chat_archive($1,$2)',[id(req.params.id),req.body.on]);return {ok:true};}));
 // CHAT-V4: mark a conversation unread for myself (or clear the mark), and the earlier words of an edited message.
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/:id/unread',{schema:{body}},req=>tx(req,async(c,v)=>{member(v);if(typeof req.body.on!=='boolean')fail(400,'Mark unread or read');await c.query('select pulse.chat_mark_unread($1,$2)',[id(req.params.id),req.body.on]);if(!req.body.on)await c.query('select pulse.chat_reminders_seen($1)',[id(req.params.id)]);return {ok:true};}));
 app.get<{Params:{id:string}}>('/api/v0/chats/messages/:id/revisions',req=>tx(req,async(c,v)=>{
  member(v);const mid=id(req.params.id);const m=(await c.query('select m.body,m.edited_at "editedAt",m.created_at "createdAt",m.channel_id "channelId" from pulse.chat_message m where m.id=$1 and m.removed_at is null and pulse.chat_has(m.channel_id)',[mid])).rows[0];
  if(!m)fail(404,'Message unavailable');
  const earlier=(await c.query('select body,replaced_at "replacedAt" from pulse.chat_message_revision where message_id=$1 order by replaced_at',[mid])).rows.map(r=>({body:r.body,replacedAt:iso(r.replacedAt)}));
  return {body:m.body,editedAt:iso(m.editedAt),createdAt:iso(m.createdAt),earlier};
 }));
 for(const [path,fn] of [['pin','chat_pin_message'],['star','chat_star_set']] as const)app.post<{Params:{id:string};Body:Body}>(`/api/v0/chats/messages/:id/${path}`,{schema:{body}},req=>tx(req,async(c,v)=>{
  member(v);if(typeof req.body.on!=='boolean')fail(400,'Choose on or off');await c.query(`select pulse.${fn}($1,$2)`,[id(req.params.id),req.body.on]);return {ok:true};
 }));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/messages/:id/forward',{schema:{body}},req=>tx(req,async(c,v)=>{
  member(v);const to=ids(req.body.channels,5);if(!to.length)fail(400,'Choose up to 5 chats');await c.query('select pulse.chat_refresh()');
  return {ids:(await c.query('select pulse.chat_forward($1,$2) ids',[id(req.params.id),to])).rows[0].ids};
 }));
 // CHAT-V3 (revision rounds): a comment on a point of a picture, kept as a reply in the picture's thread; resolve it when done.
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/messages/:id/annotate',{schema:{body}},req=>tx(req,async(c,v)=>{
  member(v);const b=req.body;const x=Number(b.x),y=Number(b.y);if(!(x>=0&&x<=1&&y>=0&&y<=1))fail(400,'Choose a point on the picture');
  const mid=(await c.query('select pulse.chat_annotate($1,$2,$3,$4,$5,$6) id',[id(req.params.id),id(b.fileId),x,y,String(b.body??''),id(b.clientId)])).rows[0].id;
  return {id:mid,message:(await c.query(`select ${MESSAGE} from ${FROM} where m.id=$1`,[mid])).rows[0]};
 }));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/annotations/:id/resolve',{schema:{body}},req=>tx(req,async(c,v)=>{member(v);if(typeof req.body.on!=='boolean')fail(400,'Resolve or reopen');await c.query('select pulse.chat_annotation_resolve($1,$2)',[id(req.params.id),req.body.on]);return {ok:true};}));
 // CHAT-V3: ask for an approval on a message; another member approves or asks for changes (saying what to change).
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/messages/:id/approval',{schema:{body}},req=>tx(req,async(c,v)=>{
  member(v);const mid=id(req.params.id),action=String(req.body.action??'');
  if(action==='ask')await c.query('select pulse.chat_approval_ask($1)',[mid]);
  else if(action==='withdraw')await c.query('select pulse.chat_approval_withdraw($1)',[mid]);
  else if(action==='approved'||action==='changes')await c.query('select pulse.chat_approval_decide($1,$2,$3)',[mid,action,req.body.note==null?null:String(req.body.note).slice(0,2000)]);
  else fail(400,'Ask, approve or ask for changes');
  return {ok:true};
 }));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/:id/pin',{schema:{body}},req=>tx(req,async(c,v)=>{member(v);if(typeof req.body.on!=='boolean')fail(400,'Pin or unpin');await c.query('select pulse.chat_pin($1,$2)',[id(req.params.id),req.body.on]);return {ok:true};}));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/:id/files',{schema:{body},bodyLimit:7200000},req=>tx(req,async(c,v)=>{
  member(v);const bytes=String(req.body.bytes??'');if(!/^[A-Za-z0-9+/]*={0,2}$/.test(bytes)||bytes.length>7000000)fail(400,'Choose a file up to 5 MB');
  const name=String(req.body.name??'').replace(/[\x00-\x1f/\\]/g,'_').slice(0,200),mime=String(req.body.mime??'application/octet-stream').slice(0,100);
  return {...(await c.query('select pulse.chat_file_add($1,$2,$3,$4) id',[id(req.params.id),name,mime,Buffer.from(bytes,'base64')])).rows[0],name,mime};
 }));
 // `inline=1` previews a raster image in the conversation; any other file is an attachment download.
 app.get<{Params:{id:string}}>('/api/v0/chats/files/:id',async(req,reply)=>{
  // WA-NATIVE: an imported file (`wa-<sha256>`) streams from the WhatsApp store, with its own access check.
  if(/^wa-[0-9a-f]{64}$/.test(req.params.id))return reply.redirect(`/api/v0/chats/whatsapp/files/${req.params.id.slice(3)}${(req.query as {inline?:string}).inline==='1'?'?inline=1':''}`,307);
  const file=await tx(req,async(c,v)=>{member(v);return (await c.query('select * from pulse.chat_file_read($1)',[id(req.params.id)])).rows[0];});if(!file)fail(404,'File unavailable');
  const inline=(req.query as {inline?:string}).inline==='1'&&(PREVIEW.has(file.mime)||DOC_PREVIEW.has(file.mime));
  if(!(inline&&file.mime==='application/pdf'))reply.header('content-security-policy',"sandbox");
  reply.header('cache-control',inline?'private, max-age=86400':'private, no-store').header('x-content-type-options','nosniff').header('content-disposition',`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`).type(inline?file.mime:'application/octet-stream');return reply.send(file.bytes);
 });
 // Groups people make: a name and members, then a photo and changes by the group's admins.
 app.post<{Body:Body}>('/api/v0/chats/groups',{schema:{body}},req=>tx(req,async(c,v)=>{member(v);return (await c.query('select pulse.chat_group_create($1,$2) id',[String(req.body.name??''),ids(req.body.memberIds)])).rows[0];}));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/groups/:id',{schema:{body}},req=>tx(req,async(c,v)=>{member(v);await c.query('select pulse.chat_group_update($1,$2,$3)',[id(req.params.id),String(req.body.name??''),String(req.body.description??'')]);return {ok:true};}));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/groups/:id/members',{schema:{body}},req=>tx(req,async(c,v)=>{member(v);await c.query('select pulse.chat_group_members($1,$2,$3)',[id(req.params.id),ids(req.body.add),ids(req.body.remove)]);return {ok:true};}));
 app.post<{Params:{id:string}}>('/api/v0/chats/groups/:id/leave',req=>tx(req,async(c,v)=>{member(v);await c.query('select pulse.chat_group_leave($1)',[id(req.params.id)]);return {ok:true};}));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/groups/:id/photo',{schema:{body},bodyLimit:1500000},req=>tx(req,async(c,v)=>{
  member(v);const bytes=req.body.bytes===null?null:String(req.body.bytes??'');if(bytes!==null&&(!/^[A-Za-z0-9+/]*={0,2}$/.test(bytes)||bytes.length>1400000))fail(400,'Use a photo up to 1 MB');
  await c.query('select pulse.chat_group_photo($1,$2,$3)',[id(req.params.id),String(req.body.mime??''),bytes===null?null:Buffer.from(bytes,'base64')]);return {ok:true};
 }));
 app.get<{Params:{id:string}}>('/api/v0/chats/:id/photo',async(req,reply)=>{
  const photo=await tx(req,async(c,v)=>{member(v);return (await c.query('select * from pulse.chat_group_photo_read($1)',[id(req.params.id)])).rows[0];});if(!photo)fail(404,'No photo');
  reply.header('cache-control',(req.query as {v?:string}).v?'private, max-age=31536000, immutable':'private, no-cache').header('x-content-type-options','nosniff').type(photo.mime);return reply.send(photo.bytes);
 });
 // Tasks in chat: `#` finds a task you can see; a card shows its live state; its owner can post its updates here.
 app.get('/api/v0/chats/tasks',req=>tx(req,async(c,v)=>{
  member(v);const q=String((req.query as {q?:string}).q??'').trim().slice(0,100);
  return {tasks:(await c.query(`select t.id,t.title,t.status,pulse.chat_task_label(t.status) "statusLabel",a.display_name "assigneeName" from pulse.task t left join pulse.person a on a.id=t.assignee_person_id
   where t.status not in ('done','cancelled') and ($1='' or t.title ilike '%'||$2||'%' escape '\\') order by ($3 in (t.assignee_person_id,t.owner_id,t.created_by)) desc,coalesce(t.updated_at,t.created_at) desc nulls last limit 8`,[q,q.replace(/[\\%_]/g,'\\$&'),v.person])).rows};
 }));
 app.get('/api/v0/chats/task-cards',req=>tx(req,async(c,v)=>{
  member(v);const list=String((req.query as {ids?:string}).ids??'').split(',').filter(Boolean).slice(0,60).map(id);
  return {tasks:(await c.query(`select t.id,t.title,t.status,pulse.chat_task_label(t.status) "statusLabel",t.priority,t.assignee_person_id "assigneeId",a.display_name "assigneeName",${PHOTO('a')} "assigneePhotoAt",
   coalesce(t.work_on,(t.due_at at time zone ${ORG_TZ})::date)::text "dueOn",coalesce(pr.title,pr.name) "projectName",$2 in (t.owner_id,t.created_by,t.assignee_person_id) "canFollow",
   coalesce((select array_agg(f.channel_id) from pulse.chat_task_follow f where f.task_id=t.id),'{}') "followedIn",a.side='agent' "assigneeAgent",t.review_owner_id "reviewerId",($2=t.review_owner_id and t.status='in_review') "canApprove",
   -- CHAT-WORK: who answers it in which chat (take it, decline, ask), and where an AI employee's work on it stands.
   coalesce((select jsonb_agg(jsonb_build_object('channelId',h.channel_id,'state',h.state,'personId',h.person_id,'personName',hp.display_name,'askedBy',h.asked_by,'note',h.note)) from pulse.chat_task_handshake h join pulse.person hp on hp.id=h.person_id where h.task_id=t.id),'[]') handshakes,
   (select jsonb_build_object('state',e.state,'reason',e.reason,'agent',ap.display_name,'at',e.created_at,'runtimeState',am.runtime_state,'runtimeUntil',am.runtime_until,'retryAt',e.retry_at) from pulse.agent_event e join pulse.person ap on ap.id=e.agent_id join pulse.agent_member am on am.person_id=e.agent_id where e.subject_type='task' and e.subject_id=t.id order by e.created_at desc limit 1) "agentWork"
   from pulse.task t left join pulse.person a on a.id=t.assignee_person_id left join pulse.project pr on pr.id=t.project_id where t.id=any($1::uuid[])`,[list,v.person])).rows};
 }));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/chats/tasks/:id/follow',{schema:{body}},req=>tx(req,async(c,v)=>{member(v);if(typeof req.body.on!=='boolean')fail(400,'Turn updates on or off');await c.query('select pulse.chat_task_follow_set($1,$2,$3)',[id(req.params.id),id(req.body.channelId),req.body.on]);return {ok:true};}));
 // Presence: everyone's status category, and your own status line and do-not-disturb. `touch=1` (sent while Pulse is
 // open and visible) is what makes someone "active".
 app.get('/api/v0/presence',req=>tx(req,async(c,v)=>{
  member(v);if((req.query as {touch?:string}).touch==='1')await c.query('select pulse.presence_touch()');
  const rows=(await c.query('select person_id id,state,active_at "activeAt",status_text text,status_emoji emoji,status_until until,dnd from pulse.presence_of()')).rows;
  const dnd=(await c.query("select settings->>'snoozedUntil' until,coalesce((settings->>'dnd')::boolean,false) always from pulse.companion_notification_settings where person_id=$1",[v.person])).rows[0];
  const own=rows.find(r=>r.id===v.person);
  return {people:Object.fromEntries(rows.map(({id:key,...r})=>[key,r])),me:{text:own?.text??null,emoji:own?.emoji??null,until:own?.until??null,dnd:!!own?.dnd,dndUntil:dnd?.always?'infinity':dnd?.until&&Date.parse(dnd.until)>Date.now()?dnd.until:null},at:new Date().toISOString()};
 }));
 app.post<{Body:Body}>('/api/v0/presence',{schema:{body}},req=>tx(req,async(c,v)=>{
  member(v);const b=req.body;const when=(x:unknown)=>{if(x===null||x===undefined||x==='')return null;if(x==='infinity')return 'infinity';const d=new Date(String(x));return Number.isFinite(d.getTime())?d.toISOString():fail(400,'Choose a valid time');};
  const until=when(b.until);if(until==='infinity')fail(400,'Choose when the status clears');
  await c.query('select pulse.presence_set($1,$2,$3,$4)',[b.text==null?null:String(b.text).slice(0,200),b.emoji==null?null:String(b.emoji).slice(0,32),until,when(b.dndUntil)]);return {ok:true};
 }));
 // Live updates: re-check identity and membership on each tick (refreshed at most every 30 s here; every read, send
 // and receipt refreshes it at once, so a removed member is refused immediately). No connection is held by a stream.
 // Each event names the conversations that changed, so a client refetches only those.
 app.get('/api/v0/chats/events',async(req,reply)=>{
  let person='',org='';
  const state=()=>tx(req,async(c,v)=>{member(v);person=v.person!;org=v.org;await c.query('select pulse.chat_refresh_soon()');
   return (await c.query(`select cm.channel_id id,coalesce((select max(e.seq) from pulse.chat_event e where e.org_id=cm.org_id and e.channel_id=cm.channel_id),0)::text seq from pulse.chat_member cm where cm.person_id=$1`,[v.person])).rows as {id:string;seq:string}[];});
  const stamp=(rows:{id:string;seq:string}[])=>new Map(rows.map(r=>[r.id,r.seq]));
  let last=stamp(await state()),busy=false,again=false;reply.hijack();reply.raw.writeHead(200,{'content-type':'text/event-stream','cache-control':'private, no-store','connection':'keep-alive','x-accel-buffering':'no'});reply.raw.write('retry: 1500\nevent: changed\ndata: {"all":true}\n\n');
  const check=async(beat:boolean)=>{if(reply.raw.destroyed)return;if(busy){again=true;return;}busy=true;try{const next=stamp(await state());const changed=[...next].filter(([k,s])=>last.get(k)!==s).map(([k])=>k);const left=[...last.keys()].some(k=>!next.has(k));last=next;
   if(changed.length||left)reply.raw.write(`event: changed\ndata: ${JSON.stringify({channels:changed,all:left})}\n\n`);else if(beat)reply.raw.write(': heartbeat\n\n');}catch{reply.raw.end();}finally{busy=false;if(again){again=false;void check(false);}}};
  // CHAT-V3 (live): a change in one of this person's conversations is told at once (the NOTIFY), and someone typing in one
  // is passed on as it happens; the 4-second check stays as the safety net (and re-reads membership).
  const off=hub.on(org,w=>{if(reply.raw.destroyed||!last.has(w.channel))return;
   if(w.typing){if(w.typing.person!==person)reply.raw.write(`event: typing\ndata: ${JSON.stringify({channel:w.channel,...w.typing})}\n\n`);}else void check(false);});
  const tick=setInterval(()=>void check(true),4000);
  const end=setTimeout(()=>reply.raw.end(),45000);reply.raw.on('close',()=>{off();clearInterval(tick);clearTimeout(end);});
 });
}
