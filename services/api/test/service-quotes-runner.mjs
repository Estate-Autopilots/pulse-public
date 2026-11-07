import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { cleanDraft, figures } from '../dist/erp-model.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool), ids = JSON.parse(process.env.TEST_IDS);
const operator = { authorization: `Bearer ${process.env.PULSE_OPERATOR_TOKEN}` }, logs = [];
for (const level of ['info','warn','error']) app.log[level] = (...args) => logs.push(JSON.stringify(args));
const secret = randomBytes(32).toString('base64url'), keyId = randomUUID(), hash = createHash('sha256').update(secret).digest('hex');
const headers = { authorization: `Bearer psvc_${keyId}_${secret}` };
const payload = { clientId: ids.client, lines: [{ itemId: ids.item, qty: 1 }] };
const post = (body = payload, requestKey = randomUUID(), extra = {}) => app.inject({ method: 'POST', url: '/api/v1/service/quotes', payload: body, headers: { ...headers, 'idempotency-key': requestKey }, ...extra });
const staff = (url, body, role = 'finance') => app.inject({ method: body === undefined ? 'GET' : 'POST', url: '/api/v0/erp/' + url,
  headers: { 'cf-access-authenticated-user-email': `${role}@${ids.domain}` }, ...(body === undefined ? {} : { payload: body }) });
try {
  let response = await app.inject({ method: 'POST', url: '/api/v1/operator/service-keys', headers: operator, payload: { action: 'issue', id: keyId, hash, scopes: ['quotes.draft.create'], label: 'Synthetic quote agent' } });
  assert.equal(response.statusCode, 200, response.body);
  const requestKey = randomUUID(); response = await post(payload, requestKey);
  assert.equal(response.statusCode, 201, response.body); const quote = response.json();
  assert.deepEqual(Object.keys(quote).sort(), ['id','status','number','clientId','leadId','salesperson','ownerApprovalNeeded','currency','validUntil','lines','taxable','tax','total','link','sourceRef'].sort());
  assert.equal(quote.sourceRef, null);
  assert.equal(quote.ownerApprovalNeeded, false); assert.equal(quote.status, 'draft'); assert.equal(quote.number, null);
  assert.equal(quote.salesperson.id, ids.salesperson); assert.equal(quote.link, `/quotes/${quote.id}`);
  assert.deepEqual(Object.keys(quote.lines[0]).sort(), ['itemId','name','qty','rate','catalogueRate','gstRate','taxable','tax','total'].sort());
  const expected = figures('27', cleanDraft({ issueDate: new Date().toISOString().slice(0,10), buyer: { name: 'Synthetic' }, lines: [{ description: 'Synthetic item', rate: 10000, qty: 1, gstRate: 18 }] }));
  assert.equal(quote.total, expected.total); assert.equal(quote.tax, expected.cgst + expected.sgst + expected.igst);
  response = await post({ lines: payload.lines, clientId: ids.client }, requestKey); assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), quote);
  assert.equal((await post({ ...payload, notes: 'changed' }, requestKey)).statusCode, 409);
  const sourceRef = 'synthetic-source-reference', sourceKey = randomUUID(), sourceBody = { ...payload, sourceRef };
  response = await post(sourceBody, sourceKey); assert.equal(response.statusCode, 201, response.body);
  const source = response.json(); assert.equal(source.sourceRef, sourceRef);
  response = await post({ sourceRef, lines: payload.lines, clientId: ids.client }, sourceKey);
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), source);
  assert.equal((await post({ ...sourceBody, sourceRef: 'another-source' }, sourceKey)).statusCode, 409);
  assert.equal((await post(payload, sourceKey)).statusCode, 409);
  response = await staff(`documents/${source.id}`); assert.equal(response.statusCode, 200, response.body);
  assert.ok(response.json().events.some(e => e.kind === 'created' && e.detail.sourceRef === sourceRef));
  for (const sourceRef of ['x', '🙂'.repeat(100)]) {
    response = await post({ ...payload, sourceRef }); assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().sourceRef, sourceRef);
  }
  const concurrentKey = randomUUID(), concurrent = await Promise.all([post(payload, concurrentKey), post(payload, concurrentKey)]);
  assert.deepEqual(concurrent.map(r => r.statusCode).sort(), [200,201]); assert.equal(concurrent[0].json().id, concurrent[1].json().id);
  response = await post({ ...payload, lines: [{ itemId: ids.item, qty: 1, rate: 9000 }] });
  assert.equal(response.statusCode, 201, response.body); const changed = response.json(); assert.equal(changed.ownerApprovalNeeded, true);
  response = await post({ leadId: ids.lead, lines: payload.lines }); assert.equal(response.statusCode, 201, response.body); const lead = response.json();
  assert.equal(lead.clientId, null); assert.equal(lead.leadId, ids.lead);
  response = await staff(`documents/${changed.id}`); assert.equal(response.statusCode, 200, response.body);
  const draft = response.json(); assert.equal(draft.document.ownerApproval, 'needed'); assert.equal(draft.document.fromServiceKey, true);
  response = await staff(`documents/${changed.id}`, { ...draft.document, lines: draft.lines.map(l => ({ ...l, rate: 10000 })) });
  assert.equal(response.statusCode, 200, response.body);
  response = await staff(`documents/${changed.id}`); assert.equal(response.json().document.ownerApproval, null);
  response = await staff(`documents/${changed.id}`, { ...draft.document, lines: draft.lines }); assert.equal(response.statusCode, 200, response.body);
  response = await staff(`documents/${changed.id}/issue`, {}); assert.equal(response.statusCode, 403, response.body); assert.match(response.json().error, /Owner approval needed/);
  for (const itemId of [ids.inactive, ids.foreign, randomUUID()]) assert.equal((await post({ ...payload, lines: [{ itemId, qty: 1 }] })).statusCode, 404);
  for (const body of [null, {}, { ...payload, orgId: ids.org }, { ...payload, leadId: ids.lead }, { lines: payload.lines }, { ...payload, clientId: null },
    { ...payload, lines: [] }, { ...payload, lines: Array(51).fill(payload.lines[0]) }, { ...payload, validUntil: '2026-02-30' },
    ...['', 'x'.repeat(101), null, 42].map(sourceRef => ({ ...payload, sourceRef })),
    ...[{ qty: '1' }, { qty: 0 }, { qty: 1.0001 }, { qty: 100001 }, { rate: -1 }, { rate: 1.1 }, { rate: 1e12+1 }, { discount: 1 }, { details: 'x'.repeat(1001) }].map(change => ({ ...payload, lines: [{ ...payload.lines[0], ...change }] }))]) {
    response = await post(body); assert.equal(response.statusCode, 400, response.body);
  }
  response = await post({ ...payload, lines: [{ itemId: ids.item.toUpperCase(), qty: 1.001 }] }); assert.equal(response.statusCode, 201, response.body);
  response = await post({ ...payload, notes: '🙂'.repeat(2000), lines: [{ ...payload.lines[0], details: '🙂'.repeat(1000) }] }); assert.equal(response.statusCode, 201, response.body);
  for (const requestKey of ['no', '']) assert.equal((await post(payload, requestKey)).statusCode, 400);
  assert.equal((await post(payload, randomUUID(), { headers })).statusCode, 400);
  assert.equal((await app.inject({ url: `/api/v1/service/quotes/${quote.id}`, headers })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v0/erp/documents/${quote.id}`, headers })).statusCode, 403);
  assert.equal((await post(payload, randomUUID(), { url: '/api/v1/service/quotes?org=another' })).statusCode, 400);
  assert.equal((await post({ ...payload, clientId: ids.unowned })).statusCode, 422);
  assert.equal((await post({ ...payload, salespersonId: randomUUID() })).statusCode, 422);
  assert.equal((await post({ ...payload, clientId: ids.unowned, salespersonId: ids.salesperson })).statusCode, 201);
  // Issue, send (mark/link), convert (a new document from the quote), edit and delete stay staff-only, even beside a staff identity.
  for (const [url, body] of [[`documents/${quote.id}/issue`, {}], [`documents/${quote.id}/mark`, { action: 'sent' }], [`documents/${quote.id}/link`, {}],
    ['documents', { docType: 'invoice', sourceId: quote.id }], [`documents/${quote.id}`, {}], [`documents/${quote.id}/delete`, {}]]) {
    response = await app.inject({ method: 'POST', url: `/api/v0/erp/${url}`, headers: { ...headers, cookie: 'pulse_session=staff', 'cf-access-authenticated-user-email': `founder@${ids.domain}` }, payload: body });
    assert.equal(response.statusCode, 403, url);
  }
  assert.equal((await app.inject({ url: `/api/v0/erp/documents/${quote.id}`, headers })).statusCode, 403);
  response = await staff(`documents/${quote.id}/issue`, {}); assert.equal(response.statusCode, 200, response.body);
  response = await post(payload, requestKey); assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), quote, 'replay cannot read staff changes or issued state');
  const readId = randomUUID(); response = await app.inject({ method: 'POST', url: '/api/v1/operator/service-keys', headers: operator, payload: { action: 'issue', id: readId, hash, scopes: ['clients.read'], label: 'Synthetic reader' } }); assert.equal(response.statusCode, 200);
  assert.equal((await post(payload, randomUUID(), { headers: { authorization: `Bearer psvc_${readId}_${secret}`, 'idempotency-key': randomUUID() } })).statusCode, 403);
  for (const forbidden of [secret, hash, process.env.PULSE_OPERATOR_TOKEN, 'Synthetic item', sourceRef]) assert.ok(!JSON.stringify(logs).includes(forbidden));
  console.log('QUOTES ' + JSON.stringify({ changed: changed.id, lead: lead.id, source: source.id }));
} finally { await app.close(); await pool.end(); }
