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

// REPLAY-FIXES #5: a refusal (404 on Adunor's tablet, 12 times in 7 min) is not asked again on every return to the app.
test('a refused registration pauses the automatic tries, says so once in plain words, and Retry from Devices still asks', async () => {
  const store = new Map();
  globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  try {
    const { enrollShell: enroll, enrollPaused, refusal, ENROLL_PAUSE_MS, REFUSED_WORDS } = await import('./shell-enrollment.mjs');
    let asked = 0, status = 404, t = 1_000_000;
    const native = { info: async () => ({ enrolled: false }), startEnrollment: async () => ({ code: 'SYNTHETIC', replaces: null }), finishEnrollment: async () => {}, checkInbox: async () => {} };
    const request = async () => { asked++; return { ok: status === 200, status }; };
    const now = () => t;
    await assert.rejects(enroll('a', native, request, () => true, { now }), (e) => e.refused === true && e.message === REFUSED_WORDS);
    assert.equal(asked, 1);
    for (let i = 0; i < 11; i++) { t += 30_000; await enroll('a', native, request, () => true, { now }); }
    assert.equal(asked, 1, 'opening the app again (11 times in 5.5 min) asks nothing');
    status = 200;
    await enroll('a', native, request, () => true, { now, force: true });
    assert.equal(asked, 2, 'Retry app registration in Settings → Devices asks at once');
    assert.equal(enrollPaused(t), false, 'a success ends the pause');
    status = 404; await assert.rejects(enroll('a', native, request, () => true, { now }));
    t += ENROLL_PAUSE_MS; status = 200; await enroll('a', native, request, () => true, { now });
    assert.equal(asked, 4, 'after the pause it tries by itself again');
    status = 503; await assert.rejects(enroll('a', native, request, () => true, { now }), (e) => !e.refused);
    assert.equal(enrollPaused(t), false, 'a busy server (5xx) is not a refusal: retried as before');
    assert.deepEqual([400, 403, 404, 409, 408, 429, 500, undefined].map(refusal), [true, true, true, true, false, false, false, false]);
  } finally { delete globalThis.sessionStorage; }
});
