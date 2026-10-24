import assert from 'node:assert/strict';import {Pool} from 'pg';import {writeFile} from 'node:fs/promises';import {createApp} from '../dist/app.js';
import {drainWebPush} from '../dist/web-push.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),worker=new Pool(JSON.parse(process.env.TEST_WORKER_CONFIG)),app=createApp(pool,pool),people=JSON.parse(process.env.TEST_PEOPLE);
let checks=0;const receipts=[];
const eq=(got,expected,label)=>{assert.deepEqual(got,expected,label);checks++;receipts.push({label,passed:true});};
const call=async(path,body,identity)=>{const r=await app.inject({url:'/api/v0/'+path,method:body===undefined?'GET':'POST',headers:identity?.token?{authorization:'Bearer '+identity.token}:identity?.name?{'cf-access-authenticated-user-email':identity.name+'@messaging.example'}:{},...(body===undefined?{}:{payload:body})});return {status:r.statusCode,data:r.json()};};
async function pair(name,platform){const start=(await call('native/pair/start',{platform,name:'Synthetic '+name+' '+platform})).data;eq((await call('native/pair/decide',{code:start.code,approve:true},{name})).status,200,'approve '+name+' '+platform);const result=(await call('native/pair/poll',{pairId:start.pairId,pollSecret:start.pollSecret})).data;eq(result.person.id,people[name],'bound to '+name);return {token:result.accessToken};}
try{
 const alice=await pair('alice','macos'),alice2=await pair('alice','windows'),bob=await pair('bob','windows'),bob2=await pair('bob','macos'),outsider=await pair('outsider','windows'),admin=await pair('admin','macos');
 eq((await call('companion/inbox')).status,401,'signed-out inbox refused');
 eq((await call('companion/read',{})).status,401,'signed-out malformed mark-read authenticates first');
 eq((await call('companion/read',{},alice)).status,400,'signed-in mark-read requires an item');
 eq((await call('companion/read',{id:'not-a-uuid'},alice)).status,400,'signed-in mark-read validates UUID');
 eq((await call('companion/notification-settings',{quiet:false,timezone:'UTC'},alice)).status,200,'Alice enables pings');
 eq((await call('companion/notification-settings',{quiet:false,timezone:'UTC'},bob)).status,200,'Bob enables pings');
 const list=await call('chats',undefined,alice);eq(list.status,200,'native list');const group=list.data.channels.find(c=>c.kind==='group').id;
 eq((await call('chats',undefined,admin)).data.channels.some(c=>c.id===group),false,'admin device excludes moderation-only group');
 for(const device of [outsider,admin]){
  eq((await call(`chats/${group}/messages`,undefined,device)).status,404,'nonmember cannot read group');
  eq((await call(`chats/${group}/messages`,{body:'Denied',clientId:crypto.randomUUID()},device)).status,403,'nonmember cannot send group');
 }
 eq((await call('chats/search?q=anything',undefined,admin)).status,403,'raw device API cannot bypass narrow gateway');
 const since=new Date(Date.now()-1000).toISOString(),payload={body:'Synthetic plain leadership message',clientId:crypto.randomUUID()};
 const first=await call(`chats/${group}/messages`,payload,alice);eq(first.status,200,'Mac member sends ordinary group message');
 eq((await call(`chats/${group}/messages`,payload,alice)).data.id,first.data.id,'reply delivery idempotent');
 for(const [name,device] of [['Windows Bob',bob],['Mac Bob',bob2]]){
  const s=await call('companion/updates?since='+encodeURIComponent(since),undefined,device);eq(s.status,200,name+' feed available');
  eq(s.data.rows.filter(n=>n.messageId===first.data.id).length,1,name+' receives one group event');
  // ATT (0860): a plain message in a group conversation is for-your-information: in the feed, quiet, never a ping.
  eq(s.data.rows.find(n=>n.messageId===first.data.id).pingAllowed,false,name+' group message is quiet');
  eq(s.data.counts.total,1,name+' unread is not doubled by inbox');
  eq(s.data.rows.find(n=>n.messageId===first.data.id).channelId,group,name+' exact click target');
 }
 const receipt=(await call('companion/updates',undefined,bob)).data.rows.find(n=>n.messageId===first.data.id);
 const ahead=new Date(Date.now()+30000).toISOString();
 eq((await call('companion/updates?since='+encodeURIComponent(ahead),undefined,bob)).data.rows.some(n=>n.id===receipt.id),true,'unacknowledged event survives a cursor beyond its timestamp');
 eq((await call('companion/ack',{ids:[receipt.id]},bob)).status,200,'Windows device acknowledges local delivery');
 eq((await call('companion/updates?since='+encodeURIComponent(ahead),undefined,bob)).data.rows.some(n=>n.id===receipt.id),false,'acknowledged device receipt no longer needs replay');
 eq((await call('companion/updates?since='+encodeURIComponent(ahead),undefined,bob2)).data.rows.some(n=>n.id===receipt.id),true,'Windows acknowledgment cannot consume Mac delivery');
 eq((await call('companion/ack',{ids:[]},{name:'bob'})).status,403,'browser cannot acknowledge desktop deliveries');
 eq((await call('companion/ack',{ids:['not-a-uuid']},bob)).status,400,'invalid receipt rejected');
 eq((await call('companion/updates',undefined,bob2)).data.counts.total,1,'receipt acknowledgment does not mark conversation read');
 for(const device of [alice,alice2,outsider,admin])eq((await call('companion/updates?since='+encodeURIComponent(since),undefined,device)).data.rows.some(n=>n.messageId===first.data.id),false,'no author/outsider notification');
 const reverse=await call(`chats/${group}/messages`,{body:'Synthetic Windows quick reply',clientId:crypto.randomUUID()},bob);eq(reverse.status,200,'Windows sends reverse reply');
 for(const device of [alice,alice2])eq((await call('companion/updates?since='+encodeURIComponent(since),undefined,device)).data.rows.some(n=>n.messageId===reverse.data.id&&!n.pingAllowed),true,'every Alice desktop gets the reverse group event, quiet');
 const dm=(await call('chats/direct',{personId:people.bob},{name:'alice'})).data.id;
 const direct=await call(`chats/${dm}/messages`,{body:'Synthetic direct message',clientId:crypto.randomUUID()},alice);eq(direct.status,200,'DM delivery');
 eq((await call(`chats/${dm}/messages`,undefined,admin)).status,404,'admin cannot read DM');
 const unread=(await call('companion/updates?since='+encodeURIComponent(since),undefined,bob)).data;
 eq(unread.counts.total,2,'group + DM badge');
 const notice=unread.rows.find(n=>n.messageId===direct.data.id);
 eq((await call('companion/read',{id:notice.id},alice)).status,404,'cannot mark another person notification');
 eq((await call('companion/read',{id:notice.id},bob)).status,200,'own notification read');
 eq((await call('companion/updates',undefined,bob2)).data.counts.total,2,'inbox read is not conversation read');
 const last=(await call(`chats/${dm}/messages`,undefined,bob)).data.messages.at(-1);
 eq(/\.\d{6}Z$/.test(last.createdAt),true,'message cursors preserve PostgreSQL microseconds');
 eq((await call(`chats/${dm}/read`,{through:last.createdAt},bob)).status,200,'read DM using returned message cursor');
 eq((await call('companion/updates',undefined,bob2)).data.counts.total,1,'read sync reaches other desktop');
 eq((await call('companion/notification-settings',{quiet:false,dnd:true},bob)).status,200,'DND set');
 const quiet=await call(`chats/${group}/messages`,{body:'Synthetic quiet update',clientId:crypto.randomUUID()},alice);eq(quiet.status,200,'DND does not block delivery');
 const suppressed=(await call('companion/updates?since='+encodeURIComponent(since),undefined,bob2)).data;
 eq(suppressed.rows.find(n=>n.messageId===quiet.data.id).pingAllowed,false,'DND suppresses native ping on all devices');eq(suppressed.counts.total,2,'DND preserves badge');
 eq((await call('companion/notification-settings',{quiet:false,types:{chat:false}},bob)).status,200,'Bob enables mentions while muting ordinary chat');
 const mention=await call(`chats/${group}/messages`,{body:'Synthetic @synthetic.bob mention',clientId:crypto.randomUUID()},alice);
 eq(mention.status,200,'mention delivered');
 for(const device of [bob,bob2])eq((await call('companion/updates',undefined,device)).data.rows.some(n=>n.messageId===mention.data.id&&n.kind==='mention'&&n.pingAllowed),true,'mention gets eligible event on each Bob desktop');
 const thread=await call(`chats/${group}/messages`,{body:'Synthetic followed-thread reply',parentId:first.data.id,clientId:crypto.randomUUID()},bob);
 eq(thread.status,200,'reply in followed thread delivered');
 for(const device of [alice,alice2])eq((await call('companion/updates',undefined,device)).data.rows.some(n=>n.messageId===thread.data.id&&n.kind==='reply'&&n.pingAllowed&&n.href.endsWith('&thread='+first.data.id)),true,'thread reply includes exact thread on each Alice desktop');
 // A visible web conversation may read immediately, ahead of each desktop's next poll.
 const browserClient=await worker.connect();try{
  await browserClient.query('begin');await browserClient.query("select set_config('pulse.org_id',$1,true)",[process.env.PULSE_ORG_ID]);
  for(const suffix of ['one','two'])await browserClient.query('insert into pulse.web_push_subscription(org_id,person_id,endpoint,keys) values($1,$2,$3,$4)',[process.env.PULSE_ORG_ID,people.bob,'https://fcm.googleapis.com/fcm/send/synthetic-'+suffix,JSON.stringify({auth:'A'.repeat(22),p256dh:'A'.repeat(87)})]);
  await browserClient.query('commit');
 }finally{browserClient.release();}
 eq((await call('companion/notification-settings',{quiet:false,types:{chat:true}},bob)).status,200,'Bob enables chat pings for read-race acceptance');
 // ATT (0860): a plain group message is quiet, so the read race is run on one that pings: it mentions Bob.
 const immediate=await call(`chats/${group}/messages`,{body:'Synthetic immediately read @synthetic.bob group message',clientId:crypto.randomUUID()},alice);
 eq(immediate.status,200,'group message before web read');
 const latest=(await call(`chats/${group}/messages`,undefined,bob)).data.messages.at(-1);
 eq((await call(`chats/${group}/read`,{through:latest.createdAt},{name:'bob'})).status,200,'web reads before either desktop polls');
 let immediateNotice;
 for(const device of [bob,bob2]){
  const state=(await call('companion/updates',undefined,device)).data;
  immediateNotice=state.rows.find(n=>n.messageId===immediate.data.id);
  eq(immediateNotice?.pingAllowed,true,'web read cannot consume another desktop ping');
  eq(typeof immediateNotice?.readAt,'string','queued device event survives the shared read marker');
  eq(state.counts.total,0,'shared read clears badges while device delivery stays pending');
 }
 eq((await call('companion/updates',undefined,{name:'bob'})).data.rows.find(n=>n.messageId===immediate.data.id)?.pingAllowed,true,'visible web gets a new-message toast even when conversation read wins');
 eq((await call('companion/ack',{ids:[immediateNotice.id]},bob)).status,200,'read-event device acknowledgment');
 eq((await call('companion/updates',undefined,bob)).data.rows.find(n=>n.messageId===immediate.data.id)?.pingAllowed,false,'acknowledged read event cannot ping again');
 eq((await call('companion/updates',undefined,bob2)).data.rows.find(n=>n.messageId===immediate.data.id)?.pingAllowed,true,'one desktop receipt cannot consume the other after web read');
 const queued=await worker.connect();try{
  await queued.query('begin');await queued.query("select set_config('pulse.org_id',$1,true)",[process.env.PULSE_ORG_ID]);
  eq((await queued.query('select count(*)::int count from pulse.web_push_delivery q join pulse.notification n on n.id=q.notification_id where n.message_id=$1',[immediate.data.id])).rows[0].count,2,'both browser delivery events queued before shared read');
  eq((await queued.query("select count(*)::int count from pulse.notification_delivery q join pulse.notification n on n.id=q.notification_id where n.message_id=$1 and q.channel='web'",[immediate.data.id])).rows[0].count,2,'unified outbox captures both browsers before shared read');
  await queued.query('commit');
 }finally{queued.release();}
 process.env.PULSE_NOTIFICATION_MODE='sink';
 eq((await drainWebPush(worker)).sent,2,'sink accepts both browser receipts after shared read');
 eq((await drainWebPush(worker)).sent,0,'repeated sink drain cannot notify twice');
 const c=await worker.connect();try{await c.query('begin');await c.query("select set_config('pulse.org_id',$1,true)",[process.env.PULSE_ORG_ID]);await c.query("update pulse.role_assignment set valid_to=current_date-1 where person_id=$1 and role_key='leadership'",[people.bob]);await c.query('commit');}finally{c.release();}
 eq((await call(`chats/${group}/messages`,undefined,bob)).status,404,'removed membership refuses notification click-through');
 eq((await call('companion/inbox',undefined,bob2)).data.rows.some(n=>n.channelId===group),false,'removed group receipts hidden from inbox');
 await writeFile(process.env.TEST_REPORT,JSON.stringify({checks,receipts,delivery:'API events on disposable PostgreSQL; OS delivery not claimed'},null,2));
}finally{await app.close();await pool.end();await worker.end();}
