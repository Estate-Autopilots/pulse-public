// QUOTE-STRUCT in the browser (tests/core/test_quote_structure.py; Kazuk's "Phase-wise Package Editing" build guide, 16 Nov
// 2026): the real API on a disposable synthetic company and the web app under `next dev`. Billing settings shows the
// company's phases; in the composer a package opens into its parts under the phase headings; a part is unticked, one
// gets +1, the totals and the customer's copy follow, and it saves. The package page adds its parts up by quantity, and a
// salesperson sees no cost on it. 1440 and 363, light and dark, no sideways scroll, no page errors. Screenshots with
// PULSE_QS_SCREENSHOTS=<dir> (the PDF too). Everything is invented.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), emails = JSON.parse(process.env.TEST_EMAILS), shots = process.env.PULSE_QS_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-qs', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = async () => {
  if (serverExit !== null) return;
  const gone = new Promise((done) => server.once('exit', done));
  try { process.kill(-server.pid, 'SIGTERM'); } catch { return; }
  if (await Promise.race([gone.then(() => true), delay(10000).then(() => false)])) return;
  try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  await Promise.race([gone, delay(5000)]);
};
let browser, checks = 0, current = 'start', last;
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`quote-structure runner: no result after 30 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 30 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
async function context(role, width = 1440, theme = 'light') {
  const phone = width < 600;
  const c = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, colorScheme: theme,
    extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
  await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('theme', t); } catch { /* none */ } }, theme);
  return c;
}
async function open(c, path, name) {
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
  return page;
}
const shot = async (page, name, full = true) => { if (shots) { await page.waitForTimeout(600); await page.screenshot({ path: `${shots}/${name}.png`, fullPage: full }); } };
// A phone page as the person sees it, screen by screen (a full-page capture draws fixed bars in the middle of the page).
const screens = async (page, name, n = 3) => { if (!shots) return; for (let i = 0; i < n; i++) {
  await page.evaluate((k) => window.scrollTo(0, k * (innerHeight - 140)), i); await page.waitForTimeout(500);
  await page.screenshot({ path: `${shots}/${name}-${i + 1}.png` });
  if (await page.evaluate(() => window.scrollY + innerHeight >= document.documentElement.scrollHeight - 2)) break; } };
const drawn = (page) => page.locator('canvas[data-pdf-page]').first().waitFor({ timeout: 90000 }).catch(() => undefined);
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(2000); }
  browser = await chromium.launch();
  // 1. Billing settings: the company's phases, in order.
  step(1);
  for (const width of [1440, 363]) {
    const c = await context('founder', width), page = await open(c, '/erp/settings#phases', `settings ${width}`);
    await seen(page.getByRole('heading', { name: 'Phases on quotations' }));
    await seen(page.locator('input[value="Phase 2: Make"]'));
    // The card below the app's fixed header, captured as the screen shows it.
    await page.locator('#phases').evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 90));
    await fits(page, `Settings ${width}`);
    await shot(page, `settings-phases-${width}`, false);
    await c.close();
  }
  // 2. The composer: the package opens into its parts under the phases; untick one, +1 on another; it saves.
  step(2);
  {
    const c = await context('founder', 1440), page = await open(c, `/erp/documents/${E.docs[0]}`, 'composer 1440');
    await seen(page.getByRole('button', { name: E.packageName }));
    await page.getByRole('button', { name: E.packageName }).first().click();
    await seen(page.getByText('Phase 1: Plan', { exact: true }));
    await seen(page.getByText('Phase 2: Make', { exact: true }));
    await seen(page.getByText('Bonuses included', { exact: true }));
    await page.getByRole('checkbox', { name: /Keep Synthetic alignment session/ }).uncheck();
    await seen(page.getByText('removed', { exact: true }));
    await page.getByRole('button', { name: 'More: Quantity of Synthetic video ad (standard)' }).first().click();
    await seen(page.getByText('+1', { exact: true }));
    await seen(page.getByText('Saved', { exact: true }), 60000);
    await drawn(page);
    await fits(page, 'Composer 1440'); await shot(page, 'composer-1440');
    // A part's drawer: swap for a variant in the same phase, or price it later.
    await page.getByRole('button', { name: /Synthetic video ad \(standard\).*: details/ }).first().click();
    const dlg = page.getByRole('dialog');
    await seen(dlg.getByText('Swap for'));
    await seen(dlg.getByRole('button', { name: /Synthetic video ad \(luxury\)/ }));
    await shot(page, 'part-drawer-1440', false);
    await page.keyboard.press('Escape');
    // "+ Add to Phase 1": the search opens under that phase, its items first.
    await page.getByRole('button', { name: 'Add to Phase 1: Plan' }).click();
    await seen(page.getByText(/Adding to/));
    await page.getByText(/Adding to/).first().scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -160));
    await shot(page, 'add-to-phase-1440', false);
    await c.close();
  }
  for (const [width, theme] of [[1440, 'dark'], [363, 'light'], [363, 'dark']]) {
    const c = await context('founder', width, theme), page = await open(c, `/erp/documents/${E.docs[0]}`, `composer ${width} ${theme}`);
    await seen(page.getByText('Phase 2: Make', { exact: true }));
    await fits(page, `Composer ${width} ${theme}`);
    if (width < 600) await screens(page, `composer-${width}-${theme}`, 4);
    else { await drawn(page); await shot(page, `composer-${width}-${theme}`); }
    await c.close();
  }
  // 3. The PDF as exported (the saved draft).
  step(3);
  {
    const r = await fetch(`${origin}/api/v0/erp/documents/${E.docs[0]}/pdf`, { headers: { 'cf-access-authenticated-user-email': emails.founder } });
    assert.equal(r.status, 200); const pdf = Buffer.from(await r.arrayBuffer()); assert.ok(pdf.subarray(0, 5).toString() === '%PDF-'); checks++;
    if (shots) writeFileSync(`${shots}/quotation.pdf`, pdf);
  }
  // 4. The package page: parts add up by quantity; the phase field; a salesperson sees no cost.
  step(4);
  for (const [role, width] of [['founder', 1440], ['founder', 363], ['sales', 1440]]) {
    const c = await context(role, width), page = await open(c, `/erp/catalog/${E.package}`, `package ${role} ${width}`);
    await seen(page.getByText(/Parts add up to/));
    await seen(page.getByText(E.partsTotal));
    if (role === 'founder') { await seen(page.getByText('Phase on quotations')); assert.ok(await page.getByText(/cost ₹/).count() > 0, 'leadership sees part costs'); checks++; }
    else { assert.equal(await page.getByText(/cost ₹|cost to deliver|Margin/i).count(), 0, 'a salesperson sees no cost or margin'); checks++; }
    await fits(page, `Package ${role} ${width}`);
    if (width < 600) await screens(page, `package-${role}-${width}`, 3); else { await drawn(page); await shot(page, `package-${role}-${width}`); }
    await c.close();
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log(`quote-structure runner: ${checks} checks passed`);
} catch (e) {
  if (shots && last) await last.screenshot({ path: `${shots}/failure.png`, fullPage: true }).catch(() => undefined);
  console.error(e instanceof Error ? e.stack : e); process.exitCode = 1;
} finally {
  clearTimeout(deadline); await browser?.close().catch(() => undefined); await stopServer(); await app.close().catch(() => undefined); await pool.end().catch(() => undefined);
}
