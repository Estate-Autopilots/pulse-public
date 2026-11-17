// KAZUK-GAPS in the browser (tests/core/test_kazuk_gaps.py): the real API on a disposable synthetic company and the web app
// under `next dev`. Leadership's Work → Projects (Kazuk's CEO screen) shows money at risk in rupees with each item's age and
// the client issues raised today; a salesperson's My sales leads with their pipeline by stage and follow-ups; "Resume where
// you left off" lists unfinished work on Home and in Billing, and the New project form picks up what was typed on another
// device. 1440 and 390, light and dark, no sideways scroll, no page errors. Screenshots with PULSE_KG_SCREENSHOTS=<dir>.
// Everything is invented.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), emails = JSON.parse(process.env.TEST_EMAILS), shots = process.env.PULSE_KG_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-kg', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
// CI-GREEN-4: stop waits until next dev has gone (SIGKILL after 10 s); the 3 s kill timer was unref'd, so the runner could
// exit first and leave the server up, and Next 16 allows one next dev per app folder: an alone retry could not start one.
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
const deadline = setTimeout(() => { console.error(`kazuk-gaps-browser-runner: no result after 25 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
async function context(role, width = 1440, theme = 'light') {
  const phone = width < 600;
  const c = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
  await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); } catch { /* private */ } }, theme);
  return c;
}
async function open(c, path, name) {
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
  return page;
}
const shot = async (page, name, full = true) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: full }); };
const SIZES = [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']];
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  // 1. Kazuk's CEO screen: money at risk in rupees with ages, and today's client issues, at every size and theme.
  step(1);
  for (const [width, theme] of SIZES) {
    const c = await context('founder', width, theme), page = await open(c, '/tasks?view=projects&scope=all', `ceo ${width} ${theme}`);
    await seen(page.getByText('Money at risk'));
    await seen(page.getByText('Overdue invoices'));
    await seen(page.getByText('Quotations with no answer'));
    await seen(page.getByText('Not billed yet'));
    await seen(page.getByText(/10 days/));
    // UX-GAMIFY (13 Nov 2026): today's client issues are one card, "Today's issues", worst first.
    await seen(page.getByText(/Today.s issues/).first());
    await seen(page.getByText('Synthetic inputs missing from the client'));
    await fits(page, `CEO screen ${width} ${theme}`); await shot(page, `ceo-${width}-${theme}`);
    await c.close();
  }
  // 2. The salesperson's pipeline on My sales: stages, pipeline value, won and lost this month, the follow-up due.
  step(2);
  for (const [width, theme] of SIZES) {
    const c = await context('sales', width, theme), page = await open(c, '/sales', `sales ${width} ${theme}`);
    await seen(page.getByText('My pipeline'));
    await seen(page.getByText('Sent, no answer yet'));
    await seen(page.getByText(/Pipeline value/));
    await seen(page.getByText(/Won this month/));
    await seen(page.getByText('Synthetic call about the quotation'));
    await fits(page, `My sales ${width} ${theme}`); await shot(page, `sales-${width}-${theme}`);
    await c.close();
  }
  // 3. Resume where you left off: on Home, the form left unfinished on another device; in Billing, the quotation draft.
  step(3);
  for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
    const c = await context('founder', width, theme);
    const home = await open(c, '/dashboard', `home ${width}`);
    await seen(home.getByText('Resume where you left off'));
    await seen(home.getByRole('link', { name: /New project: Synthetic office move/ }));
    await fits(home, `Home ${width}`); await shot(home, `resume-home-${width}-${theme}`);
    const erp = await open(c, '/erp', `billing ${width}`);
    await seen(erp.getByText('Resume where you left off'));
    await seen(erp.getByText(/Quotation draft/));
    await fits(erp, `Billing ${width}`); await shot(erp, `resume-billing-${width}-${theme}`);
    // Resume opens the New project form with what was typed elsewhere.
    await home.bringToFront();
    await home.getByRole('link', { name: /New project: Synthetic office move/ }).click();
    const dlg = home.getByRole('dialog', { name: 'New project' });
    await seen(dlg.getByRole('button', { name: 'Pick up where you left off' }), 240000);
    await shot(home, `resume-form-${width}-${theme}`, false);
    await dlg.getByRole('button', { name: 'Pick up where you left off' }).click();
    await expect(dlg.getByLabel('Name')).toHaveValue('Synthetic office move'); checks++;
    await c.close();
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log(`kazuk-gaps-browser-runner: ${checks} checks passed`);
} catch (e) {
  if (shots && last) await last.screenshot({ path: `${shots}/failure.png`, fullPage: true }).catch(() => undefined);
  console.error(e instanceof Error ? e.stack : e); process.exitCode = 1;
} finally {
  clearTimeout(deadline); await browser?.close().catch(() => undefined); await stopServer(); await app.close().catch(() => undefined); await pool.end().catch(() => undefined);
}
