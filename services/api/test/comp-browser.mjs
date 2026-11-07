// COMP-A in the browser: the real API (this process) and the built web app (`next start`, NEXT_DIST_DIR) on a disposable
// synthetic tenant (tests/core/test_comp.py::test_comp_in_the_browser). One person's whole story, each step by the role
// that does it, across 1440 and 390 px and light and dark: HR drafts an offer → a founder approves and sends it → the
// candidate accepts through the link (signed out, phone) → probation starts → HR confirms it → HR proposes a raise and
// a founder approves it → a pause → a bonus → the person claims a reimbursement with a photo of the bill and their head
// approves it → notice → the full and final, checked by HR and approved by a founder → the person reads every letter.
// Then a gallery of every screen at 1440/390 × light/dark. Synthetic people and figures only.
// PULSE_COMP_SCREENSHOTS=<dir> keeps the screenshots (and any failure's).
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
// An idle connection the scratch server ends must not crash the run (the next query reconnects).
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
const ready = async (page) => { await page.waitForFunction(() => document.querySelector('main h1,main h2,main h3') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 60000 }); await page.waitForTimeout(400); };
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load' }); await ready(page); };
/** The POST whose path matches `re` (anchored after /api/v0/): previews running in the background never count. */
const posted = (page, re) => page.waitForResponse((r) => r.request().method() === 'POST' && new RegExp(`^/api/v0/(?:${re})$`).test(new URL(r.url()).pathname), { timeout: 30000 });
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
/** Nothing spills sideways at phone width. */
async function noSideways(page, label) {
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  ok(w[0] <= w[1] + 1, `${label}: no sideways scroll (${w[0]} > ${w[1]})`);
}
async function drawer(page) { const d = page.getByRole('dialog'); await expect(d).toBeVisible({ timeout: 20000 }); return d; }
/** The live letter preview finished drawing at least one page. */
async function letterDrawn(scope) { await expect(scope.locator('[data-drawn="1"]').first()).toBeAttached({ timeout: 45000 }); }
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
const today = (await own('select pulse.lifecycle_today()::text d'))[0].d;
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
let offerLink = null;

try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch {} await delay(200); if (i === 599) throw new Error('next start did not answer'); }
  browser = await chromium.launch();

  await flow('1-hr-drafts-an-offer', async () => {
    const page = await as('hr', 1440, 'light'); await go(page, '/people/pay');
    const row = page.getByRole('row', { name: /Kabir Rao/ });
    await expect(row.getByText('Candidate: draft the offer')).toBeVisible();
    await shot(page, 'people-pay-1440-light-start');
    await row.getByRole('link', { name: /Draft offer/ }).click(); await ready(page);
    const d = await drawer(page);
    await d.getByLabel('Role').fill('Senior video editor');
    await d.getByLabel('Starts on').fill(today);
    await d.getByLabel('Gross pay a month').fill('48,000');
    await d.getByLabel('Other terms').fill('Work from the Pune studio; review after three months against the role KPIs.');
    await expect(d.getByText('The pay, by component (a month)')).toBeVisible({ timeout: 20000 });
    await letterDrawn(d);
    await shot(page, 'offer-draft-1440-light');
    const saved = posted(page, 'comp/offers'); await d.getByRole('button', { name: 'Ask a founder' }).click(); ok((await saved).ok(), 'the offer is saved and goes to a founder');
    await expect(page.getByText('Offer waiting for a founder').first()).toBeVisible({ timeout: 20000 });
  });

  await flow('2-founder-approves-and-sends', async () => {
    const page = await as('founder', 1440, 'dark'); await go(page, '/people/pay');
    await page.getByRole('row', { name: /Kabir Rao/ }).getByRole('link', { name: /Review offer/ }).click(); await ready(page);
    const d = await drawer(page); await letterDrawn(d);
    await shot(page, 'offer-review-1440-dark');
    const approved = posted(page, 'comp/offers/[^/]+/decide'); await d.getByRole('button', { name: 'Approve' }).click(); ok((await approved).ok(), 'approved: the offer letter is filed');
    await page.getByRole('button', { name: 'Send offer' }).first().click();
    const s = await drawer(page); const sent = posted(page, 'comp/offers/[^/]+/send'); await s.getByRole('button', { name: 'Send', exact: true }).click(); ok((await sent).ok(), 'sent by the founder');
    offerLink = await s.getByLabel('Acceptance link').inputValue();
    ok(/\/offer\/[A-Za-z0-9_-]{43}$/.test(offerLink), 'the link is shown once');
    await shot(page, 'offer-sent-1440-dark');
  });

  await flow('3-candidate-accepts-on-a-phone', async () => {
    const page = await as(null, 390, 'dark'); await page.goto(offerLink.replace(/^https?:\/\/[^/]+/, base), { waitUntil: 'load' });
    await expect(page.getByRole('heading', { name: /your offer/ })).toBeVisible({ timeout: 30000 });
    await expect(page.locator('[data-drawn="1"]')).toBeAttached({ timeout: 45000 });
    await noSideways(page, 'offer link 390');
    await shot(page, 'offer-link-390-dark');
    await page.getByLabel('Your full name').fill('Kabir Rao');
    await page.getByRole('button', { name: 'Accept the offer' }).click();
    await expect(page.getByText(/Your acceptance is recorded/)).toBeVisible({ timeout: 20000 });
    await shot(page, 'offer-accepted-390-dark');
    const st = await own("select status from pulse.comp_record where person_id=$1", [R.candidate]);
    ok(st[0]?.status === 'probation', `the record is on probation from today (${st[0]?.status})`);
  });

  await flow('4-hr-confirms-probation-on-a-phone', async () => {
    const page = await as('hr', 390, 'light'); await go(page, `/people/pay/${R.candidate}`);
    await expect(page.getByText('On probation').first()).toBeVisible();
    await noSideways(page, 'person pay 390');
    await shot(page, 'person-probation-390-light');
    await page.getByRole('button', { name: 'Confirm probation' }).first().click();
    const d = await drawer(page); await letterDrawn(d); await shot(page, 'probation-confirm-390-light');
    const done = posted(page, 'comp/people/[^/]+/probation'); await d.getByRole('button', { name: 'Confirm' }).click(); ok((await done).ok(), 'probation confirmed by HR (policy: HR)');
    await expect(page.getByText('Confirmed').first()).toBeVisible({ timeout: 20000 });
  });

  await flow('5-raise-proposed-and-approved', async () => {
    let page = await as('hr', 1440, 'dark'); await go(page, `/people/pay/${R.candidate}`);
    await page.getByRole('button', { name: 'Change pay' }).click();
    const d = await drawer(page);
    await d.getByLabel('Takes effect on').fill(addDays(today, 20));
    await d.getByLabel('Gross pay a month').fill('52,800');
    await d.getByLabel('Why').fill('Took over the Pod 2 edits after the first month.');
    await expect(d.getByRole('region', { name: 'Before and after' })).toContainText('₹48,000', { timeout: 20000 });
    await expect(d.getByText(/\+₹4,800|\+10%/).first()).toBeVisible();
    await letterDrawn(d); await shot(page, 'change-pay-1440-dark');
    const prop = posted(page, 'comp/changes'); await d.getByRole('button', { name: 'Propose' }).click(); ok((await prop).ok(), 'HR proposes the raise');
    await page.context().close();
    page = await as('founder', 1440, 'light'); await go(page, '/people/pay');
    await page.getByRole('row', { name: /Kabir Rao/ }).getByRole('link', { name: /Review change/ }).click(); await ready(page);
    const a = await drawer(page); await expect(a.getByText('₹52,800').first()).toBeVisible(); await letterDrawn(a);
    await shot(page, 'change-review-1440-light');
    const ap = posted(page, 'comp/changes/[^/]+/decide'); await a.getByRole('button', { name: 'Approve' }).click(); ok((await ap).ok(), 'a founder approves; the letter is filed');
    await expect(page.getByText('Revision of your pay').first()).toBeVisible({ timeout: 20000 });
  });

  await flow('6-pause-and-bonus', async () => {
    let page = await as('hr', 1440, 'light'); await go(page, `/people/pay/${R.candidate}`);
    await page.getByRole('button', { name: 'Pause pay' }).click();
    let d = await drawer(page);
    await d.getByLabel('First day').fill(addDays(today, 40)); await d.getByLabel('Last day').fill(addDays(today, 49));
    await d.getByLabel('Paid during the pause, %').fill('50'); await d.getByLabel('Note for the letter').fill('Ten days away for a family matter, at half pay.');
    await letterDrawn(d); await shot(page, 'pause-1440-light');
    let p = posted(page, 'comp/pauses'); await d.getByRole('button', { name: 'Propose' }).click(); ok((await p).ok(), 'pause proposed');
    await page.getByRole('button', { name: 'Bonus or advance' }).click();
    d = await drawer(page);
    await d.getByLabel('Amount').fill('7,500'); await d.getByLabel('What it is for').fill('Festival bonus');
    await shot(page, 'bonus-1440-light');
    p = posted(page, 'comp/items'); await d.getByRole('button', { name: 'Propose' }).click(); ok((await p).ok(), 'bonus proposed');
    await page.context().close();
    page = await as('founder', 390, 'dark'); await go(page, `/people/pay/${R.candidate}`);
    await noSideways(page, 'founder person page 390');
    await shot(page, 'person-waiting-390-dark');
    await page.getByRole('button', { name: 'Review pause' }).click();
    d = await drawer(page); p = posted(page, 'comp/pauses/[^/]+/decide'); await d.getByRole('button', { name: 'Approve' }).click(); ok((await p).ok(), 'pause approved');
    await expect(page.getByRole('button', { name: 'Review pause' })).toHaveCount(0, { timeout: 20000 });
    await page.getByRole('button', { name: 'Review', exact: true }).first().click();
    d = await drawer(page); p = posted(page, 'comp/items/[^/]+/decide'); await d.getByRole('button', { name: 'Approve' }).click(); ok((await p).ok(), 'bonus approved');
  });

  await flow('7-claim-with-a-photo-and-the-head-approves', async () => {
    let page = await as('candidate', 390, 'light'); await go(page, '/me/pay');
    await noSideways(page, 'my pay 390');
    await page.getByRole('button', { name: 'Claim a reimbursement' }).click();
    const d = await drawer(page);
    await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 360; c.height = 480; const g = c.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 360, 480); g.fillStyle = '#111'; g.font = '22px sans-serif'; g.fillText('SYNTHETIC CABS', 40, 60); g.fillText('Total 1,240.00', 40, 120);
      const png = new Uint8Array(await (await new Promise((ok) => c.toBlob(ok, 'image/png'))).arrayBuffer());
      const input = document.querySelector('input[type=file][capture]');
      const dt = new DataTransfer(); dt.items.add(new File([png], 'bill.png', { type: 'image/png' })); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(d.getByRole('img', { name: 'The bill' })).toBeVisible({ timeout: 10000 });
    await d.getByLabel('Amount').fill('1,240'); await d.getByLabel('Shop or vendor').fill('Synthetic Cabs'); await d.getByLabel('What it was for').fill('Cab to the Baner shoot');
    await shot(page, 'claim-390-light');
    const p = posted(page, 'comp/claims'); await d.getByRole('button', { name: 'Send claim' }).click(); ok((await p).ok(), 'the claim is sent');
    await expect(page.getByText('With your head')).toBeVisible({ timeout: 20000 });
    await page.context().close();
    page = await as('head', 1440, 'light'); await go(page, '/people/pay/claims');
    await expect(page.getByText('₹1,240').first()).toBeVisible();
    await shot(page, 'claims-queue-1440-light');
    const a = posted(page, 'comp/claims/[^/]+/decide'); await page.getByRole('button', { name: 'Approve' }).click(); ok((await a).ok(), 'the head approves');
  });

  await flow('8-exit-and-full-and-final', async () => {
    // Notice is recorded in People moves (LIFECYCLE); here as the API does it for HR.
    const lwd = addDays(today, 30);
    const r = await app.inject({ url: `/api/v0/lifecycle/people/${R.candidate}/move`, method: 'POST', headers: { 'cf-access-authenticated-user-email': 'hr@comp.example' }, payload: { to: 'notice', effectiveOn: today, lastWorkingDay: lwd } });
    ok(r.statusCode === 200, `notice recorded (${r.statusCode} ${r.body.slice(0, 120)})`);
    let page = await as('hr', 1440, 'dark'); await go(page, `/people/pay/${R.candidate}`);
    await page.getByRole('button', { name: 'Full and final' }).first().click();
    let d = await drawer(page);
    await d.getByLabel('Leave days to encash').fill('3');
    await d.getByLabel('Notice served, days').fill('30');
    await expect(d.getByRole('table', { name: /The statement/ })).toContainText('Net payable', { timeout: 30000 });
    await letterDrawn(d); await shot(page, 'settlement-1440-dark');
    let p = posted(page, 'comp/settlements'); await d.getByRole('button', { name: 'Prepare' }).click(); ok((await p).ok(), 'HR prepares the statement');
    await page.getByRole('button', { name: 'Check it' }).click();
    d = await drawer(page); p = posted(page, 'comp/settlements/[^/]+/step'); await d.getByRole('button', { name: 'It is right: pass it on' }).click(); ok((await p).ok(), 'HR checks it');
    await page.context().close();
    page = await as('founder', 1440, 'light'); await go(page, `/people/pay/${R.candidate}`);
    await page.getByRole('button', { name: 'Review' }).first().click();
    d = await drawer(page); await expect(d.getByText('Net payable')).toBeVisible({ timeout: 20000 });
    await shot(page, 'settlement-approve-1440-light');
    p = posted(page, 'comp/settlements/[^/]+/step'); await d.getByRole('button', { name: 'Approve' }).click(); ok((await p).ok(), 'a founder approves; the letter is issued');
    await expect(page.getByText('Letter issued').first()).toBeVisible({ timeout: 20000 });
  });

  await flow('9-the-person-reads-their-letters', async () => {
    const page = await as('candidate', 390, 'dark'); await go(page, '/me/pay');
    for (const t of ['Offer of employment', 'Confirmation of employment', 'Revision of your pay', 'Pause in pay', 'Full and final settlement and relieving letter'])
      await expect(page.getByText(t).first()).toBeVisible();
    await noSideways(page, 'my pay 390 dark');
    await shot(page, 'my-pay-390-dark');
    const pdf = await page.request.get(base + (await page.getByRole('link', { name: 'Open' }).first().getAttribute('href')));
    ok(pdf.ok() && (await pdf.body()).subarray(0, 5).toString() === '%PDF-', 'the letter opens as a PDF');
  });

  await flow('10-gallery', async () => {
    for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']]) {
      let page = await as('founder', width, theme); await go(page, '/people/pay');
      // The raise starts in 20 days: the pay in force today is still the offer's.
      await page.getByRole('button', { name: 'Show pay' }).click(); await expect(page.getByText('₹48,000').first()).toBeVisible({ timeout: 20000 });
      if (width < 500) await noSideways(page, `people & pay ${width} ${theme}`);
      await shot(page, `people-pay-${width}-${theme}`);
      await go(page, `/people/pay/${R.candidate}`); if (width < 500) await noSideways(page, `person ${width} ${theme}`);
      await shot(page, `person-${width}-${theme}`);
      await page.context().close();
      page = await as('candidate', width, theme); await go(page, '/me/pay'); await shot(page, `my-pay-${width}-${theme}`);
      await page.context().close();
      page = await as('hr', width, theme); await go(page, '/people/pay/settings'); if (width < 500) await noSideways(page, `policy ${width} ${theme}`);
      await shot(page, `policy-${width}-${theme}`);
    }
  });
} finally {
  await browser?.close().catch(() => null); server.kill('SIGTERM'); await app.close(); await pool.end(); await owner.end();
}
const failed = results.filter((r) => !r.ok);
await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks, results, failed: failed.length, errors }, null, 1));
console.log(`comp browser: ${results.length - failed.length}/${results.length} flows, ${checks} checks, ${errors.length} page errors`);
process.exit(failed.length || errors.length ? 1 : 0);
