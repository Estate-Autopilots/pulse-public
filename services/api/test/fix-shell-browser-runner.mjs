// FIX-SHELL in the browser (tests/core/test_fix_shell.py): one Pulse account in two synthetic companies. Company A has
// its own logo; company B has Funding and the Product map switched on (organisation-only, 1947). At 1440 and 363, light
// and dark:
//   - the rail shows the company once (its own tile; no second logo stacked under the app's), collapsed and open; the
//     sidebar's switcher names the company without a second logo;
//   - All apps: one clear grid with groups, icons and one line each; Recent; a chosen group chip is solid violet with
//     white words; the phone's chips are never cut; Product map is nowhere in A; Funding links across to B (/@b/funding);
//   - /funding in A is not a dead page: one card, one button that opens it in B; /@b/funding switches and opens it;
//   - nothing runs off the right edge.
// Screenshots with PULSE_FS_SCREENSHOTS=<dir>. Everything is invented; nothing is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), shots = process.env.PULSE_FS_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-fs', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
let browser, checks = 0, current = 'start';
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`fix-shell-browser-runner: no result after 25 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const quiet = async (page) => {
  const later = page.getByRole('button', { name: 'Later', exact: true });
  try { await later.waitFor({ state: 'visible', timeout: 6000 }); await later.click(); await later.waitFor({ state: 'hidden', timeout: 10000 }); } catch { /* not offered */ }
};
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  // The account's companies carry their organisation-only modules (1947).
  const me = await (await fetch(`${origin}/api/v0/me`, { headers: { 'x-pulse-session': E.token } })).json();
  const b = (me.account?.orgs ?? []).find((o) => o.id === E.orgB);
  assert.deepEqual([...(b?.orgOnly ?? [])].sort(), ['funding', 'product_map'], `me: company B's organisation-only modules ${JSON.stringify(me.account?.orgs).slice(0, 400)}`); checks++;
  assert.ok(me.modules.off.includes('product_map') && me.modules.off.includes('funding'), 'company A has neither'); checks++;
  browser = await chromium.launch();
  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [363, 'light'], [363, 'dark']]) {
    step(`${width} ${theme}`);
    const phone = width < 600, tag = `${width}-${theme}`;
    const c = await browser.newContext({ viewport: { width, height: phone ? 800 : 900 }, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, colorScheme: theme,
      extraHTTPHeaders: { 'cf-access-authenticated-user-email': E.email } });
    await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('pulse.notify.browser.asked', '1');
      localStorage.setItem('pulse.recents', JSON.stringify([{ href: '/tasks', title: 'Tasks', kind: 'page', at: Date.now() - 60000 }, { href: '/people', title: 'Team', kind: 'page', at: Date.now() - 120000 }])); } catch { /* private */ } }, theme);
    const page = await c.newPage();
    page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
    if (!phone) {
      // Collapsed: one company tile at the top of the rail, the company switcher; the rail's foot opens the menu.
      await page.addInitScript(() => { if (!sessionStorage.getItem('fs-set')) { localStorage.setItem('pulse.sidebar.collapsed', 'true'); sessionStorage.setItem('fs-set', '1'); } });
      await page.goto(base + '/my-day', { waitUntil: 'load', timeout: 300000 });
      await seen(page.getByRole('main'));
      await quiet(page);
      const company = page.locator('[data-nav-id="rail:company"]');
      await seen(company);
      assert.equal(await company.count(), 1, 'one company tile'); checks++;
      assert.match(await company.getAttribute('aria-label'), new RegExp(`^${E.nameA}: switch company`), 'collapsed, the tile switches company'); checks++;
      assert.equal(await page.locator('aside [class*="pulseMark"]').count(), 0, 'no second (app) logo stacked in the rail'); checks++;
      await seen(page.getByRole('button', { name: 'Expand sidebar navigation' }));
      await page.waitForTimeout(800);
      await shot(page, `rail-collapsed-${tag}`);
      await fits(page, `collapsed ${tag}`);
      // Open: the panel names the company with no second logo beside the rail's.
      await page.getByRole('button', { name: 'Expand sidebar navigation' }).click();
      const trigger = page.locator('button[aria-label^="Organisation:"]');
      await seen(trigger);
      assert.equal(await trigger.locator('img, [data-org-tile]').count(), 0, 'the switcher shows the name, not a second logo'); checks++;
      assert.match(await page.locator('[data-nav-id="rail:company"]').getAttribute('aria-label'), new RegExp(`^${E.nameA} home`)); checks++;
      assert.equal(await page.locator('aside a[href="/product-map"]').count(), 0, 'no Product map in the menu here'); checks++;
      await page.waitForTimeout(600);
      await shot(page, `sidebar-open-${tag}`);
      // All apps.
      await page.locator('[data-nav-id="rail:apps"]').click();
      const apps = page.getByRole('dialog', { name: 'All apps' });
      await seen(apps);
      await seen(apps.getByRole('navigation', { name: 'Groups' }));
      await seen(apps.getByRole('region', { name: 'Recent' }).getByRole('link', { name: 'Tasks' }));
      assert.equal(await apps.locator('a[href="/product-map"]').count(), 0, 'no Product map in All apps here'); checks++;
      await seen(apps.locator(`a[href="/@${E.handleB}/funding"]`));
      const heights = await apps.locator('[data-nav-id^="apps:"]').evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().height)))]);
      assert.ok(heights.length <= 2, `tiles share one height (the Pinned row aside): ${heights}`); checks++;
      await page.waitForTimeout(500);
      await shot(page, `apps-${tag}`);
      await apps.getByRole('navigation', { name: 'Groups' }).getByRole('button', { name: /Growth/ }).click();
      await page.waitForTimeout(700);
      await shot(page, `apps-growth-${tag}`);
      // VISUAL-QA (10 Nov 2026, apps/web/app/lib/nav.ts billingOff): an admin without the Finance role or the money
      // grants, as this synthetic founder is, has no Billing in the menu (its pages only said "unavailable"), so
      // "invoice" names no page here: the launcher says so and offers the wider search. A page is still found by its
      // other words: "overview" is one of the Dashboard's (packages/ui-shell/src/nav-catalog.ts).
      const find = apps.getByRole('textbox', { name: 'Find any page' });
      await find.fill('invoice');
      await seen(apps.getByText('No page called “invoice”.', { exact: true }));
      await seen(apps.getByRole('button', { name: 'Search tasks, people and chats' }));
      assert.equal(await apps.getByRole('link', { name: /Billing/ }).count(), 0, 'no Billing for an admin without the money grants'); checks++;
      await find.fill('overview');
      await seen(apps.getByRole('link', { name: /Dashboard/ }));
      await shot(page, `apps-search-${tag}`);
      await page.keyboard.press('Escape');
    } else {
      await page.goto(base + '/my-day', { waitUntil: 'load', timeout: 300000 });
      await seen(page.getByRole('main'));
      await quiet(page);
      await page.locator('[data-nav-id="tab:more"]').click();
      const sheet = page.getByRole('dialog', { name: 'All apps' });
      await seen(sheet);
      const chips = sheet.getByRole('tablist', { name: 'Go to a group' });
      await seen(chips);
      const box = await chips.getByRole('tab').first().boundingBox();
      assert.ok(box && box.height >= 32, `the group chips are not cut: ${JSON.stringify(box)}`); checks++;
      await page.waitForTimeout(500);
      await shot(page, `more-${tag}`);
      await chips.getByRole('tab', { name: 'Growth' }).click();
      await page.waitForTimeout(800);
      const growth = chips.getByRole('tab', { name: 'Growth' });
      const look = await growth.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));
      assert.deepEqual(look, { bg: 'rgb(107, 76, 240)', fg: 'rgb(255, 255, 255)' }, 'the chosen group: white words on solid violet'); checks++;
      await shot(page, `more-growth-${tag}`);
      await fits(page, `more ${tag}`);
      await page.keyboard.press('Escape');
    }
    // An organisation-only page from the other company: one card, one way there.
    await page.goto(base + '/funding', { waitUntil: 'load', timeout: 300000 });
    const there = page.getByRole('link', { name: `Open in ${E.nameB}` });
    await seen(there);
    assert.equal(await there.getAttribute('href'), `/@${E.handleB}/funding`); checks++;
    await seen(page.getByText(`This page is in ${E.nameB}`));
    await shot(page, `funding-elsewhere-${tag}`);
    await fits(page, `funding ${tag}`);
    // Settings: the account card on top with real buttons, each area one grouped list, no coloured stripes, no right rail.
    await page.goto(base + '/settings', { waitUntil: 'load', timeout: 300000 });
    await seen(page.getByRole('region', { name: 'Your account' }).getByRole('link', { name: 'Your account' }));
    assert.equal(await page.locator('[data-stripe-card]').count(), 0, 'no stripe cards on the Settings home'); checks++;
    await page.waitForTimeout(400);
    await shot(page, `settings-${tag}`);
    await fits(page, `settings ${tag}`);
    await page.goto(base + '/settings?tab=account', { waitUntil: 'load', timeout: 300000 });
    // SETTINGS-APPLE (13 Nov, two panes) and PULSE-POLISH (afd574623, 14 Nov): the list's account row is the person's own
    // card (photo, name, one line), named after them; on ?tab=account it is the current row.
    // On a phone the section is a pushed page of its own: the list waits out of view behind it (frame data-open=detail).
    const meRow = page.getByRole('navigation', { name: 'Settings sections' }).locator('[data-settings-row="account"]');
    if (phone) { await expect(page.locator('[data-settings-frame]')).toHaveAttribute('data-open', 'detail', { timeout: 180000 }); await expect(meRow).toBeAttached(); checks++; }
    else await seen(meRow);
    assert.equal(await meRow.getAttribute('aria-current'), 'page', 'the account row is the current one'); checks++;
    await page.waitForTimeout(400);
    await shot(page, `settings-account-${tag}`);
    await fits(page, `settings account ${tag}`);
    // Account / Security: the password form at a readable width with a normal-size main button.
    await page.goto(base + '/account', { waitUntil: 'load', timeout: 300000 });
    await seen(page.getByRole('main'));
    await page.waitForTimeout(600);
    await shot(page, `account-password-${tag}`);
    await fits(page, `account ${tag}`);
    // The shared edit sheet: a full-height sheet on the right on a computer, a bottom sheet on a phone.
    await page.goto(base + '/settings?tab=sign-in', { waitUntil: 'load', timeout: 300000 });
    const access = page.getByRole('button', { name: /Account access/ }).first();
    if (await access.count()) {
      await access.click();
      const sheet = page.locator('[data-pulse-drawer]:not([inert])').last();
      await seen(sheet);
      await page.waitForTimeout(500);
      const box = await sheet.boundingBox();
      if (!phone) { assert.ok(box && box.height >= 880 && Math.round(box.x + box.width) >= width - 1, `a full-height sheet on the right: ${JSON.stringify(box)}`); checks++; }
      else { assert.ok(box && Math.round(box.y + box.height) >= 799 && box.width >= width - 1, `a bottom sheet: ${JSON.stringify(box)}`); checks++; }
      await shot(page, `sheet-${tag}`);
      await page.keyboard.press('Escape');
    } else console.log(`no Account access button at ${tag}`);
    // Find companies.
    await page.goto(base + '/directory', { waitUntil: 'load', timeout: 300000 });
    await seen(page.getByRole('searchbox'));
    await page.waitForTimeout(400);
    await shot(page, `directory-${tag}`);
    await fits(page, `directory ${tag}`);
    await c.close();
    // Signed out: the sign-in page (the other ways in as one list).
    const out = await browser.newContext({ viewport: { width, height: phone ? 800 : 900 }, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, colorScheme: theme });
    await out.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); } catch { /* private */ } }, theme);
    const login = await out.newPage();
    await login.goto(base + '/login', { waitUntil: 'load', timeout: 300000 });
    await seen(login.getByRole('heading', { level: 1 }).or(login.getByRole('heading', { level: 2 })));
    await login.waitForTimeout(400);
    await shot(login, `login-${tag}`);
    await fits(login, `login ${tag}`);
    await out.close();
  }
  // A company path switches the session to that company, then opens the page (once, at the end: it moves the session).
  step('company path');
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': E.email } });
  const page = await c.newPage();
  page.on('pageerror', (e) => errors.push(`company path: ${e.message}`));
  await page.goto(`${base}/@${E.handleB}/funding`, { waitUntil: 'load', timeout: 300000 });
  await page.waitForURL((u) => u.pathname === '/funding', { timeout: 120000 });
  await expect(page.getByText(`This page is in ${E.nameB}`)).toHaveCount(0, { timeout: 60000 }); checks++;
  await expect(page.locator('button[aria-label^="Organisation:"]')).toHaveAttribute('aria-label', new RegExp(`^Organisation: ${E.nameB}`), { timeout: 60000 }); checks++;
  await shot(page, 'company-path-funding-1440-light');
  // A company the account is not in: a clear card, never someone else's page.
  await page.goto(`${base}/@nosuchcompany/tasks`, { waitUntil: 'load', timeout: 300000 });
  await seen(page.getByText('This link is for @nosuchcompany'));
  await shot(page, 'company-path-not-yours-1440-light');
  await c.close();
  assert.deepEqual(errors.filter((e) => !/ResizeObserver|hydrat/i.test(e)), [], 'no script errors');
  console.log(`fix-shell browser: ${checks} checks passed`);
} catch (e) {
  console.error(`step ${current}: ${e?.stack ?? e}\n--- next dev tail:\n${serverTail.slice(-800)}`); process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await browser?.close().catch(() => {});
  stopServer();
  await app.close().catch(() => {});
  await pool.end().catch(() => {});
}
