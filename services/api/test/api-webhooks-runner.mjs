// API-PLATFORM-2: webhooks and events on real PostgreSQL and tenant row security (migration 1594). An admin registers a
// webhook, a task made through the API becomes a signed delivery to a local receiver (an in-process HTTP server on
// 127.0.0.1, reached through the delivery loop's injected sender: nothing leaves the machine and DNS is faked), a failure
// is logged and redelivered, a test ping is delivered, and listEvents, the SSE stream and MCP give the same events to
// keys holding the areas. Members and AI members are refused; private addresses are refused. Synthetic data only.
// Run by tests/core/test_api_webhooks.py.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Pool } from 'pg';
process.env.PULSE_V1_STREAM_MS = '1500';
process.env.PULSE_V1_STREAM_POLL_MS = '300';
const { createApp } = await import('../dist/app.js');
const { setWebhookResolver } = await import('../dist/v1-events.js');
const { deliverWebhooks } = await import('../dist/webhook-delivery.js');

const W = JSON.parse(process.env.TEST_W);
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 4 }), app = createApp(pool, pool);
setWebhookResolver(async host => { if (host === 'hooks.synthetic.example') return [{ address: '93.184.215.34' }]; if (host === 'inside.synthetic.example') return [{ address: '10.0.0.9' }]; throw Error('ENOTFOUND'); });
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
const json = r => { try { return r.json(); } catch { return r.body; } };
const asPerson = (email, method, url, payload) => app.inject({ method, url, headers: { 'cf-access-authenticated-user-email': email }, ...(payload ? { payload } : {}) });
async function api(token, method, url, payload, { status, headers = {} } = {}) {
  const h = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
  if (method !== 'GET') h['idempotency-key'] = randomUUID();
  const r = await app.inject({ method, url, headers: h, ...(payload !== undefined ? { payload } : {}) });
  if (status !== undefined) { assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`); checks++; }
  return { status: r.statusCode, body: json(r), raw: r };
}
const get = (t, url, o) => api(t, 'GET', url, undefined, o);
const post = (t, url, body, o) => api(t, 'POST', url, body, o);
async function rpc(token, method, params = {}) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/mcp', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    payload: { jsonrpc: '2.0', id: 1, method, params } });
  assert.equal(r.statusCode, 200, r.body);
  const v = r.body.split('\n').filter(s => s.startsWith('data:')).map(s => JSON.parse(s.slice(5))).find(x => x.id === 1);
  return v.result ?? v;
}
async function makeToken(email, body) {
  const r = await asPerson(email, 'POST', '/api/v0/api-tokens', body);
  assert.equal(r.statusCode, 201, r.body); checks++;
  return r.json().token;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The local receiver: answers from a script of statuses and keeps what it got.
const got = [], answers = [];
const receiver = createServer((req, res) => { let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
  got.push({ path: req.url, headers: req.headers, body }); res.statusCode = answers.shift() ?? 200; res.end('ok'); }); });
await new Promise(r => receiver.listen(0, '127.0.0.1', r));
const port = receiver.address().port;
// The delivery loop's sender, pointed at the receiver instead of the internet (safe-outbound.ts is unit-tested on its own).
const send = async (url, body, headers) => {
  assert.ok(url.startsWith('https://hooks.synthetic.example/'), 'only the registered address is called');
  const r = await fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, { method: 'POST', body, headers: { ...headers, 'content-type': 'application/json' } });
  return { status: r.status };
};
const deliver = () => deliverWebhooks(pool, send, undefined, [W.org]);

try {
  const AREAS = ['events.read', 'events.write', 'tasks.read', 'tasks.write', 'projects.read', 'chats.read'];
  const admin = await makeToken(W.adminEmail, { name: 'Webhooks admin (synthetic)', scopes: AREAS, days: 7 });
  const member = await makeToken(W.memberEmail, { name: 'Member events', scopes: ['events.read', 'events.write', 'tasks.read', 'tasks.write'], days: 7 });
  const eventsOnly = await makeToken(W.memberEmail, { name: 'Events only', scopes: ['events.read'], days: 7 });
  const tasksOnly = await makeToken(W.adminEmail, { name: 'Tasks only', scopes: ['tasks.read'], days: 7 });
  const bot = await makeToken(W.adminEmail, { kind: 'bot', name: 'Events bot (synthetic)', scopes: ['events.read', 'events.write', 'tasks.read'], days: 7, agentId: W.agent });

  // ------------------------------------------------------------------ who may manage webhooks
  const empty = (await get(admin, '/api/v1/events/webhooks', { status: 200 })).body;
  ok(empty.items.length === 0 && empty.eventTypes.includes('task.created') && empty.limit === 100 && empty.tier === 'enterprise', 'admins list webhooks with the plan\'s limit');
  await get(member, '/api/v1/events/webhooks', { status: 403 });
  await post(member, '/api/v1/events/webhooks', { url: 'https://hooks.synthetic.example/m', events: ['task.created'] }, { status: 403 });
  await post(bot, '/api/v1/events/webhooks', { url: 'https://hooks.synthetic.example/b', events: ['task.created'] }, { status: 403 });
  await get(tasksOnly, '/api/v1/events/webhooks', { status: 403 });
  await get(null, '/api/v1/events/webhooks', { status: 401 });
  // ------------------------------------------------------------------ SSRF: private, loopback, metadata, plain http, odd ports
  for (const url of ['https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://localhost/x',
    'https://inside.synthetic.example/x', 'http://hooks.synthetic.example/x', 'https://hooks.synthetic.example:8443/x']) {
    await post(admin, '/api/v1/events/webhooks', { url, events: ['task.created'] }, { status: 400 });
  }
  await post(admin, '/api/v1/events/webhooks', { url: 'https://hooks.synthetic.example/x', events: ['task.exploded'] }, { status: 400 });

  // ------------------------------------------------------------------ register, and the secret is shown once
  const made = (await post(admin, '/api/v1/events/webhooks', { url: 'https://hooks.synthetic.example/pulse', events: ['task.created', 'task.completed', 'chat.message.posted'],
    description: 'Synthetic receiver' }, { status: 200 })).body;
  const secret = made.secret, hook = made.webhook;
  ok(/^whsec_/.test(secret) && hook.active && hook.secretHint === `…${secret.slice(-4)}`, 'made, with the secret once and a hint after');
  const listed = (await get(admin, '/api/v1/events/webhooks', { status: 200 })).body;
  ok(listed.items.length === 1 && !JSON.stringify(listed).includes(secret), 'the list never shows the secret');

  // ------------------------------------------------------------------ an event becomes a signed delivery
  const task = (await post(member, '/api/v1/tasks', { title: 'Synthetic webhook task' }, { status: 200 })).body;
  const taskId = task.task?.id ?? task.id;
  ok(typeof taskId === 'string', 'a task made through the API');
  answers.push(500);
  eq(await deliver(), { sent: 0, failed: 1 }, 'the first attempt meets a 500');
  const first = got.at(-1), sig = String(first.headers['x-pulse-signature']), t = sig.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
  ok(t && createHmac('sha256', secret).update(`${t[1]}.${first.body}`).digest('hex') === t[2], 'signed: HMAC-SHA256 of "<t>.<body>" with the secret');
  const ev = JSON.parse(first.body);
  ok(ev.type === 'task.created' && ev.data.taskId === taskId && first.headers['x-pulse-event-type'] === 'task.created' && first.path === '/pulse', 'the task.created event, ids only');
  ok(!first.body.includes('Synthetic webhook task'), 'the payload carries no title or body');
  const log1 = (await get(admin, `/api/v1/events/webhooks/${hook.id}/deliveries`, { status: 200 })).body.items;
  ok(log1.length === 1 && log1[0].status === 'pending' && log1[0].attempts === 1 && log1[0].lastStatus === 500 && log1[0].lastError === 'http' && log1[0].nextAt, 'logged, retried later');
  eq(await deliver(), { sent: 0, failed: 0 }, 'not due again yet (backoff)');
  const again = (await post(admin, `/api/v1/events/webhooks/${hook.id}/deliveries/${log1[0].id}/redeliver`, {}, { status: 200 })).body.delivery;
  ok(again.redeliveryOf === log1[0].id && again.status === 'pending', 'redelivery is a new delivery');
  eq(await deliver(), { sent: 1, failed: 0 }, 'the redelivery succeeds');
  ok(got.at(-1).body === first.body, 'the same bytes are sent again');
  const delivered = (await get(admin, `/api/v1/events/webhooks/${hook.id}/deliveries?status=delivered`, { status: 200 })).body.items;
  ok(delivered.length === 1 && delivered[0].lastStatus === 200 && delivered[0].deliveredAt, 'the log shows it delivered');
  const pg = (await get(admin, `/api/v1/events/webhooks/${hook.id}/deliveries?limit=1`, { status: 200 })).body;
  ok(pg.items.length === 1 && pg.nextCursor, 'the log pages');
  await get(member, `/api/v1/events/webhooks/${hook.id}/deliveries`, { status: 403 });
  await post(admin, `/api/v1/events/webhooks/${hook.id}/deliveries/${randomUUID()}/redeliver`, {}, { status: 404 });

  // A test ping, and a paused webhook gets nothing.
  await post(admin, `/api/v1/events/webhooks/${hook.id}/test`, {}, { status: 200 });
  eq(await deliver(), { sent: 1, failed: 0 }, 'the test ping is delivered');
  ok(JSON.parse(got.at(-1).body).type === 'webhook.ping', 'webhook.ping');
  const paused = (await api(admin, 'PATCH', `/api/v1/events/webhooks/${hook.id}`, { active: false }, { status: 200 })).body.webhook;
  ok(paused.active === false && paused.disabledReason === 'admin', 'paused');
  await post(member, '/api/v1/tasks', { title: 'Synthetic while paused' }, { status: 200 });
  eq(await deliver(), { sent: 0, failed: 0 }, 'a paused webhook receives nothing');
  await api(admin, 'PATCH', `/api/v1/events/webhooks/${hook.id}`, { active: true, events: ['task.created', 'task.completed'] }, { status: 200 });
  await api(admin, 'PATCH', `/api/v1/events/webhooks/${hook.id}`, { url: 'https://169.254.169.254/x' }, { status: 400 });
  await api(admin, 'PATCH', `/api/v1/events/webhooks/${hook.id}`, {}, { status: 400 });
  const done = await post(member, `/api/v1/tasks/${taskId}/complete`, {}, { status: 200 });
  ok(done.body.id === taskId, 'completed');
  eq(await deliver(), { sent: 1, failed: 0 }, 'task.completed delivered');
  ok(JSON.parse(got.at(-1).body).type === 'task.completed', 'task.completed');

  // ------------------------------------------------------------------ listEvents, the stream and MCP, by the key's areas
  await sleep(6000);   // events are read 5 seconds after they are recorded, so a page never overtakes a commit
  const evs = (await get(admin, '/api/v1/events?types=task.created,task.completed', { status: 200 })).body;
  ok(evs.items.some(e => e.type === 'task.created' && e.data.taskId === taskId) && evs.items.some(e => e.type === 'task.completed') && evs.nextCursor, 'listEvents: the task events');
  ok((await get(eventsOnly, '/api/v1/events', { status: 200 })).body.items.length === 0, 'a key without tasks.read receives no task events');
  await get(tasksOnly, '/api/v1/events', { status: 403 });   // events.read opens the feed
  await get(admin, '/api/v1/events?types=task.exploded', { status: 400 });
  const after = (await get(admin, `/api/v1/events?cursor=${evs.nextCursor}`, { status: 200 })).body;
  ok(after.items.every(e => e.id > evs.nextCursor), 'resumes after the cursor');
  const stream = await app.inject({ method: 'GET', url: '/api/v1/events/stream?types=task.created', headers: { authorization: `Bearer ${admin}` } });
  ok(stream.statusCode === 200 && /text\/event-stream/.test(stream.headers['content-type']) && stream.body.includes('event: task.created') && stream.body.includes(`"taskId":"${taskId}"`), 'the stream sends the same events');
  const resumed = await app.inject({ method: 'GET', url: '/api/v1/events/stream?types=task.created', headers: { authorization: `Bearer ${admin}`, 'last-event-id': evs.nextCursor } });
  ok(resumed.statusCode === 200 && !resumed.body.includes(`"taskId":"${taskId}"`), 'Last-Event-ID resumes after it');
  ok((await app.inject({ method: 'GET', url: '/api/v1/events/stream' })).statusCode === 401, 'no key, no stream');
  ok((await app.inject({ method: 'GET', url: '/api/v1/events/stream', headers: { authorization: `Bearer ${tasksOnly}` } })).statusCode === 403, 'the stream needs events.read');
  const tools = (await rpc(admin, 'tools/list')).tools.map(x => x.name);
  ok(['list_events', 'list_webhooks', 'create_webhook', 'update_webhook', 'delete_webhook', 'list_webhook_deliveries', 'redeliver_webhook_delivery', 'send_webhook_test'].every(n => tools.includes(n)), 'the MCP tools');
  const viaMcp = await rpc(admin, 'tools/call', { name: 'list_events', arguments: { types: 'task.created' } });
  ok(!viaMcp.isError && viaMcp.structuredContent.items.some(e => e.data.taskId === taskId), 'list_events over MCP');
  const del = await rpc(admin, 'tools/call', { name: 'delete_webhook', arguments: { webhookId: hook.id } });
  ok(del.isError && del.structuredContent.status === 409, 'delete asks for confirm');

  // ------------------------------------------------------------------ remove
  await api(admin, 'DELETE', `/api/v1/events/webhooks/${hook.id}?confirm=true`, undefined, { status: 200 });
  ok((await get(admin, '/api/v1/events/webhooks', { status: 200 })).body.items.length === 0, 'removed');
  await api(admin, 'DELETE', `/api/v1/events/webhooks/${hook.id}?confirm=true`, undefined, { status: 404 });

  // Settings → API → Webhooks (the screen's routes): admins only, the secret shown once.
  const screen = await asPerson(W.adminEmail, 'POST', '/api/v0/webhooks', { url: 'https://hooks.synthetic.example/screen', events: ['leave.requested'] });
  ok(screen.statusCode === 201 && /^whsec_/.test(screen.json().secret) && screen.json().webhooks.length === 1, 'Settings registers one');
  ok((await asPerson(W.memberEmail, 'GET', '/api/v0/webhooks')).statusCode === 403, 'a member does not see Settings → Webhooks');
  ok((await asPerson(W.adminEmail, 'POST', '/api/v0/webhooks', { url: 'https://10.1.1.1/x', events: ['leave.requested'] })).statusCode === 400, 'the screen refuses private addresses too');

  // The doc names the new operations and the stream.
  const doc = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
  ok(doc.paths['/api/v1/events/webhooks']?.post?.security?.[0]?.bearer?.[0] === 'events.write' && doc.paths['/api/v1/events/stream']?.get, 'openapi');

  console.log(JSON.stringify({ ok: true, checks, webhookId: hook.id, taskId }));
} finally {
  receiver.close();
  await app.close();
  await pool.end();
}
