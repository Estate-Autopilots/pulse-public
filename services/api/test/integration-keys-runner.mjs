import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { defineV1Operation } from '../dist/v1.js';
import { createApiProxy, v0ProxyOptions } from '../../../apps/web/app/api/proxy.mjs';

const env = process.env, pool = new Pool({ ...JSON.parse(env.TEST_API_CONFIG), max: 1 });
// The front door is live before its area adapters; fixture operations exercise its real authentication seam.
for (const area of ['tasks','chats']) defineV1Operation({ operationId: `integration${area}Probe`, method: 'GET',
  path: `/api/v1/${area}/integration-probe`, scope: `${area}.read`, summary: 'Synthetic principal probe',
  response: { type: 'object', additionalProperties: false, required: ['viewer'], properties: { viewer: { type: 'string' } } },
  handler: async ({ client }) => ({ viewer: (await client.query('select pulse.current_viewer() v')).rows[0].v }) });
const owner = new Pool({ ...JSON.parse(env.TEST_OWNER_CONFIG), max: 1 }), app = createApp(pool, pool), logs = [], sensitive = [];
for (const level of ['info','warn','error']) app.log[level] = (...args) => logs.push(JSON.stringify(args));
app.log.child = () => app.log;
const path = '/api/v0/integrations/keys', admin = { 'cf-access-authenticated-user-email': env.TEST_ADMIN_EMAIL };
const input = { name: 'Synthetic integration', scopes: ['catalog.read'], days: 30 };
const call = (url = path, headers = admin, payload, method = payload ? 'POST' : 'GET') => app.inject({ url, headers, method, ...(payload === undefined ? {} : { payload }) });
const issue = async body => {
  const r = await call(path, admin, body); assert.equal(r.statusCode, 201);
  assert.match(r.headers['cache-control'], /no-store/);
  const { key, token } = r.json(); assert.equal(typeof key.id, 'string');
  assert.ok(new RegExp(`^psvc_${key.id}_[A-Za-z0-9_-]{43}$`).test(token));
  sensitive.push(token, token.split('_').slice(2).join('_'), createHash('sha256').update(token.slice(42)).digest('hex'));
  return { key, token };
};
const service = (k, url = '/api/v1/catalog/items') => call(url, { authorization: `Bearer ${k.token}` });
const sql = async (q, args) => {
  const c = await owner.connect();
  try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [env.TEST_ORG]);
    const r = await c.query(q, args); await c.query('commit'); return r.rows;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
};
try {
  const read = await issue(input), v1 = await issue({ ...input, scopes: ['tasks.read'], agentId: env.TEST_AGENT });
  assert.equal(read.key.createdBy, env.TEST_ADMIN); assert.equal(read.key.agent, null);
  assert.equal(v1.key.agent.id, env.TEST_AGENT); assert.match(v1.key.agent.employeeId, /-AI-\d+$/);
  const stored = (await sql('select key_hash,expires_at from pulse_priv.service_key where id=$1', [read.key.id]))[0];
  const secret = read.token.slice(42); assert.ok(stored.key_hash === createHash('sha256').update(secret).digest('hex'));
  sensitive.push(secret, stored.key_hash);
  assert.equal(Math.round((Date.parse(read.key.expiresAt) - Date.parse(read.key.createdAt)) / 86400000), 30);
  assert.equal((await service(read)).statusCode, 200);
  assert.equal((await service(read, '/api/v1/service/clients')).statusCode, 403);
  const v1Read = await service(v1, '/api/v1/tasks/integration-probe'); assert.equal(v1Read.statusCode, 200);
  assert.equal(v1Read.json().viewer, env.TEST_AGENT);
  assert.equal((await service(v1, '/api/v1/chats/integration-probe')).statusCode, 403);
  const lastUsed = (await sql('select last_used_at from pulse_priv.service_key where id=$1', [read.key.id]))[0].last_used_at;
  await service(read);
  assert.equal(+(await sql('select last_used_at from pulse_priv.service_key where id=$1', [read.key.id]))[0].last_used_at, +lastUsed);
  const listed = await call(); assert.equal(listed.statusCode, 200); assert.match(listed.headers['cache-control'], /no-store/);
  // Every selectable grant must actually issue through the real PostgreSQL contract.
  const advertised = listed.json().scopes;
  assert.equal(advertised.length, 26); assert.equal(new Set(advertised).size, advertised.length);
  for (const scope of ['updates.post','updates.requests.manage']) {
    assert.ok(!advertised.includes(scope), `${scope} is operator-only`);
    assert.equal((await call(path, admin, { ...input, scopes: [scope] })).statusCode, 400);
  }
  for (const scope of advertised) {
    const agentId = scope === 'chats.post' || /\.(read|write)$/.test(scope) && !['catalog.read','clients.read','leads.read'].includes(scope)
      ? env.TEST_AGENT : null;
    const issued = await issue({ ...input, scopes: [scope], agentId });
    assert.deepEqual(issued.key.scopes, [scope]); assert.equal(issued.key.agent?.id ?? null, agentId);
    assert.equal((await call(`${path}/${issued.key.id}/revoke`, admin, {}, 'POST')).statusCode, 200);
  }
  const keys = listed.json().keys, row = keys.find(k => k.id === read.key.id);
  assert.deepEqual(Object.keys(row).sort(), ['id','name','scopes','agent','createdBy','createdAt','expiresAt','lastUsedAt','revokedAt'].sort());
  assert.match(row.lastUsedAt, /:00(?:\.000)?(?:Z|\+00:00)$/);
  for (const s of sensitive) assert.ok(!listed.body.includes(s), 'list contains no credential material');
  const foreign = { 'cf-access-authenticated-user-email': env.TEST_OTHER_ADMIN_EMAIL, 'x-pulse-host': 'integration-other.example' };
  assert.ok(!listed.body.includes(env.TEST_FOREIGN_KEY));
  for (const [url, body, method] of [[path, undefined, 'GET'], [path, input, 'POST'],
    [`${path}/${read.key.id}/revoke`, {}, 'POST'], [`${path}/${env.TEST_FOREIGN_KEY}/revoke`, {}, 'POST']]) {
    const denied = await call(url, foreign, body, method); assert.equal(denied.statusCode, 403);
    assert.deepEqual(denied.json(), { error: 'Integration keys are not available for this company yet' });
  }
  for (const headers of [{}, { 'cf-access-authenticated-user-email': env.TEST_STAFF }, { 'x-pulse-agent-key': env.TEST_AGENT_KEY },
    { ...admin, 'x-pulse-agent-key': env.TEST_AGENT_KEY }, { ...admin, authorization: `Bearer ${read.token}` },
    { ...admin, authorization: 'Bearer ' + 'x'.repeat(43) }, { ...admin, authorization: `Bearer ${env.TEST_AGENT_KEY}` }]) {
    for (const [url, body, method] of [[path, undefined, 'GET'], [path, input, 'POST'], [`${path}/${read.key.id}/revoke`, {}, 'POST']])
      assert.ok([401,403].includes((await call(url, headers, body, method)).statusCode), 'staff-only boundary');
  }
  for (const body of [{ ...input, extra: true }, { ...input, name: ' ' }, { ...input, days: 0 }, { ...input, days: 366 },
    { ...input, days: '30' }, { ...input, days: 1.5 }, { ...input, scopes: [] }, { ...input, scopes: ['unknown'] },
    { ...input, scopes: ['catalog.read','catalog.read'] }, { ...input, scopes: ['tasks.read'] },
    { ...input, scopes: ['chats.post'], agentId: env.TEST_FOREIGN_AGENT }])
    assert.equal((await call(path, admin, body)).statusCode, 400, 'invalid issuance');
  await sql('update pulse.agent_member set disabled_at=now() where person_id=$1', [env.TEST_AGENT]);
  assert.equal((await call(path, admin, { ...input, scopes: ['chats.post'], agentId: env.TEST_AGENT })).statusCode, 400);
  await sql('update pulse.agent_member set disabled_at=null where person_id=$1', [env.TEST_AGENT]);
  assert.equal((await call(path + '?org_id=other')).statusCode, 400);
  // Browser CSRF is enforced by the common proxy; an arbitrary bearer cannot borrow its staff cookie.
  const proxy = createApiProxy({ ...v0ProxyOptions, hostLookup: async () => ({ own: true, signIn: 'access' }),
    fetchImpl: async () => { throw Error('Refused requests must not reach the API'); } });
  for (const [method, suffix] of [['POST', ''], ['POST', `/${read.key.id}/revoke`], ['GET', '']]) {
    const headers = { host: 'synthetic.example', ...admin, ...(method === 'GET' ? { authorization: 'Bearer ' + 'x'.repeat(43) } : { origin: 'https://other.example' }) };
    const r = await proxy(new Request('https://synthetic.example' + path + suffix, { method, headers }),
      { params: Promise.resolve({ path: ('integrations/keys' + suffix).split('/') }) });
    assert.equal(r.status, 403);
  }
  for (const k of [read, v1]) {
    await sql('update pulse_priv.service_key set expires_at=now() where id=$1', [k.key.id]);
    assert.equal((await service(k, k === v1 ? '/api/v1/tasks/integration-probe' : undefined)).statusCode, 401);
    await sql("update pulse_priv.service_key set expires_at=now()+interval '1 day' where id=$1", [k.key.id]);
    for (let n = 0; n < 2; n++) assert.equal((await call(`${path}/${k.key.id}/revoke`, admin, undefined, 'POST')).statusCode, 200);
    assert.equal((await service(k, k === v1 ? '/api/v1/tasks/integration-probe' : undefined)).statusCode, 401);
  }
  assert.equal((await call(`${path}/${randomUUID()}/revoke`, admin, {}, 'POST')).statusCode, 404);
  const audit = await sql("select action,actor_id,fields from pulse.audit_event where resource_id=$1 and action in ('service_key_issued','service_key_revoked') order by action", [read.key.id]);
  assert.deepEqual(audit.map(a => a.action), ['service_key_issued','service_key_revoked']);
  assert.ok(audit.every(a => a.actor_id === env.TEST_ADMIN && a.fields.join() === 'catalog.read'));
  for (const s of sensitive) assert.ok(!JSON.stringify([...logs, audit]).includes(s), 'logs and audit contain no credential material');
  await writeFile(env.TEST_LOG, JSON.stringify(logs) + '\n');
  console.log('integration keys: lifecycle, scope, expiry, tenant boundaries, CSRF and log scan passed');
} finally { await app.close(); await pool.end(); await owner.end(); }
