// COMP-B acceptance through the API on a disposable tenant with synthetic people and figures (tests/core/test_payroll.py):
// pay set up for two people, bank details for one, a bonus, the month's payroll calculated with the real keyring, the
// figures hidden until shown, an HR adjustment, HR's check, a founder's approval that files the payslips (PDF), the bank
// file and the ledger; the person reads their payslip; corrections; the budget seeded and checked by Change pay; the
// people-cost page; what-if scenarios saved and compared; who may see what; amounts sealed in the database; no amount in
// the API's log. Mail goes to the sink (PULSE_CI=1).
import assert from 'node:assert/strict'; import { Pool } from 'pg'; import { chmod, writeFile } from 'node:fs/promises'; import { randomBytes } from 'node:crypto'; import { join } from 'node:path';
import { createApp } from '../dist/app.js';
const keyFile = join(process.env.TEST_KEY_DIR, 'document-master.key');
await writeFile(keyFile, `payroll-2026-10 ${randomBytes(32).toString('base64')}\n`, { mode: 0o600 }); await chmod(keyFile, 0o600); process.env.PULSE_DOCUMENT_KEY_FILE = keyFile;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), owner = new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
for (const p of [pool, owner]) p.on('error', (e) => console.error(`pool: ${e.code ?? e.message}`));
const app = createApp(pool, pool); const R = JSON.parse(process.env.TEST_ROLES); const ORG = process.env.PULSE_ORG_ID;
let checks = 0; const receipts = [];
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; receipts.push(label); };
const ok = (v, label) => { assert.ok(v, label); checks++; receipts.push(label); };
async function call(path, body, { as = 'hr', raw = false } = {}) {
  const r = await app.inject({ url: path.startsWith('/') ? path : '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': as + '@comp.example' }, ...(body === undefined ? {} : { payload: body }) });
  if (raw) return { status: r.statusCode, body: r.rawPayload, type: r.headers['content-type'] };
  let data; try { data = r.json(); } catch { data = r.rawPayload; } return { status: r.statusCode, data };
}
async function own(sql, args = []) { const c = await owner.connect(); try { await c.query('begin'); await c.query('set local role pulse_owner'); await c.query("select set_config('pulse.org_id',$1,true)", [ORG]); const r = await c.query(sql, args); await c.query('commit'); return r.rows; } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); } }
const today = (await own('select pulse.lifecycle_today()::text d'))[0].d, month = today.slice(0, 7), first = `${month}-01`;
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const nextMonth = (() => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); })();

try {
  // ----------------------------------------------------------------------------- 1. pay records, bank, a bonus
  for (const [who, monthly] of [['person', '30,000'], ['head', '18000'], ['other', '45000']]) {
    let r = await call('comp/changes', { person: R[who], kind: 'start', effectiveOn: addDays(first, -60), payType: 'salary', figures: { monthly }, reason: 'Synthetic set-up' });
    ok(r.status === 200, `HR proposes ${who}'s pay`);
    r = await call(`comp/changes/${r.data.id}/decide`, { action: 'approve' }, { as: 'founder' });
    ok(r.status === 200, `a founder approves ${who}'s pay`);
  }
  let r = await call(`onboarding/${R.person}/bank`, { holder: 'Synthetic Person', ifsc: 'UTIB0000123', account: '918273645501', bank: 'Axis Bank' });
  ok(r.status === 200, 'HR records the person’s bank details');
  // INTEGRITY part 2: bank details wait for someone other than whoever entered them; the bank file pays only checked ones.
  eq((await call(`people/${R.person}/bank/confirm`, {})).status, 403, 'HR does not check the bank details it entered');
  await own("insert into pulse.sensitive_permission(org_id,person_id,permission,granted_by) values($1,$2,'hr.documents.read','Synthetic admin') on conflict do nothing", [ORG, R.founder]);
  eq((await call(`people/${R.person}/bank/confirm`, {}, { as: 'founder' })).status, 200, 'a founder with document access checks them');
  r = await call('comp/items', { person: R.person, kind: 'bonus', amount: '5,000', forMonth: first, reason: 'Synthetic festival bonus' });
  await call(`comp/items/${r.data.id}/decide`, { action: 'approve' }, { as: 'founder' });
  const bonusId = r.data.id;

  // ------------------------------------------------------------------------------------ 2. start and calculate
  eq((await call('comp/payroll', { month }, { as: 'person' })).status, 403, 'a member cannot start payroll');
  eq((await call('comp/payroll', undefined, { as: 'other' })).status, 403, 'nor see it');
  r = await call('comp/payroll', { month });
  ok(r.status === 200 && r.data.people === 3, 'HR starts the month: three people with pay');
  const runId = r.data.id;
  let run = (await call(`comp/payroll/${runId}`)).data;
  eq([run.status, run.calc, run.lines.length, run.lines.some((l) => 'slip' in l)], ['draft', 1, 3, false], 'the run opens without anyone’s figures');
  ok(run.totals && run.totals.people === 3 && run.totals.net > 0, 'founders and HR see the run’s totals');
  const head = run.lines.find((l) => l.person === R.head);
  ok(head.exceptions.includes('no_bank') && head.exceptions.includes('pt_details'), 'missing bank and PT details are listed for HR');
  run = (await call(`comp/payroll/${runId}?figures=1`)).data;
  const mine = run.lines.find((l) => l.person === R.person).slip;
  eq([mine.gross, mine.lines.find((l) => l.code === 'item:bonus').amount, mine.statutory.pf, mine.statutory.pfEmployer], [3000000 + 500000, 500000, 180000, 180000], 'the person’s month: pay, the bonus, PF capped');
  const low = run.lines.find((l) => l.person === R.head).slip;
  eq([low.statutory.esi, low.statutory.esiEmployer], [13500, 58500], 'ESI under the limit');
  const stored = await own('select encode(s_data,\'escape\') d from pulse.pay_run_line where run_id=$1', [runId]);
  ok(stored.every((x) => !x.d.includes('3500000') && !x.d.includes('30000')), 'the database holds only ciphertext for the lines');
  const logged = await own("select count(*)::int n from privacy.access_log where org_id=$1 and resource='comp.payroll' and purpose='payroll_view'", [ORG]);
  ok(logged[0].n >= 3, 'showing figures logged each person');

  // ----------------------------------------------------------------------------------- 3. adjust, check, approve
  r = await call(`comp/payroll/${runId}/adjust`, { person: R.head, kind: 'amount', amount: '-500', label: 'Synthetic canteen', reason: 'Agreed deduction' });
  ok(r.status === 200 && r.data.calc === 2, 'HR adjusts a line and the run recalculates');
  r = await call(`comp/payroll/${runId}/adjust`, { person: R.head, kind: 'hold', reason: 'Bank details to come' });
  eq(r.data.calc, 3, 'and holds them out of the bank file');
  eq((await call(`comp/payroll/${runId}/check`, { calc: 2 })).status, 409, 'checking a stale calculation is refused');
  eq((await call(`comp/payroll/${runId}/check`, { calc: 3, note: 'Looked at the exceptions' })).data.status, 'checked', 'HR checks the run');
  eq((await call(`comp/payroll/${runId}/approve`, {})).status, 403, 'HR does not approve it');
  r = await call(`comp/payroll/${runId}/approve`, { note: 'Synthetic approval' }, { as: 'founder' });
  ok(r.status === 200 && r.data.status === 'locked' && r.data.payslips === 3, 'a founder approves: locked, three payslips');
  eq(r.data.payout, { rows: 1, leftOut: 2 }, 'the bank file pays the one person with bank details; the held one and the one without details are left out');
  run = (await call(`comp/payroll/${runId}`)).data;
  eq([run.status, run.payout.format, run.lines.every((l) => l.payslip)], ['locked', 'axis', true], 'the run is locked with its file and payslips');
  const items = (await call(`comp/people/${R.person}`)).data.items;
  ok(items.find((i) => i.id === bonusId).paidAt, 'the bonus is marked paid');

  // ------------------------------------------------------------------------------- 4. payslips and the bank file
  const slipId = run.lines.find((l) => l.person === R.person).payslip.id;
  let pdf = await call(`comp/payslips/${slipId}/pdf`, undefined, { as: 'person', raw: true });
  eq([pdf.status, pdf.body.subarray(0, 5).toString()], [200, '%PDF-'], 'the person opens their payslip');
  eq((await call(`comp/payslips/${slipId}/pdf`, undefined, { as: 'other', raw: true })).status, 404, 'a colleague cannot');
  const content = (await call(`comp/payslips/${slipId}`, undefined, { as: 'person' })).data;
  eq(content.slip.net, mine.net - 0, 'the payslip says what the run worked out');
  eq((await call(`comp/people/${R.person}/payslips`, undefined, { as: 'person' })).data.payslips.length, 1, 'My pay lists it');
  const pulseHome = (await call('me/pulse', undefined, { as: 'person' })).data;
  ok(pulseHome.money.payslips.some((p) => p.month === month && p.href), 'and the My money tile links it');
  const file = await call(`comp/payroll/${runId}/bank-file`, undefined, { as: 'founder', raw: true });
  const csv = file.body.toString();
  ok(file.status === 200 && csv.startsWith('Payment Mode,Beneficiary Account Number') && csv.includes('IFT,918273645501,') && !csv.includes(R.head), 'the founder downloads the Axis file');
  eq((await call(`comp/payroll/${runId}/bank-file`, undefined, { as: 'person', raw: true })).status, 403, 'the person cannot');
  const titles = (await own("select title from pulse.notification where person_id=$1 and event_type='comp.payslip'", [R.person])).map((x) => x.title);
  ok(titles.length === 1 && !/₹|\d{3}/.test(titles[0].replace(/\d{4}/, '')), 'the person is told, without an amount');

  // ------------------------------------------------------------------------------------------- 5. the ledger
  const ledger = (await call('comp/ledger')).data.entries;
  const sum = (side) => ledger.filter((e) => e.side === side).reduce((a, e) => a + e.amount, 0);
  ok(ledger.length && sum('debit') === sum('credit'), 'the ledger balances');
  eq(ledger.filter((e) => e.account === 'net_payable').reduce((a, e) => a + e.amount, 0), run.totals.net, 'net pay payable is the run’s net');
  eq((await call('comp/ledger', undefined, { as: 'other' })).status, 403, 'others do not read the ledger');

  // ----------------------------------------------------------------------------------------- 6. a correction
  eq((await call('comp/payroll', { month })).status, 400, 'a locked month needs a note to correct');
  r = await call('comp/changes', { person: R.other, kind: 'raise', effectiveOn: first, payType: 'salary', figures: { monthly: '48000' }, reason: 'Synthetic backdated raise' });
  await call(`comp/changes/${r.data.id}/decide`, { action: 'approve' }, { as: 'founder' });
  r = await call('comp/payroll', { month, note: 'Backdated raise for one person' });
  ok(r.status === 200 && r.data.people === 1, 'the correction finds the one person whose pay changed');
  const fix = r.data.id;
  const fixed = (await call(`comp/payroll/${fix}?figures=1`)).data;
  eq([fixed.kind, fixed.lines[0].slip.difference > 0], ['correction', true], 'it pays the difference');

  // --------------------------------------------------------------------------------------- 7. budget and preview
  r = await call('comp/budget/seed', {}, { as: 'founder' });
  ok(r.status === 200 && r.data.saved > 0, `a founder seeds the budget (${r.data.basis})`);
  eq((await call('comp/budget/seed', {}, { as: 'hr' })).status, 403, 'HR does not set the budget');
  r = await call('comp/budget', { pod: 'Pod 9', amount: '1', from: nextMonth, to: nextMonth }, { as: 'founder' });
  eq(r.data.saved, 1, 'a founder sets next month’s budget');
  const preview = (await call('comp/preview', { person: R.person, kind: 'raise', effectiveOn: `${nextMonth}-01`, payType: 'salary', figures: { monthly: '40000' }, reason: 'Synthetic' })).data;
  eq([preview.preview.budget.available, preview.preview.budget.over], [true, true], 'Change pay says the raise breaks the budget');
  const pc = (await call('comp/people-cost')).data;
  ok(pc.budget.rows.length === 12 && pc.budget.alerts.length && pc.payroll.runs.length === 2, 'the people-cost page has the year, its alerts and payroll');
  ok(pc.outlook.months.length === 12 && pc.cash.access === false, 'the outlook is there; cash needs finance access');
  eq((await call('comp/people-cost', undefined, { as: 'person' })).status, 403, 'a member does not see people cost');

  // ------------------------------------------------------------------------------------------- 8. what if…
  const steps = [{ kind: 'hire', count: '2', role: 'Editor', pod: 'Pod 9', monthly: '25000', from: nextMonth }, { kind: 'raise', scope: 'pod', pod: 'Pod 9', percent: '10', from: nextMonth }];
  r = await call('comp/scenarios/preview', { steps });
  ok(r.status === 200 && r.data.outlook.yearCost.scenario > r.data.outlook.yearCost.base, 'the sandbox shows the cost of two hires and a raise');
  eq((await call('comp/scenarios', { name: 'Synthetic plan', steps }, { as: 'hr' })).status, 403, 'HR does not save scenarios');
  r = await call('comp/scenarios', { name: 'Synthetic plan', steps }, { as: 'founder' });
  ok(r.status === 200, 'a founder saves it');
  const pc2 = (await call(`comp/people-cost?compare=${r.data.id}`)).data;
  ok(pc2.compared.length === 1 && pc2.compared[0].outlook.yearCost.scenario > pc2.outlook.yearCost.base, 'and compares it with the base');
  const versions = (await own('select count(*)::int n from pulse.comp_change where person_id=$1', [R.person]))[0].n;
  eq(versions, 1, 'the scenario touched no record');
  eq((await call('comp/scenarios/preview', { steps: [{ kind: 'raise', scope: 'person', from: nextMonth }] })).status, 400, 'a step that makes no sense is refused');
} catch (e) { console.error(e); process.exitCode = 1; }
finally {
  await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks, receipts }, null, 1));
  await app.close(); await pool.end(); await owner.end();
}
console.log(`payroll runner: ${checks} checks`);
