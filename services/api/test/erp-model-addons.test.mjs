import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanAddOnIds, cleanDraft, cleanLines, documentInput, figures, neededLines, OPEN_UNFILLED, unfilledOpen } from '../dist/erp-model.js';

// EST-1236 (Willow Lane pilot): a quotation finished in the meeting. Add-on lines, open amounts and lines not needed.
// Synthetic items and figures only.

const system = { description: 'Synthetic 15 kW system', rate: 37999900, gstRate: 18 };
const dongle = { description: 'Synthetic dongle', rate: 250000, gstRate: 18, parentIndex: 0 };
const install = { description: 'Installation', rate: 0, gstRate: 18, open: true };
const transport = { description: 'Transport', rate: 0, gstRate: 18, open: true };

test('an add-on points at another main line of the same document', () => {
  const [a, b] = cleanLines([system, dongle]);
  assert.deepEqual([a.parentIndex, b.parentIndex, a.open, a.notNeeded], [null, 0, false, false]);
  assert.throws(() => cleanLines([system, { ...dongle, parentIndex: 1 }]), /another line of this document/);
  assert.throws(() => cleanLines([system, { ...dongle, parentIndex: 5 }]), /another line of this document/);
  assert.throws(() => cleanLines([system, { ...dongle, parentIndex: 0.5 }]), /another line of this document/);
  assert.throws(() => cleanLines([system, dongle, { ...dongle, parentIndex: 1 }]), /main line, not to another add-on/);
  assert.equal(cleanLines([system, { ...dongle, parentIndex: '' }])[1].parentIndex, null);
});

test('a main line that is not needed takes its add-ons with it; the rest keep their places', () => {
  const lines = cleanLines([{ ...system, notNeeded: true }, dongle, install, { ...system, description: 'Synthetic 10 kW system' }, { ...dongle, parentIndex: 3 }]);
  assert.deepEqual(lines.map((l) => l.notNeeded), [true, true, false, false, false]);
  const { kept, index } = neededLines(lines);
  assert.deepEqual(index, [null, null, 0, 1, 2]);
  assert.deepEqual(kept.map((l) => [l.description, l.parentIndex]), [['Installation', null], ['Synthetic 10 kW system', null], ['Synthetic dongle', 1]]);
});

test('open amounts: zero ones block issuing until filled or marked not needed', () => {
  assert.equal(unfilledOpen(cleanLines([system, install, transport])), 2);
  assert.equal(unfilledOpen(cleanLines([system, { ...install, rate: 1500000 }, { ...transport, notNeeded: true }])), 0);
  assert.equal(unfilledOpen(cleanLines([system, { description: 'Free survey', rate: 0, gstRate: 18 }])), 0); // a zero line that is not open is fine
  assert.equal(OPEN_UNFILLED, 'Fill each open amount or mark it not needed');
});

test('figures and the preview leave out lines that are not needed', () => {
  const d = cleanDraft({ issueDate: '2026-10-18', buyer: { name: 'Synthetic client', stateCode: '27' },
    lines: [{ ...system, rate: 10000000 }, { ...dongle, rate: 100000 }, { ...transport, rate: 500000, notNeeded: true }] });
  const f = figures('27', { ...d, lines: neededLines(d.lines).kept });
  assert.equal(f.taxable, 10100000);
  const row = { doc_type: 'quotation', status: 'draft', number: null, issue_date: '2026-10-18', seller: {}, buyer: { name: 'Synthetic client' }, place_of_supply: '27', reference: {} };
  const stored = [{ description: 'Synthetic system', qty: 1, rate: 10000000, gst_rate: 18, not_needed: false }, { description: 'Transport', qty: 1, rate: 500000, gst_rate: 18, not_needed: true }];
  assert.deepEqual(documentInput(row, stored).lines.map((l) => l.description), ['Synthetic system']);
});

test('an item lists its usual add-ons once each, never itself, up to 20', () => {
  const self = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(cleanAddOnIds([other], self), [other]);
  assert.deepEqual(cleanAddOnIds([], self), []);
  assert.throws(() => cleanAddOnIds(other, self), /a list/);
  assert.throws(() => cleanAddOnIds(['not-an-id'], self), /from the catalogue/);
  assert.throws(() => cleanAddOnIds([other, other], self), /once/);
  assert.throws(() => cleanAddOnIds([self], self), /its own add-on/);
  const many = Array.from({ length: 21 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
  assert.throws(() => cleanAddOnIds(many, self), /up to 20/);
});
