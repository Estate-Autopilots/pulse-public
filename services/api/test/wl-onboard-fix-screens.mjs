// WL-ONBOARD-FIX (17 Nov 2026) in the browser (tests/core/test_wl_onboard_fix_screens.py): the screens the lane changed,
// through the real API and the web app on a disposable synthetic company, at 363 and 1440 px, light and dark:
//   chats    Chats with "AI helpers you can ask" (an invented AI employee nobody has chatted with yet)
//   cashbook Finance's empty cash book: the first-run card, not four ₹0 tiles
//   getapp   Get the app: the "Install from Chrome" card first
//   import   the price list import with a Stock column: the column matched, then imported (stock 4 → 12), then undone
// Each screen: no page errors, no sideways scroll, nothing past the right edge. Screenshots with PULSE_WLOF_SHOTS=<dir>
// (<screen>-<width>-<scheme>.png). NEXT_MODE=dev runs `next dev`. Everything is invented; nothing is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const emails = JSON.parse(process.env.TEST_EMAILS), shots = process.env.PULSE_WLOF_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
let checks = 0;
const ok = (v, m) => { assert.ok(v, m); checks++; };
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`, dev = process.env.NEXT_MODE === 'dev';
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', dev ? 'dev' : 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, PULSE_PUBLIC_URL: base, NODE_ENV: dev ? 'development' : 'production', NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? '.next', NEXT_TELEMETRY_DISABLED: '1' }, stdio: 'ignore' });
process.on('exit', () => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } });
const T = dev ? 240000 : 60000;
let up = false;
for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login')).status < 500) { up = true; break; } } catch { /* starting */ } await delay(1000); }
assert.ok(up, 'the web server started');

const CSV = 'Item,Rate,GST,In stock\nTEST battery 12,361903.81,5,12\nTEST panel 400 W,18500,12,30\n';
const browser = await chromium.launch({ headless: true });
const errors = [], layout = [];
const sideways = (page, scope) => page.evaluate((scope) => {
  const W = document.documentElement.clientWidth;
  const past = [...document.querySelectorAll(`${scope}, ${scope} *`)].filter((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && r.right > W + 1 && s.position !== 'fixed' && !e.closest('[class*="tableWrap"],[class*="rows"],nav,[role="tablist"]'); }).slice(0, 3).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 40)}`);
  return { scroll: document.documentElement.scrollWidth > W + 1, past };
}, scope);
try {
  for (const scheme of ['light', 'dark']) for (const width of [363, 1440]) {
    const phone = width < 600;
    const ctx = async (who) => { const c = await browser.newContext({ viewport: { width, height: phone ? 800 : 900 }, colorScheme: scheme, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone,
      extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[who] } }); const p = await c.newPage(); p.setDefaultTimeout(T); p.on('pageerror', (e) => errors.push(`${who} ${width} ${scheme}: ${e.message.slice(0, 200)}`)); return { c, p }; };
    // Each screen is shot first, then its layout is checked; layout problems are all listed at the end.
    const shot = async (p, name, scope) => { if (shots) await p.screenshot({ path: `${shots}/${name}-${width}-${scheme}.png` });
      const s = await sideways(p, scope); if (s.scroll || s.past.length) layout.push(`${name} at ${width} ${scheme}: ${s.scroll ? 'sideways scroll; ' : ''}past the right edge: ${s.past.join(', ')}`); else checks++; };

    const founder = await ctx('founder'), F = founder.p;
    await F.goto(base + '/chats', { waitUntil: 'load', timeout: T });
    // Only the list on screen: hosted db-09 (run 44147397679) found a second, hidden copy of it (still strict if two show).
    const helpers = F.locator('[data-ai-helpers]').filter({ visible: true }); await expect(helpers).toBeVisible({ timeout: T }); checks++;
    await expect(helpers.getByText('Quotes helper')).toBeVisible(); checks++;
    await expect(helpers.getByText('Quotations, approvals and finance follow-ups')).toBeVisible(); checks++;
    ok(await helpers.getByText('Quotations, approvals and finance follow-ups').evaluate((e) => e.scrollWidth <= e.clientWidth + 1), 'the job line is not cut');
    await F.waitForTimeout(500); await shot(F, 'chats', '[data-ai-helpers]');

    await F.goto(base + '/finance?tab=book', { waitUntil: 'load', timeout: T });
    // Hosted runs find a hidden second copy of a page's section now and then (the AI helpers, then this): only the one
    // on screen counts, still strict if two show (CI-GREEN-5).
    const first = F.locator('[data-finance-first-run]').filter({ visible: true }); await expect(first).toBeVisible({ timeout: T }); checks++;
    await expect(first.getByText('Your money isn’t in Pulse yet')).toBeVisible(); checks++;
    ok(await F.locator('section[aria-label="Cash book totals"]').count() === 0, 'no ₹0 tiles before the first line');
    ok(await first.locator('[data-primary]').count() <= 1, 'one primary action');
    await F.waitForTimeout(300); await shot(F, 'cashbook', '[data-finance-first-run]');

    await F.goto(base + '/apps/get', { waitUntil: 'load', timeout: T });
    await expect(F.locator('#chrome').filter({ visible: true })).toBeVisible({ timeout: T }); checks++;
    await expect(F.getByTestId('install-chrome').filter({ visible: true })).toBeVisible(); checks++;
    await F.waitForTimeout(800); await shot(F, 'getapp', '#chrome');
    await founder.c.close();

    const fin = await ctx('finance'), P = fin.p;
    await P.goto(base + '/erp/catalog/import', { waitUntil: 'load', timeout: T });
    await expect(P.getByRole('heading', { name: 'Bring your price list' })).toBeVisible({ timeout: T }); checks++;
    // The file box of the price list on screen (a hidden second copy of the page can hold another; hosted run 44186503957).
    await P.getByRole('region', { name: 'Bring your price list' }).locator('input[type="file"]').setInputFiles({ name: 'TEST price list.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    await expect(P.getByRole('heading', { name: 'Match your columns' })).toBeVisible({ timeout: T }); checks++;
    ok(await P.locator('li').filter({ hasText: 'In stock' }).locator('select').inputValue() === 'stock', '"In stock" is matched to Stock');
    await expect(P.getByRole('status').filter({ hasText: /1 new · 1 updated/ })).toBeVisible({ timeout: T }); checks++;
    await shot(P, 'import-match', 'main');
    await P.getByRole('button', { name: /^Import 2 items$/ }).click();
    await expect(P.getByRole('heading', { name: /Imported/ })).toBeVisible({ timeout: T }); checks++;
    const row = P.locator('tr').filter({ hasText: 'TEST battery 12' });
    await expect(row.locator('[class*="stockMove"]')).toHaveText('4→12'); checks++;
    await P.waitForTimeout(700); await shot(P, 'import-done', 'main');
    await P.getByRole('button', { name: 'Undo this import' }).click();
    await expect(P.getByRole('heading', { name: 'Bring your price list' })).toBeVisible({ timeout: T }); checks++;
    await fin.c.close();
  }
  ok(!errors.length, `no page errors: ${errors.join(' | ')}`);
  ok(!layout.length, `nothing runs off the screen:\n${layout.join('\n')}`);
} finally {
  await browser.close().catch(() => {});
  await Promise.race([Promise.all([app.close(), pool.end()]).catch(() => {}), delay(8000)]);
}
if (process.env.TEST_REPORT) await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks }));
console.log(JSON.stringify({ checks }));
process.exit(0);
