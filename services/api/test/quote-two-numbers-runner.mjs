// QUOTE-BUILDER-4 (Kazuk's 19 Nov test, VTI task 1514f831; migration 2498): his four gaps through the routes, on real
// PostgreSQL and tenant row security. 1. users × months: a seat sold per user per month prints "6 users × 6 months" and
// takes its prepaid discount from its rate card; 2. the AI's create_quotation opens a package into its phase parts, and
// changes parts on the way in; revise_quotation keeps them parts; 3. only active items are found and go on; 4. the composer
// is offered no draft item. Run by tests/core/test_quote_two_numbers.py. Synthetic data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
const { createApp } = await import('../dist/app.js');

const W = JSON.parse(process.env.TEST_W);
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 4 }), app = createApp(pool, pool);
const asFinance = { 'cf-access-authenticated-user-email': `finance@${W.domain}` };
const v0 = async (method, path, body, status = 200) => {
  const r = await app.inject({ method, url: `/api/v0/erp/${path}`, headers: asFinance, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, status, `${method} ${path}: ${r.statusCode} ${r.body.slice(0, 600)}`);
  return r.json();
};
let T;
const v1 = async (method, path, payload, status = 200) => {
  const r = await app.inject({ method, url: `/api/v1/billing/${path}`, headers: { authorization: `Bearer ${T}`, 'idempotency-key': randomUUID() }, ...(payload === undefined ? {} : { payload }) });
  assert.equal(r.statusCode, status, `${method} ${path}: ${r.statusCode} ${r.body.slice(0, 600)}`);
  return r.json();
};
const R = (rupee) => rupee * 100;
try {
  const t = await app.inject({ method: 'POST', url: '/api/v0/api-tokens', headers: asFinance, payload: { name: 'QUOTE-BUILDER-4 (synthetic)', scopes: ['billing.read', 'billing.write'], days: 1 } });
  assert.equal(t.statusCode, 201, t.body); T = t.json().token;

  // Gap 3: the AI's catalogue search finds active items only; a draft is found only when asked for.
  const found = (await v1('GET', 'catalogue?query=synthetic')).items;
  assert.ok(found.some((i) => i.id === W.seatsPro) && !found.some((i) => i.id === W.draftFilm), 'no draft in the search');
  assert.deepEqual((await v1('GET', 'catalogue?query=synthetic&status=draft')).items.map((i) => i.id), [W.draftFilm]);
  // ... and a draft does not go on a quotation.
  const refused = await v1('POST', 'quotations', { buyer: { name: 'Shree Developers (sample)' }, lines: [{ itemId: W.draftFilm, qty: 1 }] }, 400);
  assert.match(JSON.stringify(refused), /draft in the catalogue; only active items go on a quotation/);

  // Gap 1: Neeti AI for 6 users × 6 months: one line, "6 users × 6 months", ₹1,899 a user a month less 10 % prepaid.
  const neeti = (await v1('POST', 'quotations', { buyer: { name: 'Om Residency (sample)' }, lines: [
    { itemId: W.seatsAi, qty: 36, qtyDims: [{ n: 6, unit: 'users' }, { n: 6, unit: 'months' }] }] })).quotation;
  const [seat] = neeti.lines;
  assert.equal(seat.qty, 36); assert.equal(seat.qtyWords, '6 users × 6 months'); assert.equal(seat.discountPercent, 10);
  assert.equal(seat.rate, R(1899)); assert.equal(neeti.taxable, 6152760, '₹61,527.60, as the rate card prices it');
  assert.equal(seat.phase, 'Phase 4: Synthetic sales system', 'in its phase, not Other items');
  // The numbers decide the quantity; numbers that do not fit are refused in plain words.
  assert.equal((await v1('POST', 'quotations', { buyer: { name: 'Om Residency (sample)' }, lines: [{ itemId: W.seatsAi, qty: 6, qtyDims: [{ n: 6, unit: 'user' }, { n: 6, unit: 'month' }] }] })).quotation.lines[0].qty, 36);
  await v1('POST', 'quotations', { buyer: { name: 'X (sample)' }, lines: [{ itemId: W.seatsAi, qtyDims: [{ n: 6, unit: 'user' }] }] }, 400);
  // The PDF (the customer's copy) says the numbers, never "× 36"; the database keeps them with the line.
  const doc = await v0('GET', `documents/${neeti.id}`);
  assert.deepEqual(doc.lines[0].qtyDims, [{ n: 6, unit: 'user' }, { n: 6, unit: 'month' }]);
  assert.deepEqual(doc.items.find((i) => i.id === W.seatsAi).termTiers, [{ months: 2, percent: 0 }, { months: 3, percent: 5 }, { months: 4, percent: 5 }, { months: 6, percent: 10 }, { months: 12, percent: 15 }],
    'the AI seat takes the Pro card\'s prepaid tiers: same unit, same phase');
  const pdf = await v1('GET', `quotations/${neeti.id}/pdf`);
  assert.ok(pdf.size > 1000);

  // Gap 2: "Growth package for Shree Developers, Neeti 6 users 6 months, swap the video for the luxury one, no ads".
  const growth = (await v1('POST', 'quotations', { buyer: { name: 'Shree Developers (sample)' }, lines: [{ itemId: W.growth, parts: [
    { itemId: W.seatsPro, qtyDims: [{ n: 6, unit: 'user' }, { n: 6, unit: 'month' }] },
    { itemId: W.video, swapItemId: W.videoLux },
    { itemId: W.ads, remove: true },
  ] }] })).quotation;
  const by = (d) => Object.fromEntries(d.lines.map((l) => [l.description, l]));
  let g = by(growth);
  assert.deepEqual(Object.keys(g), ['Synthetic market study', 'Synthetic video ad (luxury)', 'Synthetic seats (pro)', 'Synthetic partner kit'], 'the parts, the removed one kept off the copy');
  assert.equal(g['Synthetic market study'].phase, 'Phase 1: Synthetic plan'); assert.equal(g['Synthetic market study'].package, 'Synthetic Growth Package');
  assert.equal(g['Synthetic video ad (luxury)'].qty, 2); assert.equal(g['Synthetic video ad (luxury)'].rate, R(61250));
  assert.equal(g['Synthetic seats (pro)'].qtyWords, '6 users × 6 months'); assert.equal(g['Synthetic seats (pro)'].discountPercent, 10, '6 months prepaid');
  assert.equal(g['Synthetic partner kit'].rate, 0);
  const lines = (await v0('GET', `documents/${growth.id}`)).lines;
  assert.equal(lines.length, 5, 'the removed part stays on the draft, unticked');
  assert.equal(lines.find((l) => l.description === 'Synthetic partner kit').role, 'bonus');
  assert.deepEqual(lines.find((l) => l.description.startsWith('Synthetic seats')).packageDefault, { qty: 20, rate: R(1199), itemId: W.seatsPro, qtyDims: [{ n: 5, unit: 'user' }, { n: 4, unit: 'month' }], discountPercent: 5 });
  // A part that is not in the package is named back with the package's parts.
  const wrong = await v1('POST', 'quotations', { buyer: { name: 'X (sample)' }, lines: [{ itemId: W.growth, parts: [{ itemId: W.seatsAi, qty: 2 }] }] }, 400);
  assert.match(JSON.stringify(wrong), /has no part with itemId/);

  // revise_quotation with the lines sent again (as get_billing_document lists them) keeps each part in its phase and package.
  const revised = (await v1('POST', `quotations/${growth.id}/revise`, { lines: growth.lines.map((l) => ({ itemId: l.itemId, ...(l.qtyDims ? { qtyDims: l.qtyDims } : { qty: l.qty }) })) })).quotation;
  g = by(revised);
  assert.equal(g['Synthetic market study'].package, 'Synthetic Growth Package'); assert.equal(g['Synthetic seats (pro)'].qtyWords, '6 users × 6 months');
  assert.equal(revised.total, growth.total, 'the same lines, the same total');
  const after = (await v0('GET', `documents/${growth.id}`)).lines;
  assert.equal(after.find((l) => l.description === 'Synthetic partner kit').role, 'bonus', 'a bonus stays a bonus');

  // Gap 4 (composer): the document page offers items with their status, so drafts are never offered (the page filters them).
  assert.equal((await v0('GET', `documents/${growth.id}`)).items.find((i) => i.id === W.draftFilm).status, 'draft');
  console.log('quote-two-numbers runner: ok');
} finally {
  await pool.end();
}
