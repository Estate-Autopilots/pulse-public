// FIX-AI-EMPLOYEES: the API and (PULSE_AUTH_BROWSER=1) a Playwright walk of Autopilots (the AI employees as cards) and
// Connect your AI, on a disposable synthetic company (tests/core/test_autopilots_browser.py). Synthetic people, runs and
// price; nothing is sent anywhere. Screenshots go to AUTOPILOTS_SHOTS.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createApp } from '../dist/app.js';

const pool = new pg.Pool(JSON.parse(process.env.TEST_API_CONFIG)), owner = new pg.Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
const worker = new pg.Pool(JSON.parse(process.env.TEST_WORKER_CONFIG));
const app = createApp(pool, pool), ADMIN = process.env.TEST_ADMIN_EMAIL, MEMBER = process.env.TEST_MEMBER;
const A = JSON.parse(process.env.TEST_AGENTS);
const shots = process.env.AUTOPILOTS_SHOTS || join(tmpdir(), 'autopilots-shots');
let apiChecks = 0, browserChecks = 0, web, browser;
const call = async (path, who, method = 'GET', body, expected = 200) => {
  apiChecks++;
  const r = await app.inject({ url: '/api/v0/' + path, method, headers: { 'cf-access-authenticated-user-email': who }, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `${method} ${path}: ${r.body}`);
  return r.json();
};
const restore = () => { try { execFileSync('git', ['checkout', '--', 'apps/web/tsconfig.json', 'apps/web/next-env.d.ts'], { cwd: '../..', stdio: 'ignore' }); } catch { /* not a checkout */ } };

try {
  // ---- API: every card carries its cost; only leaders and the AI employees' managers read it ----------------------
  const w = await call('agents/workload', ADMIN);
  assert.equal(w.priced, true, 'the synthetic price is in place');
  const by = Object.fromEntries(w.agents.map((a) => [a.id, a]));
  for (const id of Object.values(A)) assert.ok(by[id]?.cost, `cost for ${id}`);
  const acc = by[A.accounts].cost;
  assert.equal(acc.today.tokens, 36000); assert.ok(acc.today.inr > 0, 'rupees from the price');
  assert.equal(acc.queued, 1); assert.deepEqual(acc.tools, ['billing', 'chats', 'tasks']);
  assert.equal(by[A.accounts].waitingCards.length, 2);
  assert.equal(by[A.care].cost.today.tokens, 18000);
  assert.equal(by[A.ideas].cost.today.tokens, 0); assert.ok(by[A.ideas].cost.lastRunAt, 'when it last worked');
  assert.equal(by[A.posts].runtime.state, 'out_of_quota');
  assert.equal(by[A.paused].status, 'paused');
  apiChecks += 6;
  await call('agents/workload', MEMBER, 'GET', undefined, 403);
  // An older day: nothing that day, the month still counts.
  const before = await call(`agents/workload?day=${new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10)}`, ADMIN);
  assert.equal(before.agents.find((a) => a.id === A.accounts).cost.today.tokens, 0);

  // ---- the browser walk --------------------------------------------------------------------------------------------
  if (process.env.PULSE_AUTH_BROWSER === '1') {
    mkdirSync(shots, { recursive: true });
    const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const probe = createServer(); await new Promise((d) => probe.listen(0, '127.0.0.1', d)); const port = probe.address().port; await new Promise((d) => probe.close(d));
    const base = `http://127.0.0.1:${port}`;
    web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true, stdio: 'ignore',
      env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-autopilots', PULSE_PUBLIC_LOGIN_ENABLED: '' } });
    for (let i = 0; i < 480; i++) { try { if ((await fetch(base + '/login')).status < 500) break; } catch { /* starting */ } await delay(250); if (i === 479) throw Error('web did not start'); }
    browser = await chromium.launch({ headless: true });
    const ctx = async (width, theme) => {
      const c = await browser.newContext({ viewport: { width, height: width < 700 ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1, reducedMotion: 'reduce',
        ...(width < 700 ? { hasTouch: true, isMobile: true } : {}), extraHTTPHeaders: { 'cf-access-authenticated-user-email': ADMIN } });
      await c.addInitScript((t) => { localStorage.setItem('pulse.theme', t); localStorage.setItem('pulse.notify.browser.asked', '1'); }, theme);
      return c;
    };
    // The app scrolls inside its own box, so a "full page" shot stops at the fold: grow the window to the content first.
    const shot = async (page, file) => {
      const vp = page.viewportSize();
      const h = await page.evaluate(() => { let best = document.documentElement.scrollHeight;
        for (const el of document.querySelectorAll('html, body, body *')) { const st = getComputedStyle(el);
          if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 4) best = Math.max(best, el.scrollHeight + (window.innerHeight - el.clientHeight)); }
        return best; });
      await page.setViewportSize({ width: vp.width, height: Math.min(Math.max(h, vp.height), 5000) });
      await delay(600);
      await page.screenshot({ path: join(shots, file) });
      await page.setViewportSize(vp);
      // When the window could not grow (the shell keeps its own scroll box), a second shot after scrolling shows the rest.
      if (h <= vp.height + 4) {
        await page.mouse.move(vp.width * 0.6, vp.height * 0.6); await page.mouse.wheel(0, vp.height - 160); await delay(700);
        const moved = await page.evaluate(() => [...document.querySelectorAll('html, body, body *')].some((el) => el.scrollTop > 0) || window.scrollY > 0);
        if (moved) await page.screenshot({ path: join(shots, file.replace(/\.png$/, '-b.png')) });
        await page.mouse.wheel(0, -5000); await delay(300);
      }
    };
    const noSideways = async (page, what) => {
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(wide <= 1, `no sideways scroll on ${what} (${wide}px)`); browserChecks++;
    };
    // Warm the two pages once (next dev compiles on the first visit).
    { const c = await ctx(1440, 'light'), p = await c.newPage();
      for (const u of ['/people/ai', '/settings?tab=connect-ai']) await p.goto(base + u, { timeout: 300000 }).catch(() => {});
      await c.close(); }
    const sizes = [[1440, 'light'], [1440, 'dark'], [363, 'light'], [363, 'dark'], [390, 'light'], [1920, 'light']];
    for (const [width, theme] of sizes) {
      const c = await ctx(width, theme), page = await c.newPage(), errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      // 1. Autopilots: the cards.
      await page.goto(`${base}/people/ai`, { timeout: 180000 });
      const grid = page.getByRole('list', { name: 'Your AI employees' });
      await expect(grid).toBeVisible({ timeout: 120000 });
      await expect(grid.getByRole('article')).toHaveCount(3);
      const first = grid.getByRole('article', { name: /Accounts Helper Test/ });
      await expect(first).toContainText('Waiting on you'); await expect(first).toContainText('approve 2 cards');
      await expect(page.getByRole('heading', { name: /Needs a person/ })).toBeVisible();
      await expect(grid.getByRole('article', { name: /Posts Updates Test/ })).toContainText('Waiting on budget');
      const quiet = page.getByRole('region', { name: 'Quiet today' });
      await expect(quiet.getByRole('listitem', { name: /Creative Helper Test/ })).toContainText('Last worked');
      await expect(quiet.getByRole('listitem', { name: /Old Helper Test/ })).toContainText('Paused by an admin');
      await expect(first).toContainText('Today ₹');
      browserChecks += 7;
      await noSideways(page, `Autopilots at ${width}`);
      await shot(page, `autopilots-${width}-${theme}.png`);
      // 2. Today's log (the second tab), at the two main widths.
      if (width === 1440 || width === 363) {
        await page.getByRole('link', { name: /Today's log/ }).click();
        await expect(page.getByRole('article', { name: /Accounts Helper Test/ })).toContainText('Waiting for a person', { timeout: 60000 });
        browserChecks++;
        await noSideways(page, `Today's log at ${width}`);
        await shot(page, `autopilots-log-${width}-${theme}.png`);
      }
      // 3. Connect your AI: the three apps with their real logos first.
      await page.goto(`${base}/settings?tab=connect-ai`, { timeout: 180000 });
      const big = page.getByRole('group', { name: 'Pick your AI app' });
      await expect(big).toBeVisible({ timeout: 120000 });
      for (const name of ['Claude', 'ChatGPT', 'Gemini CLI']) await expect(big.getByRole('button', { name: new RegExp(name) })).toBeVisible();
      const logos = await page.evaluate(() => [...document.querySelectorAll('img[src^="/brand-ai/"]')].map((i) => i.complete && i.naturalWidth > 0));
      assert.ok(logos.length >= 3 && logos.every(Boolean), `the brand logos load (${JSON.stringify(logos)})`);
      await expect(page.getByText('More ways to connect')).toBeVisible();
      await expect(page.getByText(/trademark of Anthropic/)).toBeVisible();
      await expect(page.getByText('Nothing connected yet')).toBeVisible({ timeout: 60000 });
      browserChecks += 6;
      await big.getByRole('button', { name: /ChatGPT/ }).click();
      await expect(page.getByRole('heading', { name: 'Set up ChatGPT' })).toBeVisible();
      browserChecks++;
      await noSideways(page, `Connect your AI at ${width}`);
      await shot(page, `connect-ai-${width}-${theme}.png`);
      // For your company is folded; opened, it says where the AI employees work.
      await page.getByText('For your company').click();
      await expect(page.getByRole('link', { name: 'Manage AI' }).or(page.getByText(/Your admins choose/))).toBeVisible({ timeout: 60000 });
      assert.deepEqual(errors, [], `no page errors at ${width} ${theme}`); browserChecks++;
      await c.close();
    }
  }
  writeFileSync(process.env.AUTOPILOTS_REPORT || join(tmpdir(), 'autopilots.json'), JSON.stringify({ apiChecks, browserChecks, shots, syntheticOnly: true }));
  console.log(JSON.stringify({ apiChecks, browserChecks, shots }));
} finally {
  await browser?.close().catch(() => {});
  if (web) { try { process.kill(-web.pid, 'SIGTERM'); } catch { /* gone */ } restore(); }
  await app.close().catch(() => {});
  await Promise.all([pool.end(), owner.end(), worker.end()]).catch(() => {});
}
