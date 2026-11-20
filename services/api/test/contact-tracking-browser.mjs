// AC-CONTACTS in the browser (tests/core/test_contact_tracking.py, PULSE_CONTACT_TRACKING_BROWSER=1): a sales team (as
// Atlas Crest is) adds a tester from Contacts → Add contact with the Tester tag, a status, the phone they use and
// where they came from; the profile shows them; the list filters by the tag. Phone (363) and desktop (1440), light and
// dark; no sideways scroll, no page errors. Screens with PULSE_CT_SHOTS=<dir>, named for the shared judge
// (<screen>-<width>-<theme>.png). Everything is invented; nothing is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const ORG = JSON.parse(process.env.TEST_ORG), shots = process.env.PULSE_CT_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-ct', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
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
let browser, checks = 0, current = 'start';
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`contact-tracking-browser: no result after 60 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 60 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 240000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [], consoleErrors = [];
// The shared judge reads <screen>-<width>-<theme>.png at 1x.
const shot = async (page, screen, width, theme, full = true) => { if (shots) await page.screenshot({ path: `${shots}/${screen}-${width}-${theme}.png`, fullPage: full }); };
const dismiss = async (page) => { for (const name of ['Later', 'Not now', 'Close']) { const b = page.getByRole('button', { name, exact: true }); try { if (await b.first().isVisible({ timeout: 1500 })) await b.first().click(); } catch { /* none */ } } };
try {
  for (let i = 0; i < 900; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(2000); }
  browser = await chromium.launch();
  for (const [width, theme] of [[1440, 'light'], [363, 'light'], [1440, 'dark'], [363, 'dark']]) {
    step(`${width} ${theme}`);
    const phone = width < 600, n = `${width}${theme[0]}`, name = `Kedab Tester ${n}`;
    const c = await browser.newContext({ viewport: { width, height: phone ? 780 : 900 }, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, colorScheme: theme,
      extraHTTPHeaders: { 'cf-access-authenticated-user-email': ORG.email } });
    await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); } catch { /* private */ } }, theme);
    const page = await c.newPage();
    page.on('pageerror', (e) => errors.push(`${width} ${theme}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${width} ${theme} ${page.url().replace(base, '')}: ${m.text().slice(0, /hydrated/.test(m.text()) ? 3000 : 200)}`); });
    // 1. Contacts → Add contact: the tester with the Tester tag, a status, their phone and where they came from.
    await page.goto(base + '/contacts', { waitUntil: 'load', timeout: 600000 });
    await dismiss(page);
    await page.getByRole('button', { name: 'Add contact' }).or(page.getByRole('link', { name: 'Add contact' })).first().click();
    const drawer = page.getByRole('dialog', { name: 'Add a contact' });
    await seen(drawer);
    await drawer.getByLabel('Name', { exact: true }).fill(name);
    await drawer.getByLabel('Phone', { exact: true }).fill('+91 90000 00011');
    await drawer.getByLabel('E-mail', { exact: true }).fill(`kedab.${n}@example.com`);
    await drawer.getByRole('checkbox', { name: /^Tester/ }).click();
    await expect(drawer.getByRole('checkbox', { name: /^Tester/ })).toHaveAttribute('aria-checked', 'true'); checks++;
    await drawer.locator('select[name=status]').selectOption('invited', { force: true });
    await drawer.getByRole('radio', { name: /^Android$/ }).click();
    await drawer.getByText('Where they came from and notes').click();
    await drawer.getByLabel('Where they came from', { exact: true }).fill('Synthetic tester list');
    await page.evaluate(() => document.querySelectorAll('[role=dialog] *').forEach((e) => { if (e.scrollTop) e.scrollTop = 0; }));
    await shot(page, '01-add-contact', width, theme, false);
    await drawer.getByRole('button', { name: 'Add contact', exact: true }).click();
    // 2. Their profile: status, tag, phone they use, where they came from.
    await page.waitForURL(/\/contacts\/[0-9a-f-]{36}/, { timeout: 300000 });
    await seen(page.getByRole('heading', { name }));
    await seen(page.getByText('Invited to test'));
    await seen(page.getByText('Synthetic tester list'));
    await page.waitForTimeout(4500);   // the "is added" toast has gone
    await fits(page, `${n} profile`);
    await shot(page, '02-profile', width, theme);
    // 3. Contacts, only the testers.
    await page.goto(base + '/contacts?tag=tester', { waitUntil: 'load', timeout: 600000 });
    await dismiss(page);
    await seen(page.getByRole('group', { name: 'Filter contacts by tag' }));
    await seen(page.getByRole('link', { name }));
    await fits(page, `${n} testers`);
    await shot(page, '03-testers', width, theme);
    await c.close();
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log(JSON.stringify({ ok: true, checks, consoleErrors: consoleErrors.slice(0, 8) }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, step: current, checks, error: String(e?.stack ?? e).slice(0, 1500), errors: errors.slice(0, 5), server: serverTail.slice(-600) }));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await stopServer(); await app.close().catch(() => undefined); await pool.end().catch(() => undefined);
}
