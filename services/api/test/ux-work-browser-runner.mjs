// UX-WORK in the browser (tests/core/test_ux_work.py): the real API on a disposable synthetic company and the web app
// under `next dev`. A member and an admin open every Work screen (My work, the task list and a task, reviews, approvals,
// processes and a process, runs and a run, My steps, My week, the project page) at 390 and 1440, light and dark. Each
// screen: no sideways scroll, one page title, keyboard focus that shows, at most one primary action in its header, and
// no page errors. With PULSE_UXW_STRICT=1 it also checks the shared Work pieces (the header, stat tiles, empty states).
// Screenshots with PULSE_UXW_SCREENSHOTS=<dir>, and a JSON of what each screen measured. Everything is invented.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), shots = process.env.PULSE_UXW_SCREENSHOTS, strict = process.env.PULSE_UXW_STRICT === '1';
if (shots) mkdirSync(shots, { recursive: true });
const emails = { admin: 'admin@estateautopilots.com', member: E.editorEmail, head: E.headEmail };
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-uxw', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
const deadline = setTimeout(() => { console.error('ux-work-browser-runner: no result after 35 minutes'); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 35 * 60_000);
deadline.unref();
let browser, checks = 0;
const errors = [], report = [], problems = [];

// Who opens what. Each screen is opened by the person it is for.
const SCREENS = [
  ['member', 'my-day', '/my-day'],
  ['member', 'work', '/tasks'],
  ['member', 'task', `/tasks/${E.task}`],
  ['member', 'my-work', '/me/work'],
  ['member', 'reviews', '/tasks?view=reviews'],
  ['member', 'approvals', '/me/approvals'],
  ['member', 'my-steps', '/me/steps'],
  ['member', 'my-week', '/my-week'],
  ['admin', 'team', '/tasks?view=team'],
  ['admin', 'processes', '/processes'],
  ['admin', 'process', `/processes/${encodeURIComponent(`workflow:${E.process}`)}`],
  ['admin', 'runs', '/runs'],
  ['admin', 'run', `/runs/${E.run}`],
  ['admin', 'project', `/tasks/projects/${E.project}`],
];
// The screens drawn with the Work kit's header (components/work-kit.tsx); the rest keep the page header in the top bar.
const KIT = new Set(['my-work', 'approvals', 'my-steps', 'my-week', 'processes', 'runs']);
// The screens whose key numbers are My day's tiles.
// Runs keeps one set of numbers: chips with counts, so it has no tiles.
const TILES = new Set(['work', 'my-work', 'approvals', 'my-steps', 'my-week', 'processes']);
const only = process.env.PULSE_UXW_ONLY ? process.env.PULSE_UXW_ONLY.split(',') : null;

async function measure(page, phone) {
  return page.evaluate((phone) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const main = document.querySelector('main') ?? document.body;
    const h1 = [...document.querySelectorAll('h1')].filter(vis).map((h) => h.textContent.trim());
    const headers = [...main.querySelectorAll('[data-page-header],[data-ux=header]')].filter(vis).length;
    const primary = [...main.querySelectorAll('[data-primary]')].filter(vis).length;
    const wide = phone ? [...main.querySelectorAll('*')].filter((el) => vis(el) && el.getBoundingClientRect().right > innerWidth + 1 && !el.closest('[data-scroll-x],[role=tablist],nav,[aria-roledescription=carousel]')).slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`) : [];
    // Solid accent buttons that are not the header's primary (a second solid button competes with it).
    const solid = [...main.querySelectorAll('[class*=btnPrimary]')].filter((el) => vis(el) && !el.closest('[data-primary]')).length;
    const title = main.querySelector('[data-ux=header] h2')?.textContent.trim() ?? null;
    const primaryText = [...main.querySelectorAll('[data-primary]')].filter(vis).map((el) => el.textContent.trim());
    return { scroll: document.documentElement.scrollWidth <= innerWidth + 1, h1, headers, primary, wide, solid, title, primaryText,
      tiles: main.querySelectorAll('[data-ux=stat]').length, stripes: main.querySelectorAll('[data-ux=stripe]').length,
      empties: main.querySelectorAll('[data-ux=empty]').length, header: !!main.querySelector('[data-ux=header]') };
  }, phone);
}

async function focusShows(page) {
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  return page.evaluate(() => { const el = document.activeElement; if (!el || el === document.body) return false; const s = getComputedStyle(el); return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none'; });
}

try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  for (const scheme of ['light', 'dark']) for (const width of [1440, 390]) {
    const phone = width < 600;
    const contexts = {};
    for (const [role, name, path] of SCREENS) {
      if (only && !only.includes(name)) continue;
      contexts[role] ??= await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, colorScheme: scheme,
        extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
      const page = await contexts[role].newPage();
      page.on('pageerror', (e) => errors.push(`${name} ${width} ${scheme}: ${e.message}`));
      await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
      await expect(page.locator('main [data-page-header], main [data-ux=header], main h1, main h2').first()).toBeVisible({ timeout: 180000 });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await delay(400);
      const m = await measure(page, phone);
      const focus = await focusShows(page);
      report.push({ name, path, width, scheme, ...m, focus });
      const where = `${name} at ${width} ${scheme}`;
      if (!m.scroll) problems.push(`${where}: sideways scroll (${m.wide.join(', ')})`);
      if (m.headers > 1) problems.push(`${where}: ${m.headers} page headers stacked`);
      if (!focus) problems.push(`${where}: keyboard focus does not show`);
      if (m.primary > 1) problems.push(`${where}: ${m.primary} primary actions`);
      if (strict && KIT.has(name) && !m.header) problems.push(`${where}: not on the shared Work header`);
      if (strict && TILES.has(name) && !m.tiles) problems.push(`${where}: no stat tiles`);
      if (strict && KIT.has(name) && m.primary !== 1) problems.push(`${where}: ${m.primary} primary actions (one expected)`);
      if (strict && KIT.has(name) && m.solid) problems.push(`${where}: ${m.solid} solid buttons besides the primary`);
      // The page's title is the top bar's heading too (it said "My desk" above "Approvals").
      if (strict && KIT.has(name) && m.title && !m.h1.includes(m.title)) problems.push(`${where}: the page heading is ${JSON.stringify(m.h1)}, the title "${m.title}"`);
      // My steps: the member's only step is an older workflow's; the primary opens it, not My day.
      if (name === 'my-steps' && m.primaryText.some((t) => /My day/.test(t))) problems.push(`${where}: the primary leaves for My day above an open step`);
      checks += 4;
      if (shots) { await page.keyboard.press('Escape'); await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); }); await page.screenshot({ path: `${shots}/${name}-${width}-${scheme}.png`, fullPage: true }); }
      await page.close();
    }
    for (const c of Object.values(contexts)) await c.close();
  }
  if (shots) writeFileSync(`${shots}/report.json`, JSON.stringify({ problems, report, errors }, null, 1));
  console.log(`ux-work: ${report.length} screens, ${problems.length} problems, ${errors.length} page errors`);
  for (const p of problems) console.log(`  ${p}`);
  // The base checks (sideways scroll, stacked headers, focus, more than one primary, page errors) fail in every mode;
  // strict adds the kit's header, tiles and exactly one primary (the pytest runs strict).
  assert.deepEqual(problems, [], 'every Work screen meets the standard'); assert.deepEqual(errors, [], 'no page errors');
  console.log(`ux-work-browser-runner: ${checks} checks`);
} finally {
  clearTimeout(deadline);
  await browser?.close().catch(() => {});
  stopServer();
  await app.close().catch(() => {}); await pool.end().catch(() => {});
}
