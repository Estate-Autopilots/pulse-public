// CONTRACTS-PRO: a contract's source is typeset as a legal document: parties, background, numbered clauses, fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { agreementClauses, buildContractModel, emptyFields, parseContract, readSource, renderContractPdf, runsOf, starterSource, writeSource, FONT_URLS } from '../src/index.js';

const plain = (runs) => runs.map((r) => r.text).join('');

test('numbers are given, never typed: clauses, sub-clauses, points and background letters', () => {
  const { title, blocks } = parseContract(`# Master Service Agreement\n## Background\n- One.\n- Two.\n## 6. Services\nThe first.\n\nThe second:\n- a point;\n  - a smaller point.\n## Fees\nOnly one paragraph.\n### Late payment\nInterest applies.\n## Schedule 1: The sheet\n| A | B |\n|---|---|\n| x | y |`);
  assert.equal(title, 'Master Service Agreement');
  const heads = blocks.filter((b) => b.kind === 'heading').map((b) => [b.number, b.title, b.part]);
  assert.deepEqual(heads, [[null, 'Background', 'recitals'], ['1', 'Services', 'clause'], ['2', 'Fees', 'clause'], ['2.2', 'Late payment', 'clause'], ['Schedule 1', 'The sheet', 'schedule']]);
  const nums = blocks.filter((b) => b.kind === 'para' || b.kind === 'item').map((b) => b.number);
  assert.deepEqual(nums, ['(A)', '(B)', '1.1', '1.2', '(a)', '(i)', '2.1', null]);
  const table = blocks.find((b) => b.kind === 'table');
  assert.equal(table.rows.length, 2, 'the separator row is not a row');
});

test('Markdown never shows: bold, defined terms and escapes become runs', () => {
  assert.deepEqual(runsOf('**Draft:** read it'), [{ text: 'Draft:', bold: true }, { text: ' read it' }]);
  const r = runsOf('"Services" means the work (the "Company") and \\*stars\\*');
  assert.equal(plain(r), '“Services” means the work (the “Company”) and *stars*');
  assert.ok(r.find((x) => x.text === '“Services”' && x.bold) && r.find((x) => x.text === '“Company”' && x.bold));
});

test('the facts line round-trips and stays out of the clauses', () => {
  const src = starterSource('service', { place: 'Pune', parties: [{ name: 'A Private Limited', type: 'private_limited', defined: 'Provider' }, { name: 'B LLP', type: 'llp', defined: 'Client' }], deal: { fee: '₹40,000 a month' } });
  const { meta, text } = readSource(src);
  assert.equal(meta.type, 'service'); assert.equal(meta.parties[1].name, 'B LLP'); assert.equal(meta.deal.fee, '₹40,000 a month');
  assert.equal(writeSource(meta, text), src);
  assert.ok(!agreementClauses(src).some((c) => /pulse:contract/.test(c.text)), 'old views never show the facts line');
  // Fields with no value block sending; filled ones do not.
  const gaps = emptyFields(src);
  assert.ok(gaps.includes('deal.start') && !gaps.includes('deal.fee'));
  assert.ok(!/\{\{[a-z_]+\}\}/.test(src), "document fields never look like a quotation's blank to the database");
});

test('a "-->" in a party name cannot end the facts line', () => {
  const src = writeSource({ type: 'nda', parties: [{ name: 'X --> Y', type: 'other', defined: 'First Party' }], deal: {} }, '## Purpose\nText');
  assert.equal(readSource(src).meta.parties[0].name, 'X --> Y');
});

test('the PDF: letterhead, parties block, signatures and a certificate page when signed', async () => {
  const fonts = { regular: await readFile(FONT_URLS.regular), semibold: await readFile(FONT_URLS.semibold) };
  const body = starterSource('service', { date: '2026-11-15', place: 'Pune', parties: [{ name: 'A Private Limited', type: 'private_limited', defined: 'Provider' }, { name: 'B LLP', type: 'llp', defined: 'Client' }],
    deal: { fee: '₹40,000 a month', gst: 'plus GST', billing: 'monthly', start: '1 Nov 2026', review: '21 Nov 2026', notice: '30 days’', city: 'Pune' } });
  const draft = buildContractModel({}, { title: 'MSA', body, status: 'draft', version: 1, company: { name: 'A Private Limited', lines: ['Pune'] }, parties: [{ name: 'A Private Limited' }, { name: 'B LLP' }] });
  assert.equal(draft.parties.length, 2, 'rows and facts are matched, not doubled');
  const d = await renderContractPdf(draft, { fonts });
  assert.ok(d.pages >= 2 && Buffer.from(d.bytes.slice(0, 5)).toString() === '%PDF-');
  const signed = buildContractModel({}, { title: 'MSA', body, status: 'active', version: 1, sha256: 'ab'.repeat(32), parties: [{ name: 'A Private Limited', signer: 'K M', signedAt: '15 Nov 2026', signKind: 'typed' }, { name: 'B LLP', signer: 'D N', signedAt: '15 Nov 2026', signKind: 'typed' }],
    audit: [{ at: '15 Nov 2026', what: 'Signed', who: 'K M' }] });
  const s = await renderContractPdf(signed, { fonts });
  assert.equal(s.pages, d.pages + 1, 'a signed copy ends with its certificate page');
});

test('a typed name is written as handwriting strokes; a name the face cannot write falls back to type', async () => {
  const { scriptSignature, scriptSignatureSvg } = await import('../src/index.js');
  const s = scriptSignature('Kedab Mifos');
  assert.ok(s && s.width > 100 && /^M[\d.]+,\d+/.test(s.d) && !/NaN/.test(s.d));
  assert.ok(scriptSignature('Kedab  Mifos').width === s.width, 'spaces collapse');
  assert.equal(scriptSignature('José'), null);
  assert.equal(scriptSignature('   '), null);
  assert.match(scriptSignatureSvg('Diya Nair'), /stroke-linecap="round"/);
});

test('a cross-reference follows renumbering, and a broken one is a gap that blocks sending', async () => {
  const { buildContractModel, clauseRefs, emptyFields, writeSource, contractFields } = await import('../src/index.js');
  const meta = { type: 'service', parties: [], deal: {} };
  const text = '## Definitions\nWords.\n## Fees\nAs set out in clause {{ref.definitions}} and {{ref.the_sheet}}.\n## Schedule 1: The sheet\n| a | b |';
  const refs = clauseRefs(text);
  assert.equal(refs.get('ref.fees').number, '2');
  assert.equal(refs.get('ref.the_sheet').number, 'Schedule 1');
  const moved = '## Fees\nAs set out in clause {{ref.definitions}}.\n## Definitions\nWords.';
  const m = buildContractModel({}, { title: 'T', body: writeSource(meta, moved), status: 'draft', version: 1 });
  const para = m.blocks.find((b) => b.kind === 'para' && b.runs.some((r) => r.filled));
  assert.equal(para.runs.map((r) => r.text).join(''), 'As set out in clause 2.');
  assert.deepEqual(emptyFields(writeSource(meta, text)), []);
  assert.deepEqual(emptyFields(writeSource(meta, '## Fees\nSee clause {{ref.gone}}.')), ['ref.gone']);
  assert.ok(contractFields(meta, text).some((f) => f.key === 'ref.definitions' && f.label === 'Clause no.: Definitions' && f.value === '1'));
});
