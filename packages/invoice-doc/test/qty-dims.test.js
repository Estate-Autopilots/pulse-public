// QUOTE-BUILDER-4 (Kazuk's 19 Nov test, VTI task 1514f831): a quantity in two numbers, "6 users × 6 months", and the
// prepaid discount from the months. Synthetic seller, buyer and items.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModel, cleanQtyDims, computeDocument, counted, dimsMatch, dimsOfUnit, dimsQty, dimsText, monthsOf, offRate, phasedName, splitQty, termPercent } from '../src/index.js';

const seller = { legalName: 'Synthetic Studio LLP', gstin: '27AAXFV2138F1ZR', stateCode: '27', address: ['1 Test Road, Pune 411001'] };
const SIX_BY_SIX = [{ n: 6, unit: 'user' }, { n: 6, unit: 'month' }];
// Neeti's prepaid tiers as Kazuk set them on his rate card: 3–5 months 5 %, 6–9 months 10 %, 12 months 15 %.
const TIERS = [{ months: 2, percent: 0 }, { months: 3, percent: 5 }, { months: 6, percent: 10 }, { months: 12, percent: 15 }];

test('a unit sold in two numbers is read from its words', () => {
  assert.deepEqual(dimsOfUnit('user/month'), ['user', 'month']);
  assert.deepEqual(dimsOfUnit('users per month'), ['user', 'month']);
  assert.deepEqual(dimsOfUnit('hours × people'), ['hour', 'person']);
  assert.deepEqual(dimsOfUnit('room x night'), ['room', 'night']);
  for (const plain of ['nos', 'month', 'km', '', null, '6 months', 'set']) assert.equal(dimsOfUnit(plain), null, String(plain));
});

test('the numbers print in words, singular and plural, and make the quantity', () => {
  assert.equal(dimsText(SIX_BY_SIX), '6 users × 6 months');
  assert.equal(dimsText([{ n: 1, unit: 'user' }, { n: 3, unit: 'months' }]), '1 user × 3 months');
  assert.equal(counted(3, 'person'), '3 people');
  assert.equal(counted(2, 'night'), '2 nights');
  assert.equal(counted(2, 'facility'), '2 facilities');
  assert.equal(dimsQty(SIX_BY_SIX), 36);
  assert.equal(dimsQty([{ n: 1.5, unit: 'hour' }, { n: 3, unit: 'person' }]), 4.5);
  assert.ok(dimsMatch(SIX_BY_SIX, 36));
  assert.ok(!dimsMatch(SIX_BY_SIX, 3), 'Kazuk saw 36 jump to 3: numbers that do not make the quantity are not printed');
  assert.equal(monthsOf(SIX_BY_SIX), 6);
});

test('numbers as sent are checked', () => {
  assert.deepEqual(cleanQtyDims([{ n: 6, unit: 'Users' }, { n: 6, unit: 'months' }]), SIX_BY_SIX);
  assert.equal(cleanQtyDims(undefined), null);
  assert.throws(() => cleanQtyDims([{ n: 6, unit: 'user' }]), /2 or 3 numbers/);
  assert.throws(() => cleanQtyDims([{ n: 0, unit: 'user' }, { n: 6, unit: 'month' }]), /positive number/);
  assert.throws(() => cleanQtyDims([{ n: 6, unit: '' }, { n: 6, unit: 'month' }]), /says what it counts/);
});

test("a package's 20 of user/month over its 4 months opens as 5 users × 4 months", () => {
  assert.deepEqual(splitQty(20, 'user/month', 4), [{ n: 5, unit: 'user' }, { n: 4, unit: 'month' }]);
  assert.deepEqual(splitQty(15, 'user/month', 3), [{ n: 5, unit: 'user' }, { n: 3, unit: 'month' }]);
  assert.equal(splitQty(7, 'user/month', 4), null, 'does not split evenly: stays one number');
  assert.equal(splitQty(20, 'nos', 4), null);
  assert.equal(splitQty(20, 'user/month', null), null);
});

test('the prepaid discount comes from the months: 3–5 months 5 %, 6–9 months 10 %, 12 months 15 %', () => {
  assert.equal(termPercent(TIERS, 1), 0);
  assert.equal(termPercent(TIERS, 2), 0);
  for (const m of [3, 4, 5]) assert.equal(termPercent(TIERS, m), 5, `${m} months`);
  for (const m of [6, 7, 9]) assert.equal(termPercent(TIERS, m), 10, `${m} months`);
  assert.equal(termPercent(TIERS, 12), 15);
  assert.equal(termPercent([], 12), 0);
  // ₹1,199 a user a month, 4 months: ₹1,139.05 (the price in Kazuk's Growth package); ₹1,899 for 6 months: ₹1,709.10.
  assert.equal(offRate(119900, termPercent(TIERS, 4)), 113905);
  assert.equal(offRate(189900, termPercent(TIERS, 6)), 170910);
});

test('Neeti 6 users × 6 months prints its numbers and adds up to the rate card price', () => {
  const line = { description: 'Neeti Sales Intelligence AI', qty: 36, qtyDims: SIX_BY_SIX, unit: 'user/month', rate: offRate(189900, 10), gstRate: 18, phase: 'Phase 4: Sales Intelligence', phaseOrder: 3 };
  assert.equal(phasedName(line), 'Neeti Sales Intelligence AI · 6 users × 6 months');
  const fig = computeDocument({ lines: [line], sellerState: '27', placeOfSupply: '27', roundTotal: false });
  assert.equal(fig.taxable, 6152760, '₹61,527.60, the Neeti rate card price Kazuk checked');
  const m = buildModel({}, { docType: 'quotation', status: 'draft', issueDate: '2026-11-20', seller, buyer: { name: 'Synthetic Builders', stateCode: '27' }, lines: [line] });
  const text = JSON.stringify(m.table.rows);
  assert.match(text, /6 users × 6 months/);
  assert.doesNotMatch(text, /× 36/);
  // A plain (not phased) document prints the numbers in its quantity column.
  const flat = buildModel({}, { docType: 'invoice', status: 'draft', issueDate: '2026-11-20', seller, buyer: { name: 'Synthetic Builders', stateCode: '27' },
    lines: [{ description: 'Seats', qty: 36, qtyDims: SIX_BY_SIX, rate: 10000, gstRate: 18 }] });
  assert.equal(flat.table.rows[0].cells.qty, '6 users × 6 months');
  // Numbers that no longer make the quantity are not printed; the quantity is.
  assert.equal(phasedName({ ...line, qty: 3 }), 'Neeti Sales Intelligence AI × 3');
});
