// KAZUK-REST rate cards in the browser (tests/core/test_kazuk_rest_rate_cards.py): the real API on a disposable synthetic
// company and the web app under `next dev`. Billing → Rate cards lists the card and opens its editor; in the composer,
// "Rate card" builds the quotation lines (Senior, per quarter, X 1, the shoot day add-on) and they save. 1440 and 390,
// no sideways scroll, no page errors. Screenshots with PULSE_KR_SCREENSHOTS=<dir>. Everything is invented.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), emails = JSON.parse(process.env.TEST_EMAILS), shots = process.env.PULSE_KR_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-kr', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
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
const deadline = setTimeout(() => { console.error(`rate-cards runner: no result after 25 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
async function context(role, width = 1440) {
  const phone = width < 600;
  return browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
}
async function open(c, path, name) {
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
  return page;
}
const shot = async (page, name, full = true) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: full }); };
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  // 1. Billing → Rate cards: the card, its price from, and its editor.
  step(1);
  for (const width of [1440, 390]) {
    const c = await context('founder', width), page = await open(c, '/erp/rate-cards', `rate cards ${width}`);
    await seen(page.getByRole('heading', { name: 'Rate cards' }));
    await seen(page.getByText('Synthetic social media'));
    await seen(page.getByText(/Reels per week 1–5/));
    await fits(page, `Rate cards ${width}`); await shot(page, `rate-cards-${width}`);
    await page.getByRole('button', { name: /Synthetic social media: edit/ }).first().click();
    const dlg = page.getByRole('dialog', { name: 'Synthetic social media' });
    await seen(dlg.getByText('Talent levels'));
    await seen(dlg.getByText(/Junior, per quarter, reels per week 1/));
    await shot(page, `rate-card-editor-${width}`, false);
    await c.close();
  }
  // 2. The composer builds lines from the rate card, priced from it, and saves them.
  step(2);
  for (const [i, width] of [[0, 1440], [1, 390]]) {
    const c = await context('founder', width), page = await open(c, `/erp/documents/${E.docs[i]}`, `composer ${width}`);
    await seen(page.getByRole('button', { name: 'Rate card' }));
    await page.getByRole('button', { name: 'Rate card' }).click();
    const dlg = page.getByRole('dialog', { name: 'Rate card' });
    await seen(dlg.getByText('Talent level'));
    await dlg.getByLabel(/^Senior/).check();
    await dlg.getByLabel(/^Per quarter/).check();
    await dlg.getByLabel(/^Synthetic shoot day/).check();
    await seen(dlg.getByText(/1,71,000/));
    await shot(page, `rate-card-pick-${width}`, false);
    await dlg.getByRole('button', { name: 'Add to the quotation' }).click();
    await seen(page.getByText('Synthetic social media · Senior · Per quarter'));
    await seen(page.getByText('Synthetic shoot day (Synthetic social media)'));
    await seen(page.getByText('Saved', { exact: true }), 60000);
    await fits(page, `Composer ${width}`); await shot(page, `rate-card-lines-${width}`);
    await c.close();
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log(`rate-cards runner: ${checks} checks passed`);
} catch (e) {
  if (shots && last) await last.screenshot({ path: `${shots}/failure.png`, fullPage: true }).catch(() => undefined);
  console.error(e instanceof Error ? e.stack : e); process.exitCode = 1;
} finally {
  clearTimeout(deadline); await browser?.close().catch(() => undefined); await stopServer(); await app.close().catch(() => undefined); await pool.end().catch(() => undefined);
}
