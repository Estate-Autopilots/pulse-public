import test from 'node:test'; import assert from 'node:assert/strict';
import { enrollShell } from './shell-enrollment.mjs';
test('failed enrollment can retry immediately; overlapping foreground calls share one completed registration', async()=>{
  let enrolled=false, starts=0, finishes=0, available=false;
  const native={info:async()=>({enrolled,personId:enrolled?'a':null}),startEnrollment:async()=>{starts++;return {code:'SYNTHETIC',replaces:null};},finishEnrollment:async()=>{finishes++;enrolled=true;},checkInbox:async()=>{}};
  const request=async(_,r)=>{assert.equal(JSON.parse(r.body).expectedPersonId,'a');return {ok:available};};
  await assert.rejects(enrollShell('a',native,request)); available=true;
  await Promise.all([enrollShell('a',native,request),enrollShell('a',native,request)]);
  assert.equal(starts,2); assert.equal(finishes,1);
});
test('unmounted enrollment never collects credentials',async()=>{
  let active=true, finish=0;
  const native={info:async()=>({enrolled:false}),startEnrollment:async()=>{active=false;return {code:'SYNTHETIC'};},finishEnrollment:async()=>finish++};
  await enrollShell('a',native,()=>{throw Error('must not approve');},()=>active); assert.equal(finish,0);
});
