import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { attachV1Seam, defineV1Operation, v1Fail } from '../dist/v1.js';
const org = process.env.TEST_ORG, other = process.env.TEST_OTHER, agent = process.env.TEST_AGENT, keys = JSON.parse(process.env.TEST_KEYS);
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 2 }), owner = new Pool({ ...JSON.parse(process.env.TEST_OWNER_CONFIG), max: 1 });
const admin = async (sql, args = [], tenant = org) => {
  const c = await owner.connect();
  try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [tenant]);
    const r = await c.query(sql, args); await c.query('commit'); return r.rows;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
};
const closed = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
let allowed = true, fail = false, limited = false, shape = false, commitFail = false;
for (const suffix of ['One', 'Two']) defineV1Operation({ operationId: `safety${suffix}`, method: 'POST', path: `/api/v1/tasks/safety${suffix}`, scope: 'tasks.write', summary: 'Synthetic write',
  body: closed({ text: { type: 'string' } }), response: closed({ id: { type: 'string' } }),
  authorize: async () => { if (!allowed) v1Fail(403, 'Membership removed'); },
  handler: async ({ client, requestId }) => {
    await client.query("select pulse.audit_write('v1_safety_fixture','fixture',$1)", [requestId]);
    await client.query('select pg_sleep(0.03)');
    if (commitFail) await client.query('insert into pulse_priv.v1_safety_commit values($1)', [randomUUID()]);
    if (fail) throw Error('synthetic rollback');
    return { id: randomUUID() };
  } });
attachV1Seam({ before: async (_ctx, _op, _input, _req, reply) => { if (limited) v1Fail(429, 'Synthetic token limit'); reply.code(shape ? 202 : 201); }, after: async (_ctx, _op, _input, answer) => shape ? { id: 'changed-after-hook' } : answer, settled: call => { if (call.principal) assert.equal('actor' in call.principal, false); } });
const app = createApp(pool, pool), attempts = [], logs = [];
for (const level of ['info', 'warn', 'error']) app.log[level] = (...args) => logs.push(JSON.stringify(args));
const call = async (key = randomUUID(), token = keys[0], text = 'PRIVATE_FIXTURE', suffix = 'One', extra = {}) => {
  const r = await app.inject({ method: 'POST', url: `/api/v1/tasks/safety${suffix}`, headers: { authorization: `Bearer ${token}`,
    ...(key === null ? {} : { 'idempotency-key': key }), ...extra }, payload: { text } });
  attempts.push({ id: r.headers['x-request-id'], status: r.statusCode }); return r;
};
const count = async () => Number((await admin("select count(*) n from pulse.audit_event where action='v1_safety_fixture'"))[0].n);
try {
  const key = randomUUID(), initial = await count();
  const [a, b] = await Promise.all([call(key), call(key)]);
  assert.equal(a.statusCode, 201, a.body); assert.equal(b.statusCode, 201, b.body); assert.equal(a.body, b.body);
  assert.equal(await count(), initial + 1);
  shape = true; const shaped = await call(key); assert.equal(shaped.statusCode, 201); assert.equal(shaped.body, a.body); shape = false;
  assert.equal((await call(key, keys[0], 'DIFFERENT')).statusCode, 409);
  assert.equal((await call(null)).statusCode, 400); assert.equal((await call('private text')).statusCode, 400);
  assert.equal((await call(randomUUID(), 'junk')).statusCode, 401);
  const appResponse = await call(key, keys[2]); assert.equal(appResponse.statusCode, 201); assert.notEqual(appResponse.body, a.body);
  const c = await call(key, keys[1]); assert.equal(c.statusCode, 201); assert.notEqual(c.body, a.body);
  const d = await call(key, keys[0], 'PRIVATE_FIXTURE', 'Two'); assert.equal(d.statusCode, 201); assert.notEqual(d.body, a.body);
  allowed = false; assert.equal((await call(key)).statusCode, 403); allowed = true;
  limited = true; assert.equal((await call(key)).statusCode, 429); limited = false;
  const retry = randomUUID(), beforeFailure = await count(); fail = true;
  assert.equal((await call(retry)).statusCode, 500); assert.equal(await count(), beforeFailure); fail = false;
  assert.equal((await call(retry)).statusCode, 201); assert.equal(await count(), beforeFailure + 1);
  const deferred = randomUUID(), beforeCommitFailure = await count(); commitFail = true;
  assert.equal((await call(deferred)).statusCode, 409); assert.equal(await count(), beforeCommitFailure); commitFail = false;
  assert.equal((await call(deferred)).statusCode, 201); assert.equal(await count(), beforeCommitFailure + 1);
  const member = randomUUID(); await call(member, keys[1]); await call(member, keys[2]);
  await admin('update pulse.agent_member set disabled_at=clock_timestamp() where person_id=$1', [agent]);
  assert.equal((await call(member, keys[1])).statusCode, 401); assert.equal((await call(member, keys[2])).statusCode, 403);
  await admin('update pulse.agent_member set disabled_at=null where person_id=$1', [agent]);
  await admin("update pulse_priv.v1_replay set expires_at=clock_timestamp()-interval '1 second' where request_key=$1", [key]);
  const expired = await call(key); assert.equal(expired.statusCode, 201); assert.notEqual(expired.body, a.body);
  // Same token/operation/key in a second tenant is a different lock/receipt; RLS stays in force.
  const token = (await admin('select id from pulse_priv.agent_key where prefix=$1', [keys[0].slice(4, 12)]))[0].id;
  const cross = await pool.connect();
  try {
    await cross.query('begin'); await cross.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true),set_config('pulse.v1_token_id',$3,true)", [other, agent, token]);
    const hash = createHash('sha256').update('synthetic').digest('hex');
    assert.equal((await cross.query("select pulse.v1_replay($1,'safetyOne',$2,$3) v", [token, key, hash])).rows[0].v, null);
    await cross.query("select pulse.v1_replay($1,'safetyOne',$2,$3,$4)", [token, key, hash, { status: 201, body: '{"id":"other"}' }]);
    await cross.query('commit');
  } finally { cross.release(); }
  // Revoke the actual key; a matching stored response is still refused.
  await admin('update pulse_priv.agent_key set revoked_at=clock_timestamp() where id=$1', [token]);
  assert.equal((await call(key)).statusCode, 401);
  // Real token-budget rejection on a stored replay still emits exactly one durable attempt receipt.
  let exhausted;
  for (let i = 0; i <= 120; i++) {
    const r = await call(member, keys[1]);
    if (r.statusCode === 429) { exhausted = r; break; }
    assert.equal(r.statusCode, 201, r.body);
  }
  assert.ok(exhausted); assert.equal(exhausted.headers['ratelimit-remaining'], '0');
  assert.ok(Number(exhausted.headers['retry-after']) >= 1);
  assert.equal((await call(member, keys[2])).statusCode, 201, 'another valid token stays independent');
  // Each HTTP attempt, including auth/input/limit/rollback refusals, has one sanitized durable audit row.
  const rows = await admin('select * from pulse_priv.v1_call where request_id=any($1::uuid[])', [attempts.map(a => a.id)]);
  // Auth refused before tenant resolution has a null org; inspect those under its RLS scope too.
  rows.push(...await admin('select * from pulse_priv.v1_call where request_id=any($1::uuid[])', [attempts.map(a => a.id)], null));
  assert.equal(rows.length, attempts.length);
  for (const a of attempts) {
    const r = rows.find(r => r.request_id === a.id); assert.equal(r.status, a.status); assert.ok(r.latency_ms >= 0);
    assert.match(r.route_template, /^\/api\/v1\/tasks\/safety(One|Two)$/);
    if (a.status === 401) assert.equal(r.principal_id, null);
  }
  const evidence = JSON.stringify([rows, logs]);
  for (const secret of [...keys, 'PRIVATE_FIXTURE', 'DIFFERENT', 'private text']) assert.ok(!evidence.includes(secret));
  console.log(`call safety: ${attempts.length} attempts audited once; concurrency, conflict, isolation, rollback, expiry, revocation verified`);
} finally { await app.close(); await pool.end(); await owner.end(); }
