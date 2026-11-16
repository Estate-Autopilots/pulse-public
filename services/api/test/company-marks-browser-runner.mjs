// COMPANY-MARKS in the browser (tests/core/test_my_day.py): one Pulse account in three synthetic companies opens My
// day. Each company is marked by its own square logo (alt text: its name), or, with none, by a solid tile with its
// initials in its brand colour, or one neutral colour when it has no brand colour either: never a hue made up from its
// name. The left stripes carry the brand colour (neutral without one). Logos keep their shape (object-fit: contain, a
// 1px border, a whole-pixel size). Phone (390) and desktop (1440), light and dark, no sideways scroll, no page errors.
// Screenshots with PULSE_CM_SCREENSHOTS=<dir>; PULSE_CM_BEFORE=1 only takes them (the page before the change).
// Everything is invented; nothing is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), shots = process.env.PULSE_CM_SCREENSHOTS, before = process.env.PULSE_CM_BEFORE === '1';
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-cm', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
let browser, checks = 0, current = 'start', last;
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`company-marks-browser-runner: no result after 20 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 20 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
const rgb = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  // The logo comes through the web app's API proxy as an image, for the signed-in account only.
  if (!before) {
    const viaApi = await fetch(`${origin}/api/v0/tasks/my-day`, { headers: { 'x-pulse-session': E.token } });
    const day = await viaApi.json();
    assert.ok(Array.isArray(day.seats), `my day: ${viaApi.status} ${JSON.stringify(day).slice(0, 300)}`);
    const markUrl = day.seats.find((s) => s.org === E.orgA)?.mark;
    assert.match(String(markUrl), /^\/api\/v0\/tasks\/my-day\/mark\/[0-9a-f-]+\?v=3$/, 'the logo address');
    assert.ok(day.seats.filter((s) => s.org !== E.orgA).every((s) => s.mark === null), 'no logo for the others');
    const r = await fetch(origin + markUrl, { headers: { 'x-pulse-session': E.token } });
    const text = await r.text();
    assert.ok(r.status === 200 && /^image\/svg\+xml/.test(r.headers.get('content-type') ?? '') && text.startsWith('<svg'), `logo served: ${r.status} ${r.headers.get('content-type')} ${text.slice(0, 80)}`);
    checks += 3;
  }
  browser = await chromium.launch();
  for (const [width, theme] of [[1440, 'light'], [390, 'light'], [1440, 'dark'], [390, 'dark']]) {
    step(`${width} ${theme}`);
    const phone = width < 600;
    const c = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: 2, hasTouch: phone, isMobile: phone, colorScheme: theme, extraHTTPHeaders: { 'cf-access-authenticated-user-email': E.email } });
    await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.removeItem('pulse.myday.only'); } catch { /* private */ } }, theme);
    const page = await c.newPage(); last = page;
    page.on('pageerror', (e) => errors.push(`${width} ${theme}: ${e.message}`));
    page.on('response', (r) => { if (/\/api\/v0\/(tasks\/my-day\/mark|brand\/mark)/.test(r.url())) console.log(`image ${r.status()} ${r.headers()['content-type']} ${r.url().replace(base, '')}`); });
    await page.goto(base + '/my-day', { waitUntil: 'load', timeout: 300000 });
    const chips = page.getByRole('navigation', { name: 'Show companies' });
    await seen(chips.getByRole('button', { name: /Synthetic Riverside Studio/ }));
    await seen(page.getByText('Synthetic edit the riverside reel'));
    // The account's one-password offer (a synthetic account has several passwords) is put off: it is not this check.
    const later = page.getByRole('button', { name: 'Later', exact: true });
    try { await later.waitFor({ state: 'visible', timeout: 8000 }); await later.click(); await later.waitFor({ state: 'hidden', timeout: 10000 }); } catch { /* not offered */ }
    if (before) { await shot(page, `my-day-${width}-${theme}`); await c.close(); continue; }
    // Wait for the logos to load (they come through the API proxy), then the shots.
    await page.waitForFunction(() => [...document.querySelectorAll('img[data-company-mark]')].length > 0 && [...document.querySelectorAll('img[data-company-mark]')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 120000 });
    await shot(page, `my-day-${width}-${theme}`);
    // The company with a logo: its logo in the chip, the rail and the line under each task, named for screen readers.
    const logo = 'img[data-company-mark][alt="Synthetic Riverside Studio"]';
    await seen(chips.locator(logo));
    const rail = page.locator('[data-area="companies"]');
    await seen(rail.locator(logo));
    const row = page.locator('li', { hasText: 'Synthetic edit the riverside reel' }).last();
    await seen(row.locator(logo));
    // Logos never stretch or blur: contain, a 1px border, a whole-pixel square.
    const looks = await page.evaluate(() => [...document.querySelectorAll('img[data-company-mark]')].map((i) => {
      const s = getComputedStyle(i), r = i.getBoundingClientRect();
      return { fit: s.objectFit, w: r.width, h: r.height, border: s.borderTopWidth, natural: i.naturalWidth };
    }));
    assert.ok(looks.length >= 3, `logos shown: ${JSON.stringify(looks)}`);
    for (const l of looks) {
      assert.equal(l.fit, 'contain', 'object-fit contain');
      assert.ok(l.w === l.h && Number.isInteger(l.w) && l.w >= 12 && l.w <= 20, `a crisp square: ${JSON.stringify(l)}`);
      assert.equal(l.border, '1px', 'a 1px border');
      assert.ok(l.natural > 0, 'loaded');
    }
    checks++;
    // A company with a brand colour and no logo: its initials on its colour; its stripe in its colour.
    const harbour = chips.locator('[data-company-mark]', { hasText: 'SH' });
    await seen(harbour);
    assert.equal(await harbour.getAttribute('aria-label'), 'Synthetic Harbour Sales'); checks++;
    assert.equal(await harbour.evaluate((el) => getComputedStyle(el).backgroundColor), rgb(E.accent), 'the brand colour'); checks++;
    const harbourRow = page.locator('li', { hasText: 'Synthetic call the harbour leads' }).last();
    await seen(harbourRow);
    if (theme === 'light') { assert.equal(await harbourRow.evaluate((el) => getComputedStyle(el, '::before').backgroundColor), rgb(E.accent), 'the stripe is the brand colour'); checks++; }
    // A company with neither: one neutral tile and a neutral stripe, the same for every such company (no hue from its name).
    const plain = chips.locator('[data-company-mark]', { hasText: 'ST' });
    await seen(plain);
    const neutral = await plain.evaluate((el) => getComputedStyle(el).backgroundColor);
    const plainRow = page.locator('li', { hasText: 'Synthetic tidy the third ledger' }).last();
    const stripe = await plainRow.evaluate((el) => getComputedStyle(el, '::before').backgroundColor);
    assert.notEqual(stripe, rgb(E.accent)); checks++;
    const sat = (c) => { const [r, g, b] = c.match(/\d+/g).map(Number); return Math.max(r, g, b) - Math.min(r, g, b); };
    assert.ok(sat(neutral) < 24 && sat(stripe) < 24, `neutral, not a hue: ${neutral} ${stripe}`); checks++;
    // No coloured dots are left.
    assert.equal(await page.locator('[class*="my-day"][class*="dot"]').count(), 0, 'no company dots'); checks++;
    await fits(page, `My day ${width} ${theme}`);
    // A logo that fails to load falls back to the initials tile, never a broken picture.
    if (width === 1440 && theme === 'light') {
      await page.route('**/api/v0/tasks/my-day/mark/**', (route) => route.fulfill({ status: 404, body: '' }));
      await page.reload({ waitUntil: 'load' });
      await seen(chips.locator('[data-company-mark]', { hasText: 'SR' }), 60000);
      await page.unroute('**/api/v0/tasks/my-day/mark/**');
    }
    await c.close();
  }
  // The logo is only for the account's own seats.
  {
    const r = await fetch(`${base}/api/v0/tasks/my-day/mark/${E.orgOther}`, { headers: { 'cf-access-authenticated-user-email': E.email } });
    if (!before) { assert.equal(r.status, 404, 'not a seat: no logo'); checks++; }
    const anon = await fetch(`${base}/api/v0/tasks/my-day/mark/${E.orgA}`);
    if (!before) { assert.ok([401, 403].includes(anon.status), `signed out: refused (${anon.status})`); checks++; }
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`company-marks-browser-runner: ${checks} checks passed`);
} catch (e) {
  if (last && shots) { try { await last.screenshot({ path: `${shots}/failure.png`, fullPage: true }); } catch { /* closed */ } }
  console.error(`step ${current}: ${e?.stack ?? e}`); process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch { /* closed */ }
  stopServer(); await app.close(); await pool.end();
}
process.exit(process.exitCode ?? 0);
