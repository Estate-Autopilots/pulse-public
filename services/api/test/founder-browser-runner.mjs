// GAP-FOUNDER-VIEW in the browser (tests/core/test_founder_view.py): the real API on three synthetic companies and a
// personal workspace, and the web app under `next dev`. The founder opens their own workspace, sees "All my companies" in
// the sidebar and one card per company in their Focus order (money, client issues, late work, people in, AI employees,
// a person who works in two of their companies, the next thing), taps Open to move into a company with the switcher's own
// switch; their profile lists their role in each company; someone who runs only one company gets the one-action empty
// page. 1440 and 363, light and dark, no sideways scroll, no page errors. Screenshots with PULSE_FV_SCREENSHOTS=<dir>.
// Everything is invented.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), emails = JSON.parse(process.env.TEST_EMAILS), shots = process.env.PULSE_FV_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-fv', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
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
let browser, checks = 0, current = 'start', last;
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`founder-browser-runner: no result after 25 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
async function context(role, width = 1440, theme = 'light') {
  const phone = width < 600;
  // The founder opens in their own workspace: the session the account switch minted (TEST_IDS.token) is the cookie.
  const workspace = role === 'founder-workspace';
  const c = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone,
    ...(workspace ? {} : { extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } }) });
  if (workspace) await c.addCookies([{ name: 'pulse_session', value: E.token, url: base }]);
  await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('pulse-fun', 'off'); } catch { /* private */ } }, theme);
  return c;
}
async function open(c, path, name) {
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
  return page;
}
/** The account's "one password for all your workspaces" prompt (a synthetic account has none yet): Later, as the owner did. */
async function later(page) {
  const b = page.getByRole('button', { name: 'Later' });
  await b.waitFor({ state: 'visible', timeout: 8000 }).then(() => b.click()).catch(() => {});
  await b.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
}
// No element keeps a focus ring from loading in the picture (a row that looks selected).
const shot = async (page, name, full = true) => { if (!shots) return; await page.evaluate(() => document.activeElement?.blur?.()); await page.mouse.move(0, 0).catch(() => {}); await page.screenshot({ path: `${shots}/${name}.png`, fullPage: full }); };
const SIZES = [[1440, 'light'], [1440, 'dark'], [363, 'light'], [363, 'dark']];
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  // 1. All my companies, in the founder's own workspace, at every size and theme.
  step(1);
  for (const [width, theme] of SIZES) {
    const c = await context('founder-workspace', width, theme), page = await open(c, '/founder', `founder ${width} ${theme}`);
    await seen(page.getByRole('heading', { name: 'All my companies' }));
    await later(page);
    for (const n of E.names) await seen(page.getByRole('heading', { name: n }));
    // Focus order: the weights put the second company first.
    const order = await page.locator('[data-founder-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-founder-card')));
    assert.deepEqual(order, E.order, `cards in the Focus order: ${order}`); checks++;
    await seen(page.getByText(/Collect the bill from .+ · 5\sdays\slate/));
    await seen(page.getByText(/₹1\.18\sL late/));
    await seen(page.getByText(/Diya Nair is also /));
    assert.equal(await page.getByText(/Diya Nair is also /).count(), 1, 'a person in two of your companies is named once'); checks++;
    await seen(page.getByText(/Do this first · /));
    await seen(page.getByText('All clear today.'));
    await seen(page.getByText(/due in 7 days/));
    if (width > 900) { await seen(page.locator('a[href="/founder"]')); }
    await fits(page, `All my companies ${width} ${theme}`); await shot(page, `founder-${width}-${theme}`);
    if (width < 600) { await shot(page, `founder-${width}-${theme}-top`, false); }
    await c.close();
  }
  // 2. Open moves into that company with the switcher's switch and lands on its home.
  step(2);
  {
    const c = await context('founder-workspace', 1440, 'light'), page = await open(c, '/founder', 'open');
    await later(page);
    // The card's one button sends the organisation switcher's own switch for that company (the switch itself and the
    // landing are the switcher's, tested in test_org_switcher / org-runner). Since ORG-PER-TAB (2141) that switch opens
    // the company in this tab (account/tab-open); BUG-SWEEP-2's "Confirm it's you" only follows a refusal of it.
    const sent = page.waitForRequest((r) => /\/api\/v0\/account\/(tab-open|switch)$/.test(r.url()) && r.method() === 'POST', { timeout: 60000 });
    await page.getByRole('button', { name: `Open ${E.names[2]}` }).click();
    const req = await sent;
    assert.equal(JSON.parse(req.postData() ?? '{}').org, E.orgs[2], 'Open sends the switch for that company'); checks++;
    const res = await req.response().catch(() => null);
    console.log(`switch answered ${res?.status() ?? 'nothing'}`);
    await c.close();
  }
  // 3. The profile says the founder's role in each company.
  step(3);
  for (const [width, theme] of [[1440, 'light'], [363, 'dark']]) {
    const c = await context('founder', width, theme), page = await open(c, '/orgs/profile', `profile ${width}`);
    await later(page);
    const roles = page.locator('[data-designations]');
    await seen(roles.getByText(E.names[0])); await seen(roles.getByText('Founder', { exact: true }));
    await seen(roles.getByText(E.names[1])); await seen(roles.getByText('Adviser', { exact: true }));
    await seen(roles.getByText('Admin', { exact: true }));
    // A notice that closes by itself (6 s, e.g. "Your role brief is ready") is let go before the picture.
    await page.waitForTimeout(1500); await page.getByText('Your role brief is ready').first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    await fits(page, `profile ${width} ${theme}`); await shot(page, `profile-${width}-${theme}`, false);
    await c.close();
  }
  // 4. Someone who runs no two companies: the one-action empty page, and no menu entry.
  step(4);
  for (const [width, theme] of [[1440, 'light'], [363, 'light']]) {
    const c = await context('diya', width, theme), page = await open(c, '/founder', `empty ${width}`);
    await later(page);
    await seen(page.getByText('You run one company'));
    await seen(page.getByRole('link', { name: 'Add a company' }));
    await seen(page.getByRole('button', { name: `Open ${E.names[0]}` }));
    assert.equal(await page.locator('nav a[href="/founder"]').count(), 0, 'no menu entry for someone who runs one company'); checks++;
    await page.waitForTimeout(1500); await page.getByText('Your role brief is ready').first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    await fits(page, `empty ${width}`); await shot(page, `founder-empty-${width}-${theme}`, false);
    await c.close();
  }
  assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`);
  console.log(`founder-browser-runner: ${checks} checks passed`);
} catch (e) {
  if (last && shots) await last.screenshot({ path: `${shots}/failed-${String(current).replace(/\W+/g, '-')}.png`, fullPage: true }).catch(() => {});
  console.error(`founder-browser-runner failed at step ${current}:`, e?.stack ?? e);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await browser?.close().catch(() => {});
  await stopServer(); await app.close().catch(() => {}); await pool.end().catch(() => {});
}
