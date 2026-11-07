// UX-FINANCE in the browser (tests/core/test_finance_ux.py::test_finance_screens_in_the_browser): every Finance screen
// (Overview, Numbers, the Cash book, Entries, Money in, Money out, Cash, People cost, the CA desk, Data sources) and My
// sales, through the real API and the web app on a disposable synthetic company, at 390 and 1440 px, light and dark.
// Each screen: one heading, no page errors, no sideways scroll on a phone, a primary action where the screen has one,
// keyboard focus that shows. Screenshots with PULSE_FUX_SHOTS=<dir> (names <prefix>-<screen>-<width>-<scheme>.png);
// PULSE_FUX_PREFIX names them (default "after"); PULSE_FUX_LOOSE=1 only takes the screenshots (the "before" run).
// NEXT_MODE=dev runs `next dev`. Everything is invented; nothing is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const emails = JSON.parse(process.env.TEST_EMAILS), shots = process.env.PULSE_FUX_SHOTS, prefix = process.env.PULSE_FUX_PREFIX || 'after';
const loose = process.env.PULSE_FUX_LOOSE === '1', schemes = (process.env.PULSE_FUX_SCHEMES || 'light,dark').split(',');
if (shots) mkdirSync(shots, { recursive: true });
let checks = 0;
const ok = (v, m) => { if (loose) { if (!v) console.log('LOOSE (not checked):', m); return; } assert.ok(v, m); checks++; };
const { chromium } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`, dev = process.env.NEXT_MODE === 'dev';
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', dev ? 'dev' : 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, PULSE_PUBLIC_URL: base, NODE_ENV: dev ? 'development' : 'production', NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? '.next', NEXT_TELEMETRY_DISABLED: '1' }, stdio: 'ignore' });
const T = dev ? 240000 : 60000;
const ready = async (page) => { await page.waitForFunction(() => document.querySelector('main h1,main h2,main h3') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: T }); await page.waitForTimeout(400); };

// [name, path, who, the screen's one primary action (a regexp on its text), or null when the screen only reads]
const SCREENS = [
  ['overview', '/finance?tab=overview', 'founder', /Add entry/],
  ['numbers', '/finance?tab=numbers&period=fy', 'founder', /Add entry/],
  ['book', '/finance?tab=book', 'founder', /Spent/],
  ['entries', '/finance?tab=entries', 'founder', /Add entry/],
  ['money-in', '/finance?tab=revenue', 'founder', null],
  ['invoiced', '/finance?tab=income', 'founder', null],
  ['clients', '/finance?tab=clients', 'founder', null],
  ['spend', '/finance?tab=subscriptions', 'founder', null],
  ['ad-spend', '/finance?tab=ad-spend', 'founder', null],
  ['budget', '/finance?tab=budget', 'founder', null],
  ['people-value', '/finance?tab=people', 'founder', null],
  ['reconcile', '/finance?tab=reconcile', 'founder', null],
  ['forecast', '/finance?tab=forecast', 'founder', null],
  ['timeline', '/finance?tab=timeline', 'founder', null],
  ['close', '/finance?tab=close', 'founder', null],
  ['people-cost', '/finance/people-cost', 'founder', null],
  ['ca-desk', '/finance/desk', 'founder', null],
  ['sources', '/finance?tab=ledger', 'founder', null],
  ['my-sales', '/sales?period=fy', 'sales', null],
  ['refused', '/finance?tab=numbers', 'member', null],
].filter(([n]) => !process.env.PULSE_FUX_ONLY || process.env.PULSE_FUX_ONLY.split(',').includes(n));

let browser;
const errors = [];
try {
  for (let i = 0; i < 960; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await delay(250); if (i === 959) throw Error('the web app did not start'); }
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) for (const scheme of schemes) {
    const ctxs = {};
    const ctx = async (who) => ctxs[who] ??= await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: scheme, deviceScaleFactor: 1,
      ...(width < 500 ? { isMobile: true, hasTouch: true } : {}), extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[who] } });
    for (const [name, path, who, primary] of SCREENS) {
      const c = await ctx(who), p = await c.newPage();
      p.on('pageerror', (e) => errors.push(`${name} ${width} ${scheme}: ${e.message}`));
      try { await p.goto(base + path, { waitUntil: 'load', timeout: T }); await ready(p); }
      catch (e) { console.log('slow', name, width, scheme, String(e).slice(0, 160)); if (!loose) throw e; }
      await p.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      if (shots) await p.screenshot({ path: `${shots}/${prefix}-${name}-${width}-${scheme}.png`, fullPage: true });
      console.log('shot', name, width, scheme, p.url().replace(base, ''));
      if (scheme === schemes[0]) {
        const fit = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
        ok(fit, `${name} at ${width}: no sideways page scroll`);
        // The shell's top bar names the area (its h1); the page's own header (title, what it is for) is there once.
        const heads = await p.locator('main [data-page-header]').count();
        ok(heads === 1, `${name} at ${width}: one page header (found ${heads})`);
        const titled = await p.locator('main [data-page-header] [data-page-title]').count();
        ok(titled === 1, `${name} at ${width}: the header names the screen`);
        if (primary) {
          const n = await p.locator('main [data-primary]').filter({ hasText: primary }).count();
          ok(n >= 1, `${name} at ${width}: a primary action matching ${primary}`);
          const all = await p.locator('main [data-page-header] [data-primary]').count();
          ok(all <= 1, `${name} at ${width}: one primary action in the header (found ${all})`);
        }
        // Text that names a figure is readable: the muted text colour against the page has at least 4.5:1 contrast.
        const contrast = await p.evaluate(() => {
          const rgb = (c) => { const n = (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number); return c.startsWith('color(srgb') ? n.map((v) => v * 255) : n; };
          const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
          const el = document.querySelector('main [data-page-header] p'); if (!el || !/^(rgb|color\(srgb)/.test(getComputedStyle(el).color)) return 21;
          let bg = null; for (let n = el; n && !bg; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) bg = c; }
          bg ??= getComputedStyle(document.body).backgroundColor;
          const a = lum(rgb(getComputedStyle(el).color)), b = lum(rgb(bg)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        });
        ok(contrast >= 4.5, `${name} at ${width}: header text contrast ${contrast.toFixed(2)} ≥ 4.5`);
        // UX-FINANCE (review): a figure in a tile (₹8,30,000) is never broken across lines or cut by its tile; words wrap.
        const broken = await p.evaluate(() => [...document.querySelectorAll('main [class*="tileValue"] > span[data-figure]')].filter((v) => {
          const t = v.closest('[class*="tile"]:not([class*="tileValue"])'), r = v.getBoundingClientRect(), lh = parseFloat(getComputedStyle(v).lineHeight) || parseFloat(getComputedStyle(v).fontSize) * 1.3;
          return r.height > lh * 1.6 || (t && r.right > t.getBoundingClientRect().right + 1);
        }).map((v) => v.textContent));
        ok(!broken.length, `${name} at ${width}: tile figures whole (${broken.slice(0, 3).join(', ')})`);
        // More sits inside the section chips, so on a phone it no longer covers them.
        if (await p.locator('main nav[aria-label="Finance sections"]').count()) ok(await p.locator('main nav[aria-label="Finance sections"] button[aria-label="More in Finance"]').count() === 1, `${name} at ${width}: More is the last section chip`);
        if (name === 'book') { const px = await p.locator('main section[aria-label="Cash book totals"] [class*="tileValue"] > span').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize)); ok(px >= 16, `book at ${width}: In hand reads large (${px}px)`); }
        if (name === 'overview') {
          ok(await p.locator('main section[aria-label="Finance mail figures"][class*="tiles"]').count() === 0, `overview at ${width}: one row of tiles (Numbers), not two`);
          ok(await p.locator('main nav[aria-label="Overview views"] [aria-current]').filter({ hasText: /^Overview$/ }).count() === 0, `overview at ${width}: the view chip is not a second Overview`);
        }
        if (name === 'refused') ok(await p.locator('main button[data-primary]').count() === 0, `refused at ${width}: no Add entry for someone who may not write`);
        if (width === 1440) {
          // The first control inside the page shows a focus ring (an outline or a box shadow) when reached by keyboard.
          await p.locator('main').first().evaluate((m) => { const f = m.querySelector('a[href],button:not([disabled])'); if (f) f.focus({ focusVisible: true }); });
          const ring = await p.evaluate(() => { const a = document.activeElement; if (!a || a === document.body) return true; const s = getComputedStyle(a); return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none'; });
          ok(ring, `${name}: keyboard focus shows`);
        }
      }
      await p.close();
    }
    for (const c of Object.values(ctxs)) await c.close();
  }
  ok(!errors.length, `no page errors: ${errors.slice(0, 5).join(' | ')}`);
  const receipt = JSON.stringify({ checks, screens: SCREENS.length, loose });
  if (process.env.TEST_REPORT) await writeFile(process.env.TEST_REPORT, receipt);
  console.log(receipt);
} finally { await browser?.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } await app.close(); await pool.end(); }
