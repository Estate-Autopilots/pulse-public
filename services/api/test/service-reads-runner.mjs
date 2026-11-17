import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { revealContact } from '../dist/acquisition-model.js';
import { serviceProxy } from '../../../apps/web/app/lib/service-proxy.mjs';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const logs = [], capture = (...args) => logs.push(JSON.stringify(args));
for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) app.log[level] = capture;
app.addHook('onRequest', (request, _reply, done) => {
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) request.log[level] = capture;
  done();
});
const expected = JSON.parse(process.env.TEST_EXPECTED);
const secret = randomBytes(32).toString('base64url'), id = randomUUID();
const hash = createHash('sha256').update(secret).digest('hex');
const headers = { authorization: `Bearer psvc_${id}_${secret}` };
const read = (resource, query = '', h = headers) => app.inject({ url: `/api/v1/service/${resource}${query}`, headers: h });
const sort = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
try {
  // The fixture really contains a protected name, readable with the configured synthetic key.
  if (!process.env.TEST_PHONE_EDGE) assert.equal(revealContact(JSON.parse(process.env.TEST_PROTECTED_CONTACT)).name, process.env.TEST_PROTECTED_NAME);
  await pool.query("select pulse.service_key_manage('issue',$1,$2,$3,'Synthetic reader')", [id, hash, ['clients.read', 'leads.read']]);
  if (process.env.TEST_PHONE_EDGE) {
    const response = await read('leads', '?phone=+919999999999');
    assert.equal(response.statusCode, process.env.TEST_PHONE_EDGE === 'empty' ? 200 : 503, response.body);
    if (response.statusCode === 200) assert.deepEqual(response.json(), { items: [], nextCursor: null });
    console.log('PHONE_EDGE ' + JSON.stringify({ keyId: id, mode: process.env.TEST_PHONE_EDGE }));
  } else if (process.env.TEST_MODULE_OFF) {
    assert.equal((await read('leads')).statusCode, 404);
    assert.equal((await read('clients')).statusCode, 200);
  } else {
    for (const resource of ['clients', 'leads']) {
      const initial = await read(resource);
      assert.equal(initial.statusCode, 200, initial.body);
      assert.match(initial.headers['cache-control'], /no-store/);
      assert.equal(initial.headers['referrer-policy'], 'no-referrer');
      assert.deepEqual(initial.json(), { items: sort(expected[resource]), nextCursor: null });
      if (resource === 'leads') for (const lead of initial.json().items) assert.equal(lead.name, null, 'protected names stay null in v1');
      assert.deepEqual((await read(resource, '?limit=200')).json(), initial.json());
      for (const sensitive of ['phone', 'email', 'address', 'identity-secret', 'private@example.invalid', '+919999999999', process.env.TEST_PROTECTED_NAME, secret, hash]) {
        assert.ok(!initial.body.includes(sensitive), sensitive);
      }
      const items = [], cursors = new Set();
      let cursor = null;
      do {
        const response = await read(resource, '?limit=2' + (cursor ? `&cursor=${cursor}` : ''));
        assert.equal(response.statusCode, 200, response.body);
        const page = response.json();
        assert.deepEqual(Object.keys(page).sort(), ['items', 'nextCursor']);
        assert.ok(page.items.length <= 2);
        items.push(...page.items);
        cursor = page.nextCursor;
        if (cursor) {
          assert.match(cursor, /^[A-Za-z0-9_-]+$/);
          assert.ok(!cursors.has(cursor)); cursors.add(cursor);
        }
      } while (cursor);
      assert.deepEqual(items, sort(expected[resource]));
      assert.equal(new Set(items.map(i => i.id)).size, items.length);
      const beyond = Buffer.from('ffffffff-ffff-ffff-ffff-ffffffffffff').toString('base64url');
      assert.deepEqual((await read(resource, `?cursor=${beyond}`)).json(), { items: [], nextCursor: null });
      for (const query of ['?org_id=another', '?limit=0', '?limit=201', '?limit=-1', '?limit=1.5', '?limit=01', '?limit=', '?limit=1&limit=2', '?cursor=', '?cursor=bad', '?cursor=' + beyond + '=', '?cursor=' + Buffer.from('not-a-uuid').toString('base64url'), '?cursor=' + beyond + '&cursor=' + beyond]) {
        assert.equal((await read(resource, query)).statusCode, 400, query);
      }
      assert.equal((await read(resource, '', { cookie: 'pulse_session=staff-session' })).statusCode, 401);
      const scopedId = randomUUID();
      await pool.query("select pulse.service_key_manage('issue',$1,$2,$3,'Other scope')", [scopedId, hash, [resource === 'clients' ? 'leads.read' : 'clients.read']]);
      assert.equal((await read(resource, '', { authorization: `Bearer psvc_${scopedId}_${secret}` })).statusCode, 403);
      await pool.query("select pulse.service_key_manage('revoke',$1)", [scopedId]);
    }
  }
  if (!process.env.TEST_MODULE_OFF && !process.env.TEST_PHONE_EDGE) {
    // Contract 1.1 (EST-1294): ?phone= alone, exact, at most 5 rows, no contact data, 30 lookups a minute per key.
    const byPhone = await read('clients', '?phone=9999999999');
    assert.equal(byPhone.statusCode, 200, byPhone.body);
    assert.deepEqual(byPhone.json(), { items: sort(expected.clients.filter(c => c.name.startsWith('Synthetic client'))).slice(0, 5), nextCursor: null });
    assert.ok(!byPhone.body.includes('9999999999'), 'the number is not echoed');
    for (const resource of ['clients', 'leads']) {
      // Lead aliases exist only under v2, while v1 is still configured first.
      const matches = resource === 'clients' ? byPhone.json() : { items: sort(expected.leads), nextCursor: null };
      for (const phone of ['9999999999', '+919999999999', '%2B919999999999']) {
        const response = await read(resource, '?phone=' + phone);
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json(), matches);
        assert.ok(!response.body.includes('9999999999'));
      }
    }
    // Public GET binding -> real Fastify HTTP handlers, including aliases stored only under v2.
    const originalApiUrl = process.env.PULSE_API_URL, originalFetch = globalThis.fetch, forwarded = [];
    process.env.PULSE_API_URL = await app.listen({ host: '127.0.0.1', port: 0 });
    globalThis.fetch = (url, options) => { forwarded.push({ url, headers: options.headers }); return originalFetch(url, options); };
    const proxyRead = (resource, query) => serviceProxy(new Request(`https://synthetic.example/api/v1/service/${resource}${query}`, {
      headers: { ...headers, host: 'synthetic.example', cookie: 'pulse_session=staff', 'x-pulse-session': 'staff-session',
        'cf-access-authenticated-user-email': 'synthetic-admin@example.test', 'x-pulse-host': 'forged-other.example' },
    }), { params: Promise.resolve({ path: [resource] }) });
    try {
      for (const resource of ['clients', 'leads']) {
        const matches = resource === 'clients' ? byPhone.json() : { items: sort(expected.leads), nextCursor: null };
        for (const phone of ['9999999999', '+919999999999', '%2B919999999999']) {
          const response = await proxyRead(resource, '?phone=' + phone);
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), matches);
          assert.equal(new URL(forwarded.at(-1).url).search, '?phone=' + phone, 'raw phone form survives the proxy');
          assert.deepEqual([...forwarded.at(-1).headers.keys()].sort(), ['authorization', 'x-pulse-host']);
          assert.equal(forwarded.at(-1).headers.get('x-pulse-host'), 'synthetic.example');
        }
        const before = forwarded.length;
        for (const query of ['?phone=9999999999&cursor=x', '?phone=9999999999&limit=2', '?phone=1&phone=2', '?phone=9999999999&org=other']) {
          const response = await proxyRead(resource, query);
          assert.equal(response.status, 400);
          assert.ok(!(await response.text()).includes('9999999999'));
        }
        assert.equal(forwarded.length, before, 'invalid phone queries never reach upstream');
      }
      console.log('Service phone proxy -> API: both resources, three phone forms, mixed-query refusal and identity stripping passed');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiUrl === undefined) delete process.env.PULSE_API_URL; else process.env.PULSE_API_URL = originalApiUrl;
    }
    assert.deepEqual((await read('clients', '?phone=%2B919000000000')).json(), { items: [], nextCursor: null });
    assert.deepEqual((await read('leads', '?phone=9000000000')).json(), { items: [], nextCursor: null });
    for (const q of ['?phone=123', '?phone=abc', '?phone=%ZZ', '?phone=9999999999&limit=2', '?phone=9999999999&cursor=x', '?phone=1&phone=2']) assert.equal((await read('clients', q)).statusCode, 400, q);
    const budgetId = randomUUID(), budgetHeaders = { authorization: `Bearer psvc_${budgetId}_${secret}` };
    await pool.query("select pulse.service_key_manage('issue',$1,$2,$3,'Phone budget')", [budgetId, hash, ['clients.read']]);
    for (let i = 0; i < 30; i++) assert.equal((await read('clients', '?phone=9000000000', budgetHeaders)).statusCode, 200);
    const limited = await read('clients', '?phone=9000000000', budgetHeaders);
    assert.equal(limited.statusCode, 429, 'exactly the 31st lookup is refused');
    assert.equal(limited.headers['retry-after'], '60');
    assert.equal((await read('clients', '?phone=9000000000')).statusCode, 200, 'another key retains its phone budget');
    assert.ok(logs.some(line => line.includes('rate_limited')));
  }
  assert.ok(logs.some(line => line.includes(id)), 'capture the real request logger');
  for (const sensitive of ['9999999999', '9000000000', secret, hash, process.env.TEST_PROTECTED_NAME]) assert.ok(!JSON.stringify(logs).includes(sensitive), 'service logs exclude contact data and credentials');
  console.log('Service reads: exact payloads, tenant boundary, pagination, scopes and module gate passed');
} finally { await app.close(); await pool.end(); }
