import test from 'node:test';
import assert from 'node:assert/strict';
import { AttendanceRecovery, ATTENDANCE_KEY } from './attendance-recovery.mjs';
function fixture() {
  let time = Date.parse('2026-10-09T12:00:00Z'), raw = null, online = true, failSave = false;
  const sent = [];
  const storage = { getItem: () => raw, setItem: (k, v) => { if (failSave) throw Error(); raw = v; } };
  const request = async (path, body) => { if (!online) throw Error('offline'); if (path === 'companion') return { person: { id: 'owner-a' }, now: new Date(time).toISOString() }; sent.push({ path, body }); return { id: 'receipt-a' }; };
  const make = owner => new AttendanceRecovery({ owner, storage, request, clock: () => time });
  return { make, storage, sent, request, get raw() { return raw; }, set raw(v) { raw = v; }, tick: n => time += n, offline: () => online = false, online: () => online = true, failSave: () => failSave = true };
}
test('offline tap survives restart with the same retry ID and server receipt, without caching a day', async () => {
  const f = fixture(), first = f.make('owner-a'); await first.retry(); f.offline(); await first.act('check-in','office');
  const id = first.records[0].id; first.dispose();
  const next = f.make('owner-a'); f.online(); await next.retry();
  assert.equal(f.sent.length,1); assert.equal(f.sent[0].body.queueId,id); assert.equal(f.sent[0].body.expectedPersonId,'owner-a'); assert.equal(next.records[0].receiptId,'receipt-a'); assert.equal(next.records[0].state,'accepted');
  assert.deepEqual(Object.keys(JSON.parse(f.raw)).sort(),['offset','owner','records']);
});
test('seven-day metadata retention never permits an attendance request older than three hours; no automatic receipt purge', async () => {
  const f = fixture(), r = f.make('owner-a'); await r.retry(); f.offline(); await r.act('check-in','office'); f.tick(3*3600000+1); f.online(); await r.retry();
  assert.equal(f.sent.length,0); assert.equal(r.records[0].state,'needs-correction'); f.tick(7*86400000); await r.retry(); assert.equal(r.records.length,1); assert.equal(f.sent.length,0);
});
test('changed account discards old actions; an old response cannot write another account’s state', async () => {
  const f = fixture(), a = f.make('owner-a'); await a.retry(); f.offline(); await a.act('check-in','office'); const b = f.make('owner-b'); f.online(); await a.retry();
  assert.equal(f.sent.length,0); assert.deepEqual(b.records,[]); assert.equal(JSON.parse(f.raw).owner,'owner-b');
  await b.retry(); assert.match(b.note,/sign-in changed/); assert.deepEqual(b.records,[]);
});
test('lost response retries the original ID; auth expiry waits and permanent denial becomes rejected', async () => {
  const f = fixture(); let status=0;
  const r = new AttendanceRecovery({owner:'owner-a',storage:f.storage,request:async(path,body)=> { if(path==='companion') return f.request(path); f.sent.push(body); if(status!==200)throw Object.assign(Error(),{status}); return {id:'receipt-a'}; }});
  await r.retry(); await r.act('check-in','office'); const id=r.records[0].id;
  status=401; await r.retry(); assert.equal(r.records[0].state,'queued'); status=200; await r.retry(); assert.equal(r.records[0].state,'accepted'); assert.ok(f.sent.every(x=>x.queueId===id));
  status=403; await r.act('check-out'); assert.equal(r.records[1].state,'rejected');
});
test('double taps cannot create duplicate queued requests and storage failure stops transport', async () => {
  const f=fixture(),r=f.make('owner-a'); await r.retry(); f.offline(); await Promise.all([r.act('check-in','office'),r.act('check-in','office')]); assert.equal(r.records.length,1);
  const g=fixture(),s=g.make('owner-a'); await s.retry(); g.failSave(); await s.act('check-in','office'); assert.equal(g.sent.length,0); assert.equal(s.records.length,0); assert.match(s.note,/storage/);
});
test('server time corrects a skewed phone before a tap', async () => {
  const f=fixture(); const r=new AttendanceRecovery({owner:'owner-a',storage:f.storage,request:f.request,clock:()=>Date.parse('2026-10-09T17:00:00Z')}); await r.retry(); await r.act('check-in','office'); assert.equal(f.sent[0].body.at,'2026-10-09T12:00:00.000Z');
});
test('replacement account wins over an in-flight accepted response', async () => {
  const f=fixture(); let resolve; const wait=new Promise(r=>resolve=r);
  const a=new AttendanceRecovery({owner:'owner-a',storage:f.storage,request:async(p,b)=>p==='companion'?f.request(p):wait}); await a.retry(); const job=a.act('check-in','office'); await new Promise(r=>setTimeout(r,0)); const b=f.make('owner-b'); resolve({id:'old-receipt'}); await job; assert.equal(JSON.parse(f.raw).owner,'owner-b'); assert.deepEqual(b.records,[]);
});

test('two online taps also reuse the shared five-second duplicate guard',async()=>{
  const f=fixture(),r=f.make('owner-a');await r.retry();await Promise.all([r.act('check-in','office'),r.act('check-in','office')]);assert.equal(f.sent.length,1);assert.equal(r.records.length,1);
});

test('EST-1195: a first tap asks Pulse for its clock itself; unreachable, nothing is saved, it says so, and Try again sends one tap', async () => {
  const f = fixture(), r = f.make('owner-a');
  f.offline(); assert.equal(await r.act('check-in', 'office'), 'unsaved');
  assert.equal(f.sent.length, 0); assert.deepEqual(r.records, []); assert.match(r.note, /check-in was not saved/); assert.equal(r.unsaved.action, 'check-in');
  f.online(); assert.equal(await r.again(), 'accepted');
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].body.at, '2026-10-09T12:00:00.000Z'); assert.equal(r.unsaved, null);
  const g = fixture(), s = g.make('owner-a'); assert.equal(await s.act('check-in', 'office'), 'accepted'); assert.equal(g.sent.length, 1);
});
test('EST-1195: an expired sign-in before the clock is confirmed says sign in again and saves nothing', async () => {
  const f = fixture();
  const r = new AttendanceRecovery({ owner: 'owner-a', storage: f.storage, request: async () => { throw Object.assign(Error(), { status: 401 }); } });
  assert.equal(await r.act('check-out'), 'unsaved'); assert.match(r.note, /sign-in has expired/); assert.equal(r.unsaved.signedOut, true); assert.deepEqual(r.records, []);
});
test('EST-1195: Pulse not answering within the timeout is given up; the tap stays queued and the retry sends the same id', async () => {
  const f = fixture(); let hang = true, aborted = 0;
  const r = new AttendanceRecovery({ owner: 'owner-a', storage: f.storage, timeoutMs: 20, request: (path, body, signal) => {
    if (path === 'companion') return f.request(path);
    if (hang) return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted++; reject(Error('aborted')); }));
    f.sent.push(body); return Promise.resolve({ id: 'receipt-a' }); } });
  await r.retry(); assert.equal(await r.act('check-in', 'office'), undefined);
  assert.equal(aborted, 1); assert.equal(r.records[0].state, 'queued'); assert.equal(r.busy, false); assert.match(r.note, /saved on this device/);
  hang = false; await r.retry();
  assert.equal(r.records[0].state, 'accepted'); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].queueId, r.records[0].id); assert.equal(r.note, '');
});
test('EST-1195: a background retry with nothing saved stays quiet', async () => {
  const f = fixture(), r = f.make('owner-a'); f.offline(); await r.retry(); assert.equal(r.note, ''); assert.equal(r.unsaved, null);
});
