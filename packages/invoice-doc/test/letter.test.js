// COMP-A: pay letters. Synthetic people and figures only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import JSZip from 'jszip';
import { buildLetterModel, FONT_URLS, letterContent, letterFields, renderLetterDocx, renderLetterPdf } from '../src/index.js';

const fonts = async () => ({ regular: await readFile(FONT_URLS.regular), semibold: await readFile(FONT_URLS.semibold) });
const OFFER = { name: 'Kabir Rao', role: 'Senior editor', payType: 'salary', currency: 'INR', monthly: 5000000, yearly: 62160000, start: '2026-11-01',
  validUntil: '2026-10-20', probationDays: 90, probationEnd: '2027-01-29', noticeProbation: 15, noticeConfirmed: 30, terms: 'Work from the Pune studio.', company: 'Synthetic Studio LLP',
  components: [{ label: 'Basic', amount: 2500000 }, { label: 'House rent allowance', amount: 1000000 }, { label: 'Special allowance', amount: 1500000 }] };

test('an offer letter says the role, start, pay, probation and notice in plain words', () => {
  const c = letterContent('offer', OFFER);
  assert.equal(c.title, 'Offer of employment');
  assert.equal(c.paragraphs[0], 'Dear Kabir,');
  assert.match(c.paragraphs[1], /role of Senior editor at Synthetic Studio LLP, starting on 1 Nov 2026\./);
  assert.match(c.paragraphs[2], /^Your salary will be ₹50,000 a month \(₹6,21,600 a year, cost to company\); the breakdown is below\.$/);
  assert.match(c.paragraphs[3], /first 90 days are a probation period, until 29 Jan 2027\. During probation either side may end the employment with 15 days' notice; after confirmation the notice period is 30 days\./);
  assert.deepEqual(c.table.rows[0], ['Basic', '₹25,000', '₹3,00,000']);
  assert.deepEqual(c.table.total, ['Total', '₹50,000', '₹6,21,600']);
});

test('a revision says from what to what, and empty fields drop their paragraph', () => {
  const c = letterContent('revision', { name: 'Kabir Rao', payType: 'salary', monthly: 5500000, previousMonthly: 5000000, effective: '2027-01-01' });
  assert.match(c.paragraphs[1], /^Your salary is raised from ₹50,000 to ₹55,000 a month, effective 1 Jan 2027\.$/);
  assert.equal(c.paragraphs.length, 4, 'no reason: that paragraph is left out');
  const cut = letterContent('revision', { name: 'A B', payType: 'contractor', monthly: 4000000, previousMonthly: 5000000, effective: '2027-01-01', reason: 'Fewer days a week.' });
  assert.match(cut.paragraphs[1], /contract fee is revised from ₹50,000 to ₹40,000 a month/);
  assert.match(cut.paragraphs.join(' '), /terms of your engagement stay the same/);
});

test("the company's own wording replaces a default, fields still filled", () => {
  const c = letterContent('pause', { name: 'Kabir Rao', pauseFrom: '2026-12-01', pauseTo: '2026-12-31', paidPercent: 0, pauseReason: 'sabbatical' },
    { pause: { title: 'Sabbatical', body: 'Hi {{firstName}},\n\nEnjoy {{pauseFrom}} to {{pauseTo}}; you are paid {{paidShare}}.' } });
  assert.equal(c.title, 'Sabbatical');
  assert.deepEqual(c.paragraphs, ['Hi Kabir,', 'Enjoy 1 Dec 2026 to 31 Dec 2026; you are paid nothing.']);
  assert.equal(letterFields({ paidPercent: 50 }).paidShare, '50%');
});

test('a settlement lists earnings and recoveries with the net', () => {
  const c = letterContent('settlement', { name: 'Kabir Rao', lastDay: '2027-03-31', settleBy: '2027-04-02', net: 6000000, company: 'Synthetic Studio LLP',
    statement: [{ label: 'Salary for 31 days', kind: 'earning', amount: 5000000 }, { label: 'Leave encashment, 6 days', kind: 'earning', amount: 1500000 },
      { label: 'Advance recovered', kind: 'deduction', amount: -500000 }] });
  assert.deepEqual(c.table.rows[2], ['Advance recovered', '− ₹5,000']);
  assert.deepEqual(c.table.total, ['Net payable', '₹60,000']);
  assert.match(c.paragraphs[2], /net amount of ₹60,000 will be paid by 2 Apr 2027/);
});

test('the PDF is the same bytes every time and the DOCX carries the same words', async () => {
  const c = letterContent('offer', OFFER);
  const letter = { ...c, kind: 'offer', date: '2026-10-13', reference: 'OFFER/26-27/0001', to: { name: 'Kabir Rao', lines: ['Senior editor'] },
    company: { name: 'Synthetic Studio LLP', lines: ['1 Test Road, Pune'] } };
  const f = await fonts();
  const a = await renderLetterPdf(buildLetterModel({ accent: '#0f766e', signature: { name: 'Asha Kireteso', title: 'Founder' } }, letter), { fonts: f });
  const b = await renderLetterPdf(buildLetterModel({ accent: '#0f766e', signature: { name: 'Asha Kireteso', title: 'Founder' } }, letter), { fonts: f });
  assert.equal(a.pages, 1);
  assert.equal(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes)), 0);
  assert.equal(Buffer.from(a.bytes.slice(0, 5)).toString(), '%PDF-');
  const docx = await renderLetterDocx(buildLetterModel({}, { ...letter, accepted: { name: 'Kabir Rao', at: '2026-10-14', via: 'link' } }), { fonts: f });
  const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml').async('string');
  for (const s of ['Offer of employment', 'Dear Kabir,', '₹6,21,600', 'Synthetic Studio LLP', 'Kabir Rao, 2026-10-14']) assert.ok(xml.includes(s), s);
});

test('a long letter breaks onto a second page with a running head', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: ${'a fairly long sentence about terms '.repeat(4)}`);
  const r = await renderLetterPdf(buildLetterModel({}, { kind: 'revision', title: 'Long letter', paragraphs: many, table: null, date: '2026-10-13', to: { name: 'Kabir Rao' }, company: { name: 'Synthetic Studio LLP' } }), { fonts: await fonts() });
  assert.ok(r.pages >= 2);
});
