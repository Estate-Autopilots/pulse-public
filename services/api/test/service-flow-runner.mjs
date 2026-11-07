import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const ids = JSON.parse(process.env.TEST_IDS), pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool), logs = [], responses = [], secrets = [];
const capture = (...args) => logs.push(JSON.stringify(args));
for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) app.log[level] = capture;
app.addHook('onRequest', (request, _reply, done) => {
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) request.log[level] = capture;
  done();
});
const scopes = ['catalog.read', 'clients.read', 'leads.read', 'quotes.draft.create', 'notify.quote_ready'];
const operator = payload => call({ method: 'POST', url: '/api/v1/operator/service-keys',
  headers: { authorization: `Bearer ${process.env.PULSE_OPERATOR_TOKEN}` }, payload });
async function call(options, expected = 200) {
  const response = await app.inject(options);
  responses.push(response.body, JSON.stringify(response.headers));
  assert.equal(response.statusCode, expected, `${options.method ?? 'GET'} ${options.url}`);
  return response.json();
}
async function issue(grants) {
  const id = randomUUID(), secret = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(secret).digest('hex'), token = `psvc_${id}_${secret}`;
  secrets.push(secret, hash, token);
  await operator({ action: 'issue', id, hash, scopes: grants, label: 'Synthetic flow agent' });
  return { id, headers: { authorization: `Bearer ${token}` } };
}
try {
  const key = await issue(scopes);
  const read = url => call({ url, headers: key.headers });
  const catalogue = await read('/api/v1/catalog/items');
  assert.equal(catalogue.items.length, 1);
  const item = catalogue.items[0];
  assert.equal(item.id, ids.item); assert.equal(item.price, 10000);
  const clients = await read('/api/v1/service/clients'), leads = await read('/api/v1/service/leads');
  assert.deepEqual(clients.items.map(c => c.id), [ids.client]);
  assert.deepEqual(leads.items.map(l => l.id), [ids.lead]);
  for (const party of [...clients.items, ...leads.items]) assert.equal(party.salesperson.id, ids.salesperson);
  // Contract 1.1 exact lookup: the input phone never returns in the projection or audit log.
  assert.deepEqual(await read('/api/v1/service/clients?phone=9999999999'), clients);
  const payload = { clientId: clients.items[0].id, sourceRef: 'synthetic-flow-source', lines: [
    { itemId: item.id, qty: 1 }, { itemId: item.id, qty: 1, rate: item.price - 1000 },
  ] };
  const request = { method: 'POST', url: '/api/v1/service/quotes', payload,
    headers: { ...key.headers, 'idempotency-key': randomUUID() } };
  const quote = await call(request, 201);
  assert.equal(quote.status, 'draft'); assert.equal(quote.number, null);
  assert.equal(quote.ownerApprovalNeeded, true); assert.equal(quote.sourceRef, payload.sourceRef);
  assert.equal(quote.salesperson.id, ids.salesperson);
  assert.deepEqual(quote.lines.map(l => [l.rate, l.catalogueRate]), [[10000, 10000], [9000, 10000]]);
  assert.equal(quote.taxable, 19000); assert.equal(quote.tax, 3420); assert.equal(quote.total, 22400);
  assert.deepEqual(await call(request), quote, 'same request replays the draft');
  const notice = { method: 'POST', url: `/api/v1/service/quotes/${quote.id}/ready-notice`, headers: key.headers };
  const first = await call(notice);
  assert.equal(first.repeat, false); assert.equal((await call(notice)).repeat, true);
  const staff = role => ({ url: `/api/v0/quotes/${quote.id}`,
    headers: { 'cf-access-authenticated-user-email': `${role}@${ids.domain}` } });
  assert.equal((await call(staff('salesperson'))).ownerApprovalNeeded, true);
  await call(staff('other'), 404);
  await call({ url: '/api/v0/me', headers: key.headers }, 403);
  const reader = await issue(scopes.filter(s => s !== 'quotes.draft.create'));
  await call({ url: '/api/v1/service/clients', headers: reader.headers });
  await call({ ...request, headers: { ...reader.headers, 'idempotency-key': randomUUID() } }, 403);
  await operator({ action: 'revoke', id: key.id });
  for (const url of ['/api/v1/catalog/items', '/api/v1/service/clients', '/api/v1/service/leads']) {
    await call({ url, headers: key.headers }, 401);
  }
  await call({ ...request, headers: { ...key.headers, 'idempotency-key': randomUUID() } }, 401);
  await call(notice, 401);
  await operator({ action: 'revoke', id: reader.id });
  assert.ok(logs.some(line => line.includes(key.id) && line.includes('scope')), 'capture actual service audit calls');
  for (const text of [...responses, ...logs]) {
    for (const value of [...secrets, process.env.PULSE_OPERATOR_TOKEN, '9999999999']) {
      assert.ok(!text.includes(value), 'responses and logs exclude credentials and phone numbers');
    }
    assert.ok(!/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(text), 'responses and logs exclude email addresses');
  }
  console.log('FLOW ' + JSON.stringify({ quote: quote.id, keyId: key.id }));
} finally { await app.close(); await pool.end(); }
