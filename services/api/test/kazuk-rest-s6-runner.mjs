// KAZUK-REST slice 6 through the API (tests/core/test_kazuk_rest_s6.py): Alice names Bob to cover her leave, Bob sees
// it on the cover page and accepts, Alice sees it covered; only HR sets the cover rule, reads who has not acknowledged
// a policy and reminds them. Synthetic people only.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const emails = JSON.parse(process.env.TEST_EMAILS);
const call = async (method, url, who, payload) => {
  const r = await app.inject({ method, url, headers: { 'cf-access-authenticated-user-email': emails[who] }, ...(payload === undefined ? {} : { payload }) });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
try {
  const before = await call('GET', '/api/v0/cover', 'alice');
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.deepEqual(before.body.uncovered.map((u) => u.sourceId), [process.env.TEST_LEAVE], 'her leave has no cover yet');
  assert.equal(before.body.canSet, false); assert.equal(before.body.policy.hours, 24); assert.equal(before.body.policy.required, false); assert.equal(before.body.policy.sop, null);
  assert.equal((await call('POST', '/api/v0/cover/ask', 'alice', { kind: 'leave', sourceId: process.env.TEST_LEAVE, coverId: 'nobody' })).status, 400);
  const ask = await call('POST', '/api/v0/cover/ask', 'alice', { kind: 'leave', sourceId: process.env.TEST_LEAVE, coverId: process.env.TEST_BOB, note: 'Synthetic handover' });
  assert.equal(ask.status, 200, JSON.stringify(ask.body));
  const bob = await call('GET', '/api/v0/cover', 'bob');
  assert.equal(bob.body.asked.length, 1); assert.equal(bob.body.asked[0].personName, 'Synthetic Alice'); assert.equal(bob.body.asked[0].note, 'Synthetic handover');
  assert.equal(bob.body.asked[0].coverStart, before.body.policy.shiftStart, 'the hours covered come from the shift');
  assert.equal((await call('POST', `/api/v0/cover/${ask.body.id}/answer`, 'alice', { accept: true })).status, 404, 'only the colleague asked answers');
  const yes = await call('POST', `/api/v0/cover/${ask.body.id}/answer`, 'bob', { accept: true });
  assert.equal(yes.status, 200, JSON.stringify(yes.body)); assert.equal(yes.body.status, 'accepted');
  const after = await call('GET', '/api/v0/cover', 'alice');
  assert.equal(after.body.mine[0].status, 'accepted'); assert.equal(after.body.mine[0].coverName, 'Synthetic Bob'); assert.deepEqual(after.body.uncovered, []);
  // The cover rule and acknowledgements are HR's.
  assert.equal((await call('POST', '/api/v0/cover/policy', 'alice', { hours: 12, required: true })).status, 403);
  assert.equal((await call('POST', '/api/v0/cover/policy', 'hr', { hours: 0 })).status, 400);
  const rule = await call('POST', '/api/v0/cover/policy', 'hr', { hours: 12, required: true, sop: '1. Synthetic step one\n2. Synthetic step two' });
  assert.equal(rule.status, 200, JSON.stringify(rule.body)); assert.deepEqual(rule.body, { hours: 12, required: true, sop: '1. Synthetic step one\n2. Synthetic step two' });
  assert.equal((await call('POST', '/api/v0/cover/policy', 'hr', { hours: 12, required: true })).body.sop, '1. Synthetic step one\n2. Synthetic step two', 'no sop keeps the steps HR wrote');
  assert.equal((await call('GET', '/api/v0/cover', 'hr')).body.canSet, true);
  const doc = process.env.TEST_DOC;
  assert.equal((await call('GET', `/api/v0/hr/policies/${doc}/acks`, 'alice')).status, 403);
  assert.equal((await call('POST', `/api/v0/hr/policies/${doc}/remind`, 'bob')).status, 403);
  const acks = await call('GET', `/api/v0/hr/policies/${doc}/acks`, 'hr');
  assert.equal(acks.status, 200, JSON.stringify(acks.body));
  assert.ok(acks.body.pending.some((p) => p.name === 'Synthetic Bob'));
  const remind = await call('POST', `/api/v0/hr/policies/${doc}/remind`, 'hr');
  assert.equal(remind.status, 200); assert.ok(remind.body.reminded >= 3, JSON.stringify(remind.body));
  assert.equal((await call('POST', `/api/v0/hr/policies/${doc}/remind`, 'hr')).body.reminded, 0, 'once a day each');
  console.log('kazuk-rest-s6-runner: passed');
} catch (e) {
  console.error(e instanceof Error ? e.stack : e); process.exitCode = 1;
} finally {
  await app.close().catch(() => undefined); await pool.end().catch(() => undefined);
}
