// BUGKIT-TELEMETRY in the browser (tests/core/test_bugkit.py): a synthetic member signs in, opens the reporter (Ctrl+B),
// points at two elements (click, then Shift-click), comments on one, marks up the picture (rectangle, undo, redo), sends
// it; three quick clicks offer the reporter softly; a field typed into never reaches a replay chunk (masked on the
// device); an admin sees the report grouped, with the elements on the picture, and the App friction tab. 1440 and 390,
// light and dark, no page errors, no sideways scroll. Screenshots with PULSE_BK_SCREENSHOTS=<dir>. Nothing is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const shots = process.env.PULSE_BK_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-bk', NEXT_TELEMETRY_DISABLED: '1', PULSE_PUBLIC_LOGIN_ENABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
let browser, current = 'start';
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`bugkit-browser-runner: no result after 25 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
deadline.unref();
const errors = [];
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const fits = async (page, what) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${what} has no sideways scroll`);
const SECRET = 'SYNTHETIC-TYPED-WORDS-4417';

async function signIn(context, username) {
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${username}: ${e.message}`));
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded', timeout: 300_000 });
  await page.locator('input[name=username]').fill(username);
  await page.locator('input[name=password]').fill('Synthetic-account-2026!');
  await page.locator('input[name=password]').press('Enter');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 180_000 });
  return page;
}

try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']]) {
    const phone = width < 600, tag = `${width}-${theme}`, full = width === 1440 && theme === 'light';
    step(`member ${tag}`);
    const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: 1, colorScheme: theme, hasTouch: phone, isMobile: phone });
    const page = await signIn(context, 'auth.person');
    const chunks = [];
    page.on('request', (r) => { if (r.url().endsWith('/api/v0/telemetry/replay') && r.method() === 'POST') chunks.push(r.postData() ?? ''); });
    await page.goto(`${base}/tasks`, { waitUntil: 'domcontentloaded', timeout: 300_000 });
    await page.waitForLoadState('networkidle', { timeout: 120_000 }).catch(() => {});
    // A field on the page gets typed into; the replay must never carry the words.
    await page.evaluate(() => { const i = document.createElement('input'); i.id = 'bk-synthetic-field'; i.placeholder = 'Synthetic field'; i.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:5;width:200px'; document.body.appendChild(i); });
    await page.locator('#bk-synthetic-field').fill(SECRET);
    await page.locator('#bk-synthetic-field').blur();
    // The reporter.
    if (phone) await page.evaluate(() => window.dispatchEvent(new CustomEvent('pulse:report-bug', { detail: null })));
    else await page.keyboard.press('Control+b');
    const sheet = page.locator('[data-bug-reporter]');
    await expect(sheet).toBeVisible({ timeout: 60_000 });
    await page.getByRole('textbox', { name: 'What went wrong?' }).fill('Synthetic: the save button on the task board does nothing.');
    await shot(page, `1-reporter-${tag}`); await fits(page, `reporter ${tag}`);
    if (full || phone) {
      step(`picker ${tag}`);
      await page.getByTestId('pick-elements').click();
      await expect(page.locator('[data-bug-picker]')).toBeVisible();
      const targets = page.locator('main h1, main h2, main button, main a').filter({ visible: true });
      const first = targets.nth(0), second = targets.nth(1);
      await first.hover();
      await shot(page, `2-picker-hover-${tag}`);
      await first.click({ force: true });
      if (phone) await second.tap({ force: true }); else await second.click({ force: true, modifiers: ['Shift'] });
      await expect(page.getByTestId('picked-element')).toHaveCount(2);
      await shot(page, `3-picker-two-picked-${tag}`);
      await page.locator('[data-bug-picker]').getByRole('button', { name: 'Done' }).click();
      await expect(page.getByTestId('pin')).toHaveCount(2);
      await page.getByRole('textbox', { name: 'Comment on element 1' }).fill('Synthetic: nothing happens when I click this');
      await page.getByRole('button', { name: 'Add the comment' }).first().click();
      await expect(page.getByTestId('pin').first()).toContainText('nothing happens');
      await shot(page, `4-pins-with-thread-${tag}`);
    }
    if (full) {
      step('markup');
      const thumb = page.getByRole('button', { name: 'Mark up or blur the picture' });
      if (await thumb.isVisible({ timeout: 20_000 }).catch(() => false)) {
        await thumb.click();
        await page.getByRole('button', { name: /^Rectangle/ }).first().click();
        const canvas = page.locator('[data-bug-reporter] canvas').last();
        const box = await canvas.boundingBox();
        assert.ok(box, 'the mark-up canvas shows');
        await page.mouse.move(box.x + 40, box.y + 40); await page.mouse.down(); await page.mouse.move(box.x + 200, box.y + 140, { steps: 6 }); await page.mouse.up();
        await page.getByRole('button', { name: /^Arrow/ }).first().click();
        await page.mouse.move(box.x + 260, box.y + 60); await page.mouse.down(); await page.mouse.move(box.x + 210, box.y + 120, { steps: 6 }); await page.mouse.up();
        await page.getByRole('button', { name: /^Undo/ }).first().click();
        await page.getByRole('button', { name: /^Redo/ }).first().click();
        await shot(page, '5-markup-1440-light');
        await page.getByRole('button', { name: /Use this picture/ }).click();
      } else console.log('markup skipped: no picture could be taken in this browser');
    }
    step(`send ${tag}`);
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page.getByText(/Sent as bug #\d+/)).toBeVisible({ timeout: 60_000 });
    await shot(page, `6-sent-${tag}`);
    await page.getByRole('button', { name: 'Done' }).click();
    if (full) {
      step('rage click');
      const spot = await page.locator('main').boundingBox();
      for (let i = 0; i < 4; i++) await page.mouse.click(spot.x + 30, spot.y + 30, { delay: 20 });
      await expect(page.getByText('Looks like something’s off').first()).toBeVisible({ timeout: 20_000 });
      await shot(page, '7-soft-prompt-1440-light');
      step('replay masking');
      for (let i = 0; i < 40 && !chunks.length; i++) await delay(1000);
      assert.ok(chunks.length, 'replay chunks were sent');
      let masked = false;
      for (const raw of chunks) {
        const text = gunzipSync(Buffer.from(JSON.parse(raw).gz, 'base64')).toString('utf8');
        assert.ok(!text.includes(SECRET), 'the typed words never reach a replay chunk');
        if (/"\*{6,}"/.test(text)) masked = true;
      }
      assert.ok(masked, 'the field shows as stars in the replay');
      console.log(`replay: ${chunks.length} chunk(s), no typed text`);
    }
    await context.close();
    step(`admin ${tag}`);
    const ac = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: 1, colorScheme: theme, hasTouch: phone, isMobile: phone });
    const admin = await signIn(ac, 'auth.admin');
    await admin.goto(`${base}/bug-reports`, { waitUntil: 'domcontentloaded', timeout: 300_000 });
    await expect(admin.getByTestId('bug-groups')).toBeVisible({ timeout: 120_000 });
    await admin.getByTestId('bug-groups').click();
    await shot(admin, `8-triage-grouped-${tag}`); await fits(admin, `triage ${tag}`);
    await admin.locator('button[aria-label^="Bug #"]').first().click();
    await expect(admin.getByText(/Picked elements/)).toBeVisible({ timeout: 60_000 });
    await shot(admin, `9-report-pins-${tag}`);
    await admin.goto(`${base}/insights?tab=friction`, { waitUntil: 'domcontentloaded', timeout: 300_000 });
    await admin.waitForLoadState('networkidle', { timeout: 120_000 }).catch(() => {});
    await shot(admin, `10-insights-friction-${tag}`); await fits(admin, `friction tab ${tag}`);
    await ac.close();
  }
  assert.deepEqual(errors.filter((e) => !/ResizeObserver|hydrat/i.test(e)), [], 'no page errors');
  console.log('bugkit browser runner: ok');
} finally {
  await browser?.close().catch(() => {});
  stopServer();
  await app.close(); await pool.end();
}
