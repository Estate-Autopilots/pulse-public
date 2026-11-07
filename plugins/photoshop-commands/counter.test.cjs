const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
function fixture(){
 const handlers={},timers=new Map(),requests=[];let listener;let gate={allowed:true,epoch:'initial'},offline=false;
 const elements={connect:{addEventListener:(_,fn)=>handlers.connect=fn},pause:{addEventListener:(_,fn)=>handlers.pause=fn},token:{value:'a'.repeat(64)},status:{textContent:''}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/counter.js','utf8'),{require:()=>({action:{addNotificationListener:async(_,fn)=>listener=fn,removeNotificationListener:()=>{listener=null;}}}),document:{getElementById:id=>elements[id]},setInterval:(fn,ms)=>{timers.set(ms,fn);return ms;},clearInterval:id=>timers.delete(id),fetch:async(url,options)=>{if(offline)throw Error('offline');if(url.endsWith('/state'))return {ok:true,json:async()=>({...gate})};requests.push(JSON.parse(options.body));return {ok:true};}});
 return {connect:()=>handlers.connect(),event:name=>listener?.(name),tick:ms=>timers.get(ms)(),requests,gate:(allowed,epoch)=>{gate={allowed,epoch};},offline:value=>{offline=value;},pause:()=>handlers.pause()};
}
test('pause and resume discard a prior hourly bucket, then count only fresh work',async()=>{
 const f=fixture();await f.connect();for(let i=0;i<8;i++)f.event('move');f.gate(false,'paused');await f.tick(10000);for(let i=0;i<8;i++)f.event('set');f.gate(true,'resumed');await f.tick(10000);for(let i=0;i<5;i++)f.event('move');await f.tick(3600000);
 assert.deepEqual(f.requests,[{app:'photoshop',epoch:'resumed',counts:{select_move:5}}]);
});
test('even a pause missed by polling invalidates the accumulated bucket at flush',async()=>{
 const f=fixture();await f.connect();for(let i=0;i<8;i++)f.event('save');f.gate(true,'after-brief-pause');await f.tick(3600000);assert.deepEqual(f.requests,[]);
});
test('connection loss discards pending counts and arbitrary Adobe event data is ignored',async()=>{
 const f=fixture();await f.connect();f.event('save');f.event({password:'never collect'});f.offline(true);await f.tick(10000);f.offline(false);await f.tick(10000);for(let i=0;i<5;i++)f.event('undo');await f.tick(3600000);assert.deepEqual(f.requests,[{app:'photoshop',epoch:'initial',counts:{undo_redo:5}}]);f.pause();f.event('move');
});
