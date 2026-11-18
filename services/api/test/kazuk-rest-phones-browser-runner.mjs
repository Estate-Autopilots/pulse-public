// KAZUK-REST slice 3 in the browser (tests/core/test_kazuk_rest_phones.py): the real API on a disposable synthetic company
// and the web app under `next dev`. (1) A call whose microphone is busy, refused or never answers says so plainly with
// Try again (and Try again asks for the microphone again); (2) on a phone, a floating "+" on Home opens the same Create
// dialog as the C key, and it is not on wider screens or on pages with their own "+ New". 1440 and 390, no sideways
// scroll, no page errors. Screenshots with PULSE_KR_SCREENSHOTS=<dir>. Everything is invented.
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
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-kr3', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
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
const deadline = setTimeout(() => { console.error(`kazuk-rest-phones-browser-runner: no result after 25 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
// The microphone, as the test wants it: window.__mic = 'busy' | 'denied' | 'hang' | 'ok'; window.__asked counts the asks.
const fakeMic = () => {
  window.__mic = 'busy'; window.__asked = 0;
  const md = navigator.mediaDevices;
  if (!md) return;
  md.getUserMedia = () => { window.__asked++; const m = window.__mic;
    if (m === 'hang') return new Promise(() => {});
    if (m === 'busy') return Promise.reject(new DOMException('Could not start audio source', 'NotReadableError'));
    if (m === 'denied') return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    return Promise.resolve(new MediaStream()); };
};
async function context(role, width = 1440) {
  const phone = width < 600;
  const c = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
  await c.addInitScript(fakeMic);
  return c;
}
async function open(c, path, name) {
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
  return page;
}
const shot = async (page, name, full = false) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: full }); };
const ring = (page) => page.evaluate(() => window.dispatchEvent(new CustomEvent('pulse:call', { detail: { channelId: '0e1d2c3b-4a59-4687-9786-a5b4c3d2e1f0', video: false } })));
/** Start a call until the call host (mounted in the shell, hydrated after the page) answers with a message. */
async function ringUntil(page, locator, wait = 3000) {
  for (let i = 0; i < 60; i++) { await ring(page); try { await expect(locator.first()).toBeVisible({ timeout: wait }); return; } catch { /* not hydrated yet */ } }
  throw Error('the call host never answered');
}
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  // 1. A call with a busy microphone, then a refused one: plain words and Try again, at both sizes.
  step(1);
  for (const width of [1440, 390]) {
    const c = await context('founder', width), page = await open(c, '/dashboard', `mic ${width}`);
    await seen(page.getByRole('heading').first());
    await page.waitForFunction(() => document.readyState === 'complete');
    await delay(1500);
    const card = page.locator('[data-call-problem="media-busy"]');
    await ringUntil(page, card); checks++;
    await seen(card.getByText('Your microphone is in use'));
    await seen(card.getByText(/Another app is using it/));
    await fits(page, `busy microphone ${width}`); await shot(page, `mic-busy-${width}`);
    const before = await page.evaluate(() => window.__asked);
    await page.evaluate(() => { window.__mic = 'denied'; });
    await card.getByRole('button', { name: 'Try again' }).click();
    const denied = page.locator('[data-call-problem="media-denied"]');
    await seen(denied.getByText('Pulse may not use your microphone'));
    assert.equal(await page.evaluate(() => window.__asked), before + 1, 'Try again asks for the microphone again'); checks++;
    await shot(page, `mic-denied-${width}`);
    await denied.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('[data-call-problem]')).toHaveCount(0); checks++;
    await c.close();
  }
  // 2. A microphone that never answers gives up after 15 seconds instead of hanging on "Connecting…".
  step(2);
  {
    const c = await context('founder', 1440), page = await open(c, '/dashboard', 'mic hang');
    await seen(page.getByRole('heading').first()); await delay(1500);
    await page.evaluate(() => { window.__mic = 'hang'; });
    await ringUntil(page, page.locator('[data-call-problem="media-timeout"]').getByText('Your microphone did not answer'), 20000); checks++;
    await shot(page, 'mic-timeout-1440');
    await c.close();
  }
  // 3. The phone's + opens the Create dialog; not on a computer. SHELL-FLOAT (16 Nov 2026): on Work too it is the bar's
  // New tab (Work's own floating + New sat over the page's rows), so Work has exactly one + New, in the bar.
  step(3);
  {
    const c = await context('founder', 390), page = await open(c, '/dashboard', 'fab 390');
    const fab = page.getByRole('button', { name: 'New task' });
    await seen(fab);
    await fits(page, 'Home with the phone +'); await shot(page, 'phone-plus-390', true);
    await fab.click();
    await seen(page.getByRole('dialog', { name: 'New task' }));
    await seen(page.getByRole('dialog', { name: 'New task' }).getByLabel('What needs doing'));
    await shot(page, 'phone-plus-dialog-390');
    const work = await open(c, '/tasks', 'work 390');
    await seen(work.locator('[data-phone-new]'));
    await expect(work.locator('[data-phone-new][data-phone-quick-create]')).toHaveCount(1); checks++;
    await c.close();
  }
  {
    const c = await context('founder', 1440), page = await open(c, '/dashboard', 'fab 1440');
    await seen(page.getByRole('heading').first());
    await expect(page.locator('[data-phone-quick-create]')).toBeHidden(); checks++;
    await fits(page, 'Home at 1440'); await shot(page, 'home-1440');
    await c.close();
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log(`kazuk-rest-phones-browser-runner: ${checks} checks passed`);
} catch (e) {
  if (shots && last) await last.screenshot({ path: `${shots}/failure.png`, fullPage: true }).catch(() => undefined);
  console.error(e instanceof Error ? e.stack : e); process.exitCode = 1;
} finally {
  clearTimeout(deadline); await browser?.close().catch(() => undefined); await stopServer(); await app.close().catch(() => undefined); await pool.end().catch(() => undefined);
}
