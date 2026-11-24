import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalRedate } from '../dist/erp-model.js';

// FIX-BILLING (BC-066, 19 Nov 2026): the night quote journey was refused "The last quotation in this series is dated
// 19 Nov 2026; date this one on or after it". An approver taking a draft as it stands is never sent back for its date:
// a quotation or proforma drafted before the series' latest number is dated the day it is approved.

const draft = (o = {}) => ({ docType: 'quotation', number: null, issueDate: '2026-11-18', validUntil: '2026-12-18', dueDate: null, ...o });

test('a quotation drafted yesterday, approved after today\'s first number, is dated today and keeps its window', () => {
  assert.deepEqual(approvalRedate(draft(), '2026-11-19', '2026-11-19'), { issueDate: '2026-11-19', validUntil: '2026-12-19', dueDate: null });
  // Three days late: validity and a proforma's due date move by the same three days.
  assert.deepEqual(approvalRedate(draft({ docType: 'proforma', issueDate: '2026-11-16', validUntil: null, dueDate: '2026-11-23' }), '2026-11-18', '2026-11-19'),
    { issueDate: '2026-11-19', validUntil: null, dueDate: '2026-11-26' });
  // Across a month and a year end.
  assert.deepEqual(approvalRedate(draft({ issueDate: '2026-12-31', validUntil: '2027-01-30' }), '2027-01-01', '2027-01-01'),
    { issueDate: '2027-01-01', validUntil: '2027-01-31', dueDate: null });
});

test('the dates stay as they are when the series would take them', () => {
  assert.equal(approvalRedate(draft(), null, '2026-11-19'), null, 'first in its series');
  assert.equal(approvalRedate(draft(), '2026-11-18', '2026-11-19'), null, 'same day as the latest number');
  assert.equal(approvalRedate(draft(), '2026-11-17', '2026-11-19'), null, 'after the latest number');
  assert.equal(approvalRedate(draft({ issueDate: '2026-11-19' }), '2026-11-19', '2026-11-19'), null, 'dated today');
});

test('invoices, credit notes, numbered revisions and odd dates are never moved', () => {
  for (const docType of ['invoice', 'credit_note']) assert.equal(approvalRedate(draft({ docType }), '2026-11-19', '2026-11-19'), null, docType);
  assert.equal(approvalRedate(draft({ number: 'QT/26-27/0007' }), '2026-11-19', '2026-11-19'), null, 'a revision keeps its number and date');
  assert.equal(approvalRedate(draft(), '2026-11-20', '2026-11-19'), null, 'a series dated after today is not chased into the future');
  assert.equal(approvalRedate(draft({ issueDate: '18/11/2026' }), '2026-11-19', '2026-11-19'), null);
  assert.equal(approvalRedate(draft(), '2026-11-19', 'today'), null);
});
