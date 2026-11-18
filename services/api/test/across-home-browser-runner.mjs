// CONNECTIONS part A in the browser (tests/core/test_across_home.py): the real API on synthetic companies and a personal
// space, and the web app under `next dev`. In their own personal space the owner's home says, in two seconds, what to do
// today across their companies, who waits on them, the money, the companies they are in (a demo company apart, not
// counted) and the companies they work with; "/" opens it; the switcher and Organisations list the demo company under its
// own heading; Settings → Organisation saves the registered name with a note. 1440 and 363, light and dark, no sideways
// scroll, no page errors. Screenshots with PULSE_ACROSS_SCREENSHOTS=<dir>. Everything is invented.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), emails = JSON.parse(process.env.TEST_EMAILS), shots = process.env.PULSE_ACROSS_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-across', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
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
const deadline = setTimeout(() => { console.error(`across-home-browser-runner: no result after 25 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [], consoleErrors = [];
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
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${name}: ${m.text().slice(0, 300)}`); });
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
// A full-page capture paints the phone's fixed tab bar over the middle of the page (a person scrolls under it); it is
// hidden for those captures only. The -top shots keep it, as a person first sees the page.
const shot = async (page, name, full = true) => { if (!shots) return; await later(page); await page.evaluate(() => document.activeElement?.blur?.()); await page.mouse.move(0, 0).catch(() => {});
  const narrow = (page.viewportSize()?.width ?? 1440) <= 760;
  // Next's dev-only "Issues" badge is hidden too (it never ships); console errors are listed at the end.
  const tag = await page.addStyleTag({ content: `nextjs-portal{display:none !important}${full && narrow ? 'nav[aria-label="Mobile navigation"]{visibility:hidden !important}' : ''}` });
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: full });
  await tag.evaluate((el) => el.remove()).catch(() => {}); };
const SIZES = [[1440, 'light'], [1440, 'dark'], [363, 'light'], [363, 'dark']];
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  // 1. The home across companies, in the owner's own personal space, at every size and theme.
  step(1);
  for (const [width, theme] of SIZES) {
    const c = await context('founder-workspace', width, theme), page = await open(c, '/dashboard', `home ${width} ${theme}`);
    await seen(page.getByRole('heading', { name: /^(Good (morning|afternoon|evening)|Working late), Kedab$/ }));
    await later(page);
    await seen(page.getByText(/2 companies/));
    await seen(page.getByText(/things? (is|are) late/));
    const today = page.getByRole('region', { name: 'Today' });
    await seen(today.getByText('Send the room plan')); await seen(today.getByText('Review the pitch deck')); await seen(today.getByText('2 days late').filter({ visible: true }));
    const waiting = page.getByRole('region', { name: 'Waiting on you' });
    await seen(waiting.getByText(/Bill 5 days late/)); await seen(waiting.getByRole('button', { name: 'Collect' }));
    await seen(waiting.getByText('Harbor Builders')); await seen(waiting.getByRole('button', { name: 'Reply' }));
    const money = page.getByRole('region', { name: 'Money' });
    await seen(money.getByText(/₹1\.18\sL/));
    const companies = page.getByRole('region', { name: "Companies you're in" });
    for (const n of E.names) await seen(companies.getByText(n, { exact: true }));
    assert.equal(await companies.getByText(E.demo, { exact: true }).count(), 0, 'the demo company is not one of your companies'); checks++;
    await seen(companies.getByText(`${E.demo} is a demo company, so it is not counted.`));
    const withWho = page.getByRole('region', { name: 'Who you work with' });
    await seen(withWho.getByText(E.workWith[0])); await seen(withWho.getByText(`Client of ${E.names[0]}`));
    await seen(withWho.getByText(E.workWith[1])); await seen(withWho.getByText(`Vendor to ${E.names[0]}`));
    await seen(withWho.getByText('Freelancer for you · Designer'));
    assert.equal(await page.locator('[data-game-page] a[class*="primary"], [data-game-page] button[class*="primary"]').count(), 1, 'one primary button'); checks++;
    await fits(page, `home ${width} ${theme}`); await shot(page, `home-${width}-${theme}`);
    if (width < 600) await shot(page, `home-${width}-${theme}-top`, false);
    await c.close();
  }
  // 2. "/" in the personal space opens this home; the tick marks a task done.
  step(2);
  {
    const c = await context('founder-workspace', 1440, 'light'), page = await open(c, '/', 'root');
    await page.waitForURL(/\/dashboard/, { timeout: 120000 }); checks++;
    await c.close();
  }
  {
    // Changes are made with the company sign-in (the walk's cookie-only session is read only); the tick acts inside the
    // task's own company, from My day (the home's tick is the same call).
    const c = await context('admin', 1440, 'light'), page = await open(c, '/my-day', 'tick');
    await later(page);
    const row = page.getByRole('listitem').filter({ hasText: 'Review the pitch deck' }).first();
    const acted = page.waitForResponse((r) => r.url().endsWith('/api/v0/tasks/my-day/act'), { timeout: 60000 });
    await row.getByRole('button', { name: /Mark “Review the pitch deck” done/ }).click();
    const res = await acted; const said = await res.text().catch(() => '');
    assert.equal(res.status(), 200, `Done answered ${res.status()}: ${said.slice(0, 300)}`); checks++;
    // Done moves it to the folded "Done today" list: the day's ring counts it.
    await seen(page.getByText(/1 of 3 done today/), 60000);
    await c.close();
  }
  // 3. The switcher: my space, the companies I am in, then the demo company under "Test and demo".
  step(3);
  for (const [width, theme] of [[1440, 'light'], [363, 'dark']]) {
    const c = await context('founder-workspace', width, theme), page = await open(c, '/dashboard', `switcher ${width}`);
    await later(page);
    await page.evaluate(() => window.dispatchEvent(new Event('pulse:orgs-open')));
    const dialog = page.getByRole('dialog', { name: 'Switch company in this tab' });
    await seen(dialog.getByText("Companies you’re in")); await seen(dialog.getByText('Test and demo'));
    const order = await dialog.locator('[role="menuitemradio"] b').evaluateAll((els) => els.map((e) => e.textContent));
    assert.equal(order.at(-1), E.demo, `the demo company is last: ${order}`); checks++;
    await shot(page, `switcher-${width}-${theme}`, false);
    await c.close();
  }
  // 4. Organisations: logos or initials, the demo company apart.
  step(4);
  for (const [width, theme] of [[1440, 'light'], [363, 'dark']]) {
    const c = await context('founder-workspace', width, theme), page = await open(c, '/orgs', `orgs ${width}`);
    await later(page);
    await seen(page.getByText('Test and demo companies'));
    await seen(page.getByText('My workspace'));
    await fits(page, `orgs ${width} ${theme}`); await shot(page, `orgs-${width}-${theme}`);
    await c.close();
  }
  // 5. Settings → Organisation: the registered name, with a note for the record.
  step(5);
  for (const [width, theme, save] of [[1440, 'light', true], [363, 'dark', false]]) {
    const c = await context('admin', width, theme), page = await open(c, '/settings?tab=organisation', `settings ${width}`);
    await later(page);
    const field = page.getByLabel('Registered name');
    await seen(field);
    if (save) {
      await field.fill('Northstar Realty Private Limited');
      await seen(page.getByLabel(/Why it changed/));
      await page.getByLabel(/Why it changed/).fill('Name approved by the registrar');
    } else {
      // The phone pass shows what the first pass saved.
      await expect(field).toHaveValue('Northstar Realty Private Limited', { timeout: 60000 }); checks++;
    }
    await fits(page, `settings ${width} ${theme}`); await shot(page, `settings-${width}-${theme}`, false);
    if (save) {
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await seen(page.getByText('Registered name saved'));
      await shot(page, `settings-${width}-${theme}-saved`, false);
    }
    await c.close();
  }
  // 6. My connections, and one connection: draft its agreement (never sent) and give a task.
  step(6);
  {
    const c = await context('admin', 1440, 'light'), page = await open(c, `/connections/${E.conn}`, 'connection');
    await later(page);
    await seen(page.getByRole('heading', { name: 'Diya Nair' }));
    await seen(page.getByText(/No agreement yet/).first());
    const drafted = page.waitForResponse((r) => r.url().endsWith(`/api/v0/connections/${E.conn}/agreement`), { timeout: 60000 });
    await page.getByRole('button', { name: 'Draft an agreement' }).click();
    const dres = await drafted; const dsaid = await dres.text().catch(() => '');
    assert.equal(dres.status(), 200, `Draft answered ${dres.status()}: ${dsaid.slice(0, 300)}`); checks++;
    await seen(page.getByText('Draft ready').first());
    await page.getByRole('textbox', { name: 'Give Diya Nair a task' }).fill('Pick the cover colours');
    await page.getByRole('button', { name: 'Give task' }).click();
    await seen(page.getByRole('region', { name: 'Tasks' }).getByText('Pick the cover colours'));
    await c.close();
  }
  for (const [width, theme] of SIZES) {
    const c = await context('founder-workspace', width, theme), page = await open(c, '/connections', `connections ${width} ${theme}`);
    await seen(page.getByRole('heading', { name: 'People you work with' }));
    await later(page);
    await seen(page.getByRole('link', { name: /Diya Nair/ }));
    await seen(page.getByText('Draft ready').first());
    await seen(page.getByText('Freelancer for you · Designer'));
    await seen(page.getByText(E.workWith[0]).first());
    await fits(page, `connections ${width} ${theme}`); await shot(page, `connections-${width}-${theme}`);
    await c.close();
  }
  for (const [width, theme] of SIZES) {
    const c = await context('founder-workspace', width, theme), page = await open(c, `/connections/${E.conn}`, `connection ${width} ${theme}`);
    await later(page);
    await seen(page.getByRole('heading', { name: 'Diya Nair' }));
    await seen(page.getByText('Draft ready').first());
    await fits(page, `connection ${width} ${theme}`); await shot(page, `connection-${width}-${theme}`);
    await c.close();
  }
  assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`);
  if (shots) writeFileSync(`${shots}/walk-log.txt`, `${checks} checks passed\nconsole errors (not failing):\n${[...new Set(consoleErrors)].join('\n')}\n`);
  if (consoleErrors.length) console.log(`console errors (not failing):\n${[...new Set(consoleErrors)].slice(0, 20).join('\n')}`);
  console.log(`across-home-browser-runner: ${checks} checks passed`);
} catch (e) {
  if (last && shots) await last.screenshot({ path: `${shots}/failed-${String(current).replace(/\W+/g, '-')}.png`, fullPage: true }).catch(() => {});
  console.error(`across-home-browser-runner failed at step ${current}:`, e?.stack ?? e);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await browser?.close().catch(() => {});
  await stopServer(); await app.close().catch(() => {}); await pool.end().catch(() => {});
}
