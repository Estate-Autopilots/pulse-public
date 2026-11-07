import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopSession } from '../src/desktop-session.js';
import { demoPayload } from '../src/demo.js';
import { projected } from '../src/queue.js';
const session = { signedIn: true, base: 'https://pulse.example/api/native/v0', deviceId: 'device-a' };
function fixture() {
  let saved = null, at = Date.now(), calls = [], reject = false;
  const client = { companion: async () => demoPayload('out', at), act: async (action, extra) => { calls.push({ action, extra }); if (reject) throw { offline: true, message: 'Offline' }; } };
  const options = { read: () => saved, write: (v) => { saved = structuredClone(v); }, clock: () => at, client: () => client };
  const controller = new DesktopSession(options); controller.use(session);
  return { controller, options, client, calls, saved: () => saved, advance: (ms) => { at += ms; }, offline: () => { reject = true; }, online: () => { reject = false; } };
}
test('offline restart restores own day and queue with the original retry ID; double tap collapses', async () => {
  const f = fixture(); await f.controller.refresh(); f.offline();
  await assert.rejects(f.controller.act('check-in'), (e) => e.offline);
  await assert.rejects(f.controller.act('check-in'), (e) => e.offline);
  assert.equal(f.controller.queue.length, 1);
  const id = f.controller.queue[0].id;
  const restarted = new DesktopSession(f.options); restarted.use(session);
  assert.equal(projected(restarted.payload, restarted.queue).state, 'in');
  f.online(); await restarted.refresh();
  assert.equal(f.calls.at(-1).extra.queueId, id);
  assert.equal(restarted.queue.length, 0);
  assert.equal(f.saved().queue.length, 0);
});
test('online tap is durable before transport; lost response retry keeps the same ID', async () => {
  const f = fixture(); await f.controller.refresh(); let accepted;
  f.client.act = async (_, extra) => { assert.equal(f.saved().queue[0].id, extra.queueId); accepted = extra.queueId; throw { offline: true }; };
  await assert.rejects(f.controller.act('check-in'));
  f.client.act = async (_, extra) => assert.equal(extra.queueId, accepted);
  await f.controller.refresh(); assert.equal(f.saved().queue.length, 0);
});
test('overlapping refreshes and taps have at most one attendance request in flight', async () => {
  const f = fixture(); await f.controller.refresh(); f.offline(); await assert.rejects(f.controller.act('check-in'));
  let active = 0, max = 0;
  f.client.act = async () => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 5)); active--; };
  await Promise.all([f.controller.refresh(), f.controller.refresh(), f.controller.act('break-start')]);
  assert.equal(max, 1); assert.equal(f.controller.queue.length, 0);
});
test('different pairing cannot load or replay the former device; late result cannot restore it', async () => {
  const f = fixture(); await f.controller.refresh(); f.offline(); await assert.rejects(f.controller.act('check-in'));
  let release;
  f.client.act = () => new Promise((r) => { release = r; });
  const pending = f.controller.refresh(); await new Promise((r) => setImmediate(r));
  f.controller.use({ ...session, deviceId: 'device-b' }); release(); await pending;
  assert.equal(f.controller.payload, null); assert.equal(f.controller.queue.length, 0); assert.equal(f.saved(), null);
});
test('sign-out invalidates a late day response and clears the recovery cache', async () => {
  const f = fixture(); let release;
  f.client.companion = () => new Promise((r) => { release = r; });
  const pending = f.controller.refresh(); await new Promise((r) => setImmediate(r));
  f.controller.use({ signedIn: false }); release(demoPayload('in')); await pending;
  assert.equal(f.saved(), null); assert.equal(f.controller.payload, null);
});
test('revoked credential stops the queue before the next tap; explicit sign-out clears it', async () => {
  const f = fixture(); await f.controller.refresh(); f.offline(); await assert.rejects(f.controller.act('check-in'));
  f.advance(6000); await assert.rejects(f.controller.act('break-start'));
  let calls = 0; f.client.act = async () => { calls++; throw { status: 401, signedOut: true }; };
  await assert.rejects(f.controller.refresh(), (e) => e.signedOut);
  assert.equal(calls, 1); assert.equal(f.controller.queue.length, 2);
  f.controller.use({ signedIn: false }); assert.equal(f.saved(), null);
});
test('expired actions are refused locally and retained day does not masquerade as fresh', async () => {
  const f = fixture(); await f.controller.refresh(); f.offline(); await assert.rejects(f.controller.act('check-in'));
  f.advance(3 * 3600000 + 1); const restarted = new DesktopSession(f.options); restarted.use(session);
  assert.equal(restarted.payload, null); f.online();
  const result = await restarted.refresh(); assert.match(result.warning, /correction/);
  assert.equal(f.calls.length, 1); assert.equal(restarted.queue.length, 0);
});
test('storage failure prevents a tap from reaching the API; cache excludes requests and networks', async () => {
  const f = fixture(); await f.controller.refresh();
  assert.equal(f.saved().payload.person, undefined); assert.equal(f.saved().payload.presence, undefined); assert.equal(f.saved().payload.waiting, undefined);
  f.controller.write = () => { throw Error('disk full'); };
  await assert.rejects(f.controller.act('check-in'), (e) => /Could not save/.test(e.message));
  assert.equal(f.calls.length, 0); assert.equal(f.controller.queue.length, 0);
});

test('accepted tap followed by a failed day read survives restart without offering a duplicate check-in', async () => {
  const f = fixture(); await f.controller.refresh();
  f.client.companion = async () => { throw { offline: true }; };
  await assert.rejects(f.controller.act('check-in'));
  assert.equal(f.controller.payload.state, 'in'); assert.equal(f.controller.queue.length, 0);
  const restarted = new DesktopSession(f.options); restarted.use(session);
  assert.equal(restarted.payload.state, 'in'); assert.equal(restarted.payload.pending, true);
  assert.equal(restarted.fresh, false);
});

test('a skewed laptop clock cannot immediately expire a fresh server-timed tap', async () => {
  const f = fixture(); const skew = 24 * 3600000;
  f.client.companion = async () => demoPayload('out', f.options.clock() - skew);
  await f.controller.refresh(); f.offline();
  await assert.rejects(f.controller.act('check-in'), (e) => e.offline);
  assert.equal(f.controller.queue.length, 1);
  assert.equal(f.controller.queue[0].at, f.options.clock() - skew);
  const restarted = new DesktopSession(f.options); restarted.use(session);
  f.online(); await restarted.refresh(); assert.equal(restarted.queue.length, 0);
  assert.equal(f.calls.length, 2);
});

test('expired-tap correction guidance survives a failed refresh and another restart', async () => {
  const f = fixture(); await f.controller.refresh(); f.offline(); await assert.rejects(f.controller.act('check-in'));
  f.advance(3 * 3600000 + 1);
  f.client.companion = async () => { throw { offline: true }; };
  await assert.rejects(f.controller.refresh());
  const restarted = new DesktopSession(f.options); restarted.use(session);
  assert.match(restarted.notice, /correction/); assert.equal(restarted.queue.length, 0);
});
