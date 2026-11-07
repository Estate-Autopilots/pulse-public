// KAZUK-FLOW (1670) through the API (tests/core/test_kazuk_flow.py): a salesperson's seat in Billing. Cost and margin
// leave every catalogue answer for the sales roles and stay for the owner; settings, templates, exports and Billing's
// setup are refused; a blank tax invoice is refused; with the company's approval off the API says approvalMode none
// and offers no approval; the owner's Start clean archives the drafted items; a salesperson's new item is usable at once.
// Synthetic company, people and figures only.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool), ids = JSON.parse(process.env.TEST_IDS);
const as = (who) => (url, body) => app.inject({ method: body === undefined ? 'GET' : 'POST', url: '/api/v0/' + url,
  headers: { 'cf-access-authenticated-user-email': `${who}@${ids.domain}` }, ...(body === undefined ? {} : { payload: body }) });
const owner = as('founder'), seller = as('seller'), head = as('head');
const ok = (r, what) => { assert.equal(r.statusCode, 200, `${what}: ${r.statusCode} ${r.body}`); return r.json(); };
try {
  // G4: cost and margin are the owner's.
  const mine = ok(await owner('erp/items'), 'owner items');
  assert.equal(mine.items.find((i) => i.id === ids.package).cost, 2300000);
  assert.equal(mine.seesCost, true); assert.equal(mine.approvalMode, 'none'); assert.equal(mine.startClean, 1);
  for (const who of [seller, head]) {
    const list = ok(await who('erp/items'), 'sales items');
    assert.ok(list.items.length >= 1 && list.items.every((i) => i.cost === null), 'no cost in the list');
    assert.equal(list.seesCost, false); assert.equal(list.startClean, 0);
    const pkg = ok(await who(`erp/items/${ids.package}`), 'sales package');
    assert.equal(pkg.item.cost, null); assert.ok(pkg.parts.length === 1 && pkg.parts.every((p) => p.cost === null), 'no part cost');
    assert.ok(pkg.versions.every((v) => v.cost === null), 'no cost in the history');
    assert.equal(ok(await who('erp/setup'), 'setup').fields.costMargin, false);
  }
  assert.equal(ok(await owner(`erp/items/${ids.package}`), 'owner package').parts[0].cost, 800000);
  // G1: Billing's own parts are leadership's and Finance's.
  assert.equal((await seller('erp/settings', { company: { legalName: 'Synthetic' } })).statusCode, 403);
  assert.equal((await seller('erp/templates', { name: 'Synthetic' })).statusCode, 403);
  assert.equal((await seller('erp/exports/sales-register')).statusCode, 403);
  assert.equal((await seller('erp/setup', { fields: {} })).statusCode, 403);
  // Who sees cost is the company's setting: everyone in Billing sees it once the owner says so, and back.
  ok(await owner('erp/settings', { company: { legalName: 'Synthetic Seller LLP', stateCode: '27' }, costVisibility: 'everyone' }), 'cost to everyone');
  assert.equal(ok(await seller(`erp/items/${ids.package}`), 'cost shown').item.cost, 2300000);
  assert.equal((await head('erp/settings', { company: { legalName: 'Synthetic Seller LLP', stateCode: '27' }, costVisibility: 'owner' })).statusCode, 403);
  ok(await owner('erp/settings', { company: { legalName: 'Synthetic Seller LLP', stateCode: '27' }, costVisibility: 'owner' }), 'cost to the owner');
  assert.equal(ok(await seller(`erp/items/${ids.package}`), 'cost hidden').item.cost, null);
  // T15: no blank tax invoice for a salesperson; a quotation is theirs.
  const blank = await seller('erp/documents', { docType: 'invoice' });
  assert.equal(blank.statusCode, 403, blank.body); assert.match(blank.json().error, /accepted quotation/);
  const quote = ok(await seller('erp/documents', { docType: 'quotation', buyer: { name: 'Test Realty Pvt Ltd', phone: '+91 90000 00111', email: 'buyer@example.test' } }), 'quotation');
  const home = ok(await seller('erp'), 'home');
  assert.equal(home.ownOnly, true); assert.equal(home.approvalMode, 'none'); assert.equal(home.seesCost, false);
  const docs = ok(await seller('erp/documents'), 'documents');
  assert.deepEqual(docs.documents.map((d) => d.id), [quote.id], 'only their own deal');
  assert.equal(docs.documents[0].salespersonName, 'Synthetic Seller One');
  assert.equal((await seller(`erp/documents/${ids.other}`)).statusCode, 404, "another salesperson's quotation is not found");
  assert.equal((await seller(`erp/documents/${ids.other}/pdf`)).statusCode, 404);
  const doc = ok(await seller(`erp/documents/${quote.id}`), 'document');
  assert.equal(doc.approvalMode, 'none'); assert.equal(doc.approval, null); assert.equal(doc.ownOnly, true);
  assert.equal(ok(await head('erp/documents'), 'head documents').documents.length, 2, 'the sales head sees the team');
  // The sales flow is configuration: EA's preset, then a step switched to Finance only shows why and who unlocks it.
  ok(await owner('erp/flow', { preset: 'ea' }), 'EA preset');
  const flow = ok(await seller('erp/flow'), 'flow');
  assert.equal(flow.preset, 'ea'); assert.equal(flow.steps.approve.on, false); assert.equal(flow.steps.price.on, false); assert.equal(flow.canSet, false);
  assert.equal(flow.steps.invoice.block.step, 'invoice'); assert.match(flow.steps.invoice.block.why, /accepted quotation/);
  assert.equal((await seller('erp/flow', { preset: 'wl' })).statusCode, 403);
  ok(await owner('erp/flow', { steps: { send: { roles: ['finance'], why: 'Finance sends quotations here', unlock: ['finance'] } } }), 'send for Finance');
  const blocked = ok(await seller(`erp/documents/${quote.id}`), 'blocked');
  assert.equal(blocked.blocks.send.why, 'Finance sends quotations here');
  ok(await owner('erp/flow', { preset: 'ea' }), 'EA preset again');
  // G3: EA's flow sends a quotation only with Kazuk's five fields; the first one missing is named.
  const noMail = await seller(`erp/documents/${quote.id}/issue`, { draft: { buyer: { name: 'Test Realty Pvt Ltd', contactName: 'Synthetic Buyer', phone: '+91 90000 00111' }, siteLocation: 'Pune' } });
  assert.equal(noMail.statusCode, 400, noMail.body); assert.match(noMail.json().error, /^Mail ID is needed to send/);
  // G9: sent with the five fields, accepted, invoiced: the invoice keeps the quotation's lines for the salesperson.
  const full = { buyer: { name: 'Test Realty Pvt Ltd', contactName: 'Synthetic Buyer', phone: '+91 90000 00111', email: 'buyer@example.test' }, siteLocation: 'Pune',
    lines: [{ description: 'Synthetic service', qty: 1, rate: 1000000, gstRate: 18 }] };
  ok(await seller(`erp/documents/${quote.id}/issue`, { draft: full }), 'issued with the five fields');
  ok(await seller(`erp/documents/${quote.id}/mark`, { action: 'accepted' }), 'accepted');
  const inv = ok(await seller('erp/documents', { docType: 'invoice', sourceId: quote.id }), 'invoice from the quotation');
  const invDoc = ok(await seller(`erp/documents/${inv.id}`), 'invoice draft');
  assert.equal(invDoc.linesLocked, true); assert.equal(invDoc.document.sourceRevision, 0);
  const cheaper = await seller(`erp/documents/${inv.id}`, { ...invDoc.document, lines: invDoc.lines.map((l) => ({ ...l, rate: 1 })) });
  assert.equal(cheaper.statusCode, 409, cheaper.body); assert.match(cheaper.json().error, /stay as accepted/);
  ok(await seller(`erp/documents/${inv.id}`, { ...invDoc.document, lines: invDoc.lines, notes: 'Thank you' }), 'dates and notes stay editable');
  assert.equal(ok(await seller(`erp/documents/${quote.id}`), 'unblocked').blocks.send, undefined);
  // G4: an item a salesperson adds is in use at once, without a cost; the owner starts the catalogue clean.
  const item = ok(await seller('erp/items', { kind: 'service', name: 'Synthetic Brand Film', price: 5000000, cost: 1500000 }), 'new item');
  assert.equal((await seller('erp/catalog/start-clean', {})).statusCode, 403);
  assert.deepEqual(ok(await owner('erp/catalog/start-clean', {}), 'start clean'), { archived: 1 });
  console.log('KF ' + JSON.stringify({ item: item.id, quote: quote.id }));
} finally { await app.close(); await pool.end(); }
