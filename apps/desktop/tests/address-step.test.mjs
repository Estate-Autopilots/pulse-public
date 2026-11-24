import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let playwright;
try { playwright = createRequire(new URL('../package.json', import.meta.url))('@playwright/test'); }
catch { playwright = createRequire(new URL('../../../tests/e2e/package.json', import.meta.url))('@playwright/test'); }

const NOT_PULSE = 'That address answered, but it isn’t Pulse, or its front door doesn’t let apps in yet. Check the address with your admin.';

const ADMIN_WAIT = 'Approved by you. Waiting for your admin to approve this computer.';
const ADMIN_DENIED = 'Your admin did not approve this computer. Nothing was signed in.';

// A mocked shell: no saved address until companion_address_set accepts one; example.com is not a Pulse gateway.
// o.company: the name native/about gives (none: an older Pulse); o.polls: the pairing poll answers in order;
// o.awaiting: a pairing kept through a restart while it waits for the admin.
function bridge(o) {
  window.__calls = []; window.__handlers = {};
  let base = o.signedIn ? 'https://old.example.org/api/native/v0' : o.awaiting ? 'https://pulse.example.com/api/native/v0' : null, paired = !!o.signedIn, named = false, waiting = !!o.awaiting;
  const polls = [...(o.polls ?? ['pending'])];
  const session = () => ({ signedIn: paired, base, site: base && new URL(base).origin, personName: paired ? 'Synthetic Teammate' : undefined, deviceId: paired ? 'd' : undefined,
    company: named ? o.company ?? null : null, awaitingAdmin: !paired && waiting ? { code: 'KQ7M-4TXA', interval: 2, until: Date.now() + 864e5 } : null });
  window.__TAURI__ = {
    event: { listen: async (name, handler) => { window.__handlers[name] = handler; }, emit: async () => {} },
    core: { invoke: async (cmd, args) => {
      window.__calls.push([cmd, args]);
      if (cmd === 'app_info') return { version: '1.0.0', platform: 'windows', shortcut: 'Ctrl+Alt+P', launch: {} };
      if (cmd === 'companion_session') return session();
      if (cmd === 'app_window_state') return { signedIn: paired, restoring: false };
      if (cmd === 'companion_address_set') {
        if (/^https:\/\/example\.com\/?$/.test(args.address)) throw JSON.stringify({ status: 0, message: 'That address answered, but it isn’t Pulse, or its front door doesn’t let apps in yet. Check the address with your admin.' });
        base = 'https://pulse.example.com/api/native/v0'; paired = false; named = false; return session();
      }
      if (cmd === 'companion_about') { named = true; return session(); }
      if (cmd === 'companion_pair_start') return { code: 'KQ7M-4TXA', verifyUrl: 'https://pulse.example.com/connect?code=KQ7M-4TXA', expiresIn: 600, interval: 2 };
      if (cmd === 'companion_pair_poll') {
        const response = polls.length > 1 ? polls.shift() : polls[0];
        if (response && typeof response === 'object' && response.error) throw response.error;
        const status = response && typeof response === 'object' ? response.status : response;
        waiting = status === 'awaiting_admin';
        if (status !== 'approved') return { status, ...(waiting ? { until: Date.now() + 864e5 } : {}) };
        paired = true; return { status, session: session() };
      }
      if (cmd === 'companion_request' && args.path === 'companion') return (await import('/companion/demo.js')).demoPayload('out', Date.now());
      if (cmd === 'companion_request') return {};
      return null;
    } },
  };
}

async function withBrowser(run) {
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
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await playwright.chromium.launch();
  try { await run(browser, url); } finally { await browser.close(); await new Promise(r => server.close(r)); }
}
const calls = (page, name) => page.evaluate((name) => window.__calls.filter(([cmd]) => cmd === name).map(([, args]) => args), name);

test('a fresh computer asks for its Pulse address before sign-in, in the panel, the Pulse window and Settings', () => withBrowser(async (browser, url) => {
  {
    // Quick panel: the address step, the "not Pulse" error, then sign-in for the accepted address only.
    let ctx = await browser.newContext({ viewport: { width: 380, height: 720 }, reducedMotion: 'reduce' });
    await ctx.addInitScript(bridge, {});
    let page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(url);
    await page.getByRole('heading', { name: 'Your Pulse address' }).waitFor();
    const sign = page.getByRole('button', { name: 'Sign in with your Pulse account' });
    assert.equal(await sign.count(), 0, 'no sign-in before an address passes the probe');
    await page.getByRole('textbox', { name: 'Pulse address' }).fill('  https://example.com ');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('alert').getByText(NOT_PULSE).waitFor();
    assert.deepEqual(await calls(page, 'companion_address_set'), [{ address: 'https://example.com' }]);
    assert.equal(await sign.count(), 0, 'still no sign-in after a refused address');
    assert.equal(await page.getByRole('textbox', { name: 'Pulse address' }).inputValue(), '  https://example.com ', 'the typed address is kept for a fix');
    await page.getByRole('textbox', { name: 'Pulse address' }).fill('pulse.example.com');
    await page.getByRole('button', { name: 'Continue' }).click();
    await sign.waitFor();
    await page.getByRole('heading', { name: 'Join Pulse at pulse.example.com?' }).waitFor();
    await page.getByText('pulse.example.com', { exact: true }).waitFor();
    await sign.click();
    await page.getByText('KQ7M-4TXA').waitFor();
    assert.equal((await calls(page, 'companion_pair_start'))[0].base, 'https://pulse.example.com/api/native/v0');
    const helpers = await page.evaluate(async () => {
      const m = await import('/address.js'); const before = window.__calls.length;
      const empty = await m.saveAddress(window.__TAURI__.core.invoke, '   ').catch((e) => e.message);
      return { host: m.addressHost('https://pulse.example.com:8443/api/native/v0'), none: m.addressHost(null), bad: m.addressHost('not a url'), empty, invoked: window.__calls.length - before };
    });
    assert.deepEqual(helpers, { host: 'pulse.example.com:8443', none: '', bad: '', empty: 'Enter your Pulse address, like https://pulse.example.com', invoked: 0 });
    assert.deepEqual(errors, []);
    await ctx.close();

    // The Pulse window opens on the same step and shows its welcome once the address is accepted.
    ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' });
    await ctx.addInitScript(bridge, {});
    page = await ctx.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${url}app.html`);
    await page.getByRole('heading', { name: 'Your Pulse address' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Sign in with your Pulse account' }).count(), 0);
    await page.getByRole('textbox', { name: 'Pulse address' }).fill('https://pulse.example.com');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('heading', { name: 'Join Pulse at pulse.example.com?' }).waitFor();
    await page.getByRole('button', { name: 'Sign in with your Pulse account' }).click();
    assert.equal((await calls(page, 'companion_pair_start'))[0].base, 'https://pulse.example.com/api/native/v0');
    assert.deepEqual(errors, []);
    await ctx.close();

    // Settings: a signed-in computer asks before Change; a refused address keeps the sign-in.
    ctx = await browser.newContext({ viewport: { width: 820, height: 600 }, reducedMotion: 'reduce' });
    await ctx.addInitScript(bridge, { signedIn: true });
    page = await ctx.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${url}settings.html#account`);
    const row = page.locator('[data-address]');
    await row.getByText('old.example.org').waitFor();
    await row.getByRole('button', { name: 'Change' }).click();
    await page.getByRole('dialog', { name: 'Change the Pulse address?' }).getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Pulse address' }).count(), 0, 'cancelling the question changes nothing');
    await row.getByRole('button', { name: 'Change' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('textbox', { name: 'Pulse address' }).fill('https://example.com');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('alert').getByText(NOT_PULSE).waitFor();
    await page.getByRole('textbox', { name: 'Pulse address' }).fill('https://pulse.example.com');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.locator('[data-address]').getByText('pulse.example.com', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    assert.deepEqual((await calls(page, 'companion_address_set')).map((a) => a.address), ['https://example.com', 'https://pulse.example.com']);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
}));

test('the panel asks to join Northwind Studio’s Pulse before the code, then waits for the admin through a restart', () => withBrowser(async (browser, url) => {
  const errors = [];
  const open = async (o, path = '', viewport = { width: 380, height: 720 }) => {
    const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await ctx.addInitScript(bridge, o);
    const page = await ctx.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(url + path);
    return { ctx, page };
  };
  // Confirm: the company is named once the address passes, and no code is requested until the person agrees.
  let { ctx, page } = await open({ company: 'Northwind Studio', polls: ['awaiting_admin', 'awaiting_admin', 'denied'] });
  await page.getByRole('textbox', { name: 'Pulse address' }).fill('pulse.example.com');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'Join Northwind Studio’s Pulse?' }).waitFor();
  assert.equal((await calls(page, 'companion_pair_start')).length, 0, 'no code before the person agrees to join');
  await page.getByRole('button', { name: 'Sign in with your Pulse account' }).click();
  await page.getByText('Your browser opened Northwind Studio’s Pulse. Check that it shows this code, then press Approve.').waitFor();
  // Awaiting admin: the code stays on screen and the poll keeps going at the server's interval.
  await page.getByRole('heading', { name: 'Waiting for your admin' }).waitFor();
  await page.getByText(ADMIN_WAIT).waitFor();
  await page.getByText('KQ7M-4TXA').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Open again' }).count(), 0, 'the browser step is done');
  // Admin denied: nothing signed in.
  await page.getByRole('alert').getByText(ADMIN_DENIED).waitFor();
  assert.equal((await calls(page, 'companion_pair_poll')).length, 3);
  assert.equal(await page.getByRole('button', { name: 'Sign in with your Pulse account' }).count(), 1);
  await ctx.close();

  // After a restart the wait resumes without a new code; the admin's approval signs the computer in.
  ({ ctx, page } = await open({ company: 'Northwind Studio', awaiting: true, polls: ['awaiting_admin', 'approved'] }));
  await page.getByRole('heading', { name: 'Waiting for your admin' }).waitFor();
  await page.getByText('Your admin approves new computers for Northwind Studio’s Pulse.', { exact: false }).waitFor();
  await page.getByText(/You’re connected/).waitFor({ timeout: 10000 });
  assert.equal((await calls(page, 'companion_pair_start')).length, 0, 'the kept request is resumed, not replaced');
  await ctx.close();

  // A temporary Pulse gateway error during an admin wait is retried; the pending device still signs in when approved.
  ({ ctx, page } = await open({ company: 'Northwind Studio', awaiting: true, polls: [
    'awaiting_admin',
    { error: JSON.stringify({ status: 502, message: 'Pulse is not answering right now' }) },
    'approved',
  ] }));
  await page.getByRole('heading', { name: 'Waiting for your admin' }).waitFor();
  await page.waitForFunction(() => window.__calls.filter(([cmd]) => cmd === 'companion_pair_poll').length >= 2);
  await page.getByRole('heading', { name: 'Waiting for your admin' }).waitFor();
  await page.getByText(ADMIN_WAIT).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0, 'a temporary gateway error does not replace the admin wait');
  await page.getByText(/You’re connected/).waitFor({ timeout: 10000 });
  assert.equal((await calls(page, 'companion_pair_poll')).length, 3, 'polling continued through the 502 until approval');
  await ctx.close();

  // Settings names the company next to its address.
  ({ ctx, page } = await open({ signedIn: true, company: 'Northwind Studio' }, 'settings.html#account', { width: 820, height: 600 }));
  await page.locator('[data-address]').getByText('Northwind Studio · old.example.org').waitFor();
  await page.getByText('Signed in on this computer · Northwind Studio').waitFor();
  await ctx.close();
  assert.deepEqual(errors, []);
}));
