import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const script=await readFile(new URL('../../public/pulse-push.js',import.meta.url),'utf8');
async function push(eventType,{visible=false,personId='a',settings={}}={}){
  const handlers={},shown=[],messages=[],navigated=[];
  const row={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',eventType,title:'New update from Morgan',kind:'update',href:'/updates/opaque'};
  const window={visibilityState:visible?'visible':'hidden',postMessage:m=>messages.push(m),navigate:u=>navigated.push(u),focus:()=>{}};
  const self={addEventListener:(type,fn)=>{handlers[type]=fn;},location:{origin:'https://pulse.example'},
    clients:{matchAll:async()=>[window]},registration:{showNotification:async(...args)=>shown.push(args)}};
  const fetch=async url=>({ok:true,json:async()=>url.startsWith('/api/v0/companion/inbox')?{rows:[row]}:{person:{id:'a'},settings}});
  runInNewContext(script,{self,fetch,Intl,Date,URL,encodeURIComponent});
  let done;handlers.push({data:{json:()=>({id:row.id,personId})},waitUntil:p=>{done=p;}});await done;
  if(shown.length){handlers.notificationclick({notification:{data:shown[0][1].data,close:()=>{}},waitUntil:p=>{done=p;}});await done;}
  return {shown,messages,navigated};
}
test('posted updates resolve their title and tap target from the authenticated inbox',async()=>{
  const r=await push('update.posted');assert.equal(r.shown[0][0],'New update from Morgan');
  assert.equal(r.shown[0][1].body,undefined);assert.equal(r.navigated[0],'https://pulse.example/updates/opaque');
  assert.deepEqual(Object.keys(r.shown[0][1].data).sort(),['id','personId']);
});
test('other events keep generic copy and visible tabs keep the in-page path',async()=>{
  assert.equal((await push('task.assigned')).shown[0][0],'Pulse');
  assert.equal((await push('task.assigned')).shown[0][1].body,'A new work update is ready');
  assert.equal((await push('update.test')).shown[0][1].body,'New update from Morgan');
  const r=await push('update.posted',{visible:true});assert.equal(r.shown.length,0);assert.equal(r.messages[0].type,'pulse-ping');
});
test('account changes, DND, type preferences and quiet hours suppress browser display',async()=>{
  for(const options of [{personId:'b'},{settings:{dnd:true}},{settings:{types:{update:false}}},
    {settings:{quiet:true,start:'00:00',end:'00:00',timezone:'UTC'}}])
    assert.equal((await push('update.posted',options)).shown.length,0);
});
