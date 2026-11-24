// Renders the Settings sheet and the Pulse window's own screens in Chromium with a mocked Tauri bridge, in light and
// dark, checks layout (no overflow, no visible scrollbars, labelled switches, no page errors) and saves screenshots.
// These are layout receipts with mocked IPC, not physical install receipts.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const require = createRequire(new URL('../../../tests/e2e/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const root = resolve('dist'), out = process.env.PULSE_SETTINGS_SCREENSHOT_DIR ?? (process.env.PULSE_DESKTOP_SCREENSHOT_DIR ? resolve(process.env.PULSE_DESKTOP_SCREENSHOT_DIR, 'settings') : '/home/eadev/ea-research/companion/desktop-settings');
await mkdir(out, { recursive: true });
const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname, file = resolve(root, '.' + path);
    if (!file.startsWith(root + sep)) throw Error('scope'); // sep: \ on the Windows runner
    res.setHeader('content-type', types[extname(file)] ?? 'text/plain'); res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const SCENES = [
  ...['general', 'notifications', 'presence', 'privacy', 'account', 'updates'].map((s) => ({ name: `settings-${s}`, page: `settings.html#${s}`, size: [820, 600] })),
  { name: 'settings-privacy-not-signed-in', page: 'settings.html#privacy', size: [820, 600], signedIn: false },
  { name: 'settings-notifications-blocked', page: 'settings.html#notifications', size: [820, 600], pingIssue: 'Pings are turned off for Pulse in Windows. Press Fix, then turn Pulse on in Notifications.' },
  { name: 'settings-account-change', page: 'settings.html#account', size: [820, 600], change: 'https://example.com' },
  { name: 'app-address', page: 'app.html', size: [1280, 820], signedIn: false, noAddress: true },
  { name: 'app-welcome', page: 'app.html', size: [1280, 820], signedIn: false },
  { name: 'app-offline', page: 'app.html#offline', size: [1280, 820] },
  { name: 'app-restoring', page: 'app.html#restoring', size: [1280, 820] },
];
const browser = await chromium.launch();
const results = [];
try {
  for (const theme of ['light', 'dark']) for (const scene of SCENES) {
    const ctx = await browser.newContext({ viewport: { width: scene.size[0], height: scene.size[1] }, colorScheme: theme, reducedMotion: 'reduce', deviceScaleFactor: 2 });
    await ctx.addInitScript((scene) => {
      const calls = []; window.__calls = calls;
      const signedIn = scene.signedIn !== false, base = scene.noAddress ? null : 'https://pulse.example.com/api/native/v0', site = base && 'https://pulse.example.com';
      const settings = { dnd: false, quiet: true, start: '20:00', end: '08:00', timezone: 'Asia/Kolkata', types: { payroll: true, update: false } };
      window.__TAURI__ = { event: { listen: async () => () => {}, emit: async () => {} }, core: { invoke: async (cmd, args) => {
        calls.push([cmd, args]);
        switch (cmd) {
          case 'app_info': return { version: '1.0.0', platform: 'windows', shortcut: 'Ctrl+Alt+P', launch: {} };
          case 'autostart_get': return true;
          case 'companion_session': return signedIn ? { signedIn: true, personName: 'Synthetic Teammate', base, site, deviceId: 'd', company: 'Northwind Studio' } : { signedIn: false, base, site, company: base && 'Northwind Studio' };
          case 'companion_address_set': throw JSON.stringify({ status: 0, message: 'That address answered, but it isn’t Pulse, or its front door doesn’t let apps in yet. Check the address with your admin.' });
          case 'app_window_state': return { signedIn, restoring: false };
          case 'companion_ping_state': return { pingIssue: scene.pingIssue ?? null };
          case 'presence_status': return { consent: true, autoConsent: false, wifi: { ssid: 'Synthetic Office', connected: true, accessPoint: true, needsLocation: false }, server: { officeId: 'o1', score: 75 } };
          case 'tracker_status': return { purposes: [], paused: true, seen: [] };
          case 'companion_request': {
            if (args.path === 'companion/notification-settings') return { settings };
            if (args.path === 'companion') return { presence: { autoCheckIn: true, dwellMinutes: 3, offices: [{ id: 'o1', name: 'Synthetic HQ' }] } };
            if (args.path === 'devices/policy') return { notices: [{ id: 'n1', body: { summary: 'Totals of focus and idle time for approved work apps during work hours.' } }] };
            return {};
          }
          case 'update_check': return null;
          default: return null;
        }
      } } };
    }, scene);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + scene.page);
    await page.waitForSelector(scene.page.startsWith('settings') ? '.main h2' : '.app-card');
    await page.waitForTimeout(300);
    if (scene.change) {
      await page.locator('[data-address]').getByRole('button', { name: 'Change' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('textbox', { name: 'Pulse address' }).fill(scene.change);
      await page.getByRole('button', { name: 'Save' }).click();
      await page.getByRole('alert').waitFor();
    }
    if (scene.noAddress) await page.getByRole('heading', { name: 'Your Pulse address' }).waitFor();
    const g = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      visibleScrollbar: [...document.querySelectorAll('*')].some((e) => e.scrollHeight > e.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY) && getComputedStyle(e).scrollbarWidth !== 'none'),
      unnamedSwitches: [...document.querySelectorAll('[role=switch]')].filter((s) => !s.getAttribute('aria-labelledby') || !document.getElementById(s.getAttribute('aria-labelledby'))?.textContent.trim()).length,
      switches: document.querySelectorAll('[role=switch]').length,
      title: document.querySelector('h1,h2')?.textContent ?? '',
      jargon: /\b(SSID|BSSID|purpose receipt|consent epoch|metadata|API|native)\b/i.test(document.body.innerText),
    }));
    assert.equal(g.overflowX, false, `${scene.name} overflows`);
    assert.equal(g.visibleScrollbar, false, `${scene.name} shows a scrollbar`);
    assert.equal(g.unnamedSwitches, 0, `${scene.name} has unlabelled switches`);
    assert.equal(g.jargon, false, `${scene.name} uses technical jargon`);
    assert.deepEqual(errors, [], `${scene.name} page errors`);
    if (scene.page.startsWith('settings')) assert.equal(await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button').count(), 6);
    if (scene.pingIssue) await page.getByRole('button', { name: 'Turn on' }).first().waitFor();
    await page.screenshot({ path: `${out}/${theme}-${scene.name}.png` });
    results.push({ theme, scene: scene.name, ...g, ipc: 'mocked' });
    await ctx.close();
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
}
console.log(`desktop settings and window screens: ${results.length} states checked → ${out}`);
