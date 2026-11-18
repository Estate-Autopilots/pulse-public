// CASE-STUDIES (1966) in the browser (tests/core/test_case_studies.py): the real API on a disposable synthetic company and
// the web app under `next dev`. An admin opens Case studies (tiles, the 8-stage strip, the companies), a case file
// (ticks the last step of stage 1, moves on with the celebration), its Numbers (suggested goals from typed months),
// Talks & links and Story; a colleague is refused. 1440 and 363, light and dark, no sideways scroll, no page errors.
// Screenshots with PULSE_CASE_SCREENSHOTS=<dir>. Every name and number is fake.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const emails = JSON.parse(process.env.TEST_EMAILS), ids = JSON.parse(process.env.TEST_CASES), shots = process.env.PULSE_CASE_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-cases', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
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
const deadline = setTimeout(() => { console.error('case-studies-browser-runner: no result after 25 minutes'); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
async function context(role, width = 1440, theme = 'light') {
  const phone = width < 600;
  const c = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
  await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('pulse-fun', 'off'); } catch { /* private */ } }, theme);
  return c;
}
async function open(c, path, name) {
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
  return page;
}
const shot = async (page, name, full = true) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: full }); };
const SIZES = [[1440, 'light'], [1440, 'dark'], [363, 'light'], [363, 'dark']];
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  for (const [width, theme] of SIZES) {
    const tag = `${width}-${theme}`;
    const c = await context('owner', width, theme);
    const list = await open(c, '/case-studies', `list ${tag}`);
    await seen(list.getByText('Example Lotus Fake Co'));
    await seen(list.getByText('The 8 stages'));
    await seen(list.getByText('In the journey'));
    await fits(list, `list ${tag}`); await shot(list, `list-${tag}`);
    // The case file: Steps.
    const page = await open(c, `/case-studies/${ids.lotus}`, `case ${tag}`);
    await seen(page.getByText('Stage 2: Trust & data'));
    await seen(page.getByRole('button', { name: 'Mark this stage done' }));
    await fits(page, `case steps ${tag}`); await shot(page, `case-steps-${tag}`);
    // Numbers: typed months give suggested goals.
    await page.getByRole('radio', { name: /Numbers/ }).click();
    await seen(page.getByText('Suggested goals'));
    await seen(page.getByText('Win it back'));
    await fits(page, `case numbers ${tag}`); await shot(page, `case-numbers-${tag}`);
    await page.getByRole('radio', { name: /Talks/ }).click();
    await seen(page.getByText('Fake first talk'));
    await fits(page, `case links ${tag}`); await shot(page, `case-links-${tag}`);
    await page.getByRole('radio', { name: /Story/ }).click();
    await seen(page.getByText('Tags for the library'));
    await fits(page, `case story ${tag}`); await shot(page, `case-story-${tag}`);
    if (width === 1440 && theme === 'light') {
      // Tick the last step of stage 1 on another case, then move on: the celebration and the next stage.
      const p2 = await open(c, `/case-studies/${ids.harbor}`, 'case tick');
      await seen(p2.getByText('Stage 1: Convince'));
      const ticked = p2.waitForResponse((r) => r.url().includes('/check') && r.request().method() === 'POST', { timeout: 120000 });
      await p2.getByRole('button', { name: 'Mark done: They agree to start the 45 days' }).click();
      assert.equal((await ticked).status(), 200); checks++;
      const moved = p2.waitForResponse((r) => r.url().includes('/stage') && r.request().method() === 'POST', { timeout: 120000 });
      await p2.getByRole('button', { name: 'Mark this stage done' }).click();
      assert.equal((await moved).status(), 200); checks++;
      await seen(p2.getByText('On to stage 2: Trust & data'));
      await shot(p2, 'case-moved-1440-light', false);
      // Add a company from the drawer.
      const p3 = await open(c, '/case-studies', 'add');
      await p3.getByRole('button', { name: 'Add a company' }).first().click();
      await p3.getByLabel('Company or owner').fill('Example New Fake Co');
      await shot(p3, 'add-drawer-1440-light', false);
      const made = p3.waitForResponse((r) => r.url().endsWith('/api/v0/case-studies') && r.request().method() === 'POST', { timeout: 120000 });
      await p3.getByRole('button', { name: 'Add to the journey' }).click();
      assert.equal((await made).status(), 200); checks++;
      await seen(p3.getByText('Stage 1: Convince'));
    }
    await c.close();
  }
  // A colleague who is not a leader is refused by the API and sees no case.
  { const c = await context('member'), page = await open(c, '/case-studies', 'member');
    const r = await c.request.get(`${origin}/api/v0/case-studies`, { headers: { 'cf-access-authenticated-user-email': emails.member } });
    assert.equal(r.status(), 403, 'a colleague is refused by the API');
    await page.waitForLoadState('networkidle').catch(() => undefined);
    assert.equal(await page.getByText('Example Lotus Fake Co').count(), 0, 'a colleague sees no case');
    checks += 2; await shot(page, 'refused-member-1440-light'); await c.close(); }
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log(`case-studies-browser-runner: ${checks} checks passed`);
} catch (e) {
  if (shots && last) await last.screenshot({ path: `${shots}/failure.png`, fullPage: true }).catch(() => undefined);
  console.error(e instanceof Error ? e.stack : e); process.exitCode = 1;
} finally {
  clearTimeout(deadline); await browser?.close().catch(() => undefined); await stopServer(); await app.close().catch(() => undefined); await pool.end().catch(() => undefined);
}
