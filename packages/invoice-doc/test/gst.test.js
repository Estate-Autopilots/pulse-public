// ERP-INVOICE: the GST arithmetic every invoice prints. Synthetic figures only.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addDays, amountInWords, computeDocument, divRound, financialYear, formatAmount, formatDate, formatDocNumber, formatInr, gstinCheckChar,
  milli, numberProblem, panFromGstin, perMillion, rupeesInWords, stateFromGstin, stateLabel, taxMode, toPaise, validGstin,
} from '../src/gst.js';

const line = (rate, gstRate = 18, extra = {}) => ({ description: 'Service', qty: 1, rate, gstRate, ...extra });

test('intra-state: CGST and SGST at half the rate each, the total and its words', () => {
  const d = computeDocument({ sellerState: '27', placeOfSupply: '27', lines: [line(10000000)] });
  assert.equal(d.mode, 'intra');
  assert.equal(d.split, 'SGST');
  assert.deepEqual([d.taxable, d.cgst, d.sgst, d.igst, d.tax, d.total, d.roundOff], [10000000, 900000, 900000, 0, 1800000, 11800000, 0]);
  assert.equal(d.words, 'Rupees One Lakh Eighteen Thousand Only');
});

test('inter-state: IGST at the full rate; the place of supply decides, not the address', () => {
  const d = computeDocument({ sellerState: '27', placeOfSupply: '29', lines: [line(10000000)] });
  assert.equal(d.mode, 'inter');
  assert.deepEqual([d.cgst, d.sgst, d.igst, d.total], [0, 0, 1800000, 11800000]);
  // No place of supply given: the seller's own state (an intra-state supply).
  assert.equal(computeDocument({ sellerState: '27', lines: [line(100)] }).mode, 'intra');
  assert.equal(taxMode('27', '96'), 'inter');
  assert.throws(() => taxMode('27', '99'), /Unknown place of supply/);
  assert.throws(() => taxMode('', '27'), /seller needs a GST state/);
});

test('union territories without a legislature charge UTGST; Delhi and Puducherry charge SGST', () => {
  assert.equal(computeDocument({ sellerState: '04', placeOfSupply: '04', lines: [line(100000)] }).split, 'UTGST');
  assert.equal(computeDocument({ sellerState: '38', placeOfSupply: '38', lines: [line(100000)] }).split, 'UTGST');
  assert.equal(computeDocument({ sellerState: '07', placeOfSupply: '07', lines: [line(100000)] }).split, 'SGST');
  assert.equal(computeDocument({ sellerState: '34', placeOfSupply: '34', lines: [line(100000)] }).split, 'SGST');
  // A Maharashtra seller billing Chandigarh: inter-state, IGST.
  assert.equal(computeDocument({ sellerState: '27', placeOfSupply: '04', lines: [line(100000)] }).mode, 'inter');
});

test('rounding: each tax component per line to the paisa, half away from zero; totals are sums of printed figures', () => {
  // ₹100.05 at 18%: CGST 9.0045 → 9.00 and SGST 9.00 (18.00 together); IGST 18.009 → 18.01.
  const intra = computeDocument({ sellerState: '27', placeOfSupply: '27', roundTotal: false, lines: [line(10005)] });
  assert.deepEqual([intra.cgst, intra.sgst, intra.total], [900, 900, 11805]);
  const inter = computeDocument({ sellerState: '27', placeOfSupply: '29', roundTotal: false, lines: [line(10005)] });
  assert.deepEqual([inter.igst, inter.total], [1801, 11806]);
  // ₹0.25 at 18% = 0.045 → 0.05 IGST (half up), CGST 0.0225 → 0.02 each.
  assert.equal(computeDocument({ sellerState: '27', placeOfSupply: '29', lines: [line(25)], roundTotal: false }).igst, 5);
  assert.equal(computeDocument({ sellerState: '27', placeOfSupply: '27', lines: [line(25)], roundTotal: false }).cgst, 2);
  // Three lines: the document's tax is the sum of the three rounded line taxes.
  const three = computeDocument({ sellerState: '27', placeOfSupply: '27', roundTotal: false, lines: [line(10005), line(10005), line(10005)] });
  assert.equal(three.cgst, 2700);
  assert.equal(three.lines.reduce((n, l) => n + l.cgst, 0), three.cgst);
});

test('the grand total rounds to the rupee with a round-off line of at most fifty paise', () => {
  const down = computeDocument({ sellerState: '27', placeOfSupply: '29', lines: [line(10005), line(333, 5, { qty: 1.5 })] });
  assert.equal(down.exact, 12331);
  assert.deepEqual([down.total, down.roundOff], [12300, -31]);
  const up = computeDocument({ sellerState: '27', placeOfSupply: '27', lines: [line(5000, 0, { gstRate: 0 }), line(50, 0)] });
  assert.deepEqual([up.exact, up.total, up.roundOff], [5050, 5100, 50]);
  const exact = computeDocument({ sellerState: '27', placeOfSupply: '27', roundTotal: false, lines: [line(10005)] });
  assert.deepEqual([exact.total, exact.roundOff], [11805, 0]);
  assert.equal(computeDocument({ sellerState: '27', lines: [line(10005)] }).words, 'Rupees One Hundred Eighteen Only');
});

test('quantities with decimals, percentage and fixed discounts come off before tax', () => {
  const half = computeDocument({ sellerState: '27', placeOfSupply: '27', lines: [line(333, 18, { qty: 1.5 })], roundTotal: false });
  assert.equal(half.lines[0].amount, 500); // 499.5 → 500
  const pct = computeDocument({ sellerState: '27', placeOfSupply: '27', lines: [line(10000000, 18, { discountPercent: 10 })] });
  assert.deepEqual([pct.discount, pct.taxable, pct.cgst, pct.total], [1000000, 9000000, 810000, 10620000]);
  const fixed = computeDocument({ sellerState: '27', placeOfSupply: '29', lines: [line(10000000, 18, { discount: 250000 })] });
  assert.deepEqual([fixed.taxable, fixed.igst], [9750000, 1755000]);
  assert.throws(() => computeDocument({ sellerState: '27', lines: [line(100, 18, { discount: 101 })] }), /discount is more than the amount/);
  assert.throws(() => computeDocument({ sellerState: '27', lines: [line(100, 18, { qty: 0 })] }), /positive number/);
  assert.throws(() => computeDocument({ sellerState: '27', lines: [line(100, 18, { qty: 1.2345 })] }), /three decimals/);
  assert.throws(() => computeDocument({ sellerState: '27', lines: [line(10.5)] }), /whole paise/);
});

test('several rates: a tax line per rate and a SAC/HSN summary', () => {
  const d = computeDocument({ sellerState: '27', placeOfSupply: '27', lines: [
    { description: 'Ads', sac: '998361', qty: 1, rate: 1000000, gstRate: 18 }, { description: 'Shoot', sac: '998382', qty: 1, rate: 500000, gstRate: 18 },
    { description: 'Print', sac: '4911', qty: 10, rate: 10000, gstRate: 12 }, { description: 'Exempt', sac: '9992', qty: 1, rate: 20000, gstRate: 0 }] });
  assert.deepEqual(d.byRate.map((g) => [g.gstRate, g.taxable, g.cgst]), [[0, 20000, 0], [12, 100000, 6000], [18, 1500000, 135000]]);
  assert.deepEqual(d.bySac.map((g) => g.sac), ['998361', '998382', '4911', '9992']);
  assert.equal(d.tax, 2 * (6000 + 135000));
});

test('reverse charge shows the tax but leaves it out of the amount payable; zero-rated exports carry none', () => {
  const rcm = computeDocument({ sellerState: '27', placeOfSupply: '27', reverseCharge: true, lines: [line(10000000)] });
  assert.deepEqual([rcm.tax, rcm.total], [1800000, 10000000]);
  const lut = computeDocument({ sellerState: '27', placeOfSupply: '96', zeroRated: true, lines: [line(10000000)] });
  assert.deepEqual([lut.mode, lut.igst, lut.total], ['inter', 0, 10000000]);
  const withIgst = computeDocument({ sellerState: '27', placeOfSupply: '96', lines: [line(10000000)] });
  assert.equal(withIgst.igst, 1800000);
});

test('GSTIN: shape, state and the check character', () => {
  assert.equal(validGstin('27AAXFV2138F1ZR'), true); // Vikriya Solutions LLP, printed on every EA invoice
  assert.equal(gstinCheckChar('27AAXFV2138F1Z'), 'R');
  assert.equal(validGstin('27AAXFV2138F1ZS'), false); // wrong check character
  assert.equal(validGstin('99AAXFV2138F1ZR'), false); // no such state
  assert.equal(validGstin('27aaxfv2138f1zr'), true); // read in capitals
  assert.equal(validGstin('27AAXFV2138F1Z'), false);
  assert.equal(stateFromGstin('29AAACN1234F1ZT'), '29');
  assert.equal(stateFromGstin('29AAACN1234F1ZU'), null);
  assert.equal(panFromGstin('27AAXFV2138F1ZR'), 'AAXFV2138F');
  assert.equal(stateLabel('27'), 'Maharashtra (27)');
});

test('amounts in words in the Indian system', () => {
  assert.equal(rupeesInWords(0), 'Zero');
  assert.equal(rupeesInWords(19), 'Nineteen');
  assert.equal(rupeesInWords(1001), 'One Thousand One');
  assert.equal(rupeesInWords(250000), 'Two Lakh Fifty Thousand');
  assert.equal(rupeesInWords(123456789), 'Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine');
  assert.equal(rupeesInWords(1000000000000), 'One Lakh Crore');
  assert.equal(amountInWords(123456789050), 'Rupees One Hundred Twenty Three Crore Forty Five Lakh Sixty Seven Thousand Eight Hundred Ninety and Fifty Paise Only');
  assert.equal(amountInWords(5), 'Rupees Zero and Five Paise Only');
});

test('figures print the same everywhere: Indian grouping without Intl', () => {
  assert.equal(formatAmount(11800050), '1,18,000.50');
  assert.equal(formatAmount(123456789012), '1,23,45,67,890.12');
  assert.equal(formatAmount(1234567890), '1,23,45,678.90');
  assert.equal(formatAmount(-3100), '-31.00');
  assert.equal(formatAmount(99), '0.99');
  assert.equal(formatInr(100000, { decimals: false }), '₹1,000');
  assert.equal(toPaise('1,18,000.5'), 11800050);
  assert.equal(toPaise('₹ 75'), 7500);
  assert.equal(toPaise('12.345'), null);
  assert.equal(formatDate('2026-10-11'), '11 Oct 2026');
  assert.equal(addDays('2026-10-25', 15), '2026-11-09');
});

test('financial years run April to March; numbers follow the series pattern within GST limits', () => {
  assert.deepEqual(financialYear('2026-10-11'), { label: '2026-27', short: '26-27', start: '2026-04-01', end: '2027-03-31' });
  assert.equal(financialYear('2027-03-31').label, '2026-27');
  assert.equal(financialYear('2027-04-01').label, '2027-28');
  assert.equal(financialYear('2099-12-31').short, '99-00');
  const fy = financialYear('2026-10-11');
  assert.equal(formatDocNumber('INV/{FY}/{N:4}', fy, 7), 'INV/26-27/0007');
  assert.equal(formatDocNumber('EA-{FYYYY}-{N}', fy, 12), 'EA-2026-27-12');
  assert.equal(formatDocNumber('Q{N:2}', fy, 123), 'Q123');
  assert.equal(numberProblem('INV/{FY}/{N:4}', fy), null);
  assert.match(numberProblem('INVOICE-{FYYYY}-{N:5}', fy), /16 characters/);
  assert.match(numberProblem('INV {FY}', fy), /\{N\}/);
  assert.match(numberProblem('INV#{N}', fy), /letters, digits/);
  assert.throws(() => formatDocNumber('X{N}', fy, 0), /counts from 1/);
});

test('the small helpers refuse what would print wrong', () => {
  assert.equal(divRound(5, 2), 3);
  assert.equal(divRound(-5, 2), -3);
  assert.equal(divRound(4, 3), 1);
  assert.equal(perMillion(18), 180000);
  assert.equal(perMillion(0.25), 2500);
  assert.throws(() => perMillion(18.00001), /four decimals/);
  assert.throws(() => perMillion(101), /between 0 and 100/);
  assert.equal(milli(1.5), 1500);
  assert.throws(() => milli(-1), /positive/);
});
