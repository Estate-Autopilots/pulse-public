// COMP-B: payroll maths on synthetic figures (paise): pro-rating for joins and changes, pauses, loss of pay, late
// arrears, recoveries, the statutory basics, corrections, the ledger balancing, the bank file, the budget, the
// projection and the what-if scenarios. No database.
import assert from 'node:assert/strict';
import test from 'node:test';
import { normaliseFigures } from '../dist/comp-model.js';
import { applySteps, bankFile, budgetCheck, budgetView, cashWithPeople, correction, costByMonth, incomeTax, INDIA, journal, ledgerFor, MH_PT, payrollLine,
  personCost, professionalTax, runTotals, runway } from '../dist/payroll-model.js';

const TEMPLATE = [{ key: 'basic', label: 'Basic', kind: 'earning', of: 'gross', pct: 50 }, { key: 'hra', label: 'House rent allowance', kind: 'earning', of: 'basic', pct: 40 },
  { key: 'special', label: 'Special allowance', kind: 'earning', balance: true }, { key: 'pf_employer', label: 'Employer PF', kind: 'employer', of: 'basic', pct: 12, cap: 180000 }];
const salary = (rupees, on = '2026-01-01') => ({ effectiveOn: on, payType: 'salary', figures: normaliseFigures({ monthly: rupees * 100 }, 'salary', TEMPLATE) });
const OFF = { ...INDIA, pf: { ...INDIA.pf, on: false }, esi: { ...INDIA.esi, on: false }, pt: { on: false }, tds: { ...INDIA.tds, on: false } };
const who = { id: 'p1', name: 'Synthetic Person', pod: 'Pod 9' };
const line = (code, slip) => slip.lines.filter((l) => l.code === code).reduce((a, l) => a + l.amount, 0);

test('pro-rating: a join mid-month, a change mid-month, a last day', () => {
  const join = payrollLine({ month: '2026-11-01', person: who, start: '2026-11-11', versions: [salary(60000, '2026-11-11')], statutory: OFF, bank: { onFile: true, status: 'confirmed' } });
  assert.equal(join.gross, 4000000); assert.equal(join.paidDays, 20); assert.equal(join.monthDays, 30);
  const change = payrollLine({ month: '2026-10-01', person: who, versions: [salary(31000), salary(62000, '2026-10-16')], statutory: OFF });
  assert.deepEqual(change.lines.filter((l) => l.code === 'pay').map((l) => l.amount), [1500000, 3200000]);
  const leave = payrollLine({ month: '2026-10-01', person: who, end: '2026-10-10', versions: [salary(31000)], statutory: OFF });
  assert.equal(leave.gross, 1000000); assert.equal(leave.paidDays, 10);
});

test('pauses at their share, loss of pay by the rules (pause days not counted twice), HR overriding the days', () => {
  const att = { enabled: true, lop: [{ date: '2026-10-05', weight: 1, why: 'unpaid_leave' }, { date: '2026-10-06', weight: 1, why: 'unpaid_leave' }, { date: '2026-10-07', weight: 0.5, why: 'half_day' },
    { date: '2026-10-21', weight: 1, why: 'unpaid_leave' }, { date: '2026-10-08', weight: 1, why: 'absent' }], lateDebit: 1 };
  const base = { month: '2026-10-01', person: who, versions: [salary(31000)], pauses: [{ from: '2026-10-20', to: '2026-10-24', paidPercent: 50 }], attendance: att, statutory: OFF };
  const s = payrollLine(base);
  assert.equal(line('pause', s), -250000);            // 5 days at half of ₹1,000 a day
  assert.equal(s.lopDays, 2);                         // two unpaid days; the 21st sits in the pause; half days, absence and late marks off by default
  assert.equal(line('lop', s), -200000);
  const strict = payrollLine({ ...base, rules: { unpaidLeave: 'pay', halfDays: 'pay', lateMarks: 'pay', absent: 'pay' } });
  assert.equal(strict.lopDays, 4.5); assert.equal(line('lop', strict), -450000);
  assert.match(strict.lopBasis, /unpaid leave 2 · half days 0.5 · days without a check-in 1 · late marks 1/);
  const set = payrollLine({ ...base, adjustments: [{ id: 'a1', kind: 'lop_days', days: 1.5, reason: 'Synthetic: agreed with the person' }] });
  assert.equal(set.lopDays, 1.5); assert.equal(line('lop', set), -150000); assert.match(set.lopBasis, /Set by HR/);
  assert.equal(set.paidDays, 31 - 2.5 - 1.5);         // 5 paused days at half pay count as 2.5 unpaid
  const fee = payrollLine({ ...base, versions: [{ effectiveOn: '2026-01-01', payType: 'contractor', figures: { monthly: 3100000, ctc: null, components: {} } }] });
  assert.equal(line('lop', fee), 0);                  // contractors invoice: no loss of pay
});

test('one-time pay, late arrears, reimbursements and recoveries; held pay and missing bank details', () => {
  const s = payrollLine({ month: '2026-10-01', person: who, versions: [salary(30000)], statutory: OFF, bank: { onFile: false, status: 'pending' },
    items: [{ id: 'i1', kind: 'bonus', amount: 500000, forMonth: '2026-10-01', payout: 'payroll' }, { id: 'i2', kind: 'arrears', amount: 120000, forMonth: '2026-09-01', payout: 'payroll' },
      { id: 'i3', kind: 'bonus', amount: 1, forMonth: '2026-10-01', payout: 'payroll', paid: true }, { id: 'i4', kind: 'advance', amount: 1000000, forMonth: '2026-09-01', payout: 'separate', paid: true, recoverMonths: 3, recoverFrom: '2026-10-01' },
      { id: 'i5', kind: 'loan', amount: 600000, forMonth: '2026-10-01', payout: 'payroll', recoverMonths: 6, recoverFrom: '2026-11-01' }],
    claims: [{ id: 'k1', amount: 45000, forMonth: '2026-10-01', label: 'Reimbursement: cabs' }] });
  assert.deepEqual(s.lines.map((l) => [l.code, l.amount]), [['pay', 3000000], ['item:bonus', 500000], ['item:arrears', 120000], ['recovery:advance', -333333], ['item:loan', 600000], ['claim', 45000]]);
  assert.equal(s.lines.find((l) => l.code === 'item:arrears').label, 'Arrears (Sep 2026)');
  assert.deepEqual(s.items.sort(), ['i1', 'i2', 'i5']); assert.deepEqual(s.claims, ['k1']);
  assert.equal(s.net, 3000000 + 500000 + 120000 + 600000 - 333333 + 45000);
  assert.equal(s.cost, 3620000);                      // salary, bonus, arrears; the loan is not a cost
  assert.ok(s.exceptions.includes('no_bank'));
  const held = payrollLine({ month: '2026-10-01', person: who, versions: [salary(30000)], statutory: OFF, adjustments: [{ id: 'h', kind: 'hold', reason: 'Synthetic' }] });
  assert.equal(held.hold, true); assert.ok(!held.exceptions.includes('no_bank'));
});

test('statutory basics: PF capped, ESI under the limit, Maharashtra PT, TDS estimates under the new regime', () => {
  const mid = payrollLine({ month: '2026-10-01', person: who, versions: [salary(30000)], pt: { state: 'MH', category: 'men' } });
  assert.deepEqual(mid.statutory, { pf: 180000, pfEmployer: 180000, esi: 0, esiEmployer: 0, pt: 20000, tds: 0 });
  assert.equal(mid.employer, 180000); assert.equal(mid.cost, 3180000);
  const feb = payrollLine({ month: '2027-02-01', person: who, versions: [salary(30000)], pt: { state: 'MH', category: 'men' } });
  assert.equal(feb.statutory.pt, 30000);
  const low = payrollLine({ month: '2026-10-01', person: who, versions: [salary(18000)], pt: { state: 'MH', category: 'women' } });
  assert.equal(low.statutory.pf, Math.round(900000 * 0.12)); assert.equal(low.statutory.esi, 13500); assert.equal(low.statutory.esiEmployer, 58500); assert.equal(low.statutory.pt, 0);
  const high = payrollLine({ month: '2026-10-01', person: who, versions: [salary(150000)], pt: { state: 'MH', category: 'men' } });
  assert.equal(high.statutory.tds, 1256667);           // ₹17.25 L taxable: ₹1,45,000 + 4% cess, a twelfth
  const missing = payrollLine({ month: '2026-10-01', person: who, versions: [salary(30000)] });
  assert.ok(missing.exceptions.includes('pt_details')); assert.equal(missing.statutory.pt, 0);
  const fee = payrollLine({ month: '2026-10-01', person: who, versions: [{ effectiveOn: '2026-01-01', payType: 'contractor', figures: { monthly: 5000000, ctc: null, components: {} } }] });
  assert.equal(fee.statutory.tds, 500000); assert.equal(fee.statutory.pf, 0); assert.equal(fee.statutory.pt, 0);
  assert.equal(incomeTax(120000000, INDIA.tds), 0);    // nil up to ₹12 L
  assert.equal(incomeTax(121000000, INDIA.tds), 1040000); // marginal relief: ₹10,000 above the limit, plus cess
  assert.equal(professionalTax(1000000, '2026-10-01', 'men', MH_PT), 17500);
});

test('the full and final is the month: its lines, coded for the ledger', () => {
  const s = payrollLine({ month: '2027-03-01', person: who, versions: [salary(60000)], statutory: OFF,
    settlement: { id: 's1', net: 2903226 + 600000 - 2000000 + 30000 - 200000, lines: [{ label: 'Pay for 15 of 31 days in the last month', kind: 'earning', amount: 2903226, basis: '2027-03-01..2027-03-15' },
      { label: 'Leave encashment, 6 days', kind: 'earning', amount: 600000 }, { label: 'Notice not served, 10 days', kind: 'deduction', amount: -2000000 },
      { label: 'Reimbursement: cabs', kind: 'reimbursement', amount: 30000 }, { label: 'Advance still to recover', kind: 'deduction', amount: -200000 }] } });
  assert.deepEqual(s.lines.map((l) => l.code), ['pay', 'fnf', 'fnf', 'claim', 'recovery:fnf']);
  assert.equal(s.settlementId, 's1'); assert.equal(s.paidDays, 15);
  const j = journal(s);
  assert.equal(j.salaries, 2903226 + 600000 - 2000000); assert.equal(j.advances_recovered, 200000); assert.equal(j.reimbursements, 30000);
});

test('the ledger balances, by pod, and a correction posts only the difference', () => {
  const a = payrollLine({ month: '2026-10-01', person: { ...who, id: 'a', pod: 'Pod 1' }, versions: [salary(30000)], pt: { state: 'MH', category: 'men' },
    items: [{ id: 'l', kind: 'loan', amount: 300000, forMonth: '2026-10-01', payout: 'payroll', recoverMonths: 3, recoverFrom: '2026-10-01' }], claims: [{ id: 'k', amount: 45000, forMonth: '2026-10-01', label: 'Cabs' }] });
  const b = payrollLine({ month: '2026-10-01', person: { ...who, id: 'b', pod: 'Pod 2' }, versions: [salary(18000)], pt: { state: 'MH', category: 'women' } });
  const led = ledgerFor([{ slip: a, pod: 'Pod 1' }, { slip: b, pod: 'Pod 2' }]);
  assert.equal(led.debit, led.credit);
  const total = (acct) => led.totals.find((t) => t.account === acct)?.amount ?? 0;
  assert.equal(total('net_payable'), a.net + b.net);
  assert.equal(total('statutory_payable'), a.statutory.pf + a.statutory.pfEmployer + a.statutory.pt + b.statutory.pf + b.statutory.pfEmployer + b.statutory.esi + b.statutory.esiEmployer);
  assert.equal(total('advances_paid'), 300000); assert.equal(total('advances_recovered'), 100000);
  assert.deepEqual([...new Set(led.entries.map((e) => e.pod))].sort(), ['Pod 1', 'Pod 2']);
  // A backdated raise for b, corrected: only the difference is posted and paid.
  const b2 = payrollLine({ month: '2026-10-01', person: { ...who, id: 'b', pod: 'Pod 2' }, versions: [salary(18000), salary(20000, '2026-10-01')], pt: { state: 'MH', category: 'women' } });
  const fix = correction(b2, b);
  assert.equal(fix.difference, b2.net - b.net); assert.equal(fix.paid, b.net);
  const led2 = ledgerFor([{ slip: fix, pod: 'Pod 2', paid: fix.previous }]);
  assert.equal(led2.debit, led2.credit);
  assert.equal(led2.totals.find((t) => t.account === 'net_payable').amount, fix.difference);
  assert.equal(correction(b, b), null);               // nothing changed: nobody is in the correction
  const t = runTotals([a, b]);
  assert.equal(t.net, a.net + b.net); assert.equal(t.people, 2); assert.equal(t.difference, null);
});

test('the bank file: Axis layout (IFT within Axis, NEFT elsewhere), amounts in rupees, nothing a spreadsheet would run', () => {
  const csv = bankFile('axis', [{ name: 'Synthetic, Person', account: '000123456789', ifsc: 'utib0000123', amount: 2345067, reference: 'PAY202610-001' },
    { name: '=HYPERLINK("x")', account: '99887766', ifsc: 'HDFC0000001', amount: 100, reference: 'PAY202610-002' }], { payOn: '2026-11-07', narration: 'Salary Oct 2026', debitAccount: '123456' });
  const rows = csv.trim().split('\r\n');
  assert.equal(rows[0], 'Payment Mode,Beneficiary Account Number,Amount,Value Date,Beneficiary Name,Beneficiary IFSC,Debit Account Number,Customer Reference,Remarks');
  assert.equal(rows[1], 'IFT,000123456789,23450.67,07-11-2026,Synthetic Person,UTIB0000123,123456,PAY202610-001,Salary Oct 2026');
  assert.ok(rows[2].startsWith('NEFT,99887766,1.00,07-11-2026,HYPERLINK x,HDFC0000001'));
  assert.ok(!csv.includes('=HYPERLINK'));
  assert.equal(bankFile('generic', [], { payOn: '2026-11-07', narration: 'Salary' }).split('\r\n')[0], 'Name,Account Number,IFSC,Amount,Reference,Narration,Value Date');
});

const people = [
  { id: 'a', name: 'A', pod: 'Pod 1', versions: [salary(30000)] },
  { id: 'b', name: 'B', pod: 'Pod 1', versions: [salary(40000), salary(50000, '2026-12-01')] },
  { id: 'c', name: 'C', pod: 'Pod 2', versions: [salary(20000)], end: '2026-11-15' },
  { id: 'd', name: 'D', pod: 'Pod 2', versions: [salary(20000)], pauses: [{ from: '2026-11-01', to: '2026-11-30', paidPercent: 50 }], items: [{ kind: 'bonus', amount: 1000000, forMonth: '2027-03-01', payout: 'payroll' }] },
];
const cost = (rupees) => Math.round(normaliseFigures({ monthly: rupees * 100 }, 'salary', TEMPLATE).ctc / 12);

test('people cost from pay records: CTC a month, scheduled raises, last days, pauses, bonuses; budget and alerts', () => {
  assert.equal(personCost(people[0], '2026-11-01'), cost(30000));
  assert.equal(personCost(people[1], '2026-12-01'), cost(50000));
  assert.equal(personCost(people[2], '2026-11-01'), Math.round(cost(20000) * 15 / 30));
  assert.equal(personCost(people[2], '2026-12-01'), 0);
  assert.equal(personCost(people[3], '2026-11-01'), Math.round(cost(20000) / 2));
  assert.equal(personCost(people[3], '2027-03-01'), cost(20000) + 1000000);
  const months = ['2026-11-01', '2026-12-01', '2027-01-01'];
  const roles = [{ id: 'r1', title: 'Editor', pod: 'Pod 1', count: 2, from: '2027-01-01', monthly: 3500000, status: 'planned' }];
  const pending = [{ id: 'o1', person: 'e', pod: 'Pod 2', kind: 'offer', from: '2026-12-01', payType: 'salary', figures: normaliseFigures({ monthly: 2500000 }, 'salary', TEMPLATE), label: 'Offer' }];
  const byMonth = costByMonth(months, people, { roles, pending });
  assert.equal(byMonth[2].byPod.find((p) => p.pod === 'Pod 1').planned, 7000000);
  assert.equal(byMonth[1].byPod.find((p) => p.pod === 'Pod 2').planned, cost(25000));
  const budget = months.flatMap((m) => [{ month: m, pod: 'Pod 1', amount: cost(30000) + cost(50000) + 100000 }, { month: m, pod: 'Pod 2', amount: 10000000 }]);
  const view = budgetView(months, { budget, actual: [{ month: '2026-11-01', pod: 'Pod 1', amount: 7000000 }], cost: byMonth, today: '2026-11-05' });
  assert.equal(view.rows[0].locked, true); assert.equal(view.rows[0].actual, 7000000);
  assert.deepEqual(view.alerts.map((a) => [a.pod, a.from]), [['Pod 1', '2027-01-01']]); // two planned editors break Pod 1 from January
  const ok = budgetCheck(view, 'Pod 1', '2026-12-01', 50000);
  assert.equal(ok.over, true); assert.equal(ok.from, '2027-01-01');
  const fine = budgetCheck(view, 'Pod 2', '2026-12-01', 100000);
  assert.equal(fine.over, false); assert.match(fine.note, /Within Pod 2/);
  assert.equal(budgetCheck(view, 'Pod 7', '2026-12-01', 1).available, false);
});

test('what-if steps change the people, never the records; burn, cash and runway', () => {
  const roles = [{ id: 'r1', title: 'Editor', pod: 'Pod 1', count: 1, from: '2027-01-01', monthly: 3500000, status: 'planned' }];
  const steps = [{ kind: 'hire', count: 2, role: 'Editor', pod: 'Pod 1', monthly: 3000000, from: '2026-12-01' }, { kind: 'raise', scope: 'pod', pod: 'Pod 1', percent: 10, from: '2027-01-01' },
    { kind: 'pause', person: 'a', from: '2026-12-01', to: '2026-12-31', paidPercent: 0 }, { kind: 'bonus', scope: 'all', amount: 3000000, month: '2027-03-01' },
    { kind: 'exit', person: 'b', on: '2027-01-31' }, { kind: 'drop_role', role: 'r1' }];
  const before = JSON.stringify(people);
  const s = applySteps(people, roles, steps, TEMPLATE);
  assert.equal(JSON.stringify(people), before);       // the records are untouched
  assert.equal(s.roles.length, 0);
  const months = ['2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01'];
  const base = costByMonth(months, people, { roles }), scen = costByMonth(months, s.people, { roles: s.roles, extra: s.extra });
  const hire = 2 * cost(30000);
  assert.equal(scen[0].committed - base[0].committed, hire - cost(30000)); // two hires, A paused for December
  assert.equal(personCost(s.people.find((p) => p.id === 'a'), '2027-01-01'), cost(33000)); // 10% for Pod 1 from January
  assert.equal(personCost(s.people.find((p) => p.id === 'b'), '2027-02-01'), 0); // B left at the end of January
  const bonus = applySteps(people, [], [{ kind: 'bonus', scope: 'all', amount: 3000000, month: '2027-03-01' }], TEMPLATE);
  assert.equal(costByMonth(['2027-03-01'], bonus.people)[0].committed - costByMonth(['2027-03-01'], people)[0].committed, 3000000); // split among those employed in March
  // Cash: FIN-LIVE's base plus the change in people cost from this month's baseline.
  const cash = months.map((m) => ({ month: m, base: { inflow: 50000000, outflow: 45000000 }, downside: { inflow: 40000000, outflow: 47000000 }, upside: { inflow: 55000000, outflow: 45000000 } }));
  const baseline = base[0].committed;
  const rows = cashWithPeople(months, cash.slice(0, 2), scen, baseline, 1000000);
  assert.equal(rows[0].base.outflow, 45000000 + scen[0].committed - baseline);
  assert.equal(rows[2].held, true);                    // beyond the forecast the last month is held
  const r = runway(rows, 'downside', 1000000);
  assert.equal(r.until, '2026-12-01'); assert.equal(r.months, 0);
  assert.equal(runway(rows, 'base', null).months, null);
});
