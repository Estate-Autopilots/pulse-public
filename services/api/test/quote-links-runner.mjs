// QUOTE-LINKS (owner, 22 Nov 2026: links on the old address, the same link again and again): on real PostgreSQL, with the
// production address settings. Run by tests/core/test_quote_links.py. Synthetic data only; mail goes to the test sink.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
const { createApp } = await import('../dist/app.js');

const W = JSON.parse(process.env.TEST_W);
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 4 }), app = createApp(pool, pool);
const asFinance = { 'cf-access-authenticated-user-email': `finance@${W.domain}` };
const v0 = async (method, path, body, status = 200) => {
  const r = await app.inject({ method, url: `/api/v0/${path}`, headers: asFinance, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, status, `${method} ${path}: ${r.statusCode} ${r.body.slice(0, 500)}`);
  return r.json();
};
let T;
const v1 = async (path, payload, status = 200) => {
  const r = await app.inject({ method: 'POST', url: `/api/v1/billing/${path}`, headers: { authorization: `Bearer ${T}`, 'idempotency-key': randomUUID() }, payload });
  assert.equal(r.statusCode, status, `${path}: ${r.statusCode} ${r.body.slice(0, 500)}`);
  return r.json();
};
const R = (rupee) => rupee * 100;
try {
  const t = await app.inject({ method: 'POST', url: '/api/v0/api-tokens', headers: asFinance, payload: { name: 'QUOTE-LINKS (synthetic)', scopes: ['billing.read', 'billing.write'], days: 1 } });
  assert.equal(t.statusCode, 201, t.body); T = t.json().token;
  const quote = async (name) => {
    const q = (await v1('quotations', { buyer: { name }, lines: [{ description: 'Synthetic panel', rate: R(9500), gstRate: 18 }] })).quotation;
    await v0('POST', `erp/documents/${q.id}/issue`, {});
    return q.id;
  };

  // 1. Links a customer opens use the brand address, never the install's old one.
  const a = await quote('ZZ Synthetic Link Buyer');
  const { url } = await v0('POST', `erp/documents/${a}/link`, { days: 30 });
  assert.match(url, /^https:\/\/app\.vitalsos\.ai\/accept\/[A-Za-z0-9_-]{43}$/, url);

  // 2. E-mail: the same version to the same address twice in a week is refused, unless "Send again".
  const mail = await v0('GET', `erp/documents/${a}/email`);
  const send = (extra = {}, status = 200) => v0('POST', `erp/documents/${a}/email`, { to: ['zz-buyer@example.test'], subject: mail.subject, body: mail.body, acceptLink: true, ...extra }, status);
  const first = await send();
  assert.deepEqual(first.sent, ['zz-buyer@example.test']);
  const sentLog = (await v0('GET', `erp/documents/${a}`)).events.filter((e) => e.kind === 'emailed');
  assert.equal(sentLog.length, 1);
  assert.match((await send({}, 409)).error, /^Already e-mailed to zz-buyer@example\.test on \d{1,2} [A-Z][a-z]{2}\. Choose Send again/);
  assert.equal((await v0('GET', `erp/documents/${a}`)).events.filter((e) => e.kind === 'emailed').length, 1, 'nothing went out the second time');
  assert.deepEqual((await send({ to: ['someone-else@example.test'] })).sent, ['someone-else@example.test'], 'another address is a first send');
  assert.deepEqual((await send({ resend: true })).sent, ['zz-buyer@example.test'], 'Send again sends');
  // The composer lists the earlier sends, so the page can say "Already e-mailed to … on …".
  assert.ok((await v0('GET', `erp/documents/${a}/email`)).sent.some((s) => (s.to ?? []).includes('zz-buyer@example.test')));

  // 3. The AI's send_quotation: one link a week unless the seller asks; its link is on the brand address.
  const b = await quote('ZZ Synthetic AI Buyer');
  const s1 = await v1(`quotations/${b}/send`, { confirm: true });
  assert.match(s1.acceptUrl, /^https:\/\/app\.vitalsos\.ai\/accept\//);
  const again = await v1(`quotations/${b}/send`, { confirm: true }, 409);
  assert.match(JSON.stringify(again), /Already sent on .*resend true/);
  assert.match((await v1(`quotations/${b}/send`, { confirm: true, resend: true })).acceptUrl, /^https:\/\/app\.vitalsos\.ai\//);
  console.log('QUOTE-LINKS runner: all checks passed');
} finally {
  await app.close(); await pool.end();
}
