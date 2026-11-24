// QUOTE-FIXES: the "Quotes to follow up" rows on Home and My day (quote-moves.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteRows, whenWords } from './quote-moves.mjs';

const NOW = Date.parse('2026-11-21T06:00:00+05:30'); // Sat 21 Nov, 6 am IST

test('a proforma and a quotation not sent yet, and a follow-up on Monday, each with its link', () => {
  const rows = quoteRows({ notSent: 2, notSentDocs: [
    { documentId: 'p1', docType: 'proforma', number: 'PI/26-27/0007', client: 'ZZ TEST Mac QA' },
    { documentId: 'q2', docType: 'quotation', number: 'QT/26-27/0022', client: 'ZZ TEST Mac QA' }],
  followUps: [{ documentId: 'd1', number: 'QT/26-27/0021', client: 'ZZ TEST Mac QA', nextDueAt: '2026-11-23T03:30:00Z' }] }, NOW);
  assert.deepEqual(rows.map((r) => [r.title, r.sub, r.href, r.go]), [
    ['Proforma PI/26-27/0007 · ZZ TEST Mac QA', 'Not sent yet', '/erp/documents/p1', 'Send'],
    ['Quotation QT/26-27/0022 · ZZ TEST Mac QA', 'Not sent yet', '/erp/documents/q2', 'Send'],
    ['Follow up ZZ TEST Mac QA on QT/26-27/0021', 'Follow-up Mon, 23 Nov, 9:00 am', '/erp/documents/d1', 'Open'],
  ]);
});

test('more than five not sent: a "see all" row; an overdue follow-up is marked; nothing to do, no rows', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ documentId: `q${i}`, docType: 'quotation', number: `QT/${i}`, client: 'A' }));
  const rows = quoteRows({ notSent: 8, notSentDocs: many }, NOW);
  assert.deepEqual(rows.at(-1), { key: 'ns-more', title: '3 more not sent yet', sub: 'Quotations and proformas', href: '/erp/documents?q=not%20sent%20yet', go: 'See all', tone: 'warn' });
  assert.equal(whenWords('2026-11-21T03:30:00Z', NOW), 'today, 9:00 am');
  assert.equal(whenWords('2026-11-22T03:30:00Z', NOW), 'tomorrow, 9:00 am');
  const [late] = quoteRows({ followUps: [{ documentId: 'd2', number: 'QT/1', client: 'A', nextDueAt: '2026-11-20T03:30:00Z' }] }, NOW);
  assert.deepEqual([late.tone, late.sub], ['warn', 'Follow-up was due Fri, 20 Nov, 9:00 am']);
  assert.deepEqual(quoteRows(null, NOW), []);
  assert.deepEqual(quoteRows({ notSent: 0, notSentDocs: [], followUps: [] }, NOW), []);
});
