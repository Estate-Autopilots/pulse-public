// COMP-A: the arithmetic of pay (comp-model.ts). Synthetic figures in paise only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrears, monthPay, monthsBetween, nextEvent, normaliseFigures, previewChange, primaryAction, recoverySchedule, serviceYears, settlement, setupPlan, splitPay } from '../dist/comp-model.js';

const INDIA = [{ key: 'basic', label: 'Basic', kind: 'earning', of: 'gross', pct: 50 }, { key: 'hra', label: 'HRA', kind: 'earning', of: 'basic', pct: 40 },
  { key: 'special', label: 'Special allowance', kind: 'earning', balance: true }, { key: 'pf_employer', label: 'Employer PF', kind: 'employer', of: 'basic', pct: 12, cap: 180000 }];

test('the company structure splits a gross into earnings that add up, then the employer part and the CTC', () => {
  const s = splitPay(5000000, INDIA);
  assert.deepEqual(s.components, { basic: 2500000, hra: 1000000, special: 1500000, pf_employer: 180000 });
  assert.equal(s.ctc, 12 * (5000000 + 180000));
  // A small salary: the PF cap does not bind.
  assert.equal(splitPay(1200000, INDIA).components.pf_employer, 72000);
  // A company outside India: one base earning.
  assert.deepEqual(splitPay(800000, [{ key: 'base', label: 'Base', kind: 'earning', balance: true }]), { components: { base: 800000 }, employer: 0, ctc: 9600000 });
});

test('figures are made whole for the pay type, and wrong input says what is wrong', () => {
  assert.equal(normaliseFigures({ monthly: 5000000 }, 'salary', INDIA).ctc, 62160000);
  assert.deepEqual(normaliseFigures({ monthly: 3000000 }, 'contractor', INDIA), { monthly: 3000000, ctc: 36000000, components: {} });
  assert.deepEqual(normaliseFigures({ rate: 150000, hours: 40 }, 'hourly', INDIA), { monthly: 6000000, ctc: 72000000, components: {}, rate: 150000, hours: 40 });
  assert.throws(() => normaliseFigures({ monthly: 5000000, components: { basic: 2000000, hra: 1000000, special: 1000000 } }, 'salary', INDIA), /add up to the pay a month/);
  assert.throws(() => normaliseFigures({ monthly: 5000000, components: { bonus: 5000000 } }, 'salary', INDIA), /not one of the company's pay components/);
  assert.throws(() => normaliseFigures({ monthly: 5000000, ctc: 1000000 }, 'salary', INDIA), /at least twelve months/);
  assert.throws(() => normaliseFigures({}, 'stipend', INDIA), /pay a month/);
  assert.throws(() => normaliseFigures({ rate: 0 }, 'hourly', INDIA), /hourly rate/);
});

test('a change preview: before and after, the cost a month, the rest of the year, arrears for a backdated change', () => {
  const before = normaliseFigures({ monthly: 5000000 }, 'salary', INDIA), after = normaliseFigures({ monthly: 5500000 }, 'salary', INDIA);
  const p = previewChange(before, after, '2026-11-01', '2026-10-13');
  assert.equal(p.diff.monthly, 500000);
  assert.equal(p.diff.percent, 10);
  assert.equal(p.diff.cost, Math.round(after.ctc / 12) - Math.round(before.ctc / 12));
  assert.equal(p.restOfYear.months, 5, 'November to March');
  assert.deepEqual(p.arrears, { amount: 0, months: 0 });
  assert.equal(p.budget.available, false);
  // Backdated to 16 Aug: half of August and all of September were paid at the old figures.
  const back = previewChange(before, after, '2026-08-16', '2026-10-13');
  assert.equal(back.arrears.months, 1.52);
  assert.equal(back.arrears.amount, Math.round(500000 * (16 / 31 + 1)));
  assert.equal(arrears(before, after, '2026-10-01', '2026-10-01').amount, 0);
  assert.equal(Math.round(monthsBetween('2026-01-01', '2027-01-01') * 1000) / 1000, 12);
});

test('a month pays each version for its days, paused days at their share, items, claims and recoveries', () => {
  const v1 = { effectiveOn: '2026-01-01', payType: 'salary', figures: { monthly: 3100000, ctc: null, components: {} } };
  const v2 = { effectiveOn: '2026-10-16', payType: 'salary', figures: { monthly: 6200000, ctc: null, components: {} } };
  const m = monthPay({ month: '2026-10-01', versions: [v2, v1], pauses: [{ from: '2026-10-20', to: '2026-10-24', paidPercent: 50 }],
    items: [{ kind: 'bonus', amount: 1000000, forMonth: '2026-10-01', payout: 'payroll' }, { kind: 'bonus', amount: 1, forMonth: '2026-10-01', payout: 'separate' },
      { kind: 'advance', amount: 1000000, forMonth: '2026-09-01', payout: 'separate', recoverMonths: 3, recoverFrom: '2026-10-01' }],
    claims: [{ amount: 45000, forMonth: '2026-10-01', payout: 'payroll' }] });
  assert.deepEqual(m.lines.map((l) => [l.label, l.amount]), [
    ['Pay for 15 of 31 days', 1500000], ['Pay for 16 of 31 days', 3200000], ['Paused 5 days at 50%', -500000],
    ['Bonus', 1000000], ['Advance recovery', -333333], ['Reimbursement', 45000]]);
  assert.equal(m.net, 1500000 + 3200000 - 500000 + 1000000 - 333333 + 45000);
  // Joining mid-month and leaving: only the days between.
  const j = monthPay({ month: '2026-11-01', versions: [v2], start: '2026-11-11', end: '2026-11-20' });
  assert.deepEqual(j.lines.map((l) => [l.label, l.amount]), [['Pay for 10 of 30 days', 2066667]]);
  assert.deepEqual(recoverySchedule(1000000, 3, '2026-10-15').map((r) => r.amount), [333333, 333333, 333334]);
});

test('the full and final: last days, leave encashment, notice either way, items, claims, recoveries, gratuity', () => {
  const f = normaliseFigures({ monthly: 6000000 }, 'salary', INDIA);
  const s = settlement({ lastDay: '2027-03-15', figures: f, encash: { days: 6, basis: 'basic', divisor: 30 }, notice: { required: 30, served: 20, mode: 'short_recovered' },
    items: [{ label: 'Bonus', amount: 500000 }], claims: [{ label: 'Reimbursement: cabs', amount: 30000 }], recoveries: [{ label: 'Advance still to recover', amount: 200000 }],
    joinedOn: '2021-09-01', gratuity: true });
  assert.deepEqual(s.lines.map((l) => [l.label, l.amount]), [
    ['Pay for 15 of 31 days in the last month', 2903226], ['Leave encashment, 6 days', 600000], ['Notice not served, 10 days', -2000000],
    ['Bonus', 500000], ['Reimbursement: cabs', 30000], ['Advance still to recover', -200000], ['Gratuity, 6 years of service', Math.round((3000000 * 15 * 6) / 26)]]);
  assert.equal(s.net, s.lines.reduce((a, l) => a + l.amount, 0));
  const lieu = settlement({ lastDay: '2027-03-31', figures: f, lastMonthPaid: true, encash: { days: 0, basis: 'basic', divisor: 30 }, notice: { required: 30, served: 0, mode: 'paid_in_lieu' } });
  assert.deepEqual(lieu.lines.map((l) => [l.label, l.amount]), [['Pay in lieu of notice, 30 days', 6000000]]);
  assert.equal(serviceYears('2022-04-01', '2027-03-31'), 5);
  assert.equal(serviceYears('2022-04-01', '2026-09-30'), 4, 'six months exactly do not round up');
  assert.equal(serviceYears('2022-04-01', '2026-10-15'), 5, 'more than six months round up');
});

test('next event and the one action: what to act on first, for whom', () => {
  const v = { me: 'hr', writer: true, approver: false }, f = { me: 'founder', writer: true, approver: true };
  const base = { id: 'p1', hasRecord: true, current: true, status: 'confirmed' };
  const draft = { ...base, offer: { id: 'o', status: 'draft', startOn: '2026-11-01', validUntil: '2026-10-20' } };
  assert.deepEqual(primaryAction(draft, nextEvent(draft, '2026-10-13', v), v), { key: 'offer.propose', label: 'Ask a founder' });
  const waiting = { ...base, offer: { id: 'o', status: 'proposed', startOn: '2026-11-01', validUntil: '2026-10-20', proposedBy: 'hr' } };
  assert.equal(nextEvent(waiting, '2026-10-13', v).tone, 'wait');
  assert.equal(primaryAction(waiting, nextEvent(waiting, '2026-10-13', v), v), null, 'HR does not approve what HR drafted');
  assert.deepEqual(primaryAction(waiting, nextEvent(waiting, '2026-10-13', f), f), { key: 'offer.approve', label: 'Review offer' });
  const prob = { ...base, status: 'probation', probation: { from: '2026-08-01', to: '2026-10-30' } };
  assert.deepEqual(nextEvent(prob, '2026-10-13', v), { key: 'probation.ends', on: '2026-10-30', label: 'Probation ends 30 Oct', tone: 'act' });
  assert.deepEqual(primaryAction(prob, nextEvent(prob, '2026-10-13', v), v), { key: 'probation', label: 'Confirm probation' });
  const paused = { ...base, status: 'paused', pause: { id: 'z', status: 'approved', from: '2026-10-01', to: '2026-11-15', paidPercent: 0 } };
  assert.equal(nextEvent(paused, '2026-10-13', v).label, 'Paused until 15 Nov');
  assert.deepEqual(primaryAction(paused, nextEvent(paused, '2026-10-13', v), v), { key: 'change', label: 'Change pay' });
  const settled = { ...base, status: 'notice', lastDay: '2026-11-12', leavingCase: 'c1', settlement: { id: 's', status: 'issued', lastDay: '2026-11-12' } };
  assert.deepEqual(nextEvent(settled, '2026-10-13', v), { key: 'last.day', on: '2026-11-12', label: 'Last day 12 Nov', tone: 'info' }, 'an issued full and final asks nothing more');
  const cand = { id: 'p3', hasRecord: false, current: false, stage: 'candidate' };
  assert.deepEqual(primaryAction(cand, nextEvent(cand, '2026-10-13', v), v), { key: 'offer', label: 'Draft offer' });
  const none = { id: 'p2', hasRecord: false, current: true };
  assert.deepEqual(primaryAction(none, nextEvent(none, '2026-10-13', v), v), { key: 'setup', label: 'Set up pay' });
  assert.equal(primaryAction({ ...base, id: 'hr' }, null, v), null, 'nobody acts on their own pay');
  const claims = { ...base, claims: 2 };
  assert.deepEqual([nextEvent(claims, '2026-10-13', v).label, primaryAction(claims, nextEvent(claims, '2026-10-13', v), v).label], ['2 claims to review', 'Review claim']);
});

test("set-up from imported rows: a contractor's settled invoice is the first version, a newer proposed salary the offer", () => {
  const rows = [{ id: 'a', kind: 'monthly', month: '2026-10-01', effectiveFrom: '2026-10-01', amount: 40000, termsStatus: 'proposed', sourceName: 'Role terms', termsNote: 'Review after 3 months' },
    { id: 'b', kind: 'invoice', month: '2026-09-01', effectiveFrom: '2026-09-01', amount: 9000, termsStatus: 'settled', sourceName: 'Invoice' }];
  const p = setupPlan(rows);
  assert.deepEqual(p.start, { id: 'b', amount: 900000, on: '2026-09-01', payType: 'contractor', source: 'Invoice' });
  assert.deepEqual(p.offer, { id: 'a', amount: 4000000, on: '2026-10-01', payType: 'salary', source: 'Role terms', note: 'Review after 3 months' });
  assert.deepEqual(setupPlan([{ id: 'c', kind: 'current', month: '2025-04-01', amount: 30000, termsStatus: null }]).start?.payType, 'salary');
  assert.equal(setupPlan([]).start, null);
});
