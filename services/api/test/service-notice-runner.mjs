import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool), ids = JSON.parse(process.env.TEST_IDS);
const secret = randomBytes(32).toString('base64url'), key = randomUUID(), hash = createHash('sha256').update(secret).digest('hex');
const headers = { authorization: `Bearer psvc_${key}_${secret}` }, logs = [];
for (const level of ['info','warn','error']) app.log[level] = (...args) => logs.push(JSON.stringify(args));
const staff = (id, role = 'salesperson') => app.inject({ url: `/api/v0/quotes/${id}`, headers: { 'cf-access-authenticated-user-email': `${role}@${ids.domain}` } });
const notice = (id, extra = {}) => app.inject({ method: 'POST', url: `/api/v1/service/quotes/${id}/ready-notice`, headers, ...extra });
const draft = async body => {
  const r = await app.inject({ method: 'POST', url: '/api/v1/service/quotes', headers: { ...headers, 'idempotency-key': randomUUID() }, payload: body });
  assert.equal(r.statusCode, 201, r.body); return r.json();
};
try {
  let r = await app.inject({ method: 'POST', url: '/api/v1/operator/service-keys', headers: { authorization: `Bearer ${process.env.PULSE_OPERATOR_TOKEN}` },
    payload: { action: 'issue', id: key, hash, scopes: ['quotes.draft.create','notify.quote_ready'], label: 'Synthetic notice agent' } });
  assert.equal(r.statusCode, 200, r.body);
  const noticeKey = randomUUID();
  r = await app.inject({ method: 'POST', url: '/api/v1/operator/service-keys', headers: { authorization: `Bearer ${process.env.PULSE_OPERATOR_TOKEN}` },
    payload: { action: 'issue', id: noticeKey, hash, scopes: ['notify.quote_ready'], label: 'Synthetic second notice agent' } });
  assert.equal(r.statusCode, 200, r.body);
  const lines = [{ itemId: ids.item, qty: 1 }], quote = await draft({ clientId: ids.client, lines });
  const lead = await draft({ leadId: ids.lead, lines: [{ ...lines[0], rate: 9000 }, lines[0]] });
  const unflagged = await draft({ leadId: ids.lead, lines });
  for (const body of [{}, { title: 'CALLER-TEXT-CANARY' }, null, 'text']) {
    r = await notice(quote.id, { payload: JSON.stringify(body), headers: { ...headers, 'content-type': 'application/json' } }); assert.equal(r.statusCode, 400, r.body);
  }
  // Signed out, the release smoke's `{}` POST answers 401 before any body or id refusal (EST-1912).
  for (const id of [quote.id, 'not-a-uuid']) {
    r = await notice(id, { payload: '{}', headers: { 'content-type': 'application/json' } }); assert.equal(r.statusCode, 401, r.body);
  }
  const concurrent = await Promise.all([notice(quote.id), notice(quote.id, { headers: { authorization: `Bearer psvc_${noticeKey}_${secret}` } })]);
  for (const response of concurrent) assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(concurrent.map(r => r.json().repeat).sort(), [false, true]);
  const first = concurrent.find(r => !r.json().repeat).json();
  assert.deepEqual(Object.keys(first).sort(), ['id','notifiedAt','repeat']);
  assert(Number.isFinite(Date.parse(first.notifiedAt)));
  r = await notice(quote.id); assert.deepEqual(r.json(), { ...first, repeat: true });
  r = await notice(lead.id); assert.equal(r.statusCode, 200, r.body);
  r = await notice(lead.id.toUpperCase()); assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().repeat, true);
  r = await notice(unflagged.id); assert.equal(r.statusCode, 200, r.body);
  r = await staff(quote.id); assert.equal(r.statusCode, 200, r.body);
  const projected = r.json();
  assert.deepEqual(Object.keys(projected).sort(), ['id','name','status','validUntil','lines','taxable','tax','total','ownerApprovalNeeded','canOpenErp'].sort());
  assert.deepEqual(Object.keys(projected.lines[0]).sort(), ['name','qty','rate','gstRate','total'].sort());
  assert.equal(projected.name, 'Northstar Homes'); assert.equal(projected.canOpenErp, false);
  assert.equal(projected.total, quote.total); assert.equal(projected.tax, quote.tax); assert.equal(projected.taxable, quote.taxable);
  assert.equal((await staff(lead.id)).json().ownerApprovalNeeded, true);
  assert.equal((await staff(quote.id, 'other')).statusCode, 404);
  r = await staff(quote.id, 'finance'); assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().canOpenErp, true);
  for (const id of [ids.foreign, randomUUID()]) {
    assert.equal((await notice(id)).statusCode, 404); assert.equal((await staff(id, 'finance')).statusCode, 404);
  }
  assert.equal((await notice(ids.staff)).statusCode, 404);
  assert.equal((await notice(ids.invoice)).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/v0/quotes/${quote.id}` })).statusCode, 401);
  assert.equal((await app.inject({ url: `/api/v0/quotes/${quote.id}`, headers })).statusCode, 403);
  assert.equal((await notice(quote.id, { headers: { 'cf-access-authenticated-user-email': `finance@${ids.domain}` } })).statusCode, 401);
  // Candidate's 401-first boundary applies before parameter/body validation, even beside staff cookies.
  for (const authorization of [undefined, 'Bearer psvc_bad']) {
    r = await notice('invalid', { payload: { title: 'invalid body' }, headers: {
      cookie: 'pulse_session=staff', ...(authorization ? { authorization } : {}),
    } });
    assert.equal(r.statusCode, 401, r.body);
  }
  assert.equal((await notice(quote.id, { url: `/api/v1/service/quotes/${quote.id}/ready-notice?org=another` })).statusCode, 400);
  assert.equal((await notice('invalid')).statusCode, 400);
  const issued = await app.inject({ method: 'POST', url: `/api/v0/erp/documents/${quote.id}/issue`,
    headers: { 'cf-access-authenticated-user-email': `finance@${ids.domain}` }, payload: {} });
  assert.equal(issued.statusCode, 200, issued.body); assert.equal((await notice(quote.id)).statusCode, 404);
  // Existing draft scope works but cannot send notices; invalid keys cannot borrow a staff identity.
  const narrow = randomUUID();
  r = await app.inject({ method: 'POST', url: '/api/v1/operator/service-keys', headers: { authorization: `Bearer ${process.env.PULSE_OPERATOR_TOKEN}` },
    payload: { action: 'issue', id: narrow, hash, scopes: ['quotes.draft.create'], label: 'Synthetic narrow agent' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await notice(lead.id, { headers: { authorization: `Bearer psvc_${narrow}_${secret}`, 'cf-access-authenticated-user-email': `finance@${ids.domain}` } })).statusCode, 403);
  assert.equal((await notice(lead.id, { headers: { authorization: `Bearer psvc_${randomUUID()}_${secret}` } })).statusCode, 401);
  assert(!logs.join('\n').includes(secret)); assert(!logs.join('\n').includes(hash)); assert(!logs.join('\n').includes('CALLER-TEXT-CANARY'));
  console.log('NOTICES ' + JSON.stringify({ quote: quote.id, lead: lead.id, unflagged: unflagged.id, key, notifiedAt: first.notifiedAt }));
} finally { await app.close(); await pool.end(); }
