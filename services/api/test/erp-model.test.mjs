import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanBuyer, cleanDraft, cleanLines, documentInput, figures, milestonePlan } from '../dist/erp-model.js';
import { csvCell, salesRegisterCsv, tallyXml, zohoInvoicesCsv } from '../dist/erp-exports.js';
import { ESIGN_OPTIONS, mirrorStatus } from '../dist/erp-seams.js';

// ERP-INVOICE: what a draft save accepts, how a stored document becomes the renderer's input, and the exports.
// Synthetic clients, GSTINs and figures only.

test('a buyer with a GSTIN takes its state from it; a bad GSTIN is refused with a reason', () => {
  const b = cleanBuyer({ name: ' Northstar Homes LLP ', gstin: '29aaacn1234f1zt', stateCode: '27', address: ['12 Lake Road', '', 'Bengaluru'] });
  assert.deepEqual([b.name, b.gstin, b.stateCode, b.address], ['Northstar Homes LLP', '29AAACN1234F1ZT', '29', ['12 Lake Road', 'Bengaluru']]);
  assert.throws(() => cleanBuyer({ name: 'X', gstin: '29AAACN1234F1ZU' }), /GSTIN is not valid/);
  assert.equal(cleanBuyer({ name: 'Walk-in', stateCode: '27' }).stateCode, '27');
  assert.throws(() => cleanBuyer({ name: 'X', stateCode: '99' }), /state/);
});

test('lines: quantities, GST rates, SAC codes and discounts are checked', () => {
  const [l] = cleanLines([{ description: 'Ads', qty: '1.5', rate: 100000, gstRate: 18, sac: '998361', discountPercent: 10 }]);
  assert.deepEqual([l.qty, l.rate, l.discountPercent, l.discount], [1.5, 100000, 10, 0]);
  assert.throws(() => cleanLines([{ description: 'x', rate: 100, gstRate: 17 }]), /GST rate/);
  assert.throws(() => cleanLines([{ description: 'x', rate: 100.5 }]), /paise/);
  assert.throws(() => cleanLines([{ description: 'x', rate: 1, sac: '99' }]), /4 to 8 digits/);
  assert.throws(() => cleanLines([{ rate: 1 }]), /description is required/);
  assert.throws(() => cleanLines(Array.from({ length: 101 }, () => ({ description: 'x', rate: 1 }))), /100 lines/);
});

test('a draft: the place of supply defaults to the buyer state; zero-rated only for exports', () => {
  const d = cleanDraft({ issueDate: '2026-10-12', buyer: { name: 'Lakeview', gstin: '29AAACN1234F1ZT' }, lines: [{ description: 'Ads', rate: 10000000, gstRate: 18 }] });
  assert.equal(d.placeOfSupply, '29');
  const f = figures('27', d);
  assert.deepEqual([f.mode, f.igst, f.total], ['inter', 1800000, 11800000]);
  assert.throws(() => figures('27', { ...d, zeroRated: true }), /exports/);
  assert.throws(() => cleanDraft({ buyer: {}, lines: [] }), /Choose the date/);
  assert.throws(() => cleanDraft({ issueDate: '2026-13-40', lines: [] }), /date/);
});

test('a stored document becomes the renderer input with figures from its lines', () => {
  const row = { doc_type: 'invoice', status: 'issued', number: 'INV/26-27/0001', issue_date: new Date('2026-10-12T00:00:00Z'), due_date: '2026-10-27', valid_until: null,
    seller: { legalName: 'Synthetic LLP', stateCode: '27', gstin: '27AAXFV2138F1ZR' }, buyer: { name: 'Northstar' }, place_of_supply: '27', reference: { project: 'P' },
    notes: '', terms: null, reverse_charge: false, zero_rated: false, round_total: true, paid: '0', credited: '0' };
  const input = documentInput(row, [{ description: 'Ads', details: '', sac: '998361', unit: 'month', qty: '1.000', rate: '10000000', discount: '0', discount_percent: null, gst_rate: '18.000' }]);
  assert.equal(input.issueDate, '2026-10-12');
  assert.deepEqual(input.lines[0], { description: 'Ads', details: '', sac: '998361', unit: 'month', qty: 1, rate: 10000000, discount: 0, discountPercent: null, gstRate: 18 });
  assert.equal(input.notes, null);
  assert.deepEqual(documentInput({ ...row, source_ref: 'private-source-reference' }, []), documentInput(row, []), 'sourceRef never enters the PDF renderer input');
});

test('milestones from a package plan: percentages of the price, the last takes the rounding', () => {
  const plan = milestonePlan(10000000, [{ label: 'Advance', percent: 33.33 }, { label: 'Month 2', percent: 33.33, offsetDays: 30 }, { label: 'Month 3', percent: 33.34, offsetDays: 60 }], '2026-10-01');
  assert.deepEqual(plan.map((m) => [m.amount, m.dueOn]), [[3333000, '2026-10-01'], [3333000, '2026-10-31'], [3334000, '2026-11-30']]);
  assert.equal(plan.reduce((n, m) => n + m.amount, 0), 10000000);
  assert.deepEqual(milestonePlan(500000, [], null), [{ label: 'Full amount', amount: 500000, dueOn: null }]);
});

const doc = (o = {}) => ({ docType: 'invoice', number: 'INV/26-27/0001', status: 'sent', issueDate: '2026-10-12', dueDate: '2026-10-27', against: null,
  buyer: { name: 'Northstar Homes LLP', gstin: '27AABCS5678K1ZS', stateCode: '27' }, placeOfSupply: '27', taxMode: 'intra', taxable: 10000000, cgst: 900000, sgst: 900000, igst: 0,
  roundOff: 0, total: 11800000, paid: 5000000, credited: 0, notes: null, terms: null,
  lines: [{ description: 'Package: month 2', details: null, sac: '998361', unit: 'month', qty: 1, rate: 10000000, discount: 0, gstRate: 18, taxable: 10000000, cgst: 900000, sgst: 900000, igst: 0, total: 11800000 }], ...o });

test('exports: sales register, Zoho Books invoice import and Tally vouchers', () => {
  const reg = salesRegisterCsv([doc()]);
  assert.match(reg, /"INV\/26-27\/0001","Invoice","","Northstar Homes LLP","27AABCS5678K1ZS","Maharashtra \(27\)","100000.00","9000.00","9000.00","0.00","0.00","118000.00","50000.00","0.00","68000.00","sent"/);
  const zoho = zohoInvoicesCsv([doc(), doc({ status: 'cancelled', number: 'INV/26-27/0002' })]);
  assert.equal(zoho.trim().split('\r\n').length, 2, 'cancelled invoices are not mirrored');
  assert.match(zoho, /"business_gst","27AABCS5678K1ZS","MH"/);
  assert.match(zoho, /"GST18","18"/);
  const tally = tallyXml('Synthetic LLP', [doc(), doc({ docType: 'credit_note', number: 'CN/26-27/0001', against: 'INV/26-27/0001', taxable: 1000000, cgst: 90000, sgst: 90000, total: 1180000 })]);
  assert.match(tally, /<VOUCHER VCHTYPE="Sales"[^]*<LEDGERNAME>Northstar Homes LLP<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-118000.00<\/AMOUNT>/);
  assert.match(tally, /<LEDGERNAME>Sales - Services<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>100000.00<\/AMOUNT>/);
  assert.match(tally, /VCHTYPE="Credit Note"[^]*<AMOUNT>11800.00<\/AMOUNT>[^]*<LEDGERNAME>Sales - Services<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-10000.00<\/AMOUNT>/);
  assert.equal(csvCell('=SUM(A1)'), `"'=SUM(A1)"`);
  assert.equal(csvCell('-31.00'), '"-31.00"');
});

test('seams: no mirror sends anything; the e-sign options name the built-in link first', () => {
  assert.equal(mirrorStatus({}).enabled, false);
  assert.match(mirrorStatus({ PULSE_ERP_MIRROR: 'zoho-books' }).note, /not built yet/);
  assert.equal(ESIGN_OPTIONS[0].key, 'click');
});
