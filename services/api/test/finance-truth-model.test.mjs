// FINANCE-TRUTH model: periods on India's financial year, HR cost from locked payroll in place of the Cash book's salary
// lines, collections from bank lines where they exist, and every number's source in words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNumbers, inr, payrollMonths, periodRange } from '../dist/finance-truth-model.js';

const month = (m, x = {}) => ({
  month: m, invoiced: { count: 0, taxable: 0, gst: 0, total: 0 }, credited: { count: 0, taxable: 0, gst: 0, total: 0 },
  receipts: { count: 0, base: 0, gstInGstAccount: 0, gstInMain: 0, tds: 0, cash: 0 }, paidInvoices: 0, bankLines: null,
  book: { lines: 0, total: 0, intoGst: 0 }, spend: { lines: 0, net: 0, gst: 0, salaries: 0, taxes: 0, categories: [] }, ...x,
});
const raw = (months, x = {}) => ({ from: months[0].month, to: months.at(-1).month, today: '2026-11-04', bank: true, accounts: ['HDFC current', 'GST account'],
  gstAccount: 'GST account', canSetAccount: true, bankEnd: '2026-10-31', months, unpaidBills: { count: 0, total: 0 },
  outstanding: { invoices: 0, base: 0, gst: 0, gstInvoices: 0, items: [] }, salespeople: [], ...x });

test('periods follow the company calendar and India’s April–March year', () => {
  assert.deepEqual(periodRange('month', '2026-11-04'), { period: 'month', from: '2026-11', to: '2026-11' });
  assert.deepEqual(periodRange('last', '2026-01-10'), { period: 'last', from: '2025-12', to: '2025-12' });
  assert.deepEqual(periodRange('quarter', '2026-02-01'), { period: 'quarter', from: '2025-12', to: '2026-02' });
  assert.deepEqual(periodRange(undefined, '2026-11-04'), { period: 'fy', from: '2026-04', to: '2026-11' });
  assert.deepEqual(periodRange('fy', '2026-03-31'), { period: 'fy', from: '2025-04', to: '2026-03' });
  assert.deepEqual(periodRange('lastfy', '2026-11-04'), { period: 'lastfy', from: '2025-04', to: '2026-03' });
  assert.deepEqual(periodRange('fy', '2026-11-04', '2026-09', '2026-06'), { period: 'custom', from: '2026-06', to: '2026-09' });
  assert.equal(periodRange('fy', '2026-11-04', '2026-13', '2026-06').period, 'fy');
});

test('HR cost is salaries and employer contributions of locked payroll', () => {
  assert.equal(payrollMonths(null), null);
  assert.deepEqual(payrollMonths([
    { month: '2026-09', account: 'salaries', side: 'debit', amount: 100000 }, { month: '2026-09', account: 'employer_contributions', side: 'debit', amount: 5000 },
    { month: '2026-09', account: 'net_payable', side: 'credit', amount: 90000 }, { month: '2026-10', account: 'salaries', side: 'debit', amount: 110000 },
  ]), { '2026-09': 105000, '2026-10': 110000 });
});

test('revenue is the base paid, GST apart, and payroll replaces the Cash book salary lines of its month', () => {
  const r = buildNumbers(raw([
    month('2026-09', { receipts: { count: 2, base: 1000000, gstInGstAccount: 0, gstInMain: 0, tds: 0, cash: 1000000 }, invoiced: { count: 1, taxable: 1000000, gst: 180000, total: 1180000 },
      bankLines: { lines: 3, client: 1000000, other: 5000, intoGst: 0 }, spend: { lines: 2, net: 300000, gst: 0, salaries: 200000, taxes: 50000, categories: [{ category: 'Salaries', net: 200000, lines: 1 }, { category: 'Rent & office', net: 100000, lines: 1 }] } }),
    month('2026-10', { receipts: { count: 1, base: 0, gstInGstAccount: 180000, gstInMain: 0, tds: 0, cash: 180000 }, paidInvoices: 1,
      book: { lines: 1, total: 180000, intoGst: 180000 }, spend: { lines: 1, net: 150000, gst: 27000, salaries: 150000, taxes: 0, categories: [{ category: 'Salaries', net: 150000, lines: 1 }] } }),
  ], { outstanding: { invoices: 1, base: 0, gst: 36000, gstInvoices: 1, items: [] } }), { '2026-09': 105000 });
  const [sep, oct] = r.months;
  assert.deepEqual([sep.revenue, sep.gstBilled, sep.collected, sep.collectedFrom, sep.otherIn], [1000000, 180000, 1000000, 'bank', 5000]);
  // September: payroll ₹1,050 replaces the ₹2,000 salary line; October has no payroll, so the Cash book's salary line counts.
  assert.deepEqual([sep.hr, sep.hrFrom, sep.expenses, sep.net], [105000, 'payroll', 205000, 795000]);
  assert.deepEqual([oct.revenue, oct.gstToGstAccount, oct.collected, oct.collectedFrom, oct.hr, oct.hrFrom, oct.expenses], [0, 180000, 180000, 'book', 150000, 'book', 150000]);
  assert.deepEqual([r.totals.revenue, r.totals.gstBilled, r.totals.gstToGstAccount, r.totals.gstOutstanding, r.totals.taxes, r.totals.hr, r.totals.net],
    [1000000, 180000, 180000, 36000, 50000, 255000, 1000000 - 355000]);
  assert.deepEqual(r.categories, [{ category: 'HR (salaries)', net: 255000 }, { category: 'Rent & office', net: 100000 }]);
  assert.match(r.sources.collected.from, /bank statement lines for Sep 2026; for Oct 2026, money received typed in the Cash book/);
  assert.match(r.sources.expenses.from, /locked payroll \(salaries and employer contributions\) for Sep 2026; the Cash book’s salary entries for Oct 2026/);
  assert.match(r.sources.gst.from, /into GST account \(the GST account\)/);
  assert.match(r.sources.gst.note, /₹500/);
  assert.equal(r.empty, false);
});

test('without the bank grant or the salary permission the page says what it used instead', () => {
  const r = buildNumbers(raw([month('2026-10', { bankLines: { lines: 1, client: 99, other: 0, intoGst: 0 }, spend: { lines: 1, net: 100000, gst: 0, salaries: 100000, taxes: 0, categories: [] } })],
    { bank: false, gstAccount: null }), null);
  assert.equal(r.months[0].collected, null);
  assert.equal(r.totals.collected, null);
  assert.equal(r.months[0].hrFrom, 'book');
  assert.match(r.sources.collected.from, /leadership with the finance amount grants/);
  assert.match(r.sources.expenses.from, /needs the salary permission/);
  assert.match(r.sources.gst.from, /name the GST account/);
  assert.deepEqual(r.access, { bank: false, payroll: false, setAccount: true });
});

test('an empty company is empty, and rupees read the Indian way', () => {
  assert.equal(buildNumbers(raw([month('2026-11')]), {}).empty, true);
  assert.equal(buildNumbers(raw([month('2026-11')], { outstanding: { invoices: 2, base: 100, gst: 18, gstInvoices: 1, items: [] } }), {}).empty, true, 'what is due today does not fill an empty period');
  assert.equal(inr(1234567800), '₹1,23,45,678');
});

test('a refund paid to a client comes off revenue, not spending, and an overpayment is neither revenue nor GST', () => {
  const r = buildNumbers(raw([month('2026-10', { receipts: { count: 2, base: 1000000, gstInGstAccount: 0, gstInMain: 180000, tds: 0, cash: 1200000, over: 20000 },
    refunds: { lines: 1, net: 50000 }, spend: { lines: 1, net: 100000, gst: 0, salaries: 0, taxes: 0, categories: [{ category: 'Rent & office', net: 100000, lines: 1 }] } })],
    { unsaidPayments: { count: 1, items: [{ id: 'p', documentId: 'd', number: 'INV-1', receivedOn: '2026-10-02', amount: 100, buyer: null }] } }), {});
  assert.equal(r.totals.revenue, 950000);
  assert.equal(r.totals.refunds, 50000);
  assert.equal(r.totals.overpaid, 20000);
  assert.equal(r.totals.expenses, 100000);
  assert.equal(r.totals.net, 850000);
  assert.match(r.sources.revenue.note, /Refunds paid to clients .* ₹500/);
  assert.match(r.sources.revenue.note, /₹200 was paid beyond/);
  assert.match(r.sources.gst.note, /1 payment does not say which account/);
  assert.equal(r.unsaidPayments.count, 1);
  assert.equal(buildNumbers(raw([month('2026-10')]), {}).unsaidPayments.count, 0);
});
