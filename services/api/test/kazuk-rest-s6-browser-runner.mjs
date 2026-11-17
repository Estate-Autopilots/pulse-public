// KAZUK-REST slice 6 in the browser (tests/core/test_kazuk_rest_s6.py): the real API on a disposable synthetic company and
// the web app under `next dev`. The colleague asked to cover sees the ask on the cover page and the SOP's steps; HR sees
// what needs someone else and the cover rule, and on the published leave policy who has not acknowledged it, and reminds
// them. 1440 and 390, light and dark, no sideways scroll, no page errors. Screenshots with PULSE_KR_SCREENSHOTS=<dir>.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const emails = JSON.parse(process.env.TEST_EMAILS), shots = process.env.PULSE_KR_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-kr6', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
// CI-GREEN-4: wait until next dev has gone (SIGKILL after 10 s). The 3 s kill timer was unref'd, so the runner could exit
// first and leave the server running: Next 16 allows one next dev per app folder, so the alone retry of this test (hosted
// 43859922415) could not start one ("Another next dev server is already running").
const stopServer = async () => {
  if (serverExit !== null) return;
  const gone = new Promise((done) => server.once('exit', done));
  try { process.kill(-server.pid, 'SIGTERM'); } catch { return; }
  if (await Promise.race([gone.then(() => true), delay(10000).then(() => false)])) return;
  try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  await Promise.race([gone, delay(5000)]);
};
// AGREEMENTS (b5e3eaae2): a person with a policy still to accept gets the acceptance sheet over the page (the HR person
// here has the leave policy too); "Not now" is the person's own answer, until the next visit.
const notNow = async (page) => {
  const later = page.locator('[data-policy-accept]').getByRole('button', { name: 'Not now', exact: true });
  if (await later.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) { await later.click(); await later.waitFor({ state: 'hidden', timeout: 10000 }); }
};
let browser, checks = 0, current = 'start', last;
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`kazuk-rest-s6-browser-runner: no result after 25 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
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
  // 1. The colleague asked: the ask, the SOP's steps, I'll cover / I can't.
  step(1);
  for (const [width, theme] of SIZES) {
    const c = await context('bob', width, theme), page = await open(c, '/cover', `cover bob ${width} ${theme}`);
    await seen(page.getByRole('heading', { name: 'Cover while away' }));
    await seen(page.getByText('Synthetic Alice'));
    await seen(page.getByText(/Synthetic handover: files in the shared drive/));
    await seen(page.getByRole('button', { name: /cover$/ }));
    await seen(page.getByText('How cover works'));
    await seen(page.getByText(/answer within 24 hours/));
    await fits(page, `cover ${width} ${theme}`); await shot(page, `cover-asked-${width}-${theme}`);
    await c.close();
  }
  // 2. HR: what needs someone else (Bob declined Carol's), the cover rule; the leave policy's acknowledgements.
  step(2);
  for (const [width, theme] of SIZES) {
    const c = await context('hr', width, theme), page = await open(c, '/cover', `cover hr ${width} ${theme}`);
    await seen(page.getByRole('heading', { name: 'Needs someone else' }));
    await seen(page.getByText(/Synthetic Carol · Leave/));
    await seen(page.getByText(/I am away that week too/));
    await seen(page.getByRole('button', { name: 'Ask someone else' }));
    await seen(page.getByRole('button', { name: 'Save the rule' }));
    await fits(page, `cover HR ${width} ${theme}`); await shot(page, `cover-hr-${width}-${theme}`);
    const pol = await open(c, '/hr?tab=policies&view=documents&doc=leave', `policies ${width} ${theme}`);
    await seen(pol.getByText(/Acknowledged by 1 of/), 240000);
    await seen(pol.getByText(/Not acknowledged yet/));
    await seen(pol.getByRole('button', { name: /Remind the \d+ who have not/ }));
    await fits(pol, `policy acks ${width} ${theme}`); await shot(pol, `policy-acks-${width}-${theme}`);
    await c.close();
  }
  // 3. Bob covers; HR reminds the people who have not acknowledged.
  step(3);
  { const c = await context('bob', 1440, 'light'), page = await open(c, '/cover', 'cover accept');
    await page.getByRole('button', { name: /cover$/ }).first().click();
    await seen(page.getByText('Covered'));
    await shot(page, 'cover-accepted-1440-light'); await c.close(); }
  { const c = await context('hr', 1440, 'light'), pol = await open(c, '/hr?tab=policies&view=documents&doc=leave', 'remind');
    await notNow(pol);
    const sent = pol.waitForResponse((r) => r.url().includes('/remind') && r.request().method() === 'POST', { timeout: 120000 });
    await pol.getByRole('button', { name: /Remind the \d+ who have not/ }).click();
    const res = await sent; assert.equal(res.status(), 200, await res.text());
    await seen(pol.getByText(/· reminded /));
    await shot(pol, 'policy-reminded-1440-light'); await c.close(); }
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log(`kazuk-rest-s6-browser-runner: ${checks} checks passed`);
} catch (e) {

  if (shots && last) await last.screenshot({ path: `${shots}/failure.png`, fullPage: true }).catch(() => undefined);
  console.error(e instanceof Error ? e.stack : e); process.exitCode = 1;
} finally {
  clearTimeout(deadline); await browser?.close().catch(() => undefined); await stopServer(); await app.close().catch(() => undefined); await pool.end().catch(() => undefined);
}
