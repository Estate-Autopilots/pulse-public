// DOCS-HUB (21 Nov 2026): plain words → document filters (find_documents and Billing → Documents' search), and the one
// plain word for where a document stands. The database half (every field searched, closer match, a sales seat's own
// documents only) is tests/core/test_docs_hub_search.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import { docState, parseDocQuery } from '../dist/doc-find.js';

const TODAY = '2026-11-20';
const p = (s) => parseDocQuery(s, TODAY);

test("the owner's own ask: last month's invoices for Willow Lane over 1 lakh", () => {
  const q = p("find last month's invoices for Willow Lane over 1 lakh");
  assert.deepEqual(q.kinds, ['invoice']);
  assert.deepEqual(q.states, []);
  assert.equal(q.from, '2026-10-01');
  assert.equal(q.to, '2026-10-31');
  assert.equal(q.min, 100000 * 100);
  assert.equal(q.max, null);
  assert.equal(q.text, 'willow lane');
  assert.deepEqual(q.understood, ['Invoices', 'Last month: 1–31 Oct 2026', 'Over ₹1 lakh', 'Matching “willow lane”']);
});

test('kinds and states in everyday words', () => {
  assert.deepEqual([p('unpaid bills Majestic').kinds, p('unpaid bills Majestic').states, p('unpaid bills Majestic').text], [['invoice'], ['unpaid'], 'majestic']);
  const ns = p('quotes not sent yet');
  assert.deepEqual([ns.kinds, ns.states, ns.text], [['quotation'], ['not_sent'], '']);
  const pf = p('proforma invoice for Neha');
  assert.deepEqual([pf.kinds, pf.text], [['proforma'], 'neha']);
  assert.deepEqual(p('part paid invoices').states, ['part_paid']);
  assert.deepEqual(p('overdue').states, ['overdue']);
  assert.deepEqual(p('paid').states, ['paid']);
  assert.deepEqual(p('quotations waiting for approval').states, ['waiting']);
  assert.deepEqual(p('credit notes').kinds, ['credit_note']);
  assert.deepEqual(p('estimates').kinds, ['quotation']);
  // "open" and "last" are how people ask, not filters or words to find.
  const o = p("open Willow Lane's last invoice");
  assert.deepEqual([o.kinds, o.states, o.text], [['invoice'], [], 'willow lane']);
  // Hindi.
  const h = p('पिछले महीने के बिल');
  assert.deepEqual([h.kinds, h.from, h.to], [['invoice'], '2026-10-01', '2026-10-31']);
});

test('a document number stays whole, never an amount or a date', () => {
  for (const n of ['QT/26-27/0019', 'INV-2026-0012', '1471']) {
    const q = p(n);
    assert.equal(q.text, n.toLowerCase(), n);
    assert.deepEqual([q.min, q.max, q.from, q.to], [null, null, null, null], n);
  }
});

test('amounts as people write them', () => {
  const b = p('between 50k and 2 lakh');
  assert.deepEqual([b.min, b.max, b.near], [5000000, 20000000, false]);
  const r = p('1-2 lakh quotations');
  assert.deepEqual([r.min, r.max, r.kinds], [10000000, 20000000, ['quotation']]);
  const e = p('₹1,18,000');
  assert.equal(e.near, true);
  assert.ok(e.min < 11800000 && e.max > 11800000 && e.max - e.min < 300000);
  assert.deepEqual(e.understood, ['About ₹1,18,000']);
  // Said back the way it was typed.
  assert.deepEqual([p('between 50k and 2 lakh').understood, p('above 2.5L').understood, p('under 1.5 cr').understood],
    [['₹50,000 to ₹2 lakh'], ['Over ₹2.5 lakh'], ['Under ₹1.5 crore']]);
  assert.deepEqual([p('under Rs 4500').max, p('above 2.5L').min, p('over 1 crore').min], [450000, 25000000, 1000000000]);
  const a = p('around 50000 rupees');
  assert.deepEqual([a.min, a.max, a.near], [4500000, 5500000, true]);
});

test('dates as people say them (the company date is 20 Nov 2026)', () => {
  const d = (s) => { const q = p(s); return [q.from, q.to]; };
  assert.deepEqual(d('invoices in October'), ['2026-10-01', '2026-10-31']);
  assert.deepEqual(d('oct 2025'), ['2025-10-01', '2025-10-31']);
  assert.deepEqual(d('december'), ['2025-12-01', '2025-12-31']);
  assert.deepEqual(d('this fy paid invoices'), ['2026-04-01', '2026-11-20']);
  assert.deepEqual(d('last fy'), ['2025-04-01', '2026-03-31']);
  assert.deepEqual(d('fy 2025-26'), ['2025-04-01', '2026-03-31']);
  assert.deepEqual(d('12 nov'), ['2026-11-12', '2026-11-12']);
  assert.deepEqual(d('25 dec'), ['2025-12-25', '2025-12-25']);
  assert.deepEqual(d('today'), ['2026-11-20', '2026-11-20']);
  assert.deepEqual(d('yesterday'), ['2026-11-19', '2026-11-19']);
  assert.deepEqual(d('this week'), ['2026-11-16', '2026-11-20']);
  assert.deepEqual(d('last week'), ['2026-11-09', '2026-11-15']);
  assert.deepEqual(d('this month'), ['2026-11-01', '2026-11-20']);
  assert.deepEqual(d('in 2025'), ['2025-01-01', '2025-12-31']);
  assert.deepEqual(d('12/11/2026'), ['2026-11-12', '2026-11-12']);
  const l = p('Pure Power 5.0 last 30 days');
  assert.deepEqual([l.from, l.to, l.text], ['2026-10-22', '2026-11-20', 'pure power 5.0']);
  // "may" is a word unless it is clearly the month.
  assert.deepEqual([p('may solar').from, p('may solar').text], [null, 'may solar']);
  assert.deepEqual(d('in may'), ['2026-05-01', '2026-05-31']);
  // January in a January: last month is December of the year before.
  const j = parseDocQuery('last month', '2027-01-10');
  assert.deepEqual([j.from, j.to], ['2026-12-01', '2026-12-31']);
});

test('where a document stands, in one plain word', () => {
  const s = (d) => docState(d, TODAY).label;
  assert.equal(s({ docType: 'quotation', status: 'draft' }), 'Draft');
  assert.equal(s({ docType: 'quotation', status: 'draft', approvalTo: 'x' }), 'Waiting for approval');
  assert.equal(s({ docType: 'quotation', status: 'issued', sentAt: null }), 'Not sent yet');
  assert.equal(s({ docType: 'quotation', status: 'sent', sentAt: '2026-11-19T10:00:00Z' }), 'With the customer');
  assert.equal(s({ docType: 'quotation', status: 'sent', sentAt: '2026-11-01T10:00:00Z', validUntil: '2026-11-15' }), 'Expired');
  assert.equal(s({ docType: 'quotation', status: 'accepted' }), 'Accepted');
  assert.equal(s({ docType: 'invoice', status: 'issued', sentAt: null, dueDate: '2026-12-01' }), 'Not sent yet');
  assert.equal(s({ docType: 'invoice', status: 'sent', sentAt: '2026-11-01', dueDate: '2026-12-01' }), 'Awaiting payment');
  assert.equal(s({ docType: 'invoice', status: 'sent', sentAt: '2026-11-01', dueDate: '2026-11-10' }), 'Overdue');
  assert.equal(s({ docType: 'invoice', status: 'part_paid', dueDate: '2026-12-01' }), 'Part-paid');
  assert.equal(s({ docType: 'invoice', status: 'paid', dueDate: '2026-11-10' }), 'Paid');
  assert.equal(s({ docType: 'invoice', status: 'cancelled' }), 'Cancelled');
  assert.equal(s({ docType: 'credit_note', status: 'issued' }), 'Issued');
});
