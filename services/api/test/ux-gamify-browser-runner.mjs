// UX-GAMIFY (owner, 9 Nov 2026) in the browser (tests/core/test_ux_gamify.py): the real API on disposable synthetic
// companies and the web app under `next dev`. Each page in TEST_PAGES ([{ name, path, see: [text…] }]) opens as the
// admin at 1440 and 363 px, light and dark: every text in `see` shows, nothing scrolls sideways, no page errors.
// Screenshots with PULSE_UXG_SCREENSHOTS=<dir> (on a phone also what each screen shows as it scrolls). A page may name
// the person who opens it (`role`, a key of TEST_EMAILS; the admin by default).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const emails = JSON.parse(process.env.TEST_EMAILS), pages = JSON.parse(process.env.TEST_PAGES), shots = process.env.PULSE_UXG_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-uxg', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
let browser, checks = 0, last;
const deadline = setTimeout(() => { console.error('ux-gamify-browser-runner: no result after 25 minutes'); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
deadline.unref();
// Only what is on screen counts (a phone's hidden sidebar holds the same words).
const seen = async (locator, timeout = 180000) => { await expect(locator.filter({ visible: true }).first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
async function context(role, width = 1440, theme = 'light') {
  const phone = width < 600;
  const c = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
  await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); } catch { /* private */ } }, theme);
  return c;
}
const SIZES = [[1440, 'light'], [1440, 'dark'], [363, 'light'], [363, 'dark']];
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  for (const [width, theme] of SIZES) {
    for (const p of pages) {
      const c = await context(p.role ?? 'admin', width, theme);
      const page = await c.newPage(); last = page;
      page.on('pageerror', (e) => errors.push(`${p.name} ${width} ${theme}: ${e.message}`));
      await page.goto(base + p.path, { waitUntil: 'load', timeout: 300000 });
      // `click`: words to press first, in order (a section of the page that is not open by default).
      for (const text of p.click ?? []) { const el = page.getByText(text, { exact: true }).filter({ visible: true }).first(); await expect(el).toBeVisible({ timeout: 180000 }); await el.click(); await delay(800); }
      for (const text of p.see) await seen(page.getByText(text));
      await fits(page, `${p.name} ${width} ${theme}`);
      if (shots) {
        await delay(1600);  // tiles count up and rings fill for about a second
        await page.screenshot({ path: `${shots}/${p.name}-${width}-${theme}.png`, fullPage: true });
        if (width < 600) for (const [k, text] of [['a', null], ['b', p.see.at(-1)]]) {
          // 'a' is the top of the page as it opens; 'b' brings the last expected words to the middle.
          if (text) await page.getByText(text).filter({ visible: true }).first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
          else await page.evaluate(() => { window.scrollTo(0, 0); for (const el of document.querySelectorAll('*')) if (el.scrollTop > 0) el.scrollTop = 0; });
          await delay(900); await page.screenshot({ path: `${shots}/${p.name}-phone-${theme}-${k}.png` });
        }
      }
      await page.close(); await c.close();
    }
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log(`ux-gamify-browser-runner: ${checks} checks passed`);
} catch (e) {
  if (shots && last) await last.screenshot({ path: `${shots}/failure.png`, fullPage: true }).catch(() => undefined);
  console.error(e instanceof Error ? e.stack : e); process.exitCode = 1;
} finally {
  clearTimeout(deadline); await browser?.close().catch(() => undefined); stopServer(); await app.close().catch(() => undefined); await pool.end().catch(() => undefined);
}
