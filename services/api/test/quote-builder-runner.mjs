// QUOTE-BUILDER (2490): the quotation builder's routes on real PostgreSQL and tenant row security: your own price with a
// note, extra and variable charges (an estimate stays out of the total), the seller's comparison, the AI's change card
// (proposed over API v1, applied or closed by a person in Billing, refused once the draft moved), and an invoice with an
// estimate refused until it is confirmed. Run by tests/core/test_quote_builder.py. Synthetic data only.
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
const v1 = async (path, payload, status = 200) => {
  const r = await app.inject({ method: 'POST', url: `/api/v1/billing/${path}`, headers: { authorization: `Bearer ${T}`, 'idempotency-key': randomUUID() }, payload });
  assert.equal(r.statusCode, status, `${path}: ${r.statusCode} ${r.body.slice(0, 600)}`);
  return r.json();
};
const R = (rupee) => rupee * 100;
try {
  const t = await app.inject({ method: 'POST', url: '/api/v0/api-tokens', headers: asFinance, payload: { name: 'QUOTE-BUILDER (synthetic)', scopes: ['billing.read', 'billing.write'], days: 1 } });
  assert.equal(t.statusCode, 201, t.body); T = t.json().token;

  // 1. A quotation with the seller's own price (and why), a variable transport charge and a fixed installation.
  const made = (await v1('quotations', { buyer: { name: 'Dorugohum Residency (sample)' }, lines: [
    { itemId: W.inverter, qty: 1, rate: R(104500), priceNote: 'Festive offer' },
    { itemId: W.solar, qty: 1 },
    { description: 'Transport', unit: 'km', qty: 65, rate: R(100), charge: 'variable' },
    { description: 'Installation', rate: R(12000), charge: 'fixed' },
  ] })).quotation;
  const id = made.id, path = `documents/${id}`;
  assert.equal(made.taxable, R(104500 + 385000 + 12000), 'the estimate is not in the total');
  assert.equal(made.estimate, R(7670)); assert.equal(made.inRupees.estimate, '₹7,670');
  assert.deepEqual(made.lines.map((l) => [l.base, l.charge, l.estimate]), [[R(110000), null, false], [R(385000), null, false], [null, 'variable', true], [null, 'fixed', false]]);
  assert.equal(made.lines[0].priceNote, 'Festive offer'); assert.equal(made.lines[0].baseRupees, '₹1,10,000');
  assert.deepEqual([made.comparison.off, made.comparison.changed, made.comparison.inRupees.off], [R(5500), 1, '₹5,500']);
  assert.equal(made.comparison.margin, R(104500 + 385000 - 90000 - 300000), 'Finance sees cost, so the margin is there');

  // 2. Billing reads the same: the base kept on the line, the charge, the estimate, the item's cost, no cards yet.
  let doc = await v0('GET', path);
  assert.deepEqual(doc.lines.map((l) => l.catalogueRate), [R(110000), R(385000), null, null]);
  assert.deepEqual(doc.lines.map((l) => [l.charge, l.confirmed, l.priceNote]), [[null, false, 'Festive offer'], [null, false, null], ['variable', false, null], ['fixed', false, null]]);
  assert.equal(doc.document.estimate, R(7670));
  assert.equal(doc.items.find((i) => i.id === W.inverter).cost, R(90000));
  assert.deepEqual(doc.proposals, []);
  const total0 = doc.document.total;
  // A save keeps the base even when the catalogue price changes later.
  await v0('POST', path, { ...doc.document, lines: doc.lines });
  assert.equal((await v0('GET', path)).lines[0].catalogueRate, R(110000));

  // 3. The AI's card: 5% off the solar system, transport confirmed at 70 km. Nothing changes until Apply.
  const card = (await v1(`documents/${id}/proposals`, { changes: [{ op: 'price', line: 2, percentOff: 5, note: 'Asked on the call' }, { op: 'edit_charge', line: 3, qty: 70, confirmed: true }],
    ask: 'Give 5% off the solar system; transport was 70 km' })).proposal;
  assert.deepEqual(card.items.map((i) => i.text), ['Synthetic PUREPower 5 kW solar system: ₹3,85,000 → ₹3,65,750 (−5%)', 'Transport: quantity 65 → 70, confirmed: the final amount']);
  assert.equal(card.before.total, total0);
  assert.equal(card.after.estimate, 0);
  assert.equal(card.after.total, Math.round((R(104500 + 365750 + 12000 + 7000) * 1.18) / 100) * 100);
  assert.equal((await v0('GET', path)).document.total, total0, 'proposing changed nothing');
  const waiting = (await v0('GET', `${path}/proposals`)).proposals;
  assert.deepEqual(waiting.map((p) => [p.id, p.stale, p.after.totalRupees]), [[card.id, false, card.after.totalRupees]]);

  // 4. A person applies it: the totals are the card's; a second Apply is refused.
  const applied = await v0('POST', `${path}/proposals/${card.id}/apply`, {});
  assert.deepEqual([applied.status, applied.total], ['applied', card.after.total]);
  doc = await v0('GET', path);
  assert.deepEqual([doc.document.total, doc.document.estimate], [card.after.total, 0]);
  assert.deepEqual([doc.lines[1].rate, doc.lines[1].priceNote, doc.lines[1].catalogueRate], [R(365750), 'Asked on the call', R(385000)]);
  assert.deepEqual([doc.lines[2].qty, doc.lines[2].confirmed], [70, true]);
  assert.match((await v0('POST', `${path}/proposals/${card.id}/apply`, {}, 409)).error, /already applied/);
  assert.ok(doc.events.some((e) => e.kind === 'ai_changes_applied'), 'the log says the AI changes were applied');

  // 5. Not now closes a card; a card the draft moved past is refused (ask again) and changes nothing.
  const later = (await v1(`documents/${id}/proposals`, { changes: [{ op: 'add_charge', description: 'Loading & unloading', rate: R(1500) }] })).proposal;
  assert.equal(later.items[0].text, 'Add Loading & unloading · ₹1,500');
  assert.equal((await v0('POST', `${path}/proposals/${later.id}/dismiss`, {})).status, 'dismissed');
  const stale = (await v1(`documents/${id}/proposals`, { changes: [{ op: 'remove', line: 1 }] })).proposal;
  await v0('POST', path, { ...doc.document, lines: [doc.lines[1], doc.lines[0], ...doc.lines.slice(2)] });
  assert.equal((await v0('GET', `${path}/proposals`)).proposals[0].stale, true);
  assert.match((await v0('POST', `${path}/proposals/${stale.id}/apply`, {}, 409)).error, /changed since this was proposed/);
  assert.equal((await v0('GET', path)).lines.filter((l) => !l.notNeeded).length, 4);
  // A card for a line that is not there, or an op it does not know, is refused when proposed.
  assert.match(JSON.stringify(await v1(`documents/${id}/proposals`, { changes: [{ op: 'price', line: 9, rate: 1 }] }, 400)), /line is 1 to 4/);

  // 6. An invoice with a charge still an estimate is not issued; confirmed, it is.
  const inv = await v0('POST', 'documents', { docType: 'invoice' });
  const invId = inv.id ?? inv.document?.id;
  const invDoc = await v0('GET', `documents/${invId}`);
  const invLines = [{ description: 'Synthetic service', rate: R(1000), gstRate: 18 }, { description: 'Transport', unit: 'km', qty: 10, rate: R(100), gstRate: 18, charge: 'variable' }];
  await v0('POST', `documents/${invId}`, { ...invDoc.document, buyer: { name: 'Dorugohum Residency (sample)', stateCode: '27' }, lines: invLines });
  assert.match((await v0('POST', `documents/${invId}/issue`, {}, 400)).error, /Confirm each charge that was an estimate/);
  await v0('POST', `documents/${invId}`, { ...invDoc.document, buyer: { name: 'Dorugohum Residency (sample)', stateCode: '27' }, lines: invLines.map((l) => (l.charge ? { ...l, qty: 12, confirmed: true } : l)) });
  const issued = await v0('POST', `documents/${invId}/issue`, {});
  assert.ok(issued.number || issued.document?.number, JSON.stringify(issued).slice(0, 300));
  console.log('QUOTE-BUILDER runner: all checks passed');
} finally {
  await app.close(); await pool.end();
}
