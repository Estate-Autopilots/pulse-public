import test from 'node:test';import assert from 'node:assert/strict';
import {createFeed,conversationTarget} from '../src/communications.js';
test('overlapping polls notify each immutable event once and resume after restart',async()=>{
 let saved=null,pings=0;const state={cursor:'2026-10-08T20:00:00Z',counts:{total:1},rows:[{id:'one',pingAllowed:true}]};
 const options={call:async()=>state,load:()=>saved,save:(_id,s)=>{saved=s;},onPing:()=>{pings++;}};
 const feed=createFeed(options);feed.reset('laptop');await feed.poll();await feed.poll();
 const restarted=createFeed(options);restarted.reset('laptop');await restarted.poll();assert.equal(pings,1);
});
test('a queued device ping survives a shared read marker while its badge is zero',async()=>{
 const event={id:'read-elsewhere',readAt:'2026-10-08T20:00:00Z',pingAllowed:true};
 const pings=[],badges=[],receipts=[];
 const feed=createFeed({call:async()=>({rows:[event],counts:{total:0},cursor:'next'}),onPing:row=>pings.push(row.id),onSnapshot:state=>badges.push(state.counts.total),acknowledge:rows=>receipts.push(rows.map(row=>row.id))});
 feed.reset('windows');await feed.poll();await feed.poll();
 assert.deepEqual(pings,['read-elsewhere']);assert.deepEqual(badges,[0,0]);assert.deepEqual(receipts,[['read-elsewhere'],['read-elsewhere']]);
});
test('account switch during a poll cannot show the previous persons ping',async()=>{
 let answer,pings=0,snapshots=0;
 const feed=createFeed({call:()=>new Promise(resolve=>{answer=resolve;}),onPing:()=>pings++,onSnapshot:()=>snapshots++});
 feed.reset('old-person');const pending=feed.poll();feed.reset('new-person');answer({rows:[{id:'old',pingAllowed:true}],cursor:'new'});await pending;
 assert.equal(pings,0);assert.equal(snapshots,0);
});
test('account switch while the OS adapter is awaiting permission cannot save an old badge',async()=>{
 let release,snapshots=0,saves=0;
 const feed=createFeed({call:async()=>({rows:[{id:'one',pingAllowed:true}],cursor:'old'}),onPing:()=>new Promise(resolve=>{release=resolve;}),onSnapshot:()=>snapshots++,save:()=>saves++});
 feed.reset('old');const pending=feed.poll();await new Promise(r=>setTimeout(r,0));feed.reset('new');release();await pending;
 assert.equal(snapshots,0);assert.equal(saves,0);
});
test('quiet hours suppression still updates badge and a cursor page is resumed',async()=>{
 const paths=[],counts=[];let n=0;
 const feed=createFeed({call:async path=>{paths.push(path);return {rows:[{id:String(++n),pingAllowed:false}],cursor:'2026-10-08T20:00:00Z',page:n===1?'page-two':null,counts:{total:7}};},onPing:()=>assert.fail('suppressed event'),onSnapshot:s=>counts.push(s.counts.total)});
 feed.reset('laptop');await feed.poll();await feed.poll();assert.match(paths[1],/page=page-two/);assert.deepEqual(counts,[7,7]);
});
test('click target accepts only conversation deep links',()=>{
 const id='11111111-1111-4111-8111-111111111111';assert.equal(conversationTarget(`/chats?channel=${id}`),id);
 assert.equal(conversationTarget('/me'),null);assert.equal(conversationTarget('/chats?channel=bad'),null);
});
import {initials,shortTime,dayLabel,inboxGroups,primaryAction,visibleConversations,hueOf} from '../src/communications.js';
import {dayText,hm} from '../src/features.js';
test('avatars use two initials and a stable colour per name',()=>{
 assert.equal(initials('Asha Rao'),'AR');assert.equal(initials('pod-2'),'P2');assert.equal(initials(''),'?');assert.equal(initials('Mira Kapoor Seduh'),'MS');
 assert.equal(hueOf('Leadership'),hueOf('Leadership'));
});
test('times read like a messenger: now, minutes, hours, yesterday, weekday, date',()=>{
 const now=Date.parse('2026-10-09T12:00:00');
 assert.equal(shortTime('2026-10-09T11:59:40',now),'now');assert.equal(shortTime('2026-10-09T11:45:00',now),'15m');assert.equal(shortTime('2026-10-09T09:00:00',now),'3h');
 assert.equal(shortTime('2026-10-08T09:00:00',now),'Yesterday');assert.equal(dayLabel('2026-10-09T08:00:00',now),'Today');assert.equal(dayLabel('2026-10-08T08:00:00',now),'Yesterday');
});
test('the inbox groups Needs you, Mentions and Updates with one action each',()=>{
 const g=inboxGroups([{kind:'decision'},{kind:'approval'},{kind:'mention'},{kind:'reply'},{kind:'holiday'}]);
 assert.deepEqual(g.map(x=>[x.title,x.items.length]),[['Needs you',1],['Mentions',2],['Updates',2]]);
 assert.equal(primaryAction({kind:'approval'}),'Review');assert.equal(primaryAction({kind:'mention'}),'Reply');assert.equal(primaryAction({kind:'policy'}),'Read');assert.equal(primaryAction({kind:'holiday'}),'View');
 assert.deepEqual(inboxGroups([]),[]);
});
test('each conversation appears once: mirrors are hidden, pinned first, newest first',()=>{
 const c=[{id:'a',name:'Leadership',lastAt:'2026-10-09T10:00:00Z'},{id:'b',name:'Leadership',lastAt:null,duplicateOf:'a'},{id:'c',name:'Pod 2',lastAt:'2026-10-09T11:00:00Z'},{id:'d',name:'Ops',lastAt:null,moderationOnly:true}];
 const v=visibleConversations(c,['a']);assert.deepEqual(v.pinned.map(x=>x.id),['a']);assert.deepEqual(v.recent.map(x=>x.id),['c']);
});
test('your day is written in plain words and shared only as that text',()=>{
 const d={checkedInAt:'2026-10-09T04:22:00Z',checkedOutAt:null,workedMinutes:492,breakMinutes:35,office:'EA Studio',deliveries:3,focus:[{tool:'Premiere',minutes:250}]};
 const t=dayText(d,new Date('2026-10-09T12:00:00Z'));
 assert.match(t,/^My day, /);assert.match(t,/\(EA Studio\), 8h 12m worked, 35 min on breaks, 3 deliveries\./);assert.match(t,/Focus: Premiere 4h 10m\./);
 assert.equal(hm(45),'45 min');assert.equal(hm(120),'2h');assert.equal(dayText(null),'');
});
