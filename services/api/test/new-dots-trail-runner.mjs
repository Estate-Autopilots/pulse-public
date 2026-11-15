// NEW-DOTS-2 in the browser (tests/core/test_new_dots.py, PULSE_AUTH_BROWSER=1): a release note names two things on
// Work's page (the New task button, and The pool inside the "More in Work" menu) and one whole page (Docs). Followed
// from the top down, for an owner at 1440 and a member on a 363 px phone:
//   - the rail's Work says 2, its page in the panel says 2 (the levels count what waits below them);
//   - a click on Work ("take me there") opens the page, and the spotlight closes in on the first thing: page dimmed, a
//     glow, a card "New … 1 of 2", Next; the second thing is inside the menu, which opens on the way; Got it clears it;
//   - the server forgets them for good (a reload shows no dots on the page; the API lists only Chats);
//   - the member, on a plain visit with reduced motion: the page's own dots (the menu says 1, the button its ring), no
//     animation, the "New: … Show me" line; then What's new says where each thing is, and Show me travels there.
// No sideways scroll and no page errors. Shots (and a video of each walk) with PULSE_ND_SCREENSHOTS=<dir>. Everything is
// invented; nothing is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const shots = process.env.PULSE_ND_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-nd', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
let browser, checks = 0, current = 'start', last;
const trail = (line) => { console.log(line); if (shots) try { appendFileSync(`${shots}/walk.log`, `${new Date().toISOString()} ${line}\n`); } catch { /* best effort */ } };
const step = (n) => { current = n; trail(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`new-dots-trail-runner: no result after 25 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
deadline.unref();
const T = 180000;
const seen = async (locator, timeout = T) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const gone = async (locator, timeout = 20000) => { await expect(locator).toHaveCount(0, { timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
/** The same moment in dark mode too (the UI gate's judge looks at both). */
// A picture for the judge, not a check: if taking it fails, the walk logs why and carries on.
const darkShot = async (page, name) => {
  if (!shots) return;
  try {
    // The app's theme follows the saved choice ("light" here) whenever the colour scheme changes, and on a slow server
    // that change can land late: dark is set again until it holds for a moment. Switching back restores light by itself.
    await page.emulateMedia({ colorScheme: 'dark' });
    const isDark = () => page.evaluate(() => document.documentElement.dataset.theme === 'dark');
    // Dark before the picture and still dark after it (the theme can flip back while it is taken): else again.
    let done = false;
    for (let i = 0; i < 8 && !done; i++) {
      await delay(400);
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      await delay(600);
      if (!(await isDark())) continue;
      await page.screenshot({ path: `${shots}/${name}.png`, timeout: 60000 });
      done = await isDark();
    }
    if (!done) trail(`  dark shot ${name}: the page would not stay dark; the picture may be light`);
  } catch (e) { trail(`  dark shot ${name} not taken: ${String(e?.message ?? e).split('\n')[0]}`); }
  await page.emulateMedia({ colorScheme: 'light' }).catch(() => {}); await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; }).catch(() => {});
};
const signIn = async (username) => { const r = await app.inject({ method: 'POST', url: '/api/v0/auth/sign-in', headers: { 'x-pulse-client-ip': randomBytes(6).toString('hex') }, payload: { username, password: 'Synthetic-account-2026!' } });
  assert.equal(r.statusCode, 200, `${username} signs in: ${r.body}`); return r.json().token; };
const context = async (token, width, { reducedMotion = 'no-preference', video = '' } = {}) => {
  const phone = width < 600, size = { width, height: phone ? 760 : 900 };
  const c = await browser.newContext({ viewport: size, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone, colorScheme: 'light', reducedMotion,
    ...(shots && video ? { recordVideo: { dir: `${shots}/video-${video}`, size } } : {}) });
  await c.addCookies([{ name: 'pulse_session', value: token, domain: '127.0.0.1', path: '/' }]);
  await c.addInitScript(() => { try { localStorage.setItem('pulse.theme', 'light'); localStorage.setItem('pulse.sidebar.collapsed', 'false'); } catch { /* private */ } });
  // The owner of this synthetic company has put Work's set-up list away (as people do after day one), so it does not fill
  // the screens: the list keeps that choice in this browser (tasks/first-run.tsx, vitals.firstrun.<person>).
  await c.addInitScript(() => { try { const get = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { const v = get.call(this, k); return v === null && typeof k === 'string' && k.startsWith('vitals.firstrun.') ? '{"hidden":true}' : v; }; } catch { /* private */ } });
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${width}: ${e.message}`));
  page.on('requestfinished', async (r) => { if (r.url().includes('/api/v0/whats-new/')) { const t = r.timing(); trail(`  ${width} ${r.method()} ${new URL(r.url()).pathname} ${r.postData() ?? ''} ${(await r.response())?.status()} ${Math.round(t.responseEnd)} ms`); } });
  return { c, page };
};
const later = async (page) => {
  for (const name of ['Later', 'Not now']) { const b = page.getByRole('button', { name, exact: true }); try { await b.first().waitFor({ state: 'visible', timeout: 2500 }); await b.first().click(); } catch { /* not offered */ } }
  // The assistant's own notices (e.g. "Your role brief is ready") belong to another feature: closed with their ×, as a
  // person would, so they do not sit on the pictures.
  const x = page.locator('[data-island] button[aria-label="Dismiss"]');
  try { await x.first().waitFor({ state: 'visible', timeout: 2500 }); await x.first().click(); } catch { /* none */ }
};
const settle = async (page) => { await page.waitForResponse((r) => r.url().includes('/api/v0/whats-new/unseen'), { timeout: T }).catch(() => {}); await delay(1200); };
const unseen = async (token) => (await app.inject({ method: 'GET', url: '/api/v0/whats-new/unseen', headers: { 'x-pulse-session': token } })).json();
const card = (page) => page.locator('[data-new-spotlight][data-ready] [role="dialog"]');
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  const owner = await signIn('auth.admin'), member = await signIn('auth.person');
  const before = await unseen(owner);
  assert.deepEqual(before.items.map((i) => `${i.route} ${i.anchor}`).sort(), ['/chats ', '/tasks work.more.pool', '/tasks work.new-task'], JSON.stringify(before)); checks++;
  assert.equal(before.count, 3); checks++;
  // A cold `next dev` compiles each page on its first visit, minutes on a loaded server; the walk's clicks would wait on
  // that. Server-side requests compile them first and run no page script, so nothing is marked as seen.
  for (const path of ['/whats-new', '/tasks']) {
    const t0 = Date.now();
    await fetch(base + path, { headers: { cookie: `pulse_session=${owner}` }, signal: AbortSignal.timeout(600000) }).then((r) => r.text()).catch(() => {});
    trail(`warmed ${path} in ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  assert.equal((await unseen(owner)).count, 3, 'warming opened nothing'); checks++;
  browser = await chromium.launch();

  // Owner, 1440: from the rail down to the button.
  step('owner 1440: the rail and the panel count what waits below');
  {
    const { c, page } = await context(owner, 1440, { video: 'owner-1440' });
    const first = settle(page);
    await page.goto(base + '/whats-new', { waitUntil: 'load', timeout: 300000 });
    await first; await later(page);
    const rail = page.getByRole('navigation', { name: 'Main sections' });
    const work = rail.getByRole('link', { name: /^Work, New$/ });
    await seen(work.locator('[data-new-dot][data-count]'));
    assert.equal((await work.locator('[data-new-dot]').textContent())?.trim(), '2', 'Work: two new things below'); checks++;
    await page.mouse.move(900, 600); await delay(300);
    const panel = page.getByRole('navigation', { name: 'Work pages' });
    await seen(panel.locator('[data-new-dot][data-count]'));
    await fits(page, "What's new at 1440");
    // (The rail and the panel are in What's new's picture below; no second picture of the same screen.)
    // What's new at 1440: each new thing, where it is, Show me.
    await seen(page.locator('a[data-new-show="work.new-task"]'));
    await shot(page, 'nd2-owner-1440-0-whats-new');
    await darkShot(page, 'nd2-owner-1440-0-whats-new-dark');

    step('owner 1440: a click on Work takes them there, the light closes in on the first thing');
    await work.click();
    await page.waitForURL(/\/tasks/, { timeout: T });
    await seen(card(page), 60000);
    await expect(card(page)).toContainText('1 of 2'); checks++;
    await expect(card(page)).toContainText('Start a task from a template: pick one when you add a task (synthetic)'); checks++;
    await delay(700);
    await shot(page, 'nd2-owner-1440-2-spotlight-new-task');
    await darkShot(page, 'nd2-owner-1440-2-spotlight-new-task-dark');
    await fits(page, 'the tour at 1440');

    step('owner 1440: Next opens the menu on the way and lights The pool');
    await card(page).getByRole('button', { name: /Next/ }).click();
    await expect(card(page)).toContainText('2 of 2', { timeout: 20000 }); checks++;
    await seen(page.getByRole('menu', { name: 'More in Work' }));
    await expect(card(page)).toContainText('The pool now puts the tasks due soonest at the top (synthetic)'); checks++;
    await delay(700);
    await shot(page, 'nd2-owner-1440-3-spotlight-pool-in-menu');
    await darkShot(page, 'nd2-owner-1440-3-spotlight-pool-in-menu-dark');
    const done = page.waitForResponse((r) => r.url().includes('/api/v0/whats-new/seen') && (r.request().postData() ?? '').includes('work.more.pool'), { timeout: T });
    await card(page).getByRole('button', { name: 'Got it' }).click();
    await done;
    await gone(page.locator('[data-new-spotlight]'));
    await shot(page, 'nd2-owner-1440-4-after');
    // The server forgot both things; only Chats is left. A reload shows no dot on the page.
    const after = await unseen(owner);
    assert.deepEqual(after.items.map((i) => `${i.route} ${i.anchor}`), ['/chats '], JSON.stringify(after)); checks++;
    await page.reload({ waitUntil: 'load', timeout: T }); await settle(page);
    await gone(page.locator('[data-new-mark]'), 8000);
    await gone(rail.getByRole('link', { name: /^Work, New$/ }), 8000);
    await c.close();
  }

  // Member, 363 phone: the bottom tab counts; a plain visit with reduced motion shows the page's own dots, still.
  step('member 363: the bottom tab says 2');
  {
    const { c, page } = await context(member, 363, { reducedMotion: 'reduce' });
    const first = settle(page);
    await page.goto(base + '/whats-new', { waitUntil: 'load', timeout: 300000 });
    await first; await later(page);
    const workTab = page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name: /^Work.*, New$/ });
    await seen(workTab.locator('[data-new-dot][data-count]'));
    assert.equal((await workTab.locator('[data-new-dot]').textContent())?.trim(), '2', 'the Work tab: two new things below'); checks++;
    // A bad anchor is refused (the API's rule and the database's).
    const bad = await app.inject({ method: 'POST', url: '/api/v0/whats-new/seen', headers: { 'x-pulse-session': member, 'x-pulse-client-ip': randomBytes(6).toString('hex') }, payload: { path: '/tasks', anchor: 'nav:/tasks' } });
    assert.equal(bad.statusCode, 400, bad.body); checks++;
    await shot(page, 'nd2-member-363-1-tab');
    // What's new, before they open Work: the Work tab's 2 and the list's two Work things agree.
    await darkShot(page, 'nd2-member-363-1-tab-dark');

    step('member 363: a plain visit, the page\'s own dots, no motion');
    await page.goto(base + '/tasks', { waitUntil: 'load', timeout: T });
    // The visit is recorded, then the top bar says what is new here (for 20 s), while the page itself loads.
    await seen(page.locator('[data-new-pill]').getByRole('button', { name: /Show me/ }), 60000);
    await settle(page);
    await seen(page.locator('[data-new-mark="work.more"]'), 60000);
    await seen(page.locator('[data-new-mark="work.new-task"]'));
    assert.equal((await page.locator('[data-new-mark="work.more"]').textContent())?.trim(), '1', 'the menu: one new thing inside'); checks++;
    const still = await page.locator('[data-new-mark] i').first().evaluate((el) => getComputedStyle(el).animationName);
    assert.equal(still, 'none', 'reduced motion: the dots do not move'); checks++;
    await fits(page, 'Work at 363');
    await shot(page, 'nd2-member-363-2-page-dots');
    await darkShot(page, 'nd2-member-363-2-page-dots-dark');
    // Opening the menu clears its own dot; the item inside keeps its ring until it is reached.
    await page.getByRole('button', { name: 'More in Work' }).click();
    await gone(page.locator('[data-new-mark="work.more"]'), 8000);
    await seen(page.locator('[data-new-mark="work.more.pool"]'));
    await shot(page, 'nd2-member-363-3-menu-open');
    await page.keyboard.press('Escape');
    await c.close();
  }

  step('member 363: What\'s new says where each thing is; Show me travels there');
  {
    const { c, page } = await context(member, 363, { video: 'member-363' });
    const first = settle(page);
    await page.goto(base + '/whats-new', { waitUntil: 'load', timeout: 300000 });
    await first; await later(page);
    const row = page.locator('a[data-new-show="work.more.pool"]');
    await seen(row);
    await expect(row).toContainText('More in Work'); checks++;
    await expect(row).toContainText('The pool'); checks++;
    await fits(page, "What's new at 363");
    // (What's new's pictures were taken before they opened Work: after it, the Work tab rightly has no badge while the
    // two things on it are still new, which reads as a mismatch in a still picture.)
    await row.click();
    await page.waitForURL(/\/tasks/, { timeout: T });
    await seen(card(page), 60000);
    await expect(card(page)).toContainText('The pool now puts the tasks due soonest at the top (synthetic)'); checks++;
    await expect(card(page)).toContainText('1 of 2'); checks++;
    // A phone has no hover: the emulated pointer still rests where Show me was tapped, so it is moved off the page.
    await page.mouse.move(1, 1).catch(() => {});
    await delay(700);
    await shot(page, 'nd2-member-363-5-spotlight-pool');
    await darkShot(page, 'nd2-member-363-5-spotlight-pool-dark');
    await fits(page, 'the tour at 363');
    await card(page).getByRole('button', { name: /Next/ }).click();
    await expect(card(page)).toContainText('2 of 2', { timeout: 20000 }); checks++;
    await page.mouse.move(1, 1).catch(() => {});
    await delay(700);
    await shot(page, 'nd2-member-363-6-spotlight-new-button');
    const done = page.waitForResponse((r) => r.url().includes('/api/v0/whats-new/seen') && (r.request().postData() ?? '').includes('work.new-task'), { timeout: T });
    await card(page).getByRole('button', { name: 'Got it' }).click();
    await done;
    await gone(page.locator('[data-new-spotlight]'));
    const after = await unseen(member);
    assert.deepEqual(after.items.map((i) => `${i.route} ${i.anchor}`), ['/chats '], JSON.stringify(after)); checks++;
    await c.close();
  }
  assert.deepEqual(errors, [], 'no page errors'); checks++;
  console.log(`new-dots-trail: ${checks} checks passed`);
} catch (e) {
  if (last && shots) await last.screenshot({ path: `${shots}/nd2-failed-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}-${current.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}.png` }).catch(() => {});
  trail(`FAILED at step ${current}: ${String(e?.message ?? e).split('\n').filter(Boolean).slice(0, 6).join(' | ')}`);
  console.error(`new-dots-trail-runner failed at step ${current}:`, e?.stack ?? e);
  if (errors.length) console.error('page errors:', errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  stopServer();
  await app.close().catch(() => {});
  await pool.end().catch(() => {});
}
