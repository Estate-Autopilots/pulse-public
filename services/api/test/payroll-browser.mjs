// COMP-B in the browser: the real API (this process) and the built web app (`next start`, NEXT_DIST_DIR) on a disposable
// synthetic tenant (tests/core/test_payroll.py::test_payroll_in_the_browser). HR starts the month's payroll, looks at the
// figures, holds one person out of the bank file and checks it → a founder approves and locks it and downloads the bank
// file → the person reads their payslip on a phone → leadership opens Finance → People cost: the budget (seeded), a
// planned role, What if… (a scenario saved and compared) and the ledger → HR sees the budget line in Change pay. Then a
// gallery at 1440 and 390 px, light and dark. Synthetic people and figures only. PULSE_COMP_SCREENSHOTS=<dir> keeps them.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { spawn } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../dist/app.js';
const R = JSON.parse(process.env.TEST_ROLES);
const keyFile = join(process.env.TEST_KEY_DIR, 'document-master.key');
await writeFile(keyFile, `browser-2026-10 ${randomBytes(32).toString('base64')}\n`, { mode: 0o600 }); await chmod(keyFile, 0o600);
process.env.PULSE_DOCUMENT_KEY_FILE = keyFile;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)); const app = createApp(pool, pool);
const owner = new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG)); const ORG = process.env.PULSE_ORG_ID;
for (const p of [pool, owner]) p.on('error', (e) => console.error(`pool: ${e.code ?? e.message}`));
const shots = process.env.PULSE_COMP_SCREENSHOTS; if (shots) await mkdir(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web',
  env: { ...process.env, PULSE_API_URL: origin, PULSE_PUBLIC_URL: base, NODE_ENV: 'production', PULSE_PUBLIC_LOGIN_ENABLED: '0', NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? '.next' }, stdio: 'ignore' });
let browser; const results = []; let checks = 0; const errors = [];
const ok = (condition, msg) => { checks++; assert.ok(condition, msg); };
async function own(sql, args = []) { const c = await owner.connect(); try { await c.query('begin'); await c.query('set local role pulse_owner'); await c.query("select set_config('pulse.org_id',$1,true)", [ORG]); const r = await c.query(sql, args); await c.query('commit'); return r.rows; } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); } }
async function api(path, body, as = 'hr') { const r = await app.inject({ url: `/api/v0/${path}`, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': `${as}@comp.example` }, ...(body === undefined ? {} : { payload: body }) }); if (r.statusCode >= 300) throw new Error(`${path}: ${r.statusCode} ${r.body.slice(0, 200)}`); return r.json(); }
const ready = async (page) => { await page.waitForFunction(() => document.querySelector('main h1,main h2,main h3') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 60000 }); await page.waitForTimeout(400); };
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load' }); await ready(page); };
const posted = (page, re) => page.waitForResponse((r) => r.request().method() === 'POST' && new RegExp(`^/api/v0/(?:${re})$`).test(new URL(r.url()).pathname), { timeout: 60000 });
const pages = [];
async function as(role, width = 1440, theme = 'light') {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1,
    ...(role ? { extraHTTPHeaders: { 'cf-access-authenticated-user-email': `${role}@comp.example` } } : {}) });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); } catch {} }, theme);
  const page = await ctx.newPage(); pages.push(page);
  page.on('pageerror', (e) => errors.push(`${role ?? 'signed-out'} ${e.message.slice(0, 200)}`));
  return page;
}
async function shot(page, name) { if (shots) { await page.waitForTimeout(500); await page.screenshot({ path: `${shots}/${name}.png` }); } }
async function noSideways(page, label) { const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]); ok(w[0] <= w[1] + 1, `${label}: no sideways scroll (${w[0]} > ${w[1]})`); }
async function drawer(page) { const d = page.getByRole('dialog'); await expect(d).toBeVisible({ timeout: 20000 }); return d; }
async function flow(name, run) {
  const started = Date.now();
  try { await run(); results.push({ name, ok: true, ms: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (e) {
    const error = String(e?.message ?? e).split('\n').slice(0, 6).join(' | ').slice(0, 900);
    results.push({ name, ok: false, error }); console.log(`FAIL ${name}: ${error}`);
    if (shots) for (const [i, p] of pages.entries()) if (!p.isClosed()) await p.screenshot({ path: `${shots}/fail-${name}-${i}.png` }).catch(() => null);
  }
  for (const p of pages.splice(0)) await p.context().close().catch(() => null);
}
const today = (await own('select pulse.lifecycle_today()::text d'))[0].d, month = today.slice(0, 7), first = `${month}-01`;
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const nextMonth = (() => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); })();
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// The month the page suggests: last month while its pay day (the 7th) is ahead, else this month (months.tsx dueMonth).
const prev = (() => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); })();
const due = Number(today.slice(8, 10)) <= 7 ? prev : month;
const monthLong = `${MONTHS[Number(due.slice(5, 7)) - 1]} ${due.slice(0, 4)}`;
let runId = null;

try {
  // Synthetic set-up through the API: pay for three people (two pods), bank details and PT for one, a bonus, a
  // synthetic cash forecast (the founder has finance access as leadership).
  await own("update pulse.people_profile set pod='Pod 3' where person_id=$1", [R.other]);
  for (const [who, monthly] of [['person', '42,000'], ['head', '18000'], ['other', '55000']]) {
    const c = await api('comp/changes', { person: R[who], kind: 'start', effectiveOn: addDays(first, -95), payType: 'salary', figures: { monthly }, reason: 'Synthetic set-up' });
    await api(`comp/changes/${c.id}/decide`, { action: 'approve' }, 'founder');
  }
  await api(`onboarding/${R.person}/bank`, { holder: 'Neha Jivop', ifsc: 'HDFC0001234', account: '501002003004', bank: 'HDFC Bank' });
  await api(`onboarding/${R.head}/bank`, { holder: 'Tara Kapoor', ifsc: 'UTIB0000456', account: '918000111222', bank: 'Axis Bank' });
  // INTEGRITY part 2: the bank file pays only details someone other than whoever entered them checked (a founder here).
  await own("insert into pulse.sensitive_permission(org_id,person_id,permission,granted_by) values($1,$2,'hr.documents.read','Synthetic admin') on conflict do nothing", [ORG, R.founder]);
  for (const who of ['person', 'head']) await api(`people/${R[who]}/bank/confirm`, {}, 'founder');
  await own("insert into pulse.hr_employment(org_id,person_id,pt_category,pt_state,updated_by) values($1,$2,'women','MH',$3) on conflict(person_id) do update set pt_category='women',pt_state='MH'", [ORG, R.person, R.hr]);
  const item = await api('comp/items', { person: R.person, kind: 'bonus', amount: '8,000', forMonth: first, reason: 'Synthetic festival bonus' });
  await api(`comp/items/${item.id}/decide`, { action: 'approve' }, 'founder');
  const fm = (i) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 7); };
  await own("insert into pulse_priv.finance_live_model(org_id,body) values($1,$2) on conflict(org_id) do update set body=excluded.body", [ORG, JSON.stringify({ asOf: today, certified: false,
    forecast: { months: [1, 2, 3, 4, 5, 6].map((i) => ({ month: fm(i), label: fm(i), base: { inflow: 900000, outflow: 1050000 }, downside: { inflow: 720000, outflow: 1100000 }, upside: { inflow: 990000, outflow: 1050000 } })),
      assumptions: ['Synthetic: invoicing continues at ₹9.0 L a month.', 'Synthetic: costs stay at ₹10.5 L a month.'], confidence: 'low', basis: 'Synthetic projection for the browser check;' },
    burn: { balance: { amount: 2400000, asOf: addDays(today, -370), ageDays: 370 } } })]);
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch {} await delay(200); if (i === 599) throw new Error('next start did not answer'); }
  browser = await chromium.launch();

  await flow('1-hr-starts-and-checks-payroll', async () => {
    const page = await as('hr', 1440, 'light'); await go(page, '/people/pay');
    await expect(page.getByText('No payroll run yet')).toBeVisible();
    await page.getByRole('link', { name: 'Payroll', exact: true }).click(); await ready(page);
    await expect(page.getByRole('heading', { name: `${monthLong} payroll` })).toBeVisible();
    await shot(page, 'payroll-start-1440-light');
    await page.getByRole('button', { name: 'Start payroll' }).click();
    const d = await drawer(page); const p = posted(page, 'comp/payroll');
    await d.getByRole('button', { name: 'Start and calculate' }).click(); ok((await p).ok(), 'HR starts the month');
    await page.waitForURL(/\/people\/pay\/payroll\/[0-9a-f-]{36}$/, { timeout: 60000 }); await ready(page);
    runId = page.url().split('/').pop();
    await expect(page.getByText('Exceptions to look at')).toBeVisible();
    await expect(page.getByText('No bank details', { exact: true })).toBeVisible();
    await shot(page, 'payroll-draft-1440-light');
    await page.getByRole('button', { name: 'Show figures' }).click();
    await expect(page.getByRole('table', { name: 'People in this payroll' })).toContainText('₹', { timeout: 30000 });
    await shot(page, 'payroll-figures-1440-light');
    await page.getByRole('button', { name: 'Details: Ahoro Nair' }).click();
    const a = await drawer(page);
    await a.getByRole('radio', { name: 'Hold from the bank file' }).click();
    await a.getByLabel('Why').fill('Bank details to come; pay by hand');
    const q = posted(page, 'comp/payroll/[^/]+/adjust'); await a.getByRole('button', { name: 'Adjust and recalculate' }).click(); ok((await q).ok(), 'HR holds one person out of the bank file');
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20000 });
    await page.getByRole('button', { name: 'Mark checked' }).click();
    const c = await drawer(page); const r = posted(page, 'comp/payroll/[^/]+/check');
    await c.getByLabel(/Note/).fill('Looked at every exception'); await c.getByRole('button', { name: 'Mark checked' }).click(); ok((await r).ok(), 'HR checks it');
    await expect(page.getByText('Waiting for a founder').first()).toBeVisible({ timeout: 20000 });
  });

  await flow('2-founder-approves-and-downloads', async () => {
    const page = await as('founder', 1440, 'dark'); await go(page, `/people/pay/payroll/${runId}`);
    await page.getByRole('button', { name: 'Approve and lock' }).click();
    const d = await drawer(page); await shot(page, 'payroll-approve-1440-dark');
    const p = posted(page, 'comp/payroll/[^/]+/approve'); await d.getByRole('button', { name: 'Approve and lock' }).click(); ok((await p).ok(), 'a founder approves and locks');
    await expect(page.getByRole('link', { name: 'Download bank file' })).toBeVisible({ timeout: 30000 });
    await shot(page, 'payroll-locked-1440-dark');
    const file = await page.request.get(`${base}/api/v0/comp/payroll/${runId}/bank-file`);
    const csv = (await file.body()).toString();
    ok(file.ok() && csv.startsWith('Payment Mode,') && csv.includes('NEFT,501002003004') && csv.includes('IFT,918000111222') && !csv.includes('Ahoro'), 'the bank file pays two people, not the one held');
  });

  await flow('3-the-person-reads-their-payslip', async () => {
    const page = await as('person', 390, 'light'); await go(page, '/me/pay');
    const slips = page.getByRole('region', { name: 'Payslips' });
    await expect(slips.getByText(MONTHS[Number(due.slice(5, 7)) - 1].slice(0, 3), { exact: false }).first()).toBeVisible();
    await noSideways(page, 'my pay 390 light'); await shot(page, 'my-pay-payslip-390-light');
    const href = await slips.getByRole('link', { name: 'Open' }).first().getAttribute('href');
    const pdf = await page.request.get(base + href);
    const bytes = await pdf.body();
    ok(pdf.ok() && bytes.subarray(0, 5).toString() === '%PDF-' && !bytes.includes(Buffer.from([0xef, 0xbf, 0xbd])) && bytes.subarray(-6).toString().includes('%%EOF'), 'the payslip opens as a PDF, its bytes intact through the web proxy');
    if (shots) await writeFile(`${shots}/payslip-sample.pdf`, bytes);
  });

  await flow('4-leadership-people-cost', async () => {
    await api('comp/budget/seed', {}, 'founder');
    await api('comp/budget/roles', { title: 'Video editor', pod: 'Pod 9', count: 2, from: nextMonth, monthly: '32000' }, 'founder');
    const page = await as('founder', 1440, 'light'); await go(page, '/finance/people-cost');
    await expect(page.getByRole('navigation', { name: 'Finance sections' }).getByRole('link', { name: 'People cost' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText(/People budget, FY/)).toBeVisible();
    await expect(page.getByText(/unconfirmed/).first()).toBeVisible();
    await shot(page, 'people-cost-1440-light');
    await page.getByRole('tab', { name: 'Budget' }).click();
    await expect(page.getByRole('table', { name: 'Planned roles' })).toContainText('Video editor');
    await shot(page, 'budget-1440-light');
    await page.getByRole('tab', { name: 'What if…' }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Two editors and a raise');
    await page.getByLabel('Add a step').selectOption('hire');
    await page.getByRole('textbox', { name: 'People', exact: true }).fill('2'); await page.getByRole('textbox', { name: 'Role', exact: true }).fill('Editor'); await page.getByLabel('Pay a month, each (₹)').fill('30000');
    await page.getByLabel('Add a step').selectOption('raise');
    const p = posted(page, 'comp/scenarios/preview'); await page.getByRole('button', { name: 'See the effect' }).click(); ok((await p).ok(), 'the sandbox works out the effect');
    await expect(page.getByText('People cost, 12 months')).toBeVisible();
    const s = posted(page, 'comp/scenarios'); await page.getByRole('button', { name: 'Save scenario' }).click(); ok((await s).ok(), 'a founder saves the scenario');
    await shot(page, 'whatif-1440-light');
    await page.getByRole('tab', { name: 'Ledger' }).click();
    await expect(page.getByRole('table', { name: 'People-cost ledger' })).toContainText('Net pay payable');
    await shot(page, 'ledger-1440-light');
    const versions = (await own('select count(*)::int n from pulse.comp_change where person_id=any($1)', [[R.person, R.head, R.other]]))[0].n;
    ok(versions === 3, 'scenarios touched no record');
  });

  await flow('5-change-pay-shows-the-budget', async () => {
    await api('comp/budget', { pod: 'Pod 9', amount: '60000', from: nextMonth, to: nextMonth }, 'founder');
    const page = await as('hr', 1440, 'light'); await go(page, `/people/pay/${R.person}?do=change`);
    const d = await drawer(page);
    await d.getByLabel('Gross pay a month').fill('52000');
    await d.getByLabel(/takes effect|Effective/).first().fill(`${nextMonth}-01`).catch(() => null);
    await expect(d.getByText(/people budget/)).toBeVisible({ timeout: 30000 });
    await shot(page, 'change-pay-budget-1440-light');
  });

  await flow('6-gallery', async () => {
    for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']]) {
      let page = await as('founder', width, theme);
      await go(page, '/finance/people-cost'); if (width < 500) await noSideways(page, `people cost ${width} ${theme}`); await shot(page, `people-cost-${width}-${theme}`);
      await go(page, `/finance/people-cost?costView=${encodeURIComponent('What if…')}`); if (width < 500) await noSideways(page, `what if ${width} ${theme}`); await shot(page, `whatif-${width}-${theme}`);
      await go(page, `/finance/people-cost?costView=Budget`); if (width < 500) await noSideways(page, `budget ${width} ${theme}`); await shot(page, `budget-${width}-${theme}`);
      await go(page, '/people/pay/payroll'); if (width < 500) await noSideways(page, `payroll ${width} ${theme}`); await shot(page, `payroll-${width}-${theme}`);
      await go(page, `/people/pay/payroll/${runId}`); if (width < 500) await noSideways(page, `run ${width} ${theme}`); await shot(page, `payroll-run-${width}-${theme}`);
      await page.context().close();
      page = await as('person', width, theme); await go(page, '/me/pay'); if (width < 500) await noSideways(page, `my pay ${width} ${theme}`); await shot(page, `my-pay-${width}-${theme}`);
      await page.context().close();
      page = await as('hr', width, theme); await go(page, '/people/pay/settings'); await page.getByText('Payroll: statutory basics').scrollIntoViewIfNeeded();
      if (width < 500) await noSideways(page, `policy ${width} ${theme}`); await shot(page, `payroll-settings-${width}-${theme}`);
    }
  });
} finally {
  await browser?.close().catch(() => null); server.kill('SIGTERM'); await app.close(); await pool.end(); await owner.end();
}
const failed = results.filter((r) => !r.ok);
await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks, results, failed: failed.length, errors }, null, 1));
for (const e of errors) console.log(`PAGE ERROR ${e}`);
console.log(`payroll browser: ${results.length - failed.length}/${results.length} flows, ${checks} checks, ${errors.length} page errors`);
process.exit(failed.length || errors.length ? 1 : 0);
