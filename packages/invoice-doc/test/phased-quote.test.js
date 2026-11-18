// QUOTE-STRUCT (Kazuk's build guide, 16 Nov 2026): a quotation printed phase by phase. Synthetic seller, buyer and items.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import JSZip from 'jszip';
import { buildModel, FONT_URLS, phasedName, phasedRows, renderDocx, renderPdf } from '../src/index.js';

const fonts = { regular: await readFile(FONT_URLS.regular), semibold: await readFile(FONT_URLS.semibold) };
const seller = { legalName: 'Synthetic Studio LLP', gstin: '27AAXFV2138F1ZR', stateCode: '27', address: ['1 Test Road, Pune 411001'] };
const pkg = 'Bundle Two · your team and your ad spend stay yours';
const P1 = { phase: 'Phase 1: Plan', phaseOrder: 0 }, P2 = { phase: 'Phase 2: Make', phaseOrder: 1 }, P3 = { phase: 'Phase 3: Run', phaseOrder: 2 };
export const LINES = [
  { description: 'Market study', rate: 420000, qty: 1, gstRate: 18, packageLabel: pkg, ...P1 },
  { description: 'Video ad (standard)', rate: 3350550, qty: 2, gstRate: 18, packageLabel: pkg, ...P2, phaseGroup: 'Attention' },
  { description: 'First test', rate: 0, qty: 1, gstRate: 18, role: 'included', packageLabel: pkg, ...P2, phaseGroup: 'Attention' },
  { description: 'Ads and nurturing', rate: 700000, qty: 4, unit: 'month', gstRate: 18, packageLabel: pkg, ...P3 },
  { description: 'Positioning', rate: 90000, qty: 1, gstRate: 18, packageLabel: pkg, ...P1 },
  { description: 'Landing page', rate: 1370275, qty: 1, gstRate: 18, packageLabel: pkg, ...P2, phaseGroup: 'Trust' },
  { description: 'Coaching', rate: 0, qty: 1, gstRate: 18, role: 'to_quote', ...P3 },
  { description: 'Partner kit', rate: 0, qty: 1, gstRate: 18, role: 'bonus', listRate: 1000000 },
  { description: 'Our own extra line', rate: 50000, qty: 1, gstRate: 18 },
];
const quote = (lines = LINES) => ({ docType: 'quotation', status: 'draft', number: null, issueDate: '2026-11-17', validUntil: '2026-12-17', seller, buyer: { name: 'Synthetic Builders', stateCode: '27' }, lines });

test('the quantity goes in the name; a monthly line shows its monthly rate and months', () => {
  assert.equal(phasedName({ description: 'Video ad', qty: 2, rate: 100 }), 'Video ad × 2');
  assert.equal(phasedName({ description: 'Video ad', qty: 1, rate: 100 }), 'Video ad');
  assert.equal(phasedName({ description: 'Ads', qty: 4, unit: 'month', rate: 700000 }), 'Ads · ₹7,000/mo × 4 months');
  assert.equal(phasedName({ description: 'Ads', qty: 1, unit: 'Month', rate: 700050 }), 'Ads · ₹7,000.50/mo × 1 month');
});

test('rows: the package heading, then each phase in order with its sub-groups, loose lines, then bonuses; no subtotals', () => {
  const rows = phasedRows(LINES.map((l) => ({ ...l, taxable: Math.round(l.rate * l.qty) })));
  const said = rows.map((r) => `${r.kind ?? 'line'}:${r.cells.item}=${r.cells.total}`);
  assert.deepEqual(said, [
    'intro:Bundle Two=',
    'heading:Phase 1: Plan=', 'line:Market study=₹4,200', 'line:Positioning=₹900',
    'heading:Phase 2: Make=', 'group:Attention=', 'line:Video ad (standard) × 2=₹67,011', 'line:First test=Included', 'group:Trust=', 'line:Landing page=₹13,702.75',
    'heading:Phase 3: Run=', 'line:Ads and nurturing · ₹7,000/mo × 4 months=₹28,000', 'line:Coaching=To be quoted',
    'heading:Other items=', 'line:Our own extra line=₹500',
    'heading:Bonuses included=', 'line:Partner kit=₹0',
  ]);
  assert.equal(rows[0].sub.item, 'your team and your ad spend stay yours');
  const bonus = rows.at(-1);
  assert.equal(bonus.sub.total, '₹10,000');
  assert.equal(bonus.strike, 'total');
  assert.ok(!said.some((s) => /subtotal/i.test(s)));
});

test('packages made one per phase share one heading', () => {
  const rows = phasedRows([{ description: 'A', rate: 100, qty: 1, packageLabel: 'Sell-Out · Phase 1', phase: 'Phase 1' }, { description: 'B', rate: 100, qty: 1, packageLabel: 'Sell-Out · Phase 2', phase: 'Phase 2' },
    { description: 'C', rate: 100, qty: 1, packageLabel: 'Other bundle · its note', phase: 'Phase 2' }]);
  assert.deepEqual(rows.filter((r) => r.kind === 'intro').map((r) => [r.cells.item, r.sub.item]), [['Sell-Out', ''], ['Other bundle', 'its note']]);
});

test('the model of a phased quotation has Item and Amount only and one total; free lines add nothing', () => {
  const m = buildModel({}, quote());
  assert.deepEqual(m.table.columns.map((c) => c.key), ['item', 'total']);
  assert.ok(Math.abs(m.table.columns.reduce((n, c) => n + c.width, 0) - 1) < 1e-9);
  const taxable = 420000 + 3350550 * 2 + 700000 * 4 + 90000 + 1370275 + 50000;
  assert.equal(m.computed.taxable, taxable);
  assert.equal(m.totals.filter((t) => t.strong).length, 1);
  assert.ok(!m.table.rows.some((r) => /0\.00/.test(r.cells.total ?? '')));
});

test('a quotation without phases, packages or roles keeps the classic table', () => {
  const m = buildModel({}, quote([{ description: 'Service', rate: 100000, qty: 2, gstRate: 18 }]));
  assert.ok(m.table.columns.some((c) => c.key === 'qty'));
  assert.ok(!m.table.rows.some((r) => r.kind));
});

test('an invoice made from a phased quotation keeps its columns and prints Included for a free line', () => {
  const m = buildModel({}, { ...quote(), docType: 'invoice', number: 'INV/1' });
  assert.ok(m.table.columns.some((c) => c.key === 'qty'));
  assert.equal(m.table.rows.find((r) => r.cells.item === 'First test').cells.total, 'Included');
});

test('the phased PDF and DOCX render, headings and all', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ ...LINES[i % LINES.length], description: `${LINES[i % LINES.length].description} ${i}` }));
  const { bytes, pages } = await renderPdf(buildModel({ style: 'band' }, quote(many)), { fonts });
  assert.ok(bytes.length > 1000 && pages >= 2);
  const docx = await renderDocx(buildModel({}, quote()), { fonts });
  const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml').async('string');
  assert.ok(xml.includes('Phase 2: Make') && xml.includes('To be quoted') && xml.includes('<w:strike/>'));
});
