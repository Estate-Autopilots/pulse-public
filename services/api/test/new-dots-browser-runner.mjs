// NEW-DOTS in the browser (tests/core/test_new_dots.py, PULSE_AUTH_BROWSER=1): the red "new" dots for an owner at 1440 and
// a member on a 363 px phone. Before: dots on the rail section, its page and sub-page, Settings, the phone tab and More,
// the avatar and the What's new count. Opening a changed page: the one-line "New: …" pill, the dots shrink away, the
// pill closes with ×, and a second visit shows no pill. /whats-new lists what is still new, then Mark all as seen
// empties it. Settings → Notifications turns the dots off. Reduced motion: no animation. No sideways scroll, no page
// errors. Screenshots with PULSE_ND_SCREENSHOTS=<dir>. Everything is invented; nothing is sent.
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
const deadline = setTimeout(() => { console.error(`new-dots-browser-runner: no result after 25 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
deadline.unref();
const T = 180000;
const seen = async (locator, timeout = T) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const gone = async (locator, timeout = 20000) => { await expect(locator).toHaveCount(0, { timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const signIn = async (username) => { const r = await app.inject({ method: 'POST', url: '/api/v0/auth/sign-in', headers: { 'x-pulse-client-ip': randomBytes(6).toString('hex') }, payload: { username, password: 'Synthetic-account-2026!' } });
  assert.equal(r.statusCode, 200, `${username} signs in: ${r.body}`); return r.json().token; };
const context = async (token, width, reducedMotion = 'no-preference') => {
  const phone = width < 600;
  const c = await browser.newContext({ viewport: { width, height: phone ? 760 : 900 }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone, colorScheme: 'light', reducedMotion });
  await c.addCookies([{ name: 'pulse_session', value: token, domain: '127.0.0.1', path: '/' }]);
  // The release note's own corner note and the first-run cards stay out of the pictures.
  await c.addInitScript(() => { try { localStorage.setItem('pulse.theme', 'light'); localStorage.setItem('pulse.sidebar.collapsed', 'false'); } catch { /* private */ } });
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${width}: ${e.message}`));
  // Every NEW-DOTS request and how long it took, for the walk's log.
  page.on('requestfinished', async (r) => { if (r.url().includes('/api/v0/whats-new/')) { const t = r.timing(); trail(`  ${width} ${r.method()} ${new URL(r.url()).pathname} ${(await r.response())?.status()} ${Math.round(t.responseEnd)} ms`); } });
  page.on('requestfailed', (r) => { if (r.url().includes('/api/v0/whats-new/')) trail(`  ${width} FAILED ${r.method()} ${r.url()} ${r.failure()?.errorText}`); });
  return { c, page };
};
const later = async (page) => { for (const name of ['Later', 'Not now', 'Got it']) { const b = page.getByRole('button', { name, exact: true }); try { await b.first().waitFor({ state: 'visible', timeout: 2500 }); await b.first().click(); } catch { /* not offered */ } } };
const dotsIn = (locator) => locator.locator('[data-new-dot]:not([data-leaving])');
const settle = async (page) => { await page.waitForResponse((r) => r.url().includes('/api/v0/whats-new/unseen'), { timeout: T }).catch(() => {}); await delay(1200); };
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  const owner = await signIn('auth.admin'), member = await signIn('auth.person');
  browser = await chromium.launch();

  // Owner, desktop 1440.
  step('owner 1440 before');
  {
    const { c, page } = await context(owner, 1440);
    const first = settle(page);
    await page.goto(base + '/dashboard', { waitUntil: 'load', timeout: 300000 });
    await first; await later(page);
    const rail = page.getByRole('navigation', { name: 'Main sections' });
    // IA-NAV: Agreements (Contracts) sits in Sales & clients.
    await seen(rail.getByRole('link', { name: /^Sales & clients, New$/ }));
    await seen(rail.getByRole('link', { name: /^Work, New$/ }));
    await seen(page.getByRole('link', { name: /^Settings, New$/ }));
    await seen(dotsIn(rail.getByRole('link', { name: /^Sales & clients, New$/ })));
    await fits(page, 'the dashboard at 1440');
    await shot(page, 'nd-owner-1440-1-before');
    // The account menu: a dot on the avatar, the count on What's new.
    await page.getByRole('button', { name: /Open account menu, New/ }).click();
    const item = page.getByRole('menuitem', { name: /What's new/ });
    await seen(item.locator('[data-new-dot][data-count]'));
    assert.equal((await item.locator('[data-new-dot]').textContent())?.trim(), '4', 'four changed places: Contracts, Settings, Work, Docs'); checks++;
    await shot(page, 'nd-owner-1440-2-menu');
    await page.keyboard.press('Escape');
    // The sidebar's Sales & clients group (folded, with its dot): opened, Agreements carries the dot.
    await page.getByRole('button', { name: /^Sales & clients, New$/ }).click();
    const panel = page.getByRole('navigation', { name: 'Sales & clients pages' });
    await seen(dotsIn(panel.getByRole('link', { name: /Agreements/ })));
    await shot(page, 'nd-owner-1440-3-panel');

    // Opening the changed page: the pill once, the dots shrink away.
    step('owner 1440 opens Contracts');
    const cleared = page.waitForResponse((r) => r.url().includes('/api/v0/whats-new/seen') && r.request().method() === 'POST', { timeout: T });
    await page.goto(base + '/contracts', { waitUntil: 'load', timeout: 300000 });
    await cleared;
    const pill = page.locator('[data-new-pill]');
    await seen(pill.getByText('Synthetic: contracts list'));
    await seen(pill.getByText('New:'));
    await gone(dotsIn(rail.getByRole('link', { name: /^Sales & clients/ })));
    await seen(rail.getByRole('link', { name: /^Sales & clients$/ }));
    await fits(page, 'Contracts with the pill at 1440');
    await shot(page, 'nd-owner-1440-4-after-pill');
    await pill.getByRole('button', { name: 'Dismiss' }).click();
    await gone(page.locator('[data-new-pill]'), 5000);
    await shot(page, 'nd-owner-1440-5-after');
    // A second visit: nothing comes back.
    await page.goto(base + '/dashboard', { waitUntil: 'load', timeout: 300000 });
    await settle(page);
    await page.goto(base + '/contracts', { waitUntil: 'load', timeout: 300000 });
    await delay(2500);
    assert.equal(await page.locator('[data-new-pill]').count(), 0, 'the pill shows on the first visit only'); checks++;

    // What's new: what is still new, then Mark all as seen.
    step("owner 1440 What's new");
    await page.goto(base + '/whats-new', { waitUntil: 'load', timeout: 300000 });
    await later(page);
    const list = page.getByRole('region', { name: /new things? for you/ });
    await seen(list.getByRole('link', { name: /Synthetic: tasks load faster/ }));
    await seen(list.getByRole('link', { name: /Synthetic: settings tidy/ }));
    await seen(dotsIn(rail.getByRole('link', { name: /^Work, New$/ })));
    await seen(page.getByRole('link', { name: /^Settings, New$/ }));
    assert.equal(await list.getByText('Synthetic: contracts list').count(), 0, 'Contracts was seen: no longer listed'); checks++;
    await fits(page, "What's new at 1440");
    await shot(page, 'nd-owner-1440-6-whats-new-before');
    await list.getByRole('button', { name: 'Mark all as seen' }).click();
    await gone(page.getByRole('region', { name: /new things? for you/ }), 30000);
    await gone(dotsIn(rail), 10000);
    await shot(page, 'nd-owner-1440-7-whats-new-after');
    await c.close();
  }

  // Member, phone 363.
  step('member 363 before');
  {
    const { c, page } = await context(member, 363);
    const first = settle(page);
    await page.goto(base + '/dashboard', { waitUntil: 'load', timeout: 300000 });
    await first; await later(page);
    const tabs = page.getByRole('navigation', { name: 'Mobile navigation' });
    await seen(tabs.getByRole('link', { name: /Work.*, New$/ }));
    await seen(dotsIn(tabs));
    assert.equal(await page.getByText('Synthetic: contracts list').count(), 0, 'a member never hears of Contracts'); checks++;
    await fits(page, 'the dashboard at 363');
    await shot(page, 'nd-member-363-1-before');
    // The avatar's dot and the count in the account menu.
    await page.getByRole('button', { name: /Open account menu, New/ }).click();
    const item = page.getByRole('menuitem', { name: /What's new/ });
    assert.equal((await item.locator('[data-new-dot]').textContent())?.trim(), '2', 'two places for a member: Work and Docs'); checks++;
    await shot(page, 'nd-member-363-2-menu');
    await page.keyboard.press('Escape');

    step('member 363 opens Work');
    const cleared = page.waitForResponse((r) => r.url().includes('/api/v0/whats-new/seen') && r.request().method() === 'POST', { timeout: T });
    await tabs.getByRole('link', { name: /Work/ }).click();
    await cleared;
    const pill = page.locator('[data-new-pill]');
    await seen(pill.getByText('Synthetic: tasks load faster'));
    await gone(dotsIn(tabs.getByRole('link', { name: /Work/ })));
    await fits(page, 'Work with the pill at 363');
    await shot(page, 'nd-member-363-3-after-pill');

    // Settings → Notifications: the person's own switch.
    step('member 363 turns dots off');
    await page.goto(base + '/settings?tab=notifications', { waitUntil: 'load', timeout: 300000 });
    await later(page);
    const sw = page.getByRole('switch', { name: /Red dots on what's new/ });
    await seen(sw);
    await expect(sw).toBeChecked(); checks++;
    await seen(dotsIn(page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: /More, New/ })));
    await sw.scrollIntoViewIfNeeded();
    await shot(page, 'nd-member-363-4-setting-on');
    await sw.click();
    await seen(page.getByText('Red dots are off.'));
    await gone(dotsIn(page.locator('body')), 10000);
    await shot(page, 'nd-member-363-5-setting-off');
    await page.goto(base + '/whats-new', { waitUntil: 'load', timeout: 300000 });
    await seen(page.getByText('Red dots are off for you.'));
    await fits(page, "What's new at 363");
    await shot(page, 'nd-member-363-6-whats-new-off');
    await page.goto(base + '/settings?tab=notifications', { waitUntil: 'load', timeout: 300000 });
    await page.getByRole('switch', { name: /Red dots on what's new/ }).click();
    await seen(page.getByText('Red dots are on.'));
    await c.close();
  }

  // Reduced motion: the dot is drawn, still, with no animation.
  step('reduced motion');
  {
    const { c, page } = await context(member, 1440, 'reduce');
    await page.goto(base + '/dashboard', { waitUntil: 'load', timeout: 300000 });
    await settle(page); await later(page);
    const dot = dotsIn(page.getByRole('navigation', { name: 'Main sections' })).first();
    await seen(dot);
    assert.equal(await dot.evaluate((el) => getComputedStyle(el).animationName), 'none', 'no pulse with reduced motion'); checks++;
    await c.close();
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`new-dots-browser-runner: ${checks} checks passed`);
} catch (e) {
  if (last && shots) { try { await last.screenshot({ path: `${shots}/failure.png`, fullPage: true }); } catch { /* closed */ } }
  trail(`FAILED at step ${current}: ${e?.stack ?? e}`);
  console.error(`step ${current}: ${e?.stack ?? e}\n--- next dev tail:\n${serverTail.slice(-800)}`); process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch { /* closed */ }
  stopServer(); await app.close(); await pool.end();
}
process.exit(process.exitCode ?? 0);
