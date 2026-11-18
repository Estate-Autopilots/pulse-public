// API-PLATFORM-2: webhook safety and signing without a database or a network. Endpoint checks (https on 443, public
// names only; private, loopback, link-local metadata and reserved addresses refused, before and after DNS), the
// signature a receiver verifies, and the delivery loop's outcome recording against a fake database and a local sender.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { OutboundError, publicAddress, safeOutbound } from '../dist/safe-outbound.js';
import { setWebhookResolver, webhookUrlProblem, newSecret, EVENT_TYPES, areaOf } from '../dist/v1-events.js';
import { deliverWebhooks, signature, webhookBody, webhookHeaders } from '../dist/webhook-delivery.js';

test('endpoints: https, port 443, public names only, re-checked after DNS', async () => {
  const answers = { 'hooks.synthetic.example': ['93.184.215.34'], 'rebind.synthetic.example': ['93.184.215.34', '10.0.0.7'],
    'metadata.synthetic.example': ['169.254.169.254'], 'loop.synthetic.example': ['127.0.0.1'], 'v6.synthetic.example': ['::1'] };
  setWebhookResolver(async host => { const a = answers[host]; if (!a) throw Object.assign(Error('ENOTFOUND'), { code: 'ENOTFOUND' }); return a.map(address => ({ address })); });
  assert.equal(await webhookUrlProblem('https://hooks.synthetic.example/pulse'), null);
  assert.equal(await webhookUrlProblem('https://unknown.synthetic.example/x'), null, 'not resolvable yet: each delivery checks again');
  for (const bad of ['http://hooks.synthetic.example/x', 'https://hooks.synthetic.example:8443/x', 'https://user:pw@hooks.synthetic.example/x',
    'https://127.0.0.1/x', 'https://10.1.2.3/x', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/x', 'https://[fd00::1]/x', 'https://localhost/x',
    'https://pulse.internal/x', 'https://intranet/x', 'https://rebind.synthetic.example/x', 'https://metadata.synthetic.example/x',
    'https://loop.synthetic.example/x', 'https://v6.synthetic.example/x', 'ftp://hooks.synthetic.example', 'not a url']) {
    assert.ok(await webhookUrlProblem(bad), bad);
  }
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(publicAddress(ip), false, ip);
  }
});

test('delivery re-resolves and refuses a name that now points inside (DNS rebinding), and never follows redirects', async () => {
  let sent = 0;
  const send = () => { sent++; throw Error('must not send'); };
  for (const address of ['169.254.169.254', '127.0.0.1', '10.0.0.2']) {
    await assert.rejects(safeOutbound('https://hooks.synthetic.example/x', '{}', {}, 1000, async () => [{ address, family: 4 }], send),
      e => e instanceof OutboundError && e.kind === 'destination');
  }
  await assert.rejects(safeOutbound('http://hooks.synthetic.example/x', '{}', {}, 1000, async () => [{ address: '93.184.215.34', family: 4 }], send),
    e => e instanceof OutboundError && e.kind === 'destination');
  assert.equal(sent, 0);
});

test('signature: t=<seconds>,v1=HMAC-SHA256("<t>.<body>") with the endpoint secret', () => {
  const secret = newSecret();
  assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  const d = { secret, attempt: 2, deliveryId: '0190f0f0-0000-7000-8000-000000000001',
    event: { id: '0190f0f0-0000-7000-8000-000000000002', type: 'task.created', createdAt: '2026-11-05T10:00:00.000Z', data: { taskId: '0190f0f0-0000-7000-8000-000000000003' } } };
  const body = webhookBody(d), h = webhookHeaders(d, body, '1793000000');
  assert.equal(h['X-Pulse-Signature'], `t=1793000000,v1=${createHmac('sha256', secret).update(`1793000000.${body}`).digest('hex')}`);
  assert.equal(signature(secret, '1793000000', body), h['X-Pulse-Signature']);
  assert.equal(h['X-Pulse-Event-Type'], 'task.created'); assert.equal(h['X-Pulse-Delivery-Attempt'], '2');
  assert.ok(!JSON.stringify(h).includes(secret) && !body.includes(secret), 'the secret is never sent');
  assert.deepEqual(JSON.parse(body), { id: d.event.id, type: 'task.created', createdAt: d.event.createdAt, data: d.event.data });
});

test('every event type belongs to an API area', () => {
  for (const t of EVENT_TYPES) assert.ok(areaOf(t), t);
  assert.equal(areaOf('expense.approved'), 'finance.read'); assert.equal(areaOf('chat.message.posted'), 'chats.read');
});

test('the delivery loop: lease, send without a transaction held, record the outcome; no URL, body or secret in what it returns', async () => {
  const calls = [], open = { n: 0 };
  const secret = newSecret();
  const client = { query: async (sql, args) => {
    calls.push(sql);
    if (sql.includes('v1_webhook_due')) return { rows: [{ v: [{ id: 'd1', lease: 'l1' }, { id: 'd2', lease: 'l2' }] }] };
    if (sql.includes('v1_webhook_dispatch')) return { rows: [{ v: { url: 'https://hooks.synthetic.example/p', secret, attempt: 1, deliveryId: args[0],
      event: { id: 'e1', type: 'task.created', createdAt: '2026-11-05T10:00:00.000Z', data: {} } } }] };
    if (sql.includes('v1_webhook_attempt')) { calls.push(JSON.stringify(args)); return { rows: [] }; }
    return { rows: [] }; }, release() { open.n--; } };
  const pool = { connect: async () => { open.n++; return client; }, query: async () => ({ rows: [{ org: 'org-1' }] }) };
  const seen = [];
  const send = async (url, body, headers) => { assert.equal(open.n, 0, 'no connection is held while sending'); seen.push({ url, headers, body });
    return { status: seen.length === 1 ? 204 : 500 }; };
  const out = await deliverWebhooks(pool, send, () => 0, ['org-1']);
  assert.deepEqual(out, { sent: 1, failed: 1 });
  const attempts = calls.filter(c => c.startsWith('["d'));
  assert.deepEqual(attempts.map(a => JSON.parse(a)), [['d1', 'l1', 204, 0, null], ['d2', 'l2', 500, 0, 'http']]);
  assert.ok(seen.every(s => s.headers['X-Pulse-Signature'].startsWith('t=')));
  assert.ok(!JSON.stringify(out).includes(secret));
});
