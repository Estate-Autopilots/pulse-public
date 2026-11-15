// CHAT-VOICE-FIX part 3 in the browser (tests/core/test_chat_import_media_browser.py, synthetic world): an admin opens a
// group's menu → Import WhatsApp chat, lands on the import with that group chosen, picks a WhatsApp export made "with
// media" (.zip: the chat text, a photo, a voice note), decides the senders, imports, and the photo and voice note arrive
// beside their messages; importing the same .zip again adds nothing; the group's imported history shows the photo and
// streams the voice note. Real imports are switched on for this run only (PULSE_CHAT_IMPORT=1). Nothing leaves the
// machine. Screenshots (363 and 1440, light and dark) with PULSE_VOICE_SHOTS=<dir>. VOICE_NEXT_DEV=1 runs `next dev`.
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
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, isMobile: w < 500, hasTouch: w < 500, extraHTTPHeaders: { 'cf-access-authenticated-user-email': process.env.TEST_ADMIN } });
  const page = await ctx.newPage(); page.setDefaultTimeout(T);
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  page.on('response', (res) => { if (res.url().includes('/api/v0/') && res.status() >= 500) apiErrors.push(`${res.status()} ${new URL(res.url()).pathname}`); });
  return { ctx, page };
}
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load', timeout: T }); await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: T }); await page.waitForTimeout(500); };
const step = async (name, run) => { const at = Date.now(); try { await run(); } catch (e) { console.error(`STEP FAILED: ${name}\n${e?.stack ?? e}\npage errors: ${errors.join(' | ') || 'none'}\nAPI 5xx: ${[...new Set(apiErrors)].join(' | ') || 'none'}`); throw e; } steps.push({ name, seconds: Math.round((Date.now() - at) / 100) / 10 }); };
/** Choose the export, decide every sender, approve and import. */
async function importZip(page) {
  await page.locator('[data-import-file]').setInputFiles(process.env.TEST_ZIP);
  await seen(page.getByText('2 files found in the .zip'));
  // Opened from the group's menu, the group is already the conversation it goes into.
  await expect(page.getByLabel('Conversation')).toHaveValue(E.group, { timeout: T }); checks++;
  for (const [display, choice] of Object.entries(E.senders)) await page.getByLabel(`Who is ${display}`).selectOption(choice);
  await page.getByLabel('Where the owner’s approval is recorded').fill('Synthetic approval for the browser check');
  await page.getByLabel(/Retention proposal/).fill('Keep while the group exists');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /^Import \d+ messages?$/ }).click();
}
const historyButton = (page) => page.locator('button').filter({ hasText: /imported from WhatsApp/ }).first();
try {
  await step('the group menu opens the import with the group chosen', async () => {
    const { page, ctx } = await person();
    await go(page, `/chats?channel=${E.group}`);
    await page.getByRole('button', { name: 'Conversation options' }).click();
    await page.locator('[data-import-whatsapp]').click();
    await page.waitForURL(new RegExp(`/chats/import\\?channel=${E.group}`), { timeout: T }); checks++;
    await seen(page.getByRole('heading', { name: 'Import WhatsApp history' }));
    await ctx.close();
  });
  await step('a .zip export brings its photo and voice note; the same .zip again adds nothing', async () => {
    const { page, ctx } = await person();
    await go(page, `/chats/import?channel=${E.group}`);
    await importZip(page);
    await expect(page.locator('[data-import-done]')).toContainText('with 2 photos, voice notes and files', { timeout: T }); checks++;
    await go(page, `/chats/import?channel=${E.group}`);
    await importZip(page);
    await seen(page.getByRole('alert').filter({ hasText: 'already imported' }));
    await ctx.close();
  });
  await step('the imported history shows the photo and streams the voice note', async () => {
    const { page, ctx } = await person();
    await go(page, `/chats?channel=${E.group}`);
    await historyButton(page).click();
    const panel = page.getByRole('dialog', { name: 'Imported WhatsApp history' }); await seen(panel);
    const img = panel.locator('[data-imported-file="photo"] img'); await seen(img);
    await img.scrollIntoViewIfNeeded();
    const src = await img.getAttribute('src');
    const got = await page.evaluate(async (u) => { const r = await fetch(u); const b = new Uint8Array(await r.arrayBuffer()); return { status: r.status, type: r.headers.get('content-type'), size: b.length, head: [...b.slice(0, 3)] }; }, src);
    ok(got.status === 200 && got.type === 'image/jpeg' && got.head[0] === 0xff && got.head[1] === 0xd8, `the photo is served as a JPEG: ${JSON.stringify(got)}`);
    await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth > 0), { timeout: 30000 }).toBe(true); checks++;
    const audio = panel.locator('[data-imported-file="audio"] audio'); await expect(audio).toHaveCount(1); checks++;
    const status = await page.evaluate(async (src) => (await fetch(src, { headers: { range: 'bytes=0-3' } })).status, await audio.getAttribute('src'));
    ok(status === 206, `the voice note streams with ranges (${status})`);
    await seen(panel.getByText('Site photo'));
    await ctx.close();
  });
  if (shots) await step('screenshots for the design judge', async () => {
    for (const [w, h] of [[363, 780], [1440, 900]]) for (const scheme of ['light', 'dark']) {
      const { page, ctx } = await person({ w, h, scheme });
      await go(page, `/chats/import?channel=${E.group}`);
      await page.locator('[data-import-file]').setInputFiles(process.env.TEST_ZIP);
      await seen(page.getByText('2 files found in the .zip'));
      let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(overflow <= 0, `no sideways scroll on the import at ${w}px (${overflow}px)`);
      await page.screenshot({ path: `${shots}/import-gate-${w}-${scheme}.png` });
      await go(page, `/chats?channel=${E.group}`);
      await historyButton(page).click();
      const panel = page.getByRole('dialog', { name: 'Imported WhatsApp history' });
      await seen(panel.locator('[data-imported-file="photo"] img'));
      await page.waitForTimeout(600);
      overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(overflow <= 0, `no sideways scroll on the history at ${w}px (${overflow}px)`);
      await page.screenshot({ path: `${shots}/history-gate-${w}-${scheme}.png` });
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
