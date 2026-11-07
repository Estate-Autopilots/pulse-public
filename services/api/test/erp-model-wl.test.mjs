// BILLING-WL (owner, 4 Nov 2026; Akabod Soniba of Willow Lane): what a draft save accepts for extended warranties and
// serial numbers, and how a revised quotation and a serial-numbered line are printed. Synthetic values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanLines, displayNumber, documentInput, lineDetails } from '../dist/erp-model.js';

const unit = { description: 'Pure Power 5.0', qty: 2, rate: 4500000, gstRate: 18, itemId: '11111111-1111-4111-8111-111111111111' };

test('an extended warranty is an add-on of the line it extends, with its months', () => {
  const rows = cleanLines([unit, { description: 'Extended warranty +2 years: Pure Power 5.0', qty: 2, rate: 900000, parentIndex: 0, warrantyMonths: 24 }]);
  assert.equal(rows[1].warrantyMonths, 24); assert.equal(rows[1].parentIndex, 0); assert.equal(rows[0].warrantyMonths, null);
  assert.throws(() => cleanLines([{ description: 'Extended warranty', qty: 1, rate: 1, warrantyMonths: 12 }]), /belongs to the line it extends/);
  assert.throws(() => cleanLines([unit, { description: 'Extended warranty', qty: 1, rate: 1, parentIndex: 0, warrantyMonths: 0 }]), /1 to 600 months/);
});

test('serial numbers are cleaned, once each, and never on two lines', () => {
  assert.deepEqual(cleanLines([{ ...unit, serials: [' pp5-001 ', 'PP5 002'] }])[0].serials, ['PP5-001', 'PP5002']);
  assert.throws(() => cleanLines([{ ...unit, serials: ['PP5-001', 'pp5-001'] }]), /listed twice/);
  assert.throws(() => cleanLines([{ ...unit, serials: ['PP5-001'] }, { ...unit, serials: ['PP5-001'] }]), /on two lines/);
  assert.throws(() => cleanLines([{ ...unit, serials: ['PP5#001'] }]), /characters a serial does not use/);
  assert.deepEqual(cleanLines([unit])[0].serials, []);
});

test('a revised quotation prints R2, R3; other documents print their number', () => {
  assert.equal(displayNumber({ doc_type: 'quotation', number: 'QT/26-27/0001', revision: 0 }), 'QT/26-27/0001');
  assert.equal(displayNumber({ doc_type: 'quotation', number: 'QT/26-27/0001', revision: 1 }), 'QT/26-27/0001 R2');
  assert.equal(displayNumber({ doc_type: 'invoice', number: 'INV/26-27/0004', revision: 2 }), 'INV/26-27/0004');
  assert.equal(displayNumber({ doc_type: 'quotation', number: null, revision: 0 }), null);
  const input = documentInput({ doc_type: 'quotation', status: 'issued', number: 'QT/26-27/0001', revision: 2, issue_date: '2026-11-04', seller: {}, buyer: { name: 'Synthetic' } },
    [{ description: 'Pure Power 5.0', details: 'Lithium backup', qty: 1, rate: 4500000, gst_rate: 18, serials: ['PP5-001'] }]);
  assert.equal(input.number, 'QT/26-27/0001 R3');
  assert.equal(input.lines[0].details, 'Lithium backup\nSerial no. PP5-001');
  assert.equal(lineDetails({ details: '', serials: ['A1', 'A2'] }), 'Serial no. A1, A2');
});
