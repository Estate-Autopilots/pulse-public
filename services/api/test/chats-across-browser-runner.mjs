// CHAT-ALL in the browser (tests/core/test_chats_across.py): the real API on two synthetic companies of one account, and
// the web app under `next dev`. The chat list's switch: All (every company, each chat tagged with its company, unread
// summed), one company, "in which company?" for a new chat, and another company's chat opening there with no password
// (the sign-in proved the person); picking one company moves the tab there. 1440 and 363, light and dark, no sideways
// scroll, no page errors. Screenshots with
// PULSE_ACROSS_SCREENSHOTS=<dir>. Everything is invented.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), shots = process.env.PULSE_ACROSS_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-chat-across', NEXT_TELEMETRY_DISABLED: '1', PULSE_PUBLIC_LOGIN_ENABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
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
const deadline = setTimeout(() => { console.error(`chats-across-browser-runner: no result after 25 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++;
  // The switch's button is whole inside the list (its menu is a panel of its own, or a sheet on a phone).
  const cut = await page.evaluate(() => { const box = document.querySelector('[data-chat-scope]'); if (!box) return []; const r = box.getBoundingClientRect();
    return [...box.querySelectorAll(':scope > button')].filter((b) => { const c = b.getBoundingClientRect(); return c.left < r.left - 1 || c.right > r.right + 1; }).map((b) => b.textContent); });
  assert.deepEqual(cut, [], `${what}: no chip of the switch is cut off`); checks++; };
const errors = [], consoleErrors = [];
async function context(width = 1440, theme = 'light') {
  const phone = width < 600;
  const c = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone });
  // The account switch's session for Kedab in Northstar, made from his own sign-in (it proved the person).
  await c.addCookies([{ name: 'pulse_session', value: E.token, url: base }]);
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
async function later(page) {
  const b = page.getByRole('button', { name: 'Later' });
  await b.waitFor({ state: 'visible', timeout: 4000 }).then(() => b.click()).catch(() => {});
  await b.waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});
}
const shot = async (page, name) => { if (!shots) return; await later(page); await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.locator('[class*="needSk"]').first().waitFor({ state: 'detached', timeout: 15000 }).catch(() => {}); await page.evaluate(() => document.activeElement?.blur?.()); await page.mouse.move(0, 0).catch(() => {});
  const tag = await page.addStyleTag({ content: 'nextjs-portal{display:none !important}' });
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false });
  await tag.evaluate((el) => el.remove()).catch(() => {}); };
const SIZES = [[1440, 'light'], [1440, 'dark'], [363, 'light'], [363, 'dark']];
const scope = (page) => page.locator('[data-chat-scope]');
const trigger = (page) => scope(page).getByRole('button');
const menu = (page) => page.getByRole('menu', { name: 'Show chats from' });
const toastGone = (page) => page.getByText(/^Opened in /).first().waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {});
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  for (const [width, theme] of SIZES) {
    const c = await context(width, theme);
    // 1. All companies: both companies' chats in one list, each tagged with its company; the switch sums the unread.
    step(`all ${width} ${theme}`);
    const page = await open(c, '/chats', `all ${width} ${theme}`);
    await later(page);
    await seen(scope(page));
    await expect(scope(page)).toHaveAttribute('data-scope', 'all', { timeout: 30000 }); checks++;
    await page.locator('[data-section="groups"]').click();
    await seen(page.locator('[data-chat-row]', { hasText: E.groupA }));
    await seen(page.locator('[data-remote-org]', { hasText: E.groupB }), 60000);
    await seen(page.locator('[data-remote-org] [data-org-tag]', { hasText: E.shortB }));
    // Unread summed: Northstar's group and Brightpath's group, one chat each: "All companies 2".
    await expect(trigger(page)).toContainText('All companies', { timeout: 30000 }); checks++;
    await expect(trigger(page)).toContainText('2'); checks++;
    // On a computer the start screen counts every company too: Brightpath's chat is in "Answer first", saying where.
    if (width > 900) await seen(page.getByText(`In ${E.shortB}`));
    await fits(page, `all ${width} ${theme}`); await shot(page, `chat-all-${width}-${theme}`);
    // 2. The switch's menu: All companies, then each company with its unread (one line on the page, never cut off).
    step(`menu ${width} ${theme}`);
    await trigger(page).click();
    await seen(menu(page));
    await expect(menu(page).getByRole('menuitemradio', { name: /All companies/ })).toHaveAttribute('aria-checked', 'true'); checks++;
    await seen(menu(page).getByRole('menuitemradio', { name: new RegExp(E.shortB) }));
    await seen(menu(page).getByRole('menuitemradio', { name: /Northstar Realty/ }));
    await fits(page, `menu ${width} ${theme}`); await shot(page, `chat-menu-${width}-${theme}`);
    // 3. One company: Brightpath. The tab moves there (no password: the sign-in proved the person), so the page and the
    //    list agree; only Brightpath's chats, and its name is not repeated on every row.
    step(`company ${width} ${theme}`);
    await menu(page).getByRole('menuitemradio', { name: new RegExp(E.shortB) }).click();
    await expect(scope(page)).toHaveAttribute('data-scope', 'one', { timeout: 120000 }); checks++;
    await expect(trigger(page)).toContainText(E.shortB, { timeout: 60000 }); checks++;
    await later(page);
    await seen(page.locator('[data-chat-row]', { hasText: E.groupB }));
    await expect(page.locator('[data-chat-row]', { hasText: E.groupA })).toHaveCount(0); checks++;
    await expect(page.locator('[data-chat-row] [data-org-tag]')).toHaveCount(0); checks++;
    await expect(page.getByText(/your Pulse password/i)).toHaveCount(0); checks++;
    // Northstar's unread still shows, quietly.
    await expect(trigger(page)).toContainText('1 unread elsewhere'); checks++;
    await toastGone(page);
    await fits(page, `company ${width} ${theme}`); await shot(page, `chat-company-${width}-${theme}`);
    // Back to All companies (no move: the list widens again).
    await trigger(page).click();
    await menu(page).getByRole('menuitemradio', { name: /All companies/ }).click();
    await expect(scope(page)).toHaveAttribute('data-scope', 'all'); checks++;
    // 4. A new chat in All asks which company; the one this tab is in (now Brightpath) opens the usual panel.
    step(`pick ${width} ${theme}`);
    await page.getByRole('button', { name: 'New chat' }).first().click();
    const pick = page.locator('[data-pick-company]');
    await seen(pick);
    await seen(pick.getByText(E.nameA)); await seen(pick.getByText(E.shortB));
    await fits(page, `pick ${width} ${theme}`); await shot(page, `chat-pick-${width}-${theme}`);
    await pick.locator(`[data-pick-org="${E.orgB}"]`).click();
    await expect(pick).toHaveCount(0); checks++;
    await c.close();
  }
  // 5. Another company's chat opens there: no password, the conversation open, the switch still on All companies.
  step('open in Brightpath');
  const c = await context(1440, 'light');
  const page = await open(c, '/chats', 'open elsewhere');
  await later(page);
  await page.locator('[data-section="groups"]').click();
  await page.locator('[data-remote-org]', { hasText: E.groupB }).first().click();
  await page.waitForURL((u) => u.pathname === '/chats' && u.searchParams.get('channel') === E.gb, { timeout: 120000 }); checks++;
  await seen(page.getByText('Bring the plans'));
  await expect(page.getByText(/your Pulse password/i)).toHaveCount(0); checks++;
  // The chat's header says which company it is in.
  await seen(page.getByText(`In ${E.shortB}`));
  await seen(scope(page));
  await expect(scope(page)).toHaveAttribute('data-scope', 'all'); checks++;
  // Now in Brightpath: Northstar's chat is the other company's (tagged, opens there).
  await seen(page.locator('[data-remote-org]', { hasText: E.groupA }), 60000);
  // The shot keeps the "Opened in Brightpath Labs" notice: it says the company changed.
  await fits(page, 'opened'); await shot(page, 'chat-opened-1440-light');
  await c.close();
  assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`);
  if (shots) writeFileSync(`${shots}/walk-log.txt`, `${checks} checks passed\nconsole errors (not failing):\n${[...new Set(consoleErrors)].join('\n')}\n`);
  if (consoleErrors.length) console.log(`console errors (not failing):\n${[...new Set(consoleErrors)].slice(0, 20).join('\n')}`);
  console.log(`chats-across-browser-runner: ${checks} checks passed`);
} catch (e) {
  if (last && shots) await last.screenshot({ path: `${shots}/failed-${String(current).replace(/\W+/g, '-')}.png`, fullPage: true }).catch(() => {});
  console.error(`chats-across-browser-runner failed at step ${current}:`, e?.stack ?? e);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await browser?.close().catch(() => {});
  await stopServer(); await app.close().catch(() => {}); await pool.end().catch(() => {});
}
