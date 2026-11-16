// AGREEMENTS (2081) through the API (tests/core/test_policy_acceptance.py): Alice finds the pay policy waiting with its
// key terms, accepts it term by term (a wrong or partial tick list is refused), then nothing waits and her acceptance is
// listed; her manager sees her accepted, Bob (no team) sees nobody, HR's count includes her. Synthetic people only.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const emails = JSON.parse(process.env.TEST_EMAILS), doc = process.env.TEST_DOC;
const call = async (method, url, who, payload) => {
  const r = await app.inject({ method, url, headers: { 'cf-access-authenticated-user-email': emails[who] }, ...(payload === undefined ? {} : { payload }) });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
try {
  const before = await call('GET', '/api/v0/agreements/policies', 'alice');
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.equal(before.body.due.length, 1); assert.deepEqual(before.body.accepted, []); assert.equal(before.body.team, false);
  const due = before.body.due[0];
  assert.equal(due.id, doc); assert.equal(due.kind, 'pay'); assert.equal(due.version, 1); assert.equal(due.publishedBy, 'Synthetic HR');
  assert.equal(due.intro, 'Synthetic Studio pays everyone the same way.');
  assert.deepEqual(due.terms.map((t) => [t.key, t.number, t.title, t.text]), [['t1-who-approves-pay', 1, 'Who approves pay', 'Leadership approves every change.'], ['t2-notice', 2, 'Notice', 'Thirty synthetic days.']]);
  assert.deepEqual(due.closing, { title: 'What happens next', text: 'Ask HR.' });
  assert.equal(due.body, undefined, 'the terms, not the raw text');
  const light = await call('GET', '/api/v0/agreements/policies?due=1', 'alice');
  assert.deepEqual(light.body.due, before.body.due); assert.deepEqual(light.body.accepted, []); assert.equal(light.body.team, false, 'the visit check asks only what waits');
  const url = `/api/v0/agreements/policies/${doc}/accept`;
  assert.equal((await call('POST', url, 'alice', { terms: ['t1-who-approves-pay'] })).status, 409, 'every term');
  assert.equal((await call('POST', url, 'alice', { terms: ['t2-notice', 't1-who-approves-pay'] })).status, 409, 'in order');
  assert.equal((await call('POST', url, 'alice', { terms: 'all' })).status, 400);
  assert.equal((await call('POST', '/api/v0/agreements/policies/nope/accept', 'alice', { terms: [] })).status, 400);
  assert.equal((await call('POST', '/api/v0/agreements/policies/00000000-0000-4000-8000-000000000001/accept', 'alice', { terms: [] })).status, 404);
  const ok = await call('POST', url, 'alice', { terms: ['t1-who-approves-pay', 't2-notice'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.version, 1); assert.equal(ok.body.via, 'steps');
  const again = await call('POST', url, 'alice', { terms: ['t1-who-approves-pay', 't2-notice'] });
  assert.equal(again.status, 200); assert.equal(again.body.at, ok.body.at, 'a second press changes nothing');
  const after = await call('GET', '/api/v0/agreements/policies', 'alice');
  assert.deepEqual(after.body.due, []);
  assert.deepEqual(after.body.accepted.map((a) => [a.documentId, a.version, a.via, a.terms, a.current]), [[doc, 1, 'steps', 2, true]]);
  const mgr = await call('GET', '/api/v0/agreements/team', 'mgr');
  assert.equal(mgr.status, 200, JSON.stringify(mgr.body)); assert.equal(mgr.body.scope, 'team'); assert.equal(mgr.body.people, 1);
  assert.deepEqual(mgr.body.policies[0].accepted.map((p) => p.name), ['Synthetic Alice']);
  assert.equal((await call('GET', '/api/v0/agreements/policies', 'mgr')).body.team, true, 'a manager has a team to see');
  const bob = await call('GET', '/api/v0/agreements/team', 'bob');
  assert.equal(bob.status, 200); assert.equal(bob.body.people, 0);
  const hr = await call('GET', '/api/v0/agreements/team', 'hr');
  assert.equal(hr.body.scope, 'company'); assert.ok(hr.body.policies[0].pending.some((p) => p.name === 'Synthetic Bob'));
  const list = await call('GET', '/api/v0/hr/policies', 'hr');
  assert.equal(list.body.rows.find((r) => r.id === doc).ackCount, 1, "HR desk's and People & pay's count include it");
  console.log('policy-acceptance-runner: passed');
} catch (e) {
  console.error(e instanceof Error ? e.stack : e); process.exitCode = 1;
} finally {
  await app.close().catch(() => undefined); await pool.end().catch(() => undefined);
}
