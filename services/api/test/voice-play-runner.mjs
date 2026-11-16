// CHAT-VOICE-FIX in the browser (owner, 14 Nov 2026: Kazuk's voice note "does not play, I'm on full speaker,
// nothing"): the real API (in this process) and the web app on tests/core/test_chat_voice_play_browser.py's synthetic
// team. Chromium runs with the autoplay policy real browsers apply to a page (sound only from a tap) and every voice
// file answers 5 s late, as a loaded server does: the old player fetched the whole note first and its play() came
// after the tap's permission had run out. Checks:
//   1. a tap plays the note although the file answers 5 s later: it streams (range requests) from /play;
//   2. a browser that cannot play WebM/Opus (Safari, iPhone) asks for the AAC copy;
//   3. a note that cannot play says so, with Try again and Download, and is never silent.
// Screenshots with PULSE_VOICE_SHOTS=<dir>. VOICE_NEXT_DEV=1 runs a private `next dev`.
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
const T = dev ? 180000 : 45000, SLOW = 5000;
let checks = 0; const errors = []; const steps = [];
const ok = (c, m) => { checks++; assert.ok(c, m); };
const seen = async (locator, timeout = T) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
let up = false;
for (let i = 0; i < 600 && exited === null; i++) { try { if ((await fetch(base + '/login')).status < 500) { up = true; break; } } catch { /* starting */ } await delay(1000); }
assert.ok(up, `the web server did not start (exit ${exited})`);
// The policy real browsers apply: sound starts only from a tap (Playwright's default lets any page play).
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=user-gesture-required'] });
async function person({ phone = false, safari = false } = {}) {
  const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: phone, hasTouch: phone,
    extraHTTPHeaders: { 'cf-access-authenticated-user-email': process.env.TEST_LISTENER } });
  // Safari and iPhones: no WebM/Opus.
  if (safari) await ctx.addInitScript(() => { const can = HTMLMediaElement.prototype.canPlayType; HTMLMediaElement.prototype.canPlayType = function (t) { return /webm|ogg/i.test(t) ? '' : can.call(this, t); }; });
  const asked = [];
  // A loaded server: every voice file answers 5 s late.
  await ctx.route(/\/api\/v0\/chats\/files\//, async (route) => { asked.push({ url: route.request().url(), range: route.request().headers().range ?? null }); await delay(SLOW); await route.continue(); });
  const page = await ctx.newPage(); page.setDefaultTimeout(T);
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  return { ctx, page, asked };
}
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load', timeout: T }); await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: T }); await page.waitForTimeout(500); };
const step = async (name, run) => { const at = Date.now(); try { await run(); } catch (e) { console.error(`STEP FAILED: ${name}\n${e?.stack ?? e}\npage errors: ${errors.join(' | ') || 'none'}`); throw e; } steps.push({ name, seconds: Math.round((Date.now() - at) / 100) / 10 }); };
const note = (page, mid) => page.locator(`[data-voice-note="${mid}"]`);
try {
  await step('a tap plays the note although the file answers 5 s late', async () => {
    const { page, asked, ctx } = await person();
    await go(page, `/chats?channel=${E.group}`);
    const n = note(page, E.good); await seen(n);
    const tapped = Date.now();
    await n.locator('[data-voice-play]').click();
    await seen(n.getByRole('button', { name: 'Pause the voice message' }), SLOW + 25000);
    const started = Date.now() - tapped;
    ok(started >= SLOW - 500, `it waited for the slow file (${started} ms)`);
    // It goes on playing: the clock moves past 0:01 and no "Couldn't play" shows.
    await expect(n.locator('time')).toHaveText(/0:0[1-3]/, { timeout: 8000 }); checks++;
    await expect(n.getByText('Couldn’t play')).toHaveCount(0); checks++;
    ok(asked.some((a) => a.url.includes(`/api/v0/chats/files/${E.goodFile}/play`) && !a.url.includes('as=aac')), `it streamed the WebM copy: ${JSON.stringify(asked)}`);
    ok(!asked.some((a) => new URL(a.url).pathname === `/api/v0/chats/files/${E.goodFile}`), 'it never downloaded the whole file first');
    // Through the web app's proxy, as Safari needs it: a range answered 206 as audio (not a generic download).
    const got = await page.evaluate(async (u) => { const r = await fetch(u, { headers: { range: 'bytes=0-15' } }); return { status: r.status, type: r.headers.get('content-type'), range: r.headers.get('content-range'), size: (await r.arrayBuffer()).byteLength }; }, `/api/v0/chats/files/${E.goodFile}/play`);
    ok(got.status === 206 && got.type === 'audio/webm' && /^bytes 0-15\//.test(got.range ?? '') && got.size === 16, `the note streams with ranges as audio: ${JSON.stringify(got)}`);
    await shot(page, 'voice-01-playing-after-slow-file');
    // Played state reaches the server.
    await expect(n).not.toHaveAttribute('data-unplayed', '', { timeout: T }); checks++;
    await ctx.close();
  });
  await step('Safari and iPhones get the AAC copy', async () => {
    const { page, asked, ctx } = await person({ phone: true, safari: true });
    await go(page, `/chats?channel=${E.group}`);
    const n = note(page, E.good); await seen(n);
    await n.locator('[data-voice-play]').click();
    await expect.poll(() => asked.some((a) => a.url.includes(`/files/${E.goodFile}/play?as=aac`)), { timeout: SLOW + 5000 }).toBe(true); checks++;
    // Chromium plays the AAC copy where its build has the codec; either way it is never silent.
    await expect(n.getByRole('button', { name: 'Pause the voice message' }).or(n.getByText('Couldn’t play'))).toBeVisible({ timeout: SLOW + 20000 }); checks++;
    await shot(page, 'voice-02-phone-aac');
    await ctx.close();
  });
  await step('a note that cannot play says so, with Try again and Download', async () => {
    const { page, ctx } = await person({ phone: true });
    await go(page, `/chats?channel=${E.group}`);
    const n = note(page, E.broken); await seen(n);
    await n.locator('[data-voice-play]').click();
    await seen(n.getByText('Couldn’t play'), SLOW * 2 + 25000);
    await expect(n.getByRole('button', { name: 'Try again' })).toHaveCount(2); checks++;  // the play button and the words beside the message
    const dl = n.getByRole('link', { name: 'Download' }); await seen(dl);
    ok((await dl.getAttribute('href')) === `/api/v0/chats/files/${E.brokenFile}`, 'Download is the file itself');
    await shot(page, 'voice-03-could-not-play');
    // Try again is a fresh tap: it tries once more and says so again (the file is still broken).
    await n.getByRole('button', { name: 'Try again' }).last().click();
    await seen(n.getByText('Couldn’t play'), SLOW * 2 + 25000);
    await ctx.close();
  });
  // The UI gate's screenshots (363 and 1440, light and dark): a playing note and one that could not play.
  if (shots) await step('screenshots for the design judge', async () => {
    for (const [w, h] of [[363, 780], [1440, 900]]) for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, isMobile: w < 500, hasTouch: w < 500, extraHTTPHeaders: { 'cf-access-authenticated-user-email': process.env.TEST_LISTENER } });
      const page = await ctx.newPage(); page.setDefaultTimeout(T);
      await go(page, `/chats?channel=${E.group}`);
      // A note playing, then the broken one tapped: the first stops where it was, the second says it could not play.
      await note(page, E.good).locator('[data-voice-play]').click();
      await seen(note(page, E.good).getByRole('button', { name: 'Pause the voice message' }), 20000);
      await page.waitForTimeout(1500);
      await note(page, E.broken).locator('[data-voice-play]').click();
      await seen(note(page, E.broken).getByText('Couldn’t play'), 30000);
      await page.waitForTimeout(600);  // the line has risen in
      // The failure line and its Try again stay inside the bubble.
      const inside = await note(page, E.broken).evaluate((el) => { const r = el.getBoundingClientRect(); return [...el.querySelectorAll('[role="alert"], [data-voice-failed]')].every((x) => x.getBoundingClientRect().right <= r.right + 0.5); });
      ok(inside, `the failure line fits its bubble at ${w}px`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(overflow <= 0, `no sideways scroll at ${w}px (${overflow}px)`);
      await page.screenshot({ path: `${shots}/voice-gate-${w}-${scheme}.png` });
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
