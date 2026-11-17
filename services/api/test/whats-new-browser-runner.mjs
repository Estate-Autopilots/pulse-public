// RELEASE-COMMS in the browser (tests/core/test_whats_new.py): /whats-new for an owner and a member, phone (390) and
// desktop (1440), light and dark: the release, "For you" first, Please check, Known issues, the share card with Send on
// WhatsApp and Save image; no sideways scroll, no page errors. Then the "was updated" note: a first visit only remembers
// the newest release; an older remembered one shows the note, which leads to /whats-new and does not come back.
// Screenshots with PULSE_WN_SCREENSHOTS=<dir>. Everything is invented; nothing is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const id = Number(process.env.TEST_NOTE_ID), headline = 'Synthetic release: faster task lists', shots = process.env.PULSE_WN_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-wn', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
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
const deadline = setTimeout(() => { console.error(`whats-new-browser-runner: no result after 20 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 20 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
const signIn = async (username) => { const r = await app.inject({ method: 'POST', url: '/api/v0/auth/sign-in', headers: { 'x-pulse-client-ip': randomBytes(6).toString('hex') }, payload: { username, password: 'Synthetic-account-2026!' } });
  assert.equal(r.statusCode, 200, `${username} signs in: ${r.body}`); return r.json().token; };
const context = async (token, width, theme, init) => {
  const phone = width < 600;
  const c = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone, colorScheme: theme });
  await c.addCookies([{ name: 'pulse_session', value: token, domain: '127.0.0.1', path: '/' }]);
  await c.addInitScript(([t, extra]) => { try { localStorage.setItem('pulse.theme', t); for (const [k, v] of Object.entries(extra ?? {})) if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } catch { /* private */ } }, [theme, init ?? {}]);
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${width} ${theme}: ${e.message}`));
  return { c, page };
};
const later = async (page) => { const b = page.getByRole('button', { name: 'Later', exact: true }); try { await b.waitFor({ state: 'visible', timeout: 4000 }); await b.click(); } catch { /* not offered */ } };
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  const owner = await signIn('auth.admin'), member = await signIn('auth.person');
  browser = await chromium.launch();
  for (const [who, token] of [['owner', owner], ['member', member]]) {
    for (const [width, theme] of [[1440, 'light'], [390, 'light'], [1440, 'dark'], [390, 'dark']]) {
      if (who === 'member' && theme === 'dark') continue;
      step(`${who} ${width} ${theme}`);
      const { c, page } = await context(token, width, theme);
      await page.goto(base + '/whats-new', { waitUntil: 'load', timeout: 300000 });
      await later(page);
      const release = page.locator('article', { hasText: headline });
      await seen(release.getByRole('heading', { name: headline }));
      await seen(release.getByText('IST'));
      if (who === 'owner') {
        await seen(release.getByRole('heading', { name: 'For you' }));
        await seen(release.getByText('Synthetic: billing totals'));
        await seen(release.getByText('Synthetic: check a bill'));
        await seen(release.getByRole('heading', { name: 'For sales' }));
      } else {
        assert.equal(await release.getByText('Synthetic: billing totals').count(), 0, 'a member never sees the owner part'); checks++;
        assert.equal(await release.getByRole('heading', { name: 'For you' }).count(), 0); checks++;
      }
      await seen(release.getByRole('heading', { name: 'For everyone' }));
      await seen(release.getByRole('heading', { name: 'Please check' }));
      await seen(release.getByRole('heading', { name: 'Known issues' }));
      const wa = release.getByRole('link', { name: 'Send on WhatsApp' });
      await seen(wa);
      const href = await wa.getAttribute('href');
      assert.equal(href, `https://wa.me/?text=${encodeURIComponent(who === 'owner' ? 'Synthetic owner text' : 'Synthetic everyone text')}`); checks++;
      assert.equal(await wa.getAttribute('target'), '_blank'); checks++;
      const save = release.getByRole('link', { name: 'Save image' });
      await seen(save);
      assert.match(String(await save.getAttribute('href')), new RegExp(`^/api/v0/whats-new/${id}/card/${who === 'owner' ? 'owner' : 'everyone'}\\?v=`)); checks++;
      const img = release.getByRole('img', { name: headline });
      await img.scrollIntoViewIfNeeded();
      await page.waitForFunction((alt) => { const i = [...document.images].find((x) => x.alt === alt); return !!i && i.complete && i.naturalWidth > 0; }, headline, { timeout: 120000 });
      checks++;
      await fits(page, `${who} /whats-new ${width} ${theme}`);
      await shot(page, `whats-new-${who}-${width}-${theme}`);
      await c.close();
    }
  }
  // The "was updated" note.
  step('update note');
  {
    // A first visit only remembers the newest release.
    const { c, page } = await context(owner, 1440, 'light');
    const newest = page.waitForResponse((r) => r.url().includes('/api/v0/whats-new?limit=1'), { timeout: 300000 });
    await page.goto(base + '/notifications', { waitUntil: 'load', timeout: 300000 });
    await newest; await delay(1500);
    assert.equal(await page.getByText('Vitals OS was updated').count(), 0, 'no note on a first visit'); checks++;
    const viewer = await page.evaluate(() => document.body.dataset.viewer);
    assert.ok(viewer, 'the signed-in person is on the page');
    await page.waitForFunction(([k, v]) => localStorage.getItem(k) === v, [`pulse.whats-new.seen.${viewer}`, String(id)], { timeout: 60000 }); checks++; // the newest release is remembered
    await c.close();
    // An older remembered release: the note shows, leads to /whats-new, and does not come back.
    for (const width of [1440, 390]) {
      const v = await context(owner, width, 'light', { [`pulse.whats-new.seen.${viewer}`]: String(id - 1) });
      await v.page.goto(base + '/notifications', { waitUntil: 'load', timeout: 300000 });
      await later(v.page);
      const note = v.page.locator('[data-update]');
      await seen(note.getByText('Vitals OS was updated'));
      await seen(note.getByText(headline));
      await fits(v.page, `the note ${width}`);
      await shot(v.page, `update-note-${width}`);
      await note.getByRole('link', { name: "See what's new" }).click();
      await v.page.waitForURL(/\/whats-new$/, { timeout: 120000 }); checks++;
      await v.page.goto(base + '/notifications', { waitUntil: 'load', timeout: 300000 });
      await delay(3000);
      assert.equal(await v.page.locator('[data-update]').count(), 0, 'seen: the note does not come back'); checks++;
      await v.c.close();
    }
  }
  // The account menu leads to the page.
  step('menu');
  {
    const { c, page } = await context(member, 1440, 'light');
    await page.goto(base + '/notifications', { waitUntil: 'load', timeout: 300000 });
    await later(page);
    await page.getByRole('button', { name: 'Open account menu' }).click();
    await page.getByRole('menuitem', { name: "What's new" }).click();
    await page.waitForURL(/\/whats-new$/, { timeout: 120000 }); checks++;
    await c.close();
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`whats-new-browser-runner: ${checks} checks passed`);
} catch (e) {
  if (last && shots) { try { await last.screenshot({ path: `${shots}/failure.png`, fullPage: true }); } catch { /* closed */ } }
  console.error(`step ${current}: ${e?.stack ?? e}`); process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch { /* closed */ }
  await stopServer(); await app.close(); await pool.end();
}
process.exit(process.exitCode ?? 0);
