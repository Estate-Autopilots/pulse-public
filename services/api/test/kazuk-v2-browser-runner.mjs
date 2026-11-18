// KAZUK-V2 in the browser (tests/core/test_kazuk_v2.py): Kazuk's v2 test steps (T08, T22-T29) on screen. The real API on
// a disposable synthetic company and the web app under `next dev`. Each page in TEST_PAGES
// ([{ name, path, role, see: [text…], hide: [text…], step }]) opens as its person at 1440 and 363 px, light and dark:
// every text in `see` shows, none in `hide` does, nothing scrolls sideways, no page errors. TEST_API_CHECKS
// ([{ step, role, url, method, body, status, has, headers }]) are asked of the API as that person, or (role null) as the
// Sales Agent with its co-worker key (T27: how did I do, the project, read only).
// Screenshots with PULSE_KV2_SCREENSHOTS=<dir>. Everything is invented (Test Realty Pvt Ltd, example.test).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const emails = JSON.parse(process.env.TEST_EMAILS), only = process.env.KV2_ONLY ? new RegExp(process.env.KV2_ONLY) : null, pages = JSON.parse(process.env.TEST_PAGES).filter((p) => !only || only.test(p.name)), checksApi = JSON.parse(process.env.TEST_API_CHECKS ?? '[]');
const shots = process.env.PULSE_KV2_SCREENSHOTS, sizes = JSON.parse(process.env.TEST_SIZES ?? '[[1440,"light"],[1440,"dark"],[363,"light"],[363,"dark"]]');
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-kv2', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
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
let browser, checks = 0, last;
const passed = new Set();
const deadline = setTimeout(() => { console.error('kazuk-v2-browser-runner: no result after 30 minutes'); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 30 * 60_000);
deadline.unref();
// Only what is on screen counts (a phone's hidden sidebar holds the same words).
const seen = async (locator, timeout = 180000) => { await expect(locator.filter({ visible: true }).first()).toBeVisible({ timeout }); checks++; };
// A phone's layout viewport grows to fit what sticks out, so the width is checked against the size asked for, and a
// failure names the widest elements.
const fits = async (page, what, width) => {
  const r = await page.evaluate((w) => ({ sw: document.documentElement.scrollWidth, wide: [...document.querySelectorAll('body *')].map((el) => ({ el, b: el.getBoundingClientRect() }))
    .filter(({ b }) => b.right > w + 1 && b.width > 0).sort((a, b) => b.b.width - a.b.width).slice(0, 8)
    .map(({ el, b }) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} right=${Math.round(b.right)} w=${Math.round(b.width)}`) }), width);
  assert.ok(r.sw <= width + 1, `${what} has no sideways scroll (page ${r.sw} px wide): ${r.wide.join(' | ')}`); checks++;
};
const errors = [];
async function context(role, width = 1440, theme = 'light') {
  const phone = width < 600;
  const c = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
  await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); } catch { /* private */ } }, theme);
  return c;
}
try {
  for (const k of checksApi) {
    const r = await fetch(`${origin}/api/v0/${k.url}`, { method: k.method ?? (k.body === undefined ? 'GET' : 'POST'),
      // An AI co-worker's call (role null) sends its key alone, never a person's sign-in.
      headers: { ...(k.role ? { 'cf-access-authenticated-user-email': emails[k.role] } : {}), 'content-type': 'application/json', ...(k.headers ?? {}) }, ...(k.body === undefined ? {} : { body: JSON.stringify(k.body) }) });
    const text = await r.text();
    assert.equal(r.status, k.status, `${k.step} ${k.role} ${k.url}: ${r.status} ${text.slice(0, 300)}`); checks++;
    for (const h of k.has ?? []) { assert.ok(text.includes(h), `${k.step} ${k.url}: "${h}" not in ${text.slice(0, 600)}`); checks++; }
    passed.add(k.step); console.log(`${k.step} API ${k.role ?? 'agent'} ${k.url} -> ${r.status}`);
  }
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  for (const [width, theme] of sizes) {
    for (const p of pages) {
      const c = await context(p.role, width, theme);
      const page = await c.newPage(); last = page;
      page.on('pageerror', (e) => errors.push(`${p.name} ${width} ${theme}: ${e.message}`));
      await page.goto(base + p.path, { waitUntil: 'load', timeout: 300000 });
      for (const text of p.see) await seen(page.getByText(text));
      if (p.hide?.length) {
        const body = await page.locator('#main-content').first().innerText();
        for (const text of p.hide) { assert.ok(!body.includes(text), `${p.name} ${width} ${theme}: "${text}" is on the page`); checks++; }
      }
      await fits(page, `${p.name} ${width} ${theme}`, width);
      if (shots) {
        await delay(3000);  // tiles count up and rings fill: wait until they settle, so a shot never shows a number mid-count
        // A phone's full-page shot draws the fixed bottom menu and chat button over the middle of the page, so on a
        // phone each screenful is its own shot, as a person scrolling sees it.
        if (width < 600) {
          for (let k = 1; k <= 8; k++) {
            await page.screenshot({ path: `${shots}/${p.name}-${width}-${theme}${k === 1 ? '' : `-p${k}`}.png` });
            const more = await page.evaluate(() => { const y = window.scrollY; window.scrollBy(0, Math.round(innerHeight * 0.8)); return window.scrollY > y; });
            if (!more) break;
            await delay(600);
          }
        } else await page.screenshot({ path: `${shots}/${p.name}-${width}-${theme}.png`, fullPage: true });
        // On a computer the page scrolls inside the app's main box, not the document: a shot per screenful below.
        if (width >= 600) for (let k = 1; k <= 4; k++) {
          const moved = await page.evaluate((y) => { const box = [...document.querySelectorAll('main, [id="main-content"], *')].find((el) => el.scrollHeight > el.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(el).overflowY));
            if (!box) return false; const before = box.scrollTop; box.scrollTop = y; return box.scrollTop > before; }, k * 820);
          if (!moved) break;
          await delay(700); await page.screenshot({ path: `${shots}/${p.name}-${width}-${theme}-${k + 1}.png` });
        }
      }
      if (p.step) passed.add(p.step);
      await page.close(); await c.close();
    }
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  for (const s of [...passed].sort()) console.log(`${s} PASS`);
  console.log(`kazuk-v2-browser-runner: ${checks} checks passed`);
} catch (e) {
  if (shots && last) await last.screenshot({ path: `${shots}/failure.png`, fullPage: true }).catch(() => undefined);
  console.error(e instanceof Error ? e.stack : e); process.exitCode = 1;
} finally {
  clearTimeout(deadline); await browser?.close().catch(() => undefined); await stopServer(); await app.close().catch(() => undefined); await pool.end().catch(() => undefined);
}
