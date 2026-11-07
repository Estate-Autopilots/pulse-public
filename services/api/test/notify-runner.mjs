// UX-NOTIFY screens through the real API and the built web app, on a disposable synthetic tenant
// (tests/core/test_notify.py::test_notify_in_the_browser): Pip's island announces an arrival in the top bar, its
// action opens the bell's panel on that card, the card's own buttons answer it, the menu and the summary work, and
// nothing floats in a corner. Optional evidence: PULSE_NOTIFY_SCREENSHOTS=<dir> (screenshots and short videos).
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { spawn } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool); let apiChecks = 0, browserChecks = 0;
const E = JSON.parse(process.env.TEST_IDS);
const emails = { member: process.env.TEST_MEMBER, head: process.env.TEST_HEAD };
const shots = process.env.PULSE_NOTIFY_SCREENSHOTS;
const call = async (path, body, role = 'member', expected = 200) => {
  apiChecks++; const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': emails[role] }, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `${role} ${path}: ${r.body}`); return r.json();
};
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'production' }, stdio: 'ignore' });
let browser;
const check = (condition, msg) => { browserChecks++; assert.ok(condition, msg); };
const ready = async (page) => { await page.waitForFunction(() => document.querySelector('main h2,main h3') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 60000 }); await page.waitForTimeout(400); };
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load' }); await ready(page); };
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
let round = 0;
try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await delay(250); if (i === 159) throw Error('Notify browser web did not start'); }
  browser = await chromium.launch({ headless: true });
  if (shots) await mkdir(`${shots}/videos`, { recursive: true });
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    const tag = `${width}-${theme}`, phone = width < 900, size = { width, height: phone ? 844 : 900 };
    const context = await browser.newContext({ viewport: size, colorScheme: theme, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails.member }, ...(shots ? { recordVideo: { dir: `${shots}/videos`, size } } : {}) });
    await context.addInitScript((t) => { localStorage.setItem('pulse.theme', t); }, theme);
    // EST-1763: what reached the island and what it showed, with times (ms since load), for the DIAG line below.
    await context.addInitScript(() => {
      const log = window.__island = [], at = () => Math.round(performance.now());
      window.addEventListener('pulse:arrival', (e) => log.push(`${at()} arrival ${e.detail?.title}`));
      let last = ''; new MutationObserver(() => { const i = document.querySelector('[data-island]'); const s = i ? `${i.hasAttribute('data-open') ? 'open' : 'rest'} ${i.textContent.slice(0, 80)}` : '';
        if (s !== last) { last = s; log.push(`${at()} ${s}`); } }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    // The page's first update poll announces what arrived just before it (a folded "N new updates" line), and on a
    // working day after the brief time "Your role brief is ready" too. The ask below is created once the island has
    // closed, which may be only the pause between two of them: it must still open on its own line (EST-1763).
    const firstPoll = page.waitForResponse((r) => r.url().includes('/api/v0/companion/updates'), { timeout: 60000 });
    await go(page, '/tasks');
    await page.mouse.move(size.width / 2, size.height - 40);
    await firstPoll;
    const bar = page.locator('header').first();
    await page.waitForTimeout(1500);
    await expect(page.locator('[data-island][data-open]')).toHaveCount(0, { timeout: 40000 });
    // Pip floats free by default (owner, 20 Oct 2026): on the page, whole on the screen, below the top bar and above a
    // phone's tab bar.
    const pip = page.locator('[data-island][data-home="free"]').getByRole('button', { name: /^Pip/ });
    await expect(pip).toBeVisible(); browserChecks++;
    // No corner companion or corner toasts anywhere.
    check(await page.getByRole('button', { name: /Open the Pulse companion/ }).count() === 0, 'no corner companion');
    check(await page.locator('[class*="corner"]').count() === 0, 'no corner region');
    const head = await bar.boundingBox(), rest = await pip.boundingBox();
    const tabs = phone ? await page.getByRole('navigation', { name: 'Mobile navigation' }).boundingBox() : null;
    check(rest.y >= head.y + head.height - 1 && rest.y + rest.height <= (tabs ? tabs.y : size.height) + 1 && rest.x >= 0 && rest.x + rest.width <= size.width + 1,
      `${tag}: Pip rests on the page, clear of the top bar${phone ? ' and the tab bar' : ''}`);
    // At rest it covers no other control in the top bar or the page header.
    const controls = await page.evaluate(() => [...document.querySelectorAll('header a, header button, header input, main [data-page-header] a, main [data-page-header] button')]
      .filter((el) => !el.closest('[class*="island"]') && el.getClientRects().length).map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, label: el.getAttribute('aria-label') ?? el.textContent }; }));
    const covered = controls.filter((c) => c.width && overlaps(c, rest));
    check(covered.length === 0, `${tag}: resting island covers ${JSON.stringify(covered)}`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${tag}: no sideways scroll`);
    await shot(page, `${tag}-01-rest`);

    // A pod head asks the member to take a task: the island springs open with the avatar, one line and "Review".
    const task = await call('tasks', { title: `Grade the Sunrise teaser · take ${++round}`, assigneeId: E.head }, 'head');
    await call('work/asks', { kind: 'take', taskId: task.id, toId: E.member, note: 'Can you take this today?' }, 'head');
    await page.mouse.move(size.width / 2, size.height - 40);
    const island = page.locator('[data-island]');
    const review = island.getByRole('button', { name: 'Review' });
    try { await expect(review).toBeVisible({ timeout: 20000 }); browserChecks++; } catch (e) {
      if (shots) await page.screenshot({ path: `${shots}/${tag}-FAILED-arrival.png` });
      console.error('DIAG', JSON.stringify(await page.evaluate(async () => ({
        island: document.querySelector('[data-island]')?.outerHTML.slice(0, 900), expanded: [...document.querySelectorAll('header [aria-expanded="true"]')].map((x) => x.outerHTML.slice(0, 160)),
        notices: await fetch('/api/v0/notices').then((r) => r.json()).then((d) => d.rows?.slice(0, 4).map((n) => `${n.group}:${n.eventType}:${n.title}`) ?? d),
        updates: await fetch('/api/v0/companion/updates').then((r) => r.json()).then((d) => ({ total: d.counts?.total, rows: d.rows?.map((r) => `${r.kind}:${r.pingAllowed}:${r.title}`) })),
        history: window.__island?.slice(-40),
      }))));
      throw e;
    }
    await expect(island).toContainText(`take ${round}`); browserChecks++;
    await page.waitForTimeout(700);
    // Its bubble opens beside Pip, whole on the screen and below the top bar.
    const openBox = await island.evaluate((el) => { const rs = [...el.querySelectorAll('*')].map((n) => n.getBoundingClientRect()).filter((r) => r.width && r.height);
      return { x: Math.min(...rs.map((r) => r.left)), y: Math.min(...rs.map((r) => r.top)), right: Math.max(...rs.map((r) => r.right)), bottom: Math.max(...rs.map((r) => r.bottom)) }; });
    check(openBox.y >= head.y + head.height - 1 && openBox.bottom <= size.height + 1 && openBox.x >= 0 && openBox.right <= size.width + 1, `${tag}: the open island stays on the screen, below the top bar`);
    await shot(page, `${tag}-02-island-arrival`);
    // Review opens the panel on that card; Take it answers the ask from there.
    await review.click();
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    await expect(panel).toBeVisible(); browserChecks++;
    // ATT: same-day asks fold into a stack ("2 tasks for you"); Review opens the stack on this card.
    const card = panel.locator('li[data-card]').filter({ hasText: `take ${round}` });
    await expect(card.getByRole('button', { name: 'Take it' })).toBeVisible(); browserChecks++;
    await expect(panel.getByRole('heading', { name: 'Needs your action' })).toBeVisible(); browserChecks++;
    if (phone) { const p = await panel.boundingBox(); check(p.width >= width - 1 && p.height >= size.height - 2, `${tag}: full-screen sheet`); }
    await page.waitForTimeout(500);
    await shot(page, `${tag}-03-panel`);
    await card.getByRole('button', { name: 'Take it' }).click();
    await expect(card).toContainText('It’s yours', { timeout: 20000 }); browserChecks++;
    const asks = await call('work/asks', undefined, 'member');
    check(asks.recent.some((a) => a.taskId === task.id && a.status === 'accepted'), `${tag}: the ask was accepted`);
    await shot(page, `${tag}-04-panel-answered`);
    // Filters and keyboard: Unread, then the arrow keys between cards, Escape back to the bell.
    await panel.getByRole('button', { name: /^Unread/ }).click();
    await expect(panel.getByRole('button', { name: /^Unread/ })).toHaveAttribute('aria-pressed', 'true'); browserChecks++;
    await panel.getByRole('button', { name: 'All', exact: true }).click();
    await panel.getByRole('button', { name: 'All', exact: true }).press('ArrowDown');
    check(await page.evaluate(() => document.activeElement?.hasAttribute('data-card')), `${tag}: arrow keys reach the cards`);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0); browserChecks++;
    check(await page.evaluate(() => /^Notifications/.test(document.activeElement?.getAttribute('aria-label') ?? '')), `${tag}: focus returns to the bell`);
    // Pip's menu: Notifications, New task, New project, Ask Pip, Do not disturb.
    // Hold the arrival queue while using Pip, then dismiss any active arrival covering its button.
    // Hovering the covered button directly would keep that arrival's countdown paused.
    await island.hover();
    if (await island.getAttribute('data-open') !== null) await island.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(island).not.toHaveAttribute('data-open', ''); browserChecks++;
    if (!phone) { await pip.hover(); await expect(page.getByRole('tooltip')).toContainText('unread'); browserChecks++; await page.waitForTimeout(400); await shot(page, `${tag}-05-summary`); }
    await pip.click();
    const menu = page.getByRole('menu', { name: 'Pip' });
    await expect(menu).toBeVisible(); browserChecks++;
    for (const item of ['Notifications', 'New task', 'New project', 'Ask Pip']) { await expect(menu.getByRole('menuitem', { name: new RegExp(`^${item}`) })).toBeVisible(); browserChecks++; }
    await expect(menu.getByRole('menuitemcheckbox', { name: /Do not disturb/ })).toHaveAttribute('aria-checked', 'false'); browserChecks++;
    await page.waitForTimeout(400);
    await shot(page, `${tag}-06-menu`);
    await menu.getByRole('menuitem', { name: /^New task/ }).click();
    await expect(page.getByRole('dialog', { name: 'New task' })).toBeVisible(); browserChecks++;
    await page.keyboard.press('Escape');
    // Mark all read from the panel: the bell's count goes.
    await page.getByRole('button', { name: /^Notifications/ }).click();
    // (Disabled when an earlier combination already read everything.)
    const markAll = panel.getByRole('button', { name: 'Mark all read' });
    await expect(markAll).toBeVisible(); browserChecks++;
    if (await markAll.isEnabled()) await markAll.click();
    await expect(panel).toContainText('All read', { timeout: 20000 }); browserChecks++;
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible({ timeout: 15000 }); browserChecks++;
    // The brand sheet: the three directions, the mark, Pip's states and the app icons.
    await go(page, '/brand');
    // The mark in use is Ripple since the owner chose it on 20 Oct 2026 (packages/design-system/src/brand.js LIVE).
    await expect(page.getByRole('article', { name: 'Ripple, chosen' })).toBeVisible(); browserChecks++;
    check(await page.locator('svg.pip').count() >= 12, `${tag}: Pip's states on the brand sheet`);
    if (shots) for (const [n, id] of [['08-brand-directions', 'brand-directions'], ['09-brand-mark', 'brand-mark'], ['10-brand-pip', 'brand-pip'], ['11-brand-icons', 'brand-icons']]) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded(); await page.evaluate((h) => document.getElementById(h)?.scrollIntoView({ block: 'start' }), id); await page.waitForTimeout(500); await shot(page, `${tag}-${n}`);
    }
    check(errors.length === 0, `${tag}: page errors ${errors.join(' | ')}`);
    const video = page.video();
    await context.close();
    if (video && shots) await rename(await video.path(), `${shots}/videos/${tag}-island-and-panel.webm`);
  }
  // The pod head approves the member's leave from the panel (once: the first combination took the arrival).
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails.head } });
  const page = await ctx.newPage(); await go(page, '/tasks');
  await page.getByRole('button', { name: /^Notifications/ }).click();
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  const leave = panel.getByRole('listitem').filter({ hasText: 'asks for leave' });
  await expect(leave.getByRole('button', { name: 'Approve' })).toBeVisible(); browserChecks++;
  await leave.getByRole('button', { name: 'Reject' }).click();
  await expect(leave.getByRole('textbox', { name: /Reason/ })).toBeVisible(); browserChecks++;
  await leave.getByRole('button', { name: 'Cancel' }).click();
  await leave.getByRole('button', { name: 'Approve' }).click();
  await expect(leave).toContainText('Approved', { timeout: 20000 }); browserChecks++;
  if (shots) await page.screenshot({ path: `${shots}/1440-light-07-approved.png` });
  await ctx.close();
  const flows = await call('hr/flows', undefined, 'head');
  check(flows.rows.some((f) => f.personId === E.member && f.kind === 'leave' && (f.status === 'approved' || f.stage !== 'pod_head')), 'the leave moved past the pod head');
  if (process.env.PULSE_NOTIFY_REPORT) await writeFile(process.env.PULSE_NOTIFY_REPORT, JSON.stringify({ apiChecks, browserChecks }));
  console.log(JSON.stringify({ ok: true, apiChecks, browserChecks }));
} finally {
  await browser?.close(); server.kill(); await app.close(); await pool.end();
}
