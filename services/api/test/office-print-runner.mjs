// OFFICE-PRINT (2503; spec: the Mac's ~/orch/office-setup/print-agent/QUEUE-API.md): the company print queue on real
// PostgreSQL and tenant row security, through the API exactly as print_agent.py calls it. Run by tests/core/test_office_print.py.
// Synthetic data only; nothing is printed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
const { createApp } = await import('../dist/app.js');

const W = JSON.parse(process.env.TEST_W);
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 4 }), app = createApp(pool, pool);
const as = (who) => ({ 'cf-access-authenticated-user-email': `${who}@${W.domain}` });
const v0 = async (who, method, path, body, status = 200) => {
  const r = await app.inject({ method, url: `/api/v0/${path}`, headers: as(who), ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, status, `${who} ${method} ${path}: ${r.statusCode} ${r.body.slice(0, 500)}`);
  return r.body ? r.json() : null;
};
/** The agent's calls, as print_agent.py makes them (its token only). */
const agent = (token) => async (method, path, body, status = 200) => {
  const r = await app.inject({ method, url: `/api/v0/office-print${path}`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, status, `agent ${method} ${path}: ${r.statusCode} ${r.body.slice(0, 300)}`);
  return r;
};
const R = (rupee) => rupee * 100;
try {
  // A numbered quotation (its filed PDF is what prints).
  const t = await app.inject({ method: 'POST', url: '/api/v0/api-tokens', headers: as('finance'), payload: { name: 'OFFICE-PRINT (synthetic)', scopes: ['billing.read', 'billing.write'], days: 1 } });
  assert.equal(t.statusCode, 201, t.body);
  const T = t.json().token;
  const v1 = async (path, payload, status = 200) => {
    const r = await app.inject({ method: 'POST', url: `/api/v1/billing/${path}`, headers: { authorization: `Bearer ${T}`, 'idempotency-key': randomUUID() }, payload });
    assert.equal(r.statusCode, status, `${path}: ${r.statusCode} ${r.body.slice(0, 500)}`);
    return r.json();
  };
  const q = (await v1('quotations', { buyer: { name: 'ZZ Synthetic Print Buyer' }, lines: [{ description: 'Synthetic panel', rate: R(9500), gstRate: 18 }] })).quotation;
  const draftQ = (await v1('quotations', { buyer: { name: 'ZZ Synthetic Draft' }, lines: [{ description: 'Synthetic panel', rate: R(100), gstRate: 18 }] })).quotation;
  await v0('finance', 'POST', `erp/documents/${q.id}/issue`, {});

  // 1. Before an agent is connected: a print says so in plain words.
  assert.match((await v0('finance', 'POST', 'office-print/jobs', { documentId: q.id, copies: 1 }, 400)).error, /No office printer is connected/);
  // 2. Only admins or leadership connect the office computer; the token is shown once, only its hash is kept.
  await v0('finance', 'POST', 'office-print/agents', { name: 'x' }, 403);
  const made = await v0('founder', 'POST', 'office-print/agents', { name: 'Willow Lane office Mac' });
  assert.match(made.token, /^vpa_[A-Za-z0-9_-]{43}$/);
  assert.match(made.base, /\/api\/office-print$/);
  const over = await v0('founder', 'GET', 'office-print');
  assert.equal(over.canManage, true);
  assert.deepEqual(over.agents.map((a) => [a.name, !!a.revokedAt]), [['Willow Lane office Mac', false]]);
  assert.ok(!JSON.stringify(over).includes(made.token.slice(4)), 'the token is never shown again');
  const call = agent(made.token);

  // 3. Nothing queued: 204. A wrong token: 401.
  await call('POST', '/agent/next', { agent: 'office-mac', printer: 'ipp://192.0.2.10/ipp/print' }, 204);
  await agent(`vpa_${'A'.repeat(43)}`)('POST', '/agent/next', { agent: 'x', printer: 'y' }, 401);
  await app.inject({ method: 'POST', url: '/api/v0/office-print/agent/next', payload: {} }).then((r) => assert.equal(r.statusCode, 401));

  // 4. A person prints 2 copies: queued as them, in the document's log; a draft is refused; 21 copies are refused.
  assert.match((await v0('finance', 'POST', 'office-print/jobs', { documentId: draftQ.id, copies: 1 }, 400)).error, /no filed copy to print yet/);
  await v0('finance', 'POST', 'office-print/jobs', { documentId: q.id, copies: 21 }, 400);
  const queued = await v0('finance', 'POST', 'office-print/jobs', { documentId: q.id, copies: 2, sides: 'two-sided-long-edge' });
  assert.equal(queued.queued, true);
  assert.deepEqual([queued.job.copies, queued.job.pages, queued.job.sides], [2, 1, 'two-sided-long-edge']);
  assert.ok((await v0('finance', 'GET', `erp/documents/${q.id}`)).events.some((e) => e.kind === 'print_queued'));

  // 5. The agent claims it, fetches the PDF, prints, says done; then the queue is empty again.
  const next = (await call('POST', '/agent/next', { agent: 'office-mac', printer: 'ipp://192.0.2.10/ipp/print' })).json();
  assert.deepEqual([next.id, next.copies, next.sides, next.requested_by], [queued.job.id, 2, 'two-sided-long-edge', 'Kedab Accounts']);
  const pdf = await call('GET', `/jobs/${next.id}/file`);
  assert.equal(pdf.headers['content-type'], 'application/pdf'); assert.equal(pdf.rawPayload.subarray(0, 4).toString(), '%PDF');
  await call('GET', `/jobs/${randomUUID()}/file`, undefined, 404);
  assert.equal((await call('POST', `/jobs/${next.id}/update`, { status: 'printing' })).json().status, 'printing');
  assert.equal((await call('POST', `/jobs/${next.id}/update`, { status: 'done', printer_job: 42, detail: 'completed' })).json().status, 'done');
  await call('POST', `/jobs/${next.id}/update`, { status: 'printing' }, 400);
  await call('GET', `/jobs/${next.id}/file`, undefined, 404); // done: no longer handed out
  await call('POST', '/agent/next', { agent: 'office-mac', printer: 'ipp://192.0.2.10/ipp/print' }, 204);
  assert.ok((await v0('finance', 'GET', `erp/documents/${q.id}`)).events.some((e) => e.kind === 'printed'));

  // 6. A failed print says why, in the queue's history.
  const j2 = (await v0('finance', 'POST', 'office-print/jobs', { documentId: q.id, copies: 1 })).job;
  assert.equal((await call('POST', '/agent/next', { agent: 'office-mac', printer: 'p' })).json().id, j2.id);
  await call('POST', `/jobs/${j2.id}/update`, { status: 'failed', detail: 'media-empty: out of paper' });
  const hist = await v0('finance', 'GET', 'office-print');
  assert.deepEqual(hist.jobs.slice(0, 2).map((j) => [j.status, j.detail]), [['failed', 'media-empty: out of paper'], ['done', 'completed']]);

  // 7. Printer status: toner under 15% makes one task for the admin who connected it (once a day); the printer shows.
  const st = { agent: 'office-mac', printer: 'ipp://192.0.2.10/ipp/print', model: 'Synthetic LaserJet M1', state: 'idle', warnings: ['toner-low'], ink: [{ name: 'black', percent: 9 }], pages: 1234, accepts_pdf: true };
  assert.equal((await call('POST', '/agent/status', st)).json().alert, true);
  assert.equal((await call('POST', '/agent/status', st)).json().alert, false, 'one task, not one every 15 minutes');
  const printers = (await v0('founder', 'GET', 'office-print')).printers;
  assert.deepEqual(printers.map((p) => [p.model, p.pages, p.ink[0].percent]), [['Synthetic LaserJet M1', 1234, 9]]);

  // 8. The day's limit: 200 pages a company (here 3 printed or failed-not-counted so far: 2 done + 1 failed = 2 counted).
  let n = 0;
  for (; n < 20; n++) {
    const r = await app.inject({ method: 'POST', url: '/api/v0/office-print/jobs', headers: as('finance'), payload: { documentId: q.id, copies: 20 } });
    if (r.statusCode !== 200) { assert.match(r.json().error, /Today's print limit is 200 pages/); break; }
  }
  assert.equal(n, 9, '2 pages printed + 9 × 20 = 182; the tenth job (20 more) would pass 200');

  // 9. bhrātā's print_document: only with confirm; a person's own key prints as them.
  await v1(`documents/${q.id}/print`, { copies: 1 }, 400); // confirm is required
  const pr = await v1(`documents/${q.id}/print`, { copies: 1, confirm: false }, 400);
  assert.match(JSON.stringify(pr), /Ask the person first/);

  // 10. A revoked token stops at once.
  assert.equal((await v0('founder', 'POST', `office-print/agents/${made.id}/revoke`, {})).revoked, true);
  await call('POST', '/agent/next', { agent: 'office-mac', printer: 'p' }, 401);
  await call('POST', '/agent/status', st, 401);
  console.log('OFFICE-PRINT runner: all checks passed');
} finally {
  await app.close(); await pool.end();
}
