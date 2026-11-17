import test from 'node:test';
import assert from 'node:assert/strict';
import { forgetShared, sharedJson } from './shared-get.mjs';

// PERF: callers asking at once share one request; failures are not kept. Synthetic values only.
test('callers within the window share one request; later ones ask again', async () => {
  let calls = 0, clock = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ webPushKey: 'synthetic-key', n: calls }) }; };
  const [a, b] = await Promise.all([sharedJson('/x', 1000, fetchImpl, () => clock), sharedJson('/x', 1000, fetchImpl, () => clock)]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  clock = 2000;
  assert.equal((await sharedJson('/x', 1000, fetchImpl, () => clock)).n, 2);
  forgetShared('/x');
  assert.equal((await sharedJson('/x', 1000, fetchImpl, () => clock)).n, 3);
});

test('a failed answer is null and is not kept', async () => {
  let calls = 0;
  const failing = async () => { calls++; return { ok: false, json: async () => ({}) }; };
  assert.equal(await sharedJson('/y', 10_000, failing, () => 0), null);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await sharedJson('/y', 10_000, failing, () => 0), null);
  assert.equal(calls, 2);
});
