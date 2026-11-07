import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';
const source=await readFile(new URL('../../public/pulse-push.js',import.meta.url),'utf8');
const id='11111111-1111-4111-8111-111111111111';
function worker({person='one',member=true,pages=[],dnd=false,read=false,kind='chat',href='/chats?channel='+id,eventType,title='New message in Chats'}={}){
 const handlers={},notes=[],opens=[],messages=[];
 const context={URL,Intl,Date,fetch:async path=>({ok:true,json:async()=>path.includes('/updates')?{person:{id:person},settings:{dnd,quiet:false}}:{rows:member?[{id,kind,messageId:kind==='chat'?id:null,readAt:read?'2026-10-08T12:00:00Z':null,title,href,eventType}]:[]}}),
 self:{location:{origin:'https://pulse.example'},clients:{matchAll:async()=>pages.map(p=>({...p,postMessage:m=>messages.push(m),navigate:async url=>opens.push(url),focus:async()=>{}})),openWindow:async url=>opens.push(url)},registration:{showNotification:async(title,n)=>notes.push({title,...n})},addEventListener:(name,handler)=>{handlers[name]=handler;},skipWaiting:()=>{}}};
 vm.runInNewContext(source,context);
 const push=async()=>{let pending;handlers.push({data:{json:()=>({id,personId:'one'})},waitUntil:p=>{pending=p;}});await pending;};
 const click=async()=>{let pending;handlers.notificationclick({notification:{data:{id,personId:'one'},close:()=>{}},waitUntil:p=>{pending=p;}});await pending;};
 return {push,click,notes,opens,messages};
}
test('closed-page web notification is generic and click opens the entitled exact conversation',async()=>{
 const w=worker();await w.push();assert.equal(w.notes.length,1);assert.equal(w.notes[0].body,'A new work update is ready');await w.click();assert.deepEqual(w.opens,['https://pulse.example/chats?channel='+id]);
});
test('visible Pulse tab gets an in-page event; no duplicate native browser toast',async()=>{
 const w=worker({pages:[{visibilityState:'visible'}]});await w.push();assert.equal(w.notes.length,0);assert.equal(w.messages[0].type,'pulse-ping');
});
test('another surface reading a chat cannot consume this browser delivery',async()=>{
 const chat=worker({read:true});await chat.push();assert.equal(chat.notes.length,1);
 const visible=worker({read:true,pages:[{visibilityState:'visible'}]});await visible.push();assert.equal(visible.messages.length,1);
 const decision=worker({read:true,kind:'decision'});await decision.push();assert.equal(decision.notes.length,0);
});
test('account change, lost membership, DND and external links cannot disclose a conversation',async()=>{
 for(const options of [{person:'two'},{member:false},{dnd:true}]){const w=worker(options);await w.push();assert.equal(w.notes.length,0);}
 const other=worker({person:'two'});await other.click();assert.deepEqual(other.opens,['/account']);
 const forbidden=worker({member:false});await forbidden.click();assert.deepEqual(forbidden.opens,[]);
 const external=worker({href:'https://outside.example/chat'});await external.click();assert.deepEqual(external.opens,[]);
});
test('a test the person asked for shows as a real notification with its own title, even with Pulse in front',async()=>{
 const w=worker({pages:[{visibilityState:'visible'}],kind:'update',eventType:'update.test',title:'Test from Pulse: notifications reach you here',href:'/notifications'});
 await w.push();assert.equal(w.messages.length,0);assert.equal(w.notes.length,1);assert.equal(w.notes[0].body,'Test from Pulse: notifications reach you here');
 const dnd=worker({dnd:true,kind:'update',eventType:'update.test',href:'/notifications'});await dnd.push();assert.equal(dnd.notes.length,0);
});
