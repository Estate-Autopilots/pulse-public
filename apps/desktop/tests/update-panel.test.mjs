import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let playwright;
try { playwright = createRequire(new URL('../package.json', import.meta.url))('@playwright/test'); }
catch { playwright = createRequire(new URL('../../../tests/e2e/package.json', import.meta.url))('@playwright/test'); }

test('real quick panel keeps update actions visible and checks automatically', async () => {
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const base = path.startsWith('/companion/') ? resolve(desktop, '../../packages/companion/src') : resolve(desktop, 'src');
      const file = resolve(base, path === '/' ? 'index.html' : '.' + path.replace(/^\/companion/, ''));
      assert.ok(file.startsWith(base + sep));
      res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(file)] ?? 'text/plain');
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await playwright.chromium.launch();
  try {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 360, height: 460 }, colorScheme: theme, reducedMotion: 'reduce' });
      await ctx.addInitScript(() => {
        window.__calls = []; window.__handlers = {}; window.__releaseAttendance = null;
        window.__TAURI__ = {
          event: { listen: async (name, handler) => { window.__handlers[name] = handler; }, emit: async (name, payload) => window.__handlers[name]?.({ payload }) },
          core: { invoke: async (cmd, args) => {
            window.__calls.push([cmd, args]);
            if (cmd === 'app_info') return { version: '1.0.0', platform: 'windows', shortcut: 'Ctrl+Alt+P' };
            if (cmd === 'companion_session') return { signedIn: true, deviceId: 'synthetic', base: 'https://pulse.estateautopilots.com/api/native/v0' };
            if (cmd === 'update_check') return { version: '1.0.1', notes: 'Compact update cards, automatic checks and reachable install buttons. '.repeat(25) };
            if (cmd === 'companion_request' && args.path === 'companion') {
              if (!window.__attendanceReleased) await new Promise(r => { window.__releaseAttendance = () => { window.__attendanceReleased = true; r(); }; });
              const { demoPayload } = await import('/companion/demo.js');
              return demoPayload('in', Date.parse('2026-10-09T13:00:00+05:30'));
            }
            if (cmd === 'companion_request') return { channels: [], rows: [], people: [], messages: [], members: [] };
            return null;
          } },
        };
      });
      const page = await ctx.newPage(); const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.clock.install();
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction(() => window.__calls.some(([cmd]) => cmd === 'update_prepare'));
      assert.equal(await page.evaluate(() => window.__calls.filter(([cmd]) => cmd === 'update_check').length), 1, 'launch discovery runs while attendance is still pending');
      await page.waitForFunction(() => typeof window.__releaseAttendance === 'function');
      await page.evaluate(() => window.__releaseAttendance());
      await page.getByRole('button', { name: 'Install and restart', exact: true }).waitFor();
      // More content than the native window can fit, including the newer Today features.
      await page.evaluate(() => { const extra = document.createElement('div'); extra.style.height = '800px'; document.getElementById('app').append(extra); });
      const assertActions = async () => {
        const geometry = await page.evaluate(() => ({
          buttons: [...document.querySelectorAll('.pc-update button.pc-btn')].map(e => {
            const r = e.getBoundingClientRect(), s = getComputedStyle(e);
            return { name: e.textContent, top: r.top, bottom: r.bottom, left: r.left, right: r.right, font: s.fontFamily, background: s.backgroundColor };
          }), height: innerHeight,
          nestedScroll: [...document.querySelectorAll('#app *, #update-host *')].filter(e => e.scrollHeight > e.clientHeight + 2 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY)).map(e => e.className),
        }));
        assert.equal(geometry.buttons.length, 2);
        assert.ok(geometry.buttons.every(b => b.top >= 0 && b.bottom <= geometry.height && b.left >= 0 && b.right <= 360), JSON.stringify(geometry));
        assert.notEqual(geometry.buttons[0].background, geometry.buttons[1].background, 'primary and secondary look different');
        assert.match(geometry.buttons[0].font, /sans-serif|system-ui/);
        assert.deepEqual(geometry.nestedScroll, []);
        for (const name of ['Install and restart', 'Later']) {
          const button = page.getByRole('button', { name, exact: true });
          await button.click({ trial: true });
        }
      };
      for (const height of [460, 680]) {
        await page.setViewportSize({ width: 360, height }); await assertActions();
        await page.getByText("What's new", { exact: true }).click(); await assertActions();
        await page.getByText("What's new", { exact: true }).click();
      }
      await page.getByText("What's new", { exact: true }).click();
      await page.getByRole('button', { name: 'Full release notes', exact: true }).click();
      await page.getByRole('heading', { name: "What's new in Pulse 1.0.1", exact: true }).waitFor();
      await assertActions();
      await page.getByRole('button', { name: 'Back to today', exact: true }).click();
      if (process.env.PULSE_UPDATE_SCREENSHOT_DIR) {
        await mkdir(process.env.PULSE_UPDATE_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: resolve(process.env.PULSE_UPDATE_SCREENSHOT_DIR, `${theme}-update.png`) });
      }
      await page.clock.fastForward(4 * 60 * 60 * 1000 + 60000);
      await page.waitForFunction(() => window.__calls.filter(([cmd]) => cmd === 'update_check').length >= 2);
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('pulse.updateState') || '{}').status === 'Update ready' || window.__calls.filter(([cmd]) => cmd === 'update_prepare').length >= 2);
      assert.deepEqual(errors, []);
      await page.getByRole('button', { name: 'Later', exact: true }).click();
      assert.equal(await page.locator('.pc-update').count(), 0);
      // The current desktop has a separate Settings window; it consumes the panel's discovery state.
      if (await readFile(resolve(desktop, 'src/settings.html')).then(() => true, () => false)) {
        const settings = await ctx.newPage();
        settings.on('pageerror', e => errors.push(e.message));
        await settings.setViewportSize({ width: 760, height: 700 });
        await settings.goto(`http://127.0.0.1:${server.address().port}/settings.html#updates`);
        await settings.getByText('Update ready', { exact: true }).waitFor();
        assert.equal(await settings.evaluate(() => window.__calls.some(([cmd]) => cmd === 'update_check')), false, 'Settings consumes the automatic result instead of invalidating the native prepared bundle');
        await settings.evaluate(() => window.__handlers['pulse:update-state']({ payload: { channel: 'test', status: 'Pulse is up to date', running: false, version: null } }));
        await settings.getByText('Pulse is up to date', { exact: true }).waitFor();
        await settings.getByRole('button', { name: 'Check now', exact: true }).click();
        await settings.evaluate(() => window.__handlers['pulse:update-state']({ payload: { channel: 'test', status: 'Update ready', running: false, version: '1.0.1' } }));
        await settings.getByRole('button', { name: 'Install and restart', exact: true }).waitFor();
        assert.deepEqual(errors, []);
      }
      await ctx.close();
    }
  } finally { await browser.close(); await new Promise(r => server.close(r)); }
});
