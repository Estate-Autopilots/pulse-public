// KAZUK-REST slice 5 in the browser (tests/core/test_kazuk_rest_s5.py): the real API on disposable synthetic companies and
// the web app under `next dev`. The Pulse dev organisation's leadership opens Bug reports → From other companies: the
// reporting company and its number, the masked title, the screen and signals, a status and "Make a task". 1440 and 390,
// light and dark, no sideways scroll, no page errors. Screenshots with PULSE_KR_SCREENSHOTS=<dir>. Everything is invented.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const emails = JSON.parse(process.env.TEST_EMAILS), source = process.env.TEST_SOURCE_NAME, shots = process.env.PULSE_KR_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-kr5', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
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
const deadline = setTimeout(() => { console.error(`kazuk-rest-s5-browser-runner: no result after 25 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
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
  step(1);
  for (const [width, theme] of SIZES) {
    const c = await context('devLead', width, theme);
    // Bug reports offers the inbox to the dev organisation's leadership.
    const triage = await open(c, '/bug-reports', `triage ${width} ${theme}`);
    await seen(triage.getByRole('link', { name: /From other companies/ }));
    const page = await open(c, '/bug-reports/dev', `inbox ${width} ${theme}`);
    await seen(page.getByRole('heading', { name: 'From other companies' }));
    await seen(page.getByText(source));
    await seen(page.getByText('Bug on /tasks/:id'));
    await seen(page.getByText('Synthetic idea: bulk export of the leave calendar'));
    await seen(page.getByText('Stopped their work'));
    await seen(page.getByText(/A summary only/));
    assert.equal(await page.getByText(/98765|fake\.person|save button/).count(), 0, 'nothing private on the page'); checks++;
    await fits(page, `inbox ${width} ${theme}`); await shot(page, `dev-inbox-${width}-${theme}`);
    await c.close();
  }
  // Make the dev team's own task for the first one, then it links to the task.
  step(2);
  const c = await context('devLead', 1440, 'light'), page = await open(c, '/bug-reports/dev', 'inbox task');
  await page.getByRole('button', { name: 'Make a task' }).first().click();
  await seen(page.getByRole('link', { name: 'Open the task' }));
  await shot(page, 'dev-inbox-task-1440-light');
  await c.close();
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log(`kazuk-rest-s5-browser-runner: ${checks} checks passed`);
} catch (e) {
  if (shots && last) await last.screenshot({ path: `${shots}/failure.png`, fullPage: true }).catch(() => undefined);
  console.error(e instanceof Error ? e.stack : e); process.exitCode = 1;
} finally {
  clearTimeout(deadline); await browser?.close().catch(() => undefined); await stopServer(); await app.close().catch(() => undefined); await pool.end().catch(() => undefined);
}
