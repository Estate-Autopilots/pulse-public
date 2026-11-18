// CHAT-VOICE-FIX parts 2-3 in the browser (tests/core/test_chat_voice_heard_browser.py's synthetic team): the real API
// (in this process) and the web app. Checks:
//   1. a voice note the server is sure of shows its words; one it is not sure of says "Not clear — listen"
//      with its English gist, and offers no Transcript button;
//   2. find in this chat finds a voice note by what it says (the list shows the heard words);
//   3. find in this chat filters by type (voice notes) and person without any words, and clears.
// Screenshots (363 and 1440, light and dark) with PULSE_VOICE_SHOTS=<dir>. VOICE_NEXT_DEV=1 runs a private `next dev`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool); const E = JSON.parse(process.env.TEST_IDS);
const shots = process.env.PULSE_VOICE_SHOTS; if (shots) await mkdir(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`; const dev = process.env.VOICE_NEXT_DEV === '1';
const { openSync } = await import('node:fs'); const out = shots ? openSync(`${shots}/next.log`, 'w') : 'ignore';
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', dev ? 'dev' : 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: dev ? 'development' : 'production', PULSE_PUBLIC_LOGIN_ENABLED: '0', NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? (dev ? '.next-voice' : '.next') }, stdio: ['ignore', out, out] });
let exited = null; server.on('exit', (code) => { exited = code; });
process.on('exit', () => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } });
const T = dev ? 180000 : 45000;
let checks = 0; const errors = []; const steps = []; const apiErrors = [];
const ok = (c, m) => { checks++; assert.ok(c, m); };
const seen = async (locator, timeout = T) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
let up = false;
for (let i = 0; i < 600 && exited === null; i++) { try { if ((await fetch(base + '/login')).status < 500) { up = true; break; } } catch { /* starting */ } await delay(1000); }
assert.ok(up, `the web server did not start (exit ${exited})`);
const browser = await chromium.launch({ headless: true });
async function person({ w = 1440, h = 900, scheme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, locale: 'en-IN', timezoneId: 'Asia/Kolkata', isMobile: w < 500, hasTouch: w < 500, extraHTTPHeaders: { 'cf-access-authenticated-user-email': process.env.TEST_LISTENER } });
  const page = await ctx.newPage(); page.setDefaultTimeout(T);
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  page.on('response', (res) => { if (res.url().includes('/api/v0/') && res.status() >= 500) apiErrors.push(`${res.status()} ${new URL(res.url()).pathname}`); });
  return { ctx, page };
}
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load', timeout: T }); await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: T }); await page.waitForTimeout(500); };
const step = async (name, run) => { const at = Date.now(); try { await run(); } catch (e) { console.error(`STEP FAILED: ${name}\n${e?.stack ?? e}\npage errors: ${errors.join(' | ') || 'none'}\nAPI 5xx: ${[...new Set(apiErrors)].join(' | ') || 'none'}`); throw e; } steps.push({ name, seconds: Math.round((Date.now() - at) / 100) / 10 }); };
const note = (page, mid) => page.locator(`[data-voice-note="${mid}"]`);
const openFind = async (page) => { await page.keyboard.press('Control+Shift+F'); const box = page.getByRole('searchbox', { name: 'Search this chat' }).or(page.locator('[data-find-bar] input')); await seen(box); return box.first(); };
try {
  await step('clear words show; an unclear note says so with its gist', async () => {
    const { page, ctx } = await person();
    await go(page, `/chats?channel=${E.group}`);
    await seen(note(page, E.clear).getByText(E.clearWords));
    const u = note(page, E.unclear);
    await seen(u.getByText('Not clear — listen'));
    await seen(u.getByText(E.gist));
    await expect(u.getByText(E.hiddenWords)).toHaveCount(0); checks++;
    await expect(u.getByRole('button', { name: /Transcript/ })).toHaveCount(0); checks++;
    await ctx.close();
  });
  await step('find in this chat finds a voice note by what it says', async () => {
    const { page, ctx } = await person();
    await go(page, `/chats?channel=${E.group}`);
    const box = await openFind(page);
    await box.fill(E.searchWord);
    const count = page.locator('[data-find-count]'); await expect(count).toHaveText(/^1 of 1/, { timeout: 20000 }); checks++;
    await count.click();
    await seen(page.getByRole('option').filter({ hasText: E.searchWord }));
    await ctx.close();
  });
  await step('find in this chat by type and person, without words', async () => {
    const { page, ctx } = await person();
    await go(page, `/chats?channel=${E.group}`);
    await openFind(page);
    await page.locator('[data-find-filters]').click();
    const panel = page.locator('[data-find-filter-panel]'); await seen(panel);
    await panel.locator('[data-find-type]').selectOption('voice');
    await expect(page.locator('[data-find-count]')).toHaveText(/of 2$/, { timeout: 20000 }); checks++;
    await panel.locator('[data-find-from]').selectOption(E.author);
    await expect(page.locator('[data-find-count]')).toHaveText(/of 2$/, { timeout: 20000 }); checks++;
    await panel.locator('[data-find-type]').selectOption('image');
    await expect(page.locator('[data-find-count]')).toHaveText('0', { timeout: 20000 }); checks++;
    await panel.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.locator('[data-find-filters]')).not.toHaveAttribute('data-on', '', { timeout: 10000 }); checks++;
    await ctx.close();
  });
  if (shots) await step('screenshots for the design judge', async () => {
    for (const [w, h] of [[363, 780], [1440, 900]]) for (const scheme of ['light', 'dark']) {
      const { page, ctx } = await person({ w, h, scheme });
      await go(page, `/chats?channel=${E.group}`);
      await seen(note(page, E.unclear).getByText('Not clear — listen'));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(overflow <= 0, `no sideways scroll at ${w}px (${overflow}px)`);
      await page.screenshot({ path: `${shots}/heard-gate-${w}-${scheme}.png` });
      await openFind(page);
      await page.locator('[data-find-filters]').click();
      await seen(page.locator('[data-find-filter-panel]'));
      await page.locator('[data-find-filter-panel] [data-find-type]').selectOption('voice');
      await expect(page.locator('[data-find-count]')).toHaveText(/of 2$/, { timeout: 20000 });
      const fits = await page.locator('[data-find-filter-panel]').evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 0.5; });
      ok(fits, `the filter panel fits the screen at ${w}px`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${shots}/find-gate-${w}-${scheme}.png` });
      await ctx.close();
    }
  });
  ok(errors.length === 0, `no page errors: ${errors.join(' | ')}`);
  if (process.env.PULSE_VOICE_REPORT) await writeFile(process.env.PULSE_VOICE_REPORT, JSON.stringify({ checks, steps }, null, 1));
  console.log(JSON.stringify({ checks, steps }));
} finally {
  await browser.close().catch(() => {}); await app.close().catch(() => {}); await pool.end().catch(() => {});
  try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
}
process.exit(0);
