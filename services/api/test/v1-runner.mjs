// EST-1611: the API v1 front door on real PostgreSQL and row security (driven by tests/core/test_api_v1_front_door.py).
// One fixture operation reads a chat as the principal; what each key reaches comes only from the database.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { attachV1Seam, defineV1Operation, v1Fail } from '../dist/v1.js';
import { v1BearerProxy } from '../../../apps/web/app/api/proxy.mjs';

const keys = JSON.parse(process.env.TEST_KEYS), { TEST_AGENT: agent, TEST_CHAT: chat, TEST_OUTSIDE: outside, TEST_ORG: org, TEST_ADMIN: admin } = process.env;
const UUID = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
defineV1Operation({ operationId: 'fixtureChatRead', method: 'GET', path: '/api/v1/chats/{chatId}', scope: 'chats.read', summary: 'Fixture: one chat',
  params: { type: 'object', additionalProperties: false, required: ['chatId'], properties: { chatId: UUID } },
  query: { type: 'object', additionalProperties: false, properties: { view: { type: 'string', enum: ['brief'] } } },
  response: { type: 'object', additionalProperties: false, required: ['id', 'kind', 'viewer', 'actor'], properties: { id: UUID, kind: { type: 'string' }, viewer: UUID, actor: { type: 'string' } } },
  handler: async ({ client, principal }, { params }) => {
    const row = (await client.query('select id from pulse.chat_channel where id=$1', [params.chatId])).rows[0] ?? v1Fail(404, 'No such chat');
    return { id: row.id, kind: principal.kind, viewer: (await client.query('select pulse.current_viewer() v')).rows[0].v, actor: principal.actor };
  } });
const seen = [], settled = [];
attachV1Seam({ before: async ({ principal }, op) => { seen.push(`${op.operationId}:${principal.kind}`); }, after: async (_ctx, _op, _input, answer) => answer,
  settled: call => settled.push(call) });

const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 2 });
const app = createApp(pool, pool), logs = [], responses = [];
for (const level of ['info', 'warn', 'error']) app.log[level] = (...args) => logs.push(JSON.stringify(args));
app.log.child = () => app.log;
app.addHook('onSend', async (_req, _reply, payload) => { responses.push(String(payload)); return payload; });
const asAdmin = async (sql, args) => { const c = await pool.connect();
  try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true), set_config('pulse.viewer_id',$2,true)", [org, admin]); await c.query(sql, args); await c.query('commit'); }
  finally { c.release(); } };
const call = (key, url, headers = {}) => app.inject({ url, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } });
const expect = async (key, url, status, headers) => {
  const r = await call(key, url, headers);
  assert.equal(r.statusCode, status, `${url} ${JSON.stringify(Object.keys(headers ?? {}))} ${r.body}`);
  assert.match(r.headers['cache-control'], /no-store/);
  if (status >= 400) {
    assert.match(r.headers['content-type'], /^application\/problem\+json/);
    const body = r.json();
    assert.deepEqual(Object.keys(body).sort(), ['detail', 'requestId', 'status', 'title', 'type']);
    assert.equal(body.status, status); assert.equal(body.requestId, r.headers['x-request-id']);
  }
  return r;
};
const at = id => `/api/v1/chats/${id}`;
try {
  // Scope ∩ the AI member's chats ∩ the install: an app key acts as its bound member, never a person; the outside chat is not there.
  for (const [key, kind, actor] of [[keys.app, 'app', `service:${keys.app.slice(5, 41)}`], [keys.ai, 'ai', 'agent:v1-front-door']]) {
    assert.deepEqual((await expect(key, at(chat), 200)).json(), { id: chat, kind, viewer: agent, actor });
    await expect(key, `${at(chat)}?view=brief`, 200);
    await expect(key, at(outside), 404);
    await expect(key, `${at(chat)}?org_id=${org}`, 400);
    await expect(key, '/api/v1/chats', 404);
  }
  // A live key without the area scope: 403. Existing keys gain nothing (chats.post is not chats.read; old pak_ keys hold none).
  for (const key of [keys.appTasks, keys.aiTasks, keys.legacy, keys.old]) await expect(key, at(chat), 403);
  // Unknown, revoked or wrong secret: 401, also before an unknown query is looked at.
  const wrong = `psvc_${keys.app.slice(5, 41)}_${'A'.repeat(43)}`, unknown = `psvc_00000000-0000-4000-8000-000000000000_${'A'.repeat(43)}`;
  for (const key of [keys.aiRevoked, wrong, unknown, undefined, 'x'.repeat(43)]) await expect(key, `${at(chat)}?org_id=x`, 401);
  // A sign-in beside the key is refused, not stripped; the old agent header is not a v1 credential.
  for (const headers of [{ cookie: 'pulse_session=staff' }, { 'x-pulse-session': 'a'.repeat(43) }, { 'cf-access-authenticated-user-email': 'synthetic@example.test' },
    { 'cf-access-jwt-assertion': 'synthetic' }, { 'x-pulse-agent-key': keys.ai }]) {
    await expect(keys.app, at(chat), 401, headers); await expect(keys.ai, at(chat), 401, headers);
  }
  await expect(undefined, at(chat), 401, { 'x-pulse-agent-key': keys.ai });
  // Another company's address: the AI key is unknown there; an app key is install-local.
  await expect(keys.ai, at(chat), 401, { 'x-pulse-host': process.env.TEST_OTHER_HOST });
  await expect(keys.app, at(chat), 403, { 'x-pulse-host': process.env.TEST_OTHER_HOST });
  // The member switched off: its AI key stops (401); the app key stays authentic but may not act as it (403).
  await asAdmin('select pulse.agent_switch($1,false)', [agent]);
  await expect(keys.ai, at(chat), 401); await expect(keys.app, at(chat), 403);
  await asAdmin('select pulse.agent_switch($1,true)', [agent]);
  await expect(keys.ai, at(chat), 200);
  // Legacy surfaces are unchanged: the old key still runs /api/v0/agent/*, and service paths keep their own answers.
  const me = await app.inject({ url: '/api/v0/agent/me', headers: { 'x-pulse-agent-key': keys.old } });
  assert.equal(me.statusCode, 200, me.body); assert.equal(me.json().id, agent);
  for (const key of [keys.app, keys.legacy]) {
    const r = await call(key, '/api/v1/service/clients');
    assert.equal(r.statusCode, 403); assert.deepEqual(r.json(), { error: 'Service key lacks required scope' });
  }
  // The deployed path: the web's bearer-only proxy forwards the key and the address and nothing else.
  const forwarded = [];
  const fetchImpl = async (url, init) => { const u = new URL(url); forwarded.push([...new Headers(init.headers).keys()].sort());
    const r = await app.inject({ method: init.method, url: u.pathname + u.search, headers: Object.fromEntries(new Headers(init.headers)) });
    return new Response(r.body, { status: r.statusCode, headers: { 'content-type': r.headers['content-type'], 'x-request-id': r.headers['x-request-id'] ?? '' } }); };
  const viaWeb = (key, path, headers = {}) => v1BearerProxy(new Request(`http://web.test/api/v1/${path.join('/')}`, { headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } }),
    { params: Promise.resolve({ path }) }, fetchImpl);
  const web = await viaWeb(keys.ai, ['chats', chat]);
  assert.equal(web.status, 200); assert.equal((await web.json()).kind, 'ai'); assert.match(web.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  for (const headers of [{ cookie: 'pulse_session=staff' }, { 'cf-access-authenticated-user-email': 'synthetic@example.test' }]) {
    const refused = await viaWeb(keys.ai, ['chats', chat], headers);
    assert.equal(refused.status, 401); assert.equal((await refused.json()).title, 'Unauthorized');
  }
  assert.equal((await viaWeb(undefined, ['chats', chat])).status, 401);
  assert.equal((await viaWeb(keys.ai, ['chats', '..', '..', 'v0', 'people'])).status, 404);
  assert.deepEqual(forwarded, [['authorization']]);
  const reference = await viaWeb(undefined, ['openapi.json']);
  assert.equal(reference.status, 200);
  const served = await reference.json();
  assert.deepEqual(served.paths['/api/v1/chats/{chatId}'].get.security, [{ bearer: ['chats.read'] }]);
  // EST-2290: the service paths arrive inlined with their own key scope, never as a reference to a document nobody serves.
  assert.deepEqual(served.paths['/api/v1/service/clients'].get.security, [{ serviceKey: ['clients.read'] }]);
  assert.doesNotMatch(JSON.stringify(served), /"\$ref":"(?!#\/components\/)/);
  // Seams: before ran as each principal that got through; settled saw every v1 call, refusals included, with ids only.
  assert.ok(seen.includes('fixtureChatRead:app') && seen.includes('fixtureChatRead:ai'));
  assert.ok(settled.some(s => s.status === 401 && s.principal === null) && settled.some(s => s.status === 200 && s.principal?.id === agent));
  // No key, secret or digest in any log, response or seam record.
  const evidence = JSON.stringify([logs, responses, settled]);
  for (const key of Object.values(keys)) {
    const secret = key.startsWith('psvc_') ? key.slice(-43) : key.slice(14);
    for (const part of [key, secret, createHash('sha256').update(secret).digest('hex')]) assert.ok(!evidence.includes(part), 'a key reached the evidence');
  }
  console.log(`v1 front door: ${settled.length} v1 calls checked, ${forwarded.length} through the web proxy`);
} finally { await app.close(); await pool.end(); }
