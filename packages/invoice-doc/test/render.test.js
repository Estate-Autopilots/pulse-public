// ERP-INVOICE: the document model and its PDF and DOCX writers. Synthetic seller, buyer and figures.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { buildModel, FONT_URLS, imageSize, normaliseDesign, renderDocx, renderPdf, sampleDocument } from '../src/index.js';

const fonts = { regular: await readFile(FONT_URLS.regular), semibold: await readFile(FONT_URLS.semibold) };
const seller = { legalName: 'Synthetic Studio LLP', gstin: '27AAXFV2138F1ZR', stateCode: '27', address: ['1 Test Road, Pune 411001'], email: 'billing@example.test' };
// A 2×1 PNG (red, white).
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEElEQVR4nGP4z8DwHwqYGQA3ywH/9C2u8wAAAABJRU5ErkJggg==', 'base64'));

test('a template design is completed with safe defaults', () => {
  const d = normaliseDesign({ style: 'neon', accent: 'red', show: { bank: false, lineTax: 'yes' }, fontScale: 4 });
  assert.equal(d.style, 'line');
  assert.equal(d.accent, '#5b45d6');
  assert.equal(d.show.bank, false);
  assert.equal(d.show.lineTax, false);
  assert.equal(d.fontScale, 1.15);
});

test('the model says what a GST invoice must: number, date, place of supply, GSTINs, tax split, total in words', () => {
  const m = buildModel({ show: { lineTax: true } }, sampleDocument(seller, { number: 'INV/26-27/0001' }));
  assert.equal(m.title, 'Tax Invoice');
  assert.equal(m.draft, false);
  const meta = Object.fromEntries(m.meta);
  assert.equal(meta['Invoice no.'], 'INV/26-27/0001');
  assert.equal(meta['Place of supply'], 'Maharashtra (27)');
  assert.equal(meta['Reverse charge'], 'No');
  assert.ok(m.seller.lines.includes('GSTIN 27AAXFV2138F1ZR'));
  assert.ok(m.parties[0].lines.includes('GSTIN 27AABCS5678K1ZS'));
  assert.deepEqual(m.table.columns.map((c) => c.key), ['n', 'item', 'sac', 'qty', 'rate', 'taxable', 'cgst', 'sgst', 'total']);
  assert.ok(m.totals.some((t) => t.label === 'CGST 9%') && m.totals.some((t) => t.label === 'SGST 9%'));
  assert.equal(m.totals.at(-1).label, 'Total');
  assert.match(m.words, /^Rupees .* Only$/);
  // Inter-state: one IGST column and an IGST total.
  const inter = buildModel({ show: { lineTax: true } }, sampleDocument(seller, { inter: true }));
  assert.deepEqual(inter.table.columns.filter((c) => /gst/.test(c.key)).map((c) => c.key), ['igst']);
  assert.ok(inter.totals.some((t) => t.label === 'IGST 18%'));
  assert.equal(inter.draft, true);
});

test('each kind of document has its own title and wording', () => {
  const q = buildModel({}, sampleDocument(seller, { docType: 'quotation' }));
  assert.equal(q.title, 'Quotation');
  assert.equal(q.parties[0].heading, 'Prepared for');
  assert.ok(Object.fromEntries(q.meta)['Valid until']);
  assert.match(q.notes, /not a demand for payment/);
  const cn = buildModel({}, sampleDocument(seller, { docType: 'credit_note' }));
  assert.equal(Object.fromEntries(cn.meta)['Against invoice'], 'EA/26-27/014, 30 Sep 2026');
  assert.equal(cn.totals.at(-1).label, 'Total credit');
  assert.match(buildModel({}, sampleDocument(seller, { docType: 'proforma' })).notes, /not a tax invoice/);
  assert.equal(buildModel({ titles: { invoice: 'Invoice' } }, sampleDocument(seller)).title, 'Invoice');
});

test('the bank block and balance follow the template and the payments', () => {
  const bank = { accountName: 'Synthetic Studio LLP', bankName: 'Test Bank', accountNumber: '000011112222', ifsc: 'TEST0000001' };
  assert.deepEqual(buildModel({ bank }, sampleDocument(seller)).bank.map(([k]) => k), ['Account name', 'Bank', 'Account no.', 'IFSC']);
  assert.equal(buildModel({ bank, show: { bank: false } }, sampleDocument(seller)).bank, null);
  // EST-1261: a quotation shows the bank block and the authorised signatory as well; a credit note never shows the bank.
  const quote = buildModel({ bank, signature: { name: 'Synthetic Signer', title: 'Director' } }, sampleDocument(seller, { docType: 'quotation' }));
  assert.deepEqual(quote.bank.map(([k]) => k), ['Account name', 'Bank', 'Account no.', 'IFSC']);
  assert.equal(quote.signature.name, 'Synthetic Signer');
  assert.equal(buildModel({ bank, show: { bank: false } }, sampleDocument(seller, { docType: 'quotation' })).bank, null);
  assert.equal(buildModel({ bank }, sampleDocument(seller, { docType: 'credit_note' })).bank, null);
  const paid = buildModel({}, { ...sampleDocument(seller, { number: 'INV/26-27/0002' }), paid: 5000000 });
  assert.equal(paid.balance[0].label, 'Amount received');
});

test('image sizes are read from PNG and JPEG headers', () => {
  assert.deepEqual(imageSize(PNG, 'image/png'), { width: 2, height: 1 });
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 30, 0, 40, 3, 1, 1]);
  assert.deepEqual(imageSize(jpeg, 'image/jpeg'), { width: 40, height: 30 });
  assert.equal(imageSize(PNG, 'image/gif'), null);
});

test('the PDF is the same bytes every time for the same document, and long documents run onto more pages', async () => {
  const doc = sampleDocument(seller, { number: 'INV/26-27/0003' });
  const design = { style: 'band', show: { lineTax: true }, bank: { accountNumber: '1', ifsc: 'TEST0000001' }, terms: 'Synthetic terms.\nSecond line.', footer: 'Synthetic footer' };
  const m = buildModel(design, doc, { logo: { bytes: PNG, mime: 'image/png' } });
  const a = await renderPdf(m, { fonts });
  const b = await renderPdf(m, { fonts });
  assert.equal(Buffer.from(a.bytes.slice(0, 5)).toString(), '%PDF-');
  assert.ok(Buffer.from(a.bytes).equals(Buffer.from(b.bytes)), 'deterministic output');
  assert.equal(a.pages, 1);
  const loaded = await PDFDocument.load(a.bytes);
  assert.equal(loaded.getPageCount(), 1);
  assert.equal(loaded.getTitle(), 'Tax Invoice INV/26-27/0003');
  const long = { ...doc, lines: Array.from({ length: 70 }, (_, i) => ({ description: `Synthetic deliverable ${i + 1} with a description long enough to wrap onto a second line of the table`, sac: '998361', qty: 1, rate: 100000 + i, gstRate: 18 })) };
  const many = await renderPdf(buildModel(design, long), { fonts });
  assert.ok(many.pages >= 3, `70 lines took ${many.pages} pages`);
  // Characters the font lacks become "?" instead of failing.
  const odd = await renderPdf(buildModel({}, { ...doc, buyer: { ...doc.buyer, name: 'नॉर्थस्टार Homes ✓' } }), { fonts });
  assert.equal(odd.pages, 1);
});

test('the DOCX holds the same words and figures', async () => {
  const m = buildModel({ show: { lineTax: true }, terms: 'Synthetic terms.' }, sampleDocument(seller, { number: 'INV/26-27/0004', inter: true }), { logo: { bytes: PNG, mime: 'image/png' } });
  const bytes = await renderDocx(m, { fonts });
  assert.equal(Buffer.from(bytes.slice(0, 2)).toString(), 'PK');
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml').async('string');
  for (const text of ['Tax Invoice', 'INV/26-27/0004', 'Lakeview Developers Pvt Ltd', 'Karnataka (29)', 'IGST 18%', m.totals.at(-1).value, m.words, 'Synthetic terms.']) {
    assert.ok(xml.includes(text.replace(/&/g, '&amp;')), `document.xml has ${text}`);
  }
  assert.ok(Object.keys(zip.files).some((f) => f.startsWith('word/media/')), 'the logo is embedded');
});
