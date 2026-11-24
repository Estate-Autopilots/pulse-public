// WL-DAY (22 Nov 2026): GET /api/v0/erp/documents/:id/latest?chat=… as a Billing person (not a superuser): a link whose
// quotation is gone leads to the chat's newest one (it answered 403 for everyone: the API role could not read
// erp_quote_chat); a chat the person is not in leads nowhere; plain words, never 403. Run by
// tests/core/test_chat_quote_link.py. Synthetic data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Pool } from 'pg';
const { createApp } = await import('../dist/app.js');

const W = JSON.parse(process.env.TEST_W);
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 4 }), app = createApp(pool, pool);
const asFinance = { 'cf-access-authenticated-user-email': `finance@${W.domain}` };
const v0 = async (method, path, body, status = 200) => {
  const r = await app.inject({ method, url: `/api/v0/${path}`, headers: asFinance, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, status, `${method} ${path}: ${r.statusCode} ${r.body.slice(0, 400)}`);
  return r.json();
};
try {
  const t = await app.inject({ method: 'POST', url: '/api/v0/api-tokens', headers: asFinance, payload: { name: 'CHAT-QUOTE-LINK (synthetic)', scopes: ['billing.read', 'billing.write'], days: 1 } });
  assert.equal(t.statusCode, 201, t.body);
  const q = await app.inject({ method: 'POST', url: '/api/v1/billing/quotations', headers: { authorization: `Bearer ${t.json().token}`, 'idempotency-key': randomUUID() },
    payload: { buyer: { name: 'ZZ Synthetic Chat Buyer' }, lines: [{ description: 'Synthetic panel', rate: 950000, gstRate: 18 }] } });
  assert.equal(q.statusCode, 200, q.body);
  const kept = q.json().quotation.id;
  console.log(`KEEP ${kept}`);
  const rl = createInterface({ input: process.stdin });
  await new Promise((done) => rl.once('line', done)); rl.close();
  const gone = randomUUID();   // the link's own quotation: gone (replaced, discarded or never theirs)
  const r = await v0('GET', `erp/documents/${gone}/latest?chat=${W.chat}`);
  assert.deepEqual([r.state, r.id, r.docType], ['replaced', kept, 'quotation'], 'the chat\'s newest quotation');
  const none = await v0('GET', `erp/documents/${gone}/latest?chat=${W.other}`);
  assert.deepEqual([none.state, none.id], ['unavailable', null], 'a chat the person is not in leads nowhere');
  const here = await v0('GET', `erp/documents/${kept}/latest?chat=${W.chat}`);
  assert.deepEqual([here.state, here.id], ['here', kept]);
  console.log('CHAT-QUOTE-LINK runner: all checks passed');
} finally {
  await app.close(); await pool.end();
}
