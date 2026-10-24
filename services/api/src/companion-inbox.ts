import {pingAllowed,pingSettings,pushEndpoint} from './notification-policy.js';
import { orgZone } from './org-time.js';
import type { FastifyInstance } from 'fastify';
import { fail, type Tx } from './routes.js';
import {webPushConfig} from './web-push-config.js';

// Explicit self and membership checks also apply to administrators and their device tokens.
export const INBOX_VISIBLE = `n.person_id=pulse.current_viewer() and pulse.notification_authorized(n.id,pulse.current_viewer()) and n.dismissed_at is null and
 (n.channel_id is null or exists(select 1 from pulse.chat_member cm join pulse.person p on p.id=cm.person_id
 where cm.org_id=n.org_id and cm.channel_id=n.channel_id and cm.person_id=pulse.current_viewer() and p.status='active'))`;
// ATT: what the bell's number counts: unread notifications that are not just for information (0860). QA-1024 (R014): the
// notification panel's "need you" uses this same count, so the bell and the panel never show two numbers (bell 2, panel 53).
export const IMPORTANT_UNREAD = `(select count(*)::int from pulse.notification n where ${INBOX_VISIBLE} and n.read_at is null and n.expires_at>clock_timestamp() and not n.quiet
       and coalesce(n.priority,pulse.notification_priority(n.event_type))<>'fyi')`;
const fields = `n.id,n.title,n.href,n.kind,n.event_type "eventType",n.subject_type "subjectType",n.subject_id "subjectId",n.expires_at "expiresAt",n.snoozed_until "snoozedUntil",1 "contractVersion",n.channel_id "channelId",n.message_id "messageId",n.read_at "readAt",to_char(n.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "at",
 coalesce(n.priority,pulse.notification_priority(n.event_type)) priority,n.quiet`;
export function registerCompanionInboxRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/companion/inbox', req => tx(req, async (c,v) => {
    if(!v.person) fail(403,'Use your individual Pulse account');
    await c.query('select pulse.chat_refresh_soon()');
    const item=(req.query as {id?:string}).id;
    if(item&&!/^[0-9a-f-]{36}$/.test(item))fail(400,'Invalid inbox item');
    return {rows:(await c.query(`select ${fields} from pulse.notification n where ${INBOX_VISIBLE} and ($1::uuid is null or n.id=$1) order by n.created_at desc,n.id desc limit 100`,[item??null])).rows};
  }));
  // Validate the item after authentication, preserving the anonymous 401 boundary.
  app.post<{Body:{id?:string}}>('/api/v0/companion/read', {schema:{body:{type:'object'}}}, req => tx(req,async(c,v)=>{
    if(!v.person) fail(403,'Use your individual Pulse account');
    if(typeof req.body.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.body.id)||Object.keys(req.body).some(key=>key!=='id'))fail(400,'Invalid inbox item');
    await c.query('select pulse.chat_refresh()');
    const result=await c.query(`update pulse.notification n set read_at=coalesce(read_at,clock_timestamp()) where id=$1 and ${INBOX_VISIBLE} returning id`,[req.body.id]);
    if(!result.rowCount)fail(404,'This update is unavailable for your account');
    return {ok:true};
  }));
  // Short polling works with the same rotating device credential, including a hidden desktop panel.
  // Overlap protects events committed after the preceding poll; clients deduplicate immutable IDs.
  app.get('/api/v0/companion/updates', req => tx(req,async(c,v)=>{
    if(!v.person)fail(403,'Use your individual Pulse account');
    await c.query('select pulse.chat_refresh_soon()');
    if(v.nativeDevice)await c.query('select pulse.companion_queue_local($1)',[v.nativeDevice]);
    const query=req.query as {since?:string;page?:string};
    const raw=query.since;
    let after:{at:string;id:string}|null=null;
    if(query.page){try{after=JSON.parse(Buffer.from(query.page,'base64url').toString());if(!after||!Number.isFinite(Date.parse(after.at))||!/^[0-9a-f-]{36}$/.test(after.id))throw Error();}catch{fail(400,'Invalid page cursor');}}
    const since=raw?new Date(raw):new Date();
    if(!Number.isFinite(since.getTime())||since.getTime()>Date.now()+60000)fail(400,'Invalid update cursor');
    const serverAt=(await c.query('select clock_timestamp() "at"')).rows[0].at;
    const pending=`($4::uuid is not null and exists(select 1 from pulse.native_push_delivery d where d.notification_id=n.id and d.device_id=$4 and d.app_received_at is null))`;
    const rows=(await c.query(`select ${fields},${pending} "devicePending" from pulse.notification n where ${INBOX_VISIBLE}
      and (n.created_at>=greatest($1::timestamptz-interval '10 seconds',clock_timestamp()-interval '48 hours') or ${pending})
      and ($2::timestamptz is null or (n.created_at,n.id)>($2::timestamptz,$3::uuid))
      order by n.created_at,n.id limit 201`,[since,after?.at??null,after?.id??null,v.nativeDevice??null])).rows;
    const hasMore=rows.length>200;rows.splice(200);
    const counts=(await c.query(`select
      (select count(*)::int from pulse.chat_message m join pulse.chat_member cm on cm.channel_id=m.channel_id
       where cm.person_id=$1 and m.author_id<>$1 and m.created_at>cm.read_through and m.removed_at is null) chats,
      (select count(*)::int from pulse.notification n where ${INBOX_VISIBLE} and n.read_at is null and n.expires_at>clock_timestamp() and n.channel_id is null) "nonChat",
      (select count(*)::int from pulse.notification n where ${INBOX_VISIBLE} and n.read_at is null and n.expires_at>clock_timestamp()) inbox,
      ${IMPORTANT_UNREAD} important`,[v.person])).rows[0];
    const settings=pingSettings((await c.query('select settings from pulse.companion_notification_settings where person_id=$1',[v.person])).rows[0]?.settings,await orgZone(c));
    const approvedShift=(await c.query('select pulse.notification_active_shift($1) active',[v.person])).rows[0].active;
    return {settings,suppression:settings.dnd?'Do not disturb is on.':!pingAllowed('update',{...settings,types:{}})?`Quiet hours are on until ${settings.end} (${settings.timezone}). Turn off Quiet hours to receive pings now.`:null,person:{id:v.person,name:v.name},rows:rows.map(({devicePending,...r})=>({...r,pingAllowed:!r.quiet&&(v.nativeDevice?devicePending:(!r.readAt||r.messageId!==null))&&new Date(r.expiresAt)>new Date()&&(!r.snoozedUntil||new Date(r.snoozedUntil)<=new Date())&&pingAllowed(r.kind,settings,new Date(),{approvedShift})})),counts:{...counts,total:counts.chats+counts.nonChat},
      cursor:hasMore?since.toISOString():serverAt,hasMore,page:hasMore?Buffer.from(JSON.stringify({at:rows.at(-1).at,id:rows.at(-1).id})).toString('base64url'):null};
  }));
  app.post<{Body:{ids?:string[]}}>('/api/v0/companion/ack',{schema:{body:{type:'object'}}},req=>tx(req,async(c,v)=>{
    if(!v.nativeDevice)fail(403,'An active Companion device is required');
    if(!Array.isArray(req.body.ids)||req.body.ids.length>200||req.body.ids.some(id=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))||Object.keys(req.body).some(key=>key!=='ids'))fail(400,'Invalid device receipts');
    await c.query('select pulse.companion_ack_local($1,$2)',[v.nativeDevice,req.body.ids]);return {ok:true};
  }));
  app.post<{Body:{id?:unknown;minutes?:unknown;dismiss?:unknown}}>('/api/v0/companion/snooze',{schema:{body:{type:'object'}}},req=>tx(req,async(c,v)=>{
    if(!v.person)fail(403,'Use your individual Pulse account');
    if(typeof req.body.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.body.id)||![15,60,240].includes(Number(req.body.minutes??60))||Object.keys(req.body).some(key=>!['id','minutes','dismiss'].includes(key))||req.body.dismiss!==undefined&&typeof req.body.dismiss!=='boolean')fail(400,'Choose an item and 15, 60 or 240 minutes');
    await c.query('select pulse.notification_snooze($1,$2,$3)',[req.body.id,req.body.minutes??60,req.body.dismiss===true]);return {ok:true};
  }));
  app.get('/api/v0/companion/notification-settings',req=>tx(req,async(c,v)=>{
    if(!v.person)fail(403,'Use your individual Pulse account');
    return {settings:pingSettings((await c.query('select settings from pulse.companion_notification_settings where person_id=$1',[v.person])).rows[0]?.settings,await orgZone(c)),
      webPushKey:(await webPushConfig())?.publicKey??null};
  }));
  app.post<{Body:Record<string,unknown>}>('/api/v0/companion/notification-settings',{schema:{body:{type:'object'}}},req=>tx(req,async(c,v)=>{
    if(!v.person)fail(403,'Use your individual Pulse account');
    const old=(await c.query('select settings from pulse.companion_notification_settings where person_id=$1',[v.person])).rows[0]?.settings??{};
    let settings;try{settings=pingSettings({...req.body,channels:{...old.channels,...(req.body.channels as Record<string,unknown>??{})},nightShift:req.body.nightShift??old.nightShift,snoozedUntil:req.body.snoozedUntil===undefined?old.snoozedUntil:req.body.snoozedUntil,reminders:req.body.reminders??old.reminders,mute:{...old.mute,...(req.body.mute as Record<string,unknown>??{})}},await orgZone(c));}catch(e){fail(400,(e as Error).message);}
    await c.query('insert into pulse.companion_notification_settings(org_id,person_id,settings) values($1,$2,$3) on conflict(org_id,person_id) do update set settings=excluded.settings',[v.org,v.person,JSON.stringify(settings)]);
    return {settings};
  }));
  // RELEASE-3: one test notification to the viewer's own browsers and phones (0298), at most once a minute.
  app.post('/api/v0/companion/notification-test',{schema:{body:{type:'object'}}},req=>tx(req,async(c,v)=>{
    if(!v.person||v.nativeDevice)fail(403,'Use your individual Pulse account');
    const sent=(await c.query('select pulse.notification_test() r')).rows[0].r as {id:string|null;browsers:number;phones:number};
    if(!sent.id)fail(429,'A test was just sent. Try again in a minute.');
    return {ok:true,...sent,webPush:!!await webPushConfig()};
  }));
  app.post<{Body:{endpoint?:unknown;keys?:{auth?:unknown;p256dh?:unknown};enabled?:boolean}}>('/api/v0/companion/web-push',{schema:{body:{type:'object'}}},req=>tx(req,async(c,v)=>{
    if(!v.person||v.nativeDevice)fail(403,'Enable browser pings from your signed-in Pulse page');
    let endpoint;try{endpoint=pushEndpoint(req.body.endpoint);}catch{fail(400,'Unsupported push provider');}
    if(req.body.enabled===false){await c.query('update pulse.web_push_subscription set disabled_at=clock_timestamp() where endpoint=$1 and person_id=$2',[endpoint,v.person]);return {ok:true};}
    // POLISH-2 (QA-E2E P2-4): a 5xx is masked as "temporarily unavailable"; this is a known state, said as it is.
    if(!await webPushConfig())fail(409,'Browser pings are awaiting server activation');
    const keys=req.body.keys;
    if(!keys||typeof keys.auth!=='string'||!/^[A-Za-z0-9_-]{22}$/.test(keys.auth)||typeof keys.p256dh!=='string'||!/^[A-Za-z0-9_-]{87}$/.test(keys.p256dh))fail(400,'Invalid push keys');
    // A browser switching accounts transfers its own opaque endpoint, never another person's inbox.
    await c.query('select pulse.web_push_enroll($1,$2)',[endpoint,JSON.stringify(keys)]);
    return {ok:true};
  }));

}
