import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModel, priceComparison, isEstimate } from '../src/index.js';

// QUOTE-BUILDER (owner, 19-20 Nov 2026; board 5, option C): the seller's comparison (never printed) and the customer's
// copy with estimates apart. Invented names and figures (the board's "Dorugohum Residency (sample)").
const R = (r) => r * 100;
const seller = { legalName: 'Sample Solar LLP', stateCode: '27', gstin: '27AAAAA0000A1Z5' };
const buyer = { name: 'Dorugohum Residency (sample)', stateCode: '27' };

test("the board: at catalogue prices ₹6,65,000 → ₹6,39,500, ₹25,500 off (items and charges)", () => {
  const c = priceComparison([
    { qty: 1, rate: R(365000), catalogueRate: R(385000), cost: R(300000) },
    { qty: 1, rate: R(104500), catalogueRate: R(110000), cost: R(90000) },
    { qty: 2, rate: R(75000), catalogueRate: R(75000), cost: R(60000) },
    { qty: 65, rate: R(100), charge: 'fixed' }, { qty: 1, rate: R(12000), charge: 'fixed' }, { qty: 1, rate: R(1500), charge: 'fixed' },
  ]);
  assert.equal(c.base + c.charges.fixed, R(665000));
  assert.equal(c.yours + c.charges.fixed, R(639500));
  assert.equal(c.off, R(25500));
  assert.equal(c.percentOff, 4); assert.equal(c.changed, 2); assert.equal(c.maxPercentOff, 5.2);
  assert.deepEqual(c.lines.map((l) => [l.index, l.percentOff]), [[0, 5.2], [1, 5], [2, 0]]);
  assert.equal(c.cost, R(510000)); assert.equal(c.margin, R(109500)); assert.equal(c.marginPercent, 17.7);
});

test('margin only when every item has a cost; lines with no base are counted apart; estimates and free lines kept out', () => {
  const c = priceComparison([
    { qty: 1, rate: R(100), catalogueRate: R(120) },
    { qty: 1, rate: R(50) },
    { qty: 1, rate: 0, role: 'included', catalogueRate: R(999) },
    { qty: 3, rate: R(100), charge: 'variable' },
    { qty: 1, rate: R(10), catalogueRate: R(10), notNeeded: true },
    { qty: 1.5, rate: R(10), discountPercent: 10, catalogueRate: R(10), cost: R(5) },
  ]);
  assert.equal(c.unpriced, 1); assert.equal(c.margin, null); assert.equal(c.cost, null);
  assert.equal(c.charges.estimate, R(300)); assert.equal(c.charges.fixed, 0);
  assert.equal(c.base, R(120) + 1500); assert.equal(c.yours, R(100) + 1350);
  assert.equal(c.lines.at(-1).off, 150, '10% off ₹15');
  assert.equal(isEstimate({ charge: 'variable', confirmed: true }), false);
  assert.deepEqual(priceComparison([]).lines, []);
});

test("the customer's copy prints estimates under their own heading, out of the total, with a note", () => {
  const doc = { docType: 'quotation', issueDate: '2026-11-20', seller, buyer, placeOfSupply: '27',
    lines: [{ description: 'Hybrid inverter 5 kVA', qty: 1, rate: R(104500), gstRate: 18 }],
    estimates: [{ description: 'Transport', unit: 'km', qty: 65, rate: R(100), gstRate: 18 }] };
  const m = buildModel({}, doc);
  assert.equal(m.computed.taxable, R(104500), 'the total is the fixed lines only');
  assert.equal(m.computed.total, R(123310));
  assert.equal(m.estimate, R(7670));
  const items = m.table.rows.map((r) => r.cells.item);
  assert.deepEqual(items, ['Hybrid inverter 5 kVA', 'To be confirmed at the end (estimate)', 'Transport']);
  assert.equal(m.table.rows[1].kind, 'heading');
  assert.equal(m.table.rows[2].cells.n, '2');
  assert.deepEqual(m.totals.at(-1), { label: 'To be confirmed (estimate, with GST)', value: '7,670.00' });
  assert.match(m.notes, /settled at the end at the actual amount\. They are not in the total/);
  const plain = buildModel({}, { ...doc, estimates: [] });
  assert.equal(plain.estimate, 0); assert.ok(!plain.table.rows.some((r) => r.kind === 'heading'));
  assert.ok(!/estimate/i.test(plain.notes ?? ''));
});
