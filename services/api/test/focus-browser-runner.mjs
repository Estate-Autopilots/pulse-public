// FOCUS (1845) in the browser (tests/core/test_focus.py): the real API on a disposable synthetic company and the web
// app under `next dev`. The owner (an admin) sees Focus (accounts with their windows, the burn graph, today's plan, the
// settings) and Funding; a colleague is refused. 1440 and 390, light and dark, no sideways scroll, no page errors.
// Screenshots with PULSE_FOCUS_SCREENSHOTS=<dir>. Every name and number is fake.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const emails = JSON.parse(process.env.TEST_EMAILS), shots = process.env.PULSE_FOCUS_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-focus', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
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
const deadline = setTimeout(() => { console.error('focus-browser-runner: no result after 25 minutes'); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
async function context(role, width = 1440, theme = 'light') {
  const phone = width < 600;
  const c = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
  await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); } catch { /* private */ } }, theme);
  return c;
}
async function open(c, path, name) {
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
  return page;
}
// UX-GAMIFY: rings and gauges fill for about a second; a shot waits for their final state.
const shot = async (page, name, full = true) => { if (shots) { await delay(1600); await page.screenshot({ path: `${shots}/${name}.png`, fullPage: full }); } };
const SIZES = [[1440, 'light'], [1440, 'dark'], [363, 'light'], [363, 'dark']];  // UX-GAMIFY: the owner's phone width
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  for (const [width, theme] of SIZES) {
    const c = await context('owner', width, theme), page = await open(c, '/focus', `focus ${width} ${theme}`);
    // UX-GAMIFY (9 Nov 2026): one page, Today: fuel gauges, today's quests, the rail, the week's use; Settings beside it.
    await seen(page.getByRole('heading', { name: 'Focus' }));
    // PULSE-POLISH (owner, 14 Nov 2026): one next step and why first, at most two more, the rest folded; one privacy note.
    await seen(page.getByRole('region', { name: 'Do this next' }));
    if (await page.locator('section[aria-label="Do this next"][data-kind="run"]').count()) await seen(page.getByText(/^Why:/));
    assert.equal(await page.getByText(/only you see this/i).count(), 0, 'no repeated "only you see this" labels');
    await seen(page.getByText('Only you can see Focus.'));
    for (const fold of ['Everything else today', 'AI accounts', 'AI use this week, by company']) await page.getByText(fold, { exact: true }).click();
    await seen(page.getByText('Fake Max One'));
    await seen(page.getByText('Fake lane: build the thing'));
    await seen(page.getByText('Fake company registration'));
    await seen(page.getByText('Use this week'));
    await fits(page, `focus today ${width} ${theme}`); await shot(page, `focus-today-${width}-${theme}`);
    // UX-GAMIFY: on a phone, also what a person sees, screen by screen (a full-page shot draws the fixed tab bar and the
    // + button in the middle of the page).
    if (shots && width < 600) {
      for (const [k, what] of [['a', null], ['b', page.getByText('AI accounts', { exact: true })], ['c', page.getByText('Use this week')]]) {
        // 'a' is the top of the page as it opens (scrolling the title to the very top would tuck it under the pinned bar).
        if (what) await what.first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
        else await page.evaluate(() => { window.scrollTo(0, 0); for (const el of document.querySelectorAll('*')) if (el.scrollTop > 0) el.scrollTop = 0; });
        await delay(1200);
        await page.screenshot({ path: `${shots}/focus-phone-${theme}-${k}.png` });
      }
      await page.getByRole('heading', { name: 'Focus' }).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    }
    if (width === 1440 && theme === 'light') {
      await page.getByRole('radio', { name: /^(Set up|Settings)$/ }).click();  // PULSE-POLISH: the tab is 'Set up'
      await seen(page.getByText('Save this much for urgent jobs'));
      await fits(page, 'focus settings 1440 light'); await shot(page, 'focus-settings-1440-light');
      // A reading typed by hand ("Update", in % left) for an account no collector reads.
      await page.getByRole('radio', { name: /Today/ }).click();
      await page.getByText('AI accounts', { exact: true }).click();
      await page.getByRole('article', { name: 'Fake Max Two' }).getByRole('button', { name: /^(Update now|Update)$/ }).click();  // PULSE-POLISH: "Update" 
      await page.getByLabel(/How much is left now/).fill('36');
      await shot(page, 'focus-log-reading-1440-light', false);
      const saved = page.waitForResponse((r) => r.url().includes('/reading') && r.request().method() === 'POST', { timeout: 120000 });
      await page.getByRole('button', { name: /^Save( reading)?$/ }).click();
      assert.equal((await saved).status(), 200);
      await seen(page.getByText(/Reading saved for Fake Max Two/));
      await shot(page, 'focus-reading-saved-1440-light');
    }
    await c.close();
    const f = await context('owner', width, theme), fund = await open(f, '/funding', `funding ${width} ${theme}`);
    await seen(fund.getByRole('heading', { name: 'Funding' }));
    await seen(fund.getByText('Fake Cloud Credits'));
    await seen(fund.getByText(/Blocked by: Fake company registration/));
    await fits(fund, `funding ${width} ${theme}`); await shot(fund, `funding-${width}-${theme}`);
    await f.close();
  }
  // A colleague who is not an admin is refused.
  { const c = await context('member'), page = await open(c, '/focus', 'focus member');
    const r = await c.request.get(`${origin}/api/v0/focus`, { headers: { 'cf-access-authenticated-user-email': emails.member } });
    assert.equal(r.status(), 403, 'a colleague is refused by the API');
    await page.waitForLoadState('networkidle').catch(() => undefined);
    assert.equal(await page.getByText('Fake Max One').count(), 0, 'a colleague sees no account');
    checks += 2; await shot(page, 'focus-refused-member-1440-light'); await c.close(); }
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log(`focus-browser-runner: ${checks} checks passed`);
} catch (e) {
  if (shots && last) await last.screenshot({ path: `${shots}/failure.png`, fullPage: true }).catch(() => undefined);
  console.error(e instanceof Error ? e.stack : e); process.exitCode = 1;
} finally {
  clearTimeout(deadline); await browser?.close().catch(() => undefined); await stopServer(); await app.close().catch(() => undefined); await pool.end().catch(() => undefined);
}
