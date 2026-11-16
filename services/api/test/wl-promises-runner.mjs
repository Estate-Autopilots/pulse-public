// WL-PROMISES (CEO room msgs 140, 155, 171): an install key's PDF and site-visit reads, quote revisions and cancel, and over
// API v1 quote history, workflow runs, the quotation's events, the activity read and lead-create, on real PostgreSQL and
// tenant row security. Run by tests/core/test_wl_promises.py. Synthetic data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
const { createApp } = await import('../dist/app.js');

const W = JSON.parse(process.env.TEST_W);
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 4 }), app = createApp(pool, pool);
let checks = 0;
const call = async (method, token, url, status, payload, key = randomUUID()) => {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(method === 'POST' ? { 'idempotency-key': key } : {}) };
  const r = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  const want = Array.isArray(status) ? status : [status];
  assert.ok(want.includes(r.statusCode), `${method} ${url}: ${r.statusCode} ${r.body.slice(0, 400)}`); checks++;
  return r;
};
const get = (token, url, status) => call('GET', token, url, status);
const post = (token, url, status, payload, key) => call('POST', token, url, status, payload, key);
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
const token = async (email, scopes) => {
  const r = await app.inject({ method: 'POST', url: '/api/v0/api-tokens', headers: { 'cf-access-authenticated-user-email': email }, payload: { name: 'WL promises (synthetic)', scopes, days: 7 } });
  assert.equal(r.statusCode, 201, r.body); return r.json().token;
};
const settle = () => new Promise(resolve => setTimeout(resolve, 5500));
/** A person's own click in Billing: approve (issue) a draft, as erp_document_issue does for the screens. */
const approveAsPerson = async (id) => {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('pulse.org_id',$1,true), set_config('pulse.viewer_id',$2,true)", [W.org, W.founder]);
    const r = (await c.query('select pulse.erp_document_issue($1) r', [id])).rows[0].r;
    await c.query('commit'); return r;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
};

try {
  // ---------------------------------------------------------------------------------------------- the PDF (item 1)
  const pdf = id => `/api/v1/service/files/documents/${id}/pdf`;
  await get(null, pdf(W.quote), 401);
  await get(W.narrowKey, pdf(W.quote), 403);
  await get(W.visitsKey, pdf(W.quote), 403);
  const file = await get(W.filesKey, pdf(W.quote), 200);
  ok(file.headers['content-type'].startsWith('application/pdf'), 'a PDF');
  eq(file.rawPayload.toString(), '%PDF-synthetic', 'the filed bytes');
  ok(/^attachment; filename="[A-Za-z0-9-]+\.pdf"$/.test(file.headers['content-disposition']), 'a safe file name');
  ok(String(file.headers['cache-control']).includes('no-store'), 'not cached');
  await get(W.filesKey, pdf(W.draft), 404);
  await get(W.filesKey, pdf(W.invoice), 404);
  await get(W.filesKey, pdf(randomUUID()), 404);
  await get(W.filesKey, pdf('not-a-uuid'), 404);
  await get(W.filesKey, `${pdf(W.quote)}?x=1`, 400);
  await get(W.otherFilesKey, pdf(W.quote), 404);

  // ---------------------------------------------------------------------------------------------- site visits (item 5)
  const list = `/api/v1/service/customers/${W.customer}/site-visits`, one = `/api/v1/service/site-visits/${W.visit}`;
  await get(null, list, 401);
  await get(W.filesKey, list, 403);
  await get(W.narrowKey, one, 403);
  const visits = (await get(W.visitsKey, list, 200)).json().items;
  eq(visits.map(v => v.id), [W.visit], 'the customer\'s visit');
  eq(Object.keys(visits[0]).sort(), ['assignedPersonId', 'createdAt', 'customerId', 'id', 'notes', 'status', 'submittedAt', 'typeKey'], 'allowlisted fields');
  const visit = (await get(W.visitsKey, one, 200)).json();
  eq(visit.notes, 'Synthetic note', 'the notes');
  ok(Array.isArray(visit.fieldNotes) && !('starting_fields' in visit) && !('startingFields' in visit), 'no copy of the customer\'s details');
  await get(W.visitsKey, `/api/v1/service/site-visits/${randomUUID()}`, 404);
  eq((await get(W.otherFilesKey, list, 200)).json().items, [], 'another company sees none');
  await get(W.otherFilesKey, one, 404);

  // ---------------------------------------------------------------------------------------------- quote history (item 3)
  const admin = await token(W.adminEmail, ['billing.read', 'billing.write', 'workflows.read', 'events.read']);
  const member = await token(W.memberEmail, ['billing.read', 'billing.write', 'workflows.read']);
  const noBilling = await token(W.adminEmail, ['workflows.read']);
  await get(null, '/api/v1/billing/quotes', 401);
  await get(member, '/api/v1/billing/quotes', 403);
  await get(noBilling, '/api/v1/billing/quotes', 403);
  const all = (await get(admin, '/api/v1/billing/quotes', 200)).json();
  eq(new Set(all.items.map(q => q.id)), new Set([W.quote, W.draft]), 'quotations only');
  eq((await get(admin, '/api/v1/billing/quotes?status=accepted', 200)).json().items.map(q => q.id), [W.quote], 'by status');
  const first = (await get(admin, '/api/v1/billing/quotes?limit=1', 200)).json();
  ok(first.items.length === 1 && first.nextCursor, 'a page and a cursor');
  const second = (await get(admin, `/api/v1/billing/quotes?limit=1&cursor=${first.nextCursor}`, 200)).json();
  ok(second.items.length === 1 && second.items[0].id !== first.items[0].id && second.nextCursor === null, 'the last page');
  const q = (await get(admin, `/api/v1/billing/quotes/${W.quote}`, 200)).json();
  eq(q.status, 'accepted', 'its status');
  eq([q.revisionGroupId, q.revisionOf, q.supersededBy], [W.quote, null, null], 'a quotation of its own family');
  ok(q.lines.length >= 1, 'its lines');
  eq(Object.keys(q.lines[0]).sort(), ['catalogueRate', 'cgst', 'description', 'discount', 'gstRate', 'igst', 'itemId', 'notNeeded', 'parentPosition', 'position', 'qty', 'rate', 'sgst', 'tax', 'taxable', 'total'], 'the promised line fields');
  ok(q.lines.every(l => Number.isInteger(l.total) && l.tax === l.cgst + l.sgst + l.igst), 'whole paise, tax adds up');
  ok(!JSON.stringify(q).includes('salesperson') && !('phone' in q), 'no person fields');
  await get(member, `/api/v1/billing/quotes/${W.quote}`, 403);
  await get(admin, `/api/v1/billing/quotes/${W.invoice}`, 404);
  await get(admin, `/api/v1/billing/quotes/${randomUUID()}`, 404);

  // ---------------------------------------------------------------------------------------------- workflow runs (item 4)
  await get(null, '/api/v1/workflows/runs', 401);
  const runs = (await get(admin, '/api/v1/workflows/runs', 200)).json();
  ok(runs.items.some(r => r.id === W.run), 'the run is listed');
  const run = (await get(admin, `/api/v1/workflows/runs/${W.run}`, 200)).json();
  ok(run.steps.length === 1 && run.steps[0].key === 'go', 'its steps');
  ok(!('definition' in run) && !('context' in run), 'no definition or context');
  await get(admin, `/api/v1/workflows/runs/${randomUUID()}`, 404);
  await get(await token(W.adminEmail, ['billing.read']), '/api/v1/workflows/runs', 403);

  // ---------------------------------------------------------------------------------------------- events and activity (items 4, 5, 7)
  await settle();   // the stream holds back events younger than 5 seconds
  const events = (await get(admin, '/api/v1/events?types=quotation.sent,quotation.accepted', 200)).json();
  eq(events.items.filter(e => e.subjectId === W.quote).map(e => e.type).sort(), ['quotation.accepted', 'quotation.sent'], 'sent and accepted');
  const accepted = events.items.find(e => e.type === 'quotation.accepted');
  eq(accepted.data.documentId, W.quote, 'the quote');
  eq(accepted.data.clientId, W.customer, 'the client');
  eq(accepted.data.status, 'accepted', 'the status');
  const activity = (await get(admin, `/api/v1/events/activity?subjectId=${W.quote}`, 200)).json();
  ok(activity.items.length >= 4 && activity.items.every(e => e.subjectId === W.quote), 'one quotation\'s activity');
  eq(activity.items.map(e => e.type).filter(t => t.startsWith('quotation.')).slice(0, 2), ['quotation.created', 'quotation.issued'], 'in order');
  await get(noBilling, '/api/v1/events/activity', 403);

  // ---------------------------------------------------------------------------------------------- quote revisions (msg 155)
  const line = (qty) => [{ itemId: W.item, qty }];
  const draftBody = (extra = {}) => ({ clientId: W.customer, salespersonId: W.founder, lines: line(1), ...extra });
  const svc = '/api/v1/service/quotes';
  const v1 = (await post(W.quoteKey, svc, 201, draftBody())).json();
  eq([v1.revision, v1.revisionGroupId, v1.revisionOf, v1.number], [0, v1.id, null, null], 'a first draft is its own family');
  const v2Key = randomUUID(), v2Body = draftBody({ revisionOf: v1.id, lines: line(2) });
  const v2 = (await post(W.quoteKey, svc, 201, v2Body, v2Key)).json();
  eq([v2.revision, v2.revisionGroupId, v2.revisionOf, v2.number], [0, v1.id, v1.id, null], 'a revision of a draft');
  eq((await post(W.quoteKey, svc, 200, v2Body, v2Key)).json().id, v2.id, 'a retry returns the same revision');
  const v1now = (await get(admin, `/api/v1/billing/quotes/${v1.id}`, 200)).json();
  eq([v1now.status, v1now.supersededBy], ['cancelled', v2.id], 'the earlier draft is superseded at once and kept');
  await post(W.quoteKey, svc, 409, draftBody({ revisionOf: v1.id }));                                   // not the latest
  await post(W.quoteKey, svc, 409, { ...draftBody({ revisionOf: v2.id }), clientId: W.otherClient });   // another client
  await post(W.quoteKey, svc, 404, draftBody({ revisionOf: randomUUID() }));
  await post(W.quoteKey, svc, 400, draftBody({ revisionOf: 'nope' }));
  // Staff approve v2: the family takes its number. v3 revises the approved v2 under the same number.
  const numbered = await approveAsPerson(v2.id);
  ok(typeof numbered.number === 'string' && numbered.number.length > 0, 'the family is numbered');
  const v3 = (await post(W.quoteKey, svc, 201, draftBody({ revisionOf: v2.id, lines: line(3) }))).json();
  eq([v3.revision, v3.revisionGroupId, v3.revisionOf, v3.number], [1, v1.id, v2.id, numbered.number], 'R2 keeps the family number');
  eq((await get(admin, `/api/v1/billing/quotes/${v2.id}`, 200)).json().status, 'issued', 'the approved revision stays live until the next is approved');
  const r2 = await approveAsPerson(v3.id);
  eq([r2.number, r2.revision], [numbered.number, 1], 'R2 approved under the same number');
  const v2now = (await get(admin, `/api/v1/billing/quotes/${v2.id}`, 200)).json();
  eq([v2now.status, v2now.supersededBy, v2now.number], ['cancelled', v3.id, numbered.number], 'the approved revision before it is superseded and kept');
  const family = (await get(admin, `/api/v1/billing/quotes?revisionGroupId=${v1.id}`, 200)).json().items;
  eq(new Set(family.map(x => x.id)), new Set([v1.id, v2.id, v3.id]), 'the whole family reads back');

  // Cancel: drafts this key made, with a reason.
  const v4 = (await post(W.quoteKey, svc, 201, draftBody({ revisionOf: v3.id }))).json();
  eq([v4.revision, v4.number], [2, numbered.number], 'R3 drafted');
  const cancel = id => `/api/v1/service/quotes/${id}/cancel`;
  await post(null, cancel(v4.id), 401, { reason: 'Synthetic' });
  await post(W.narrowKey, cancel(v4.id), 403, { reason: 'Synthetic' });
  await post(W.quoteKey, cancel(v4.id), 400, { reason: '' });
  const gone = (await post(W.quoteKey, cancel(v4.id), 200, { reason: 'Customer chose the smaller system' })).json();
  eq([gone.status, gone.cancelReason, gone.number], ['cancelled', 'Customer chose the smaller system', numbered.number], 'cancelled, kept, reason recorded');
  await post(W.quoteKey, cancel(v4.id), 409, { reason: 'Again' });
  await post(W.quoteKey, cancel(v3.id), 409, { reason: 'Approved' });
  await post(W.quoteKey, cancel(W.quote), 404, { reason: 'Not made by this key' });
  const v5 = (await post(W.quoteKey, svc, 201, draftBody())).json();
  eq((await post(W.quoteKey, cancel(v5.id), 200, { reason: 'Never numbered' })).json().number, null, 'a draft cancelled before numbering keeps no number');
  await post(W.quoteKey, svc, 409, draftBody({ revisionOf: v5.id }));                                   // closed

  // ---------------------------------------------------------------------------------------------- lead-create (msg 140)
  const leads = '/api/v1/billing/quote-leads';
  const lead = { name: 'TEST Lead WL-Promises', phone: W.phone, area: 'Synthetic Nagar', requirement: 'Synthetic 5 kW rooftop', salespersonId: W.founder };
  await post(null, leads, 401, lead);
  await post(member, leads, 403, lead);
  await post(admin, leads, 400, { ...lead, area: undefined });
  await post(admin, leads, 400, { ...lead, phone: '98000' });
  await post(admin, leads, 400, { ...lead, salespersonId: W.otherPerson });
  const leadKey = randomUUID();
  const made = (await post(admin, leads, [200, 201], lead, leadKey)).json();
  eq(made.leadId, made.clientId, 'one id for the lead and its client');
  eq((await post(admin, leads, [200, 201], lead, leadKey)).json().leadId, made.leadId, 'a retry returns the same lead');
  const dup = await post(admin, leads, 409, { ...lead, name: 'TEST Someone else' });
  ok(dup.body.includes(`existingLeadId ${made.leadId}`), 'a duplicate phone names the lead the caller can see');
  const fromLead = (await post(W.quoteKey, svc, 201, { leadId: made.leadId, salespersonId: W.founder, lines: line(1) })).json();
  eq(fromLead.clientId, made.leadId, 'the install key drafts for the quote-lead');
  const drafted = (await post(admin, '/api/v1/billing/quotes/drafts', [200, 201], { leadId: made.leadId, lines: [{ itemId: W.item, qty: 1 }] })).json();
  eq([drafted.quotation.status, drafted.quotation.clientId], ['draft', made.leadId], 'quotes/drafts drafts for the lead');
  await post(admin, '/api/v1/billing/quotes/drafts', 400, { leadId: made.leadId, clientId: W.customer, lines: [{ itemId: W.item, qty: 1 }] });
  await post(admin, '/api/v1/billing/quotes/drafts', 404, { leadId: randomUUID(), lines: [{ itemId: W.item, qty: 1 }] });
  await post(member, '/api/v1/billing/quotes/drafts', 403, { leadId: made.leadId, lines: [{ itemId: W.item, qty: 1 }] });

  await settle();
  eq((await get(admin, `/api/v1/events/activity?subjectId=${v2.id}&types=quotation.cancelled`, 200)).json().items.length, 1, 'superseding is a quotation.cancelled event');

  console.log(JSON.stringify({ ok: true, checks, lead: made.leadId }));
} finally {
  await app.close();
  await pool.end();
}
