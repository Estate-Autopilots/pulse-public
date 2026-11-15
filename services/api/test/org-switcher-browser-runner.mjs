// ORG-SWITCHER-UX in the browser (tests/core/test_org_switcher.py): one Pulse account in five synthetic companies opens
// the organisation switcher under the company name (desktop sidebar) and the Ctrl+Shift+O dialog (every width; the
// phone's way in). Each company shows its own logo, else its initials on its brand colour, else on a colour of its
// own (never the same grey for all); the line under each name is the person's access and the company's @handle (never
// "Team · 2"); the shortcut is a key cap; a long name wraps instead of being cut off; a logo that fails to load falls
// back to the initials. No broken image anywhere in the sidebar. 1440 and 390, light and dark, no sideways scroll.
// Screenshots with PULSE_OS_SCREENSHOTS=<dir>; PULSE_OS_BEFORE=1 only takes them (the page before the change).
// Everything is invented; nothing is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), shots = process.env.PULSE_OS_SCREENSHOTS, before = process.env.PULSE_OS_BEFORE === '1';
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-os', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
let browser, checks = 0, current = 'start', last;
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`org-switcher-browser-runner: no result after 20 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 20 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
const shot = async (page, name, locator) => { if (!shots) return; await page.screenshot({ path: `${shots}/${name}.png` }); if (locator) await locator.screenshot({ path: `${shots}/${name}-close.png` }); };
const rgb = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
const sat = (c) => { const [r, g, b] = c.match(/\d+/g).map(Number); return Math.max(r, g, b) - Math.min(r, g, b); };
const NAMES = ['Synthetic Riverside Studio', 'Synthetic Harbour Sales', 'Synthetic Lakeside Clinic', 'Synthetic Third Co', E.long];
const MENU = '[role="menu"][aria-label="Switch organisation"]', DIALOG = '[role="dialog"][aria-label="Switch organisation"]';
const imagesLoaded = (page, scope) => page.waitForFunction((sel) => { const box = document.querySelector(sel); const imgs = box ? [...box.querySelectorAll('img')] : [];
  return imgs.length >= 2 && imgs.every((i) => i.complete && i.naturalWidth > 0); }, scope, { timeout: 120000 });
/** Every image in the sidebar, the menu and the dialog has loaded: no broken picture. */
const noBroken = async (page, what) => {
  const broken = await page.evaluate(() => [...document.querySelectorAll('aside img, [role="menu"] img, [role="dialog"] img')].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('src')));
  assert.deepEqual(broken, [], `${what}: no broken images`); checks++;
};
/** The tiles of a list: name -> { background, img, text }. */
const tiles = (page, scope) => page.evaluate((sel) => Object.fromEntries([...document.querySelectorAll(`${sel} [data-org-tile]`)].map((t) => [t.getAttribute('data-org-tile'),
  { bg: getComputedStyle(t).backgroundColor, img: !!t.querySelector('img'), text: t.textContent.trim() }])), scope);
const checkTiles = async (page, scope, what) => {
  const t = await tiles(page, scope);
  assert.ok(t[NAMES[1]]?.img, `${what}: the other company's logo is shown ${JSON.stringify(t)}`); checks++;
  assert.equal(t[NAMES[2]]?.bg, rgb(E.accent), `${what}: the brand colour ${JSON.stringify(t)}`); checks++;
  for (const n of [NAMES[3], NAMES[4]]) { assert.ok(t[n] && !t[n].img && sat(t[n].bg) >= 24, `${what}: ${n} has a colour of its own ${JSON.stringify(t[n])}`); checks++; }
  assert.notEqual(t[NAMES[3]].bg, t[NAMES[4]].bg, `${what}: two companies without a logo do not look alike`); checks++;
  const imgs = await page.locator(`${scope} img[data-org-mark]`).count();
  assert.ok(imgs >= 2, `${what}: both logos (the current company's and the other's): ${imgs}`); checks++;
};
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  if (!before) {
    const me = await (await fetch(`${origin}/api/v0/me`, { headers: { 'x-pulse-session': E.token } })).json();
    const orgs = me.account?.orgs ?? [];
    assert.equal(orgs.length, 5, `me: ${JSON.stringify(me.account).slice(0, 300)}`);
    const riverside = orgs.find((o) => o.id === E.orgs[0]);
    assert.match(String(riverside.mark), /^\/api\/v0\/tasks\/my-day\/mark\/[0-9a-f-]+\?v=3$/); assert.equal(riverside.access, 'owner');
    assert.equal(orgs.find((o) => o.id === E.orgs[2]).accent, E.accent);
    assert.equal(orgs.find((o) => o.id === E.orgs[3]).mark, null);
    const r = await fetch(origin + orgs.find((o) => o.id === E.orgs[1]).mark, { headers: { 'x-pulse-session': E.token } });
    assert.ok(r.status === 200 && (await r.text()).startsWith('<svg'), `the other company's logo is served: ${r.status}`);
    checks += 5;
  }
  browser = await chromium.launch();
  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']]) {
    step(`${width} ${theme}`);
    const phone = width < 600;
    const c = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: 2, hasTouch: phone, isMobile: phone, colorScheme: theme, extraHTTPHeaders: { 'cf-access-authenticated-user-email': E.email } });
    await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); } catch { /* private */ }
      // A pick is recorded, not performed: the check stays in the first company.
      window.__picked = []; window.addEventListener('pulse:org-switch', (e) => { window.__picked.push(e.detail?.org); e.stopImmediatePropagation(); }); }, theme);
    const page = await c.newPage(); last = page;
    page.on('pageerror', (e) => errors.push(`${width} ${theme}: ${e.message}`));
    page.on('response', (r) => { if (/\/api\/v0\/(tasks\/my-day\/mark|brand\/mark)/.test(r.url())) console.log(`image ${r.status()} ${r.headers()['content-type']} ${r.url().replace(base, '')}`); });
    await page.goto(base + '/my-day', { waitUntil: 'load', timeout: 300000 });
    await seen(page.getByRole('main'));
    const later = page.getByRole('button', { name: 'Later', exact: true });
    try { await later.waitFor({ state: 'visible', timeout: 8000 }); await later.click(); await later.waitFor({ state: 'hidden', timeout: 10000 }); } catch { /* not offered */ }
    const tag = `${width}-${theme}`;
    if (!phone) {
      // The sidebar switcher under the company name.
      const trigger = page.locator('button[aria-label^="Organisation:"]');
      await seen(trigger);
      await trigger.click();
      const menu = page.locator(MENU);
      await seen(menu);
      await seen(menu.getByRole('menuitemradio', { name: new RegExp(NAMES[1]) }));
      if (!before) await imagesLoaded(page, MENU); else await delay(2500);
      await shot(page, `sidebar-switcher-${tag}`, menu);
      if (!before) {
        await checkTiles(page, MENU, `sidebar ${tag}`);
        const lines = await menu.locator('[role="menuitemradio"] small').allTextContents();
        assert.ok(lines.every((l) => !/·\s*\d+$/.test(l)), `no number glued onto the role: ${lines}`); checks++;
        assert.match(lines[0], /^Owner · @/, `the person's access and the @handle: ${lines}`); checks++;
        assert.match(lines[1], /^Admin · @/); assert.match(lines[2], /^Finance · @/); checks += 2;
        assert.deepEqual(await menu.locator('kbd').allTextContents(), ['2', '3', '4', '5'], 'key caps for the shortcuts'); checks++;
        const long = menu.getByRole('menuitemradio', { name: new RegExp(E.long) });
        assert.equal(await long.getAttribute('title'), E.long, 'the full name as a tooltip'); checks++;
        const cut = await long.locator('b').evaluate((b) => ({ lines: Math.round(b.getBoundingClientRect().height / parseFloat(getComputedStyle(b).lineHeight)) }));
        assert.equal(cut.lines, 2, `the long name wraps to two lines (then ends in an ellipsis; the tooltip has it all): ${JSON.stringify(cut)}`); checks++;
        await noBroken(page, `sidebar ${tag}`);
        // 3 picks the third company while the menu is open.
        await menu.getByRole('menuitemradio').first().focus();
        await page.keyboard.press('3');
        assert.deepEqual(await page.evaluate(() => window.__picked), [E.orgs[2]], 'the 3 key picks the third company'); checks++;
      } else await page.keyboard.press('Escape');
    }
    // The Ctrl+Shift+O dialog (the phone's way in: the account menu's "Switch organisation").
    await page.evaluate(() => window.dispatchEvent(new Event('pulse:orgs-open')));
    const dialog = page.locator(DIALOG);
    await seen(dialog);
    if (!before) await imagesLoaded(page, DIALOG); else await delay(2500);
    await shot(page, `org-dialog-${tag}`, dialog);
    if (!before) {
      await checkTiles(page, DIALOG, `dialog ${tag}`);
      const lines = await dialog.locator('[role="menuitemradio"] small').allTextContents();
      assert.match(lines[0], /^Owner · @/, `dialog lines: ${lines}`); checks++;
      await noBroken(page, `dialog ${tag}`);
      await fits(page, `switcher ${tag}`);
    }
    await page.keyboard.press('Escape');
    // A logo that fails to load falls back to the initials tile, never a broken picture.
    if (!before && width === 1440 && theme === 'light') {
      await page.route('**/api/v0/tasks/my-day/mark/**', (route) => route.fulfill({ status: 404, body: '' }));
      await page.reload({ waitUntil: 'load' });
      await page.locator('button[aria-label^="Organisation:"]').click();
      const menu = page.locator(MENU);
      await seen(menu.locator(`[data-org-tile="${NAMES[1]}"]`, { hasText: 'SH' }), 60000);
      await noBroken(page, 'logos refused');
      await page.unroute('**/api/v0/tasks/my-day/mark/**');
    }
    await c.close();
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`org-switcher-browser-runner: ${checks} checks passed`);
} catch (e) {
  if (last && shots) { try { await last.screenshot({ path: `${shots}/failure.png`, fullPage: true }); } catch { /* closed */ } }
  console.error(`step ${current}: ${e?.stack ?? e}`); console.error(`next: ${serverTail.slice(-1500)}`); process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch { /* closed */ }
  stopServer(); await app.close(); await pool.end();
}
process.exit(process.exitCode ?? 0);
