// BUGFIX #29 walk (EA #29, 15 Nov 2026: "I am not able to switch from EA to Vitals OS"): a member of two companies, signed
// in with one company's own sign-in, presses the other company in the switcher on /chats. Before: nothing happened (403).
// Now: "Confirm it's you" asks for their own Pulse password once; a wrong one says so; the right one switches.
// Private API + web on a scratch DB seeded by tests/e2e/account-meta-seed.sql (synthetic: the company-only session is
// in "Fake Estate Co", the other company is "Fake Vitals Tech"). The caller resets that session before each run.
// Env: WEB, API, OUT, WIDTH (1440 | 363), DARK (1 | 0).
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const WEB = process.env.WEB, OUT = process.env.OUT ?? '/tmp/switch-prove-shots';
const WIDTH = Number(process.env.WIDTH ?? 1440), DARK = process.env.DARK === '1';
const COMPANY = 'acctmetaCompanyWalkToken00000000000000000002', PASSWORD = 'Fake-Pass-For-Tests-1';
const tag = `${WIDTH}-${DARK ? 'dark' : 'light'}`;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: WIDTH < 500 ? 780 : 900 }, colorScheme: DARK ? 'dark' : 'light', deviceScaleFactor: 1 });
await ctx.addCookies([{ name: 'pulse_session', value: COMPANY, domain: new URL(WEB).hostname, path: '/', httpOnly: true }]);
const p = await ctx.newPage(); p.setDefaultTimeout(240000);
const failed = [];
p.on('response', (r) => { if (r.url().includes('/api/v0/account/')) failed.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`); });
const shot = async (name) => { await p.waitForTimeout(700); await p.screenshot({ path: `${OUT}/${name}-${tag}.jpg`, type: 'jpeg', quality: 82 }); };
let rc = 0;
try {
  await p.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('[data-viewer]', { timeout: 300000 });
  await p.waitForTimeout(1500);
  const here = await p.evaluate(async () => (await (await fetch('/api/v0/account', { cache: 'no-store' })).json()).orgs.find((o) => o.current)?.name);
  assert.equal(here, 'Fake Estate Co');
  // The switcher (Ctrl+Shift+O anywhere; the shell's company button sends the same event).
  await p.evaluate(() => window.dispatchEvent(new Event('pulse:orgs-open')));
  await p.locator('[role="dialog"][aria-label^="Switch"] [role="menuitemradio"]', { hasText: 'Fake Vitals Tech' }).click();
  // 1. Asked once, in the app's own dialog, with a password box.
  const dialog = p.locator('dialog[data-pulse-dialog="prompt"]');
  await dialog.waitFor({ state: 'visible', timeout: 60000 });
  assert.match(await dialog.innerText(), /Confirm it's you/);
  assert.match(await dialog.innerText(), /To open Fake Vitals Tech, type your own Pulse password once/);
  assert.equal(await dialog.locator('[data-dialog-confirm]').innerText(), 'Open Fake Vitals Tech');
  assert.equal(await dialog.locator('input').getAttribute('type'), 'password');
  await shot('01-confirm');
  // 2. A wrong password: asked again, saying so.
  await dialog.locator('input').fill('Not-the-password-1');
  await dialog.locator('[data-dialog-confirm]').click();
  await p.waitForFunction(() => /not your Pulse password/.test(document.querySelector('dialog[data-pulse-dialog="prompt"]')?.textContent ?? ''), null, { timeout: 60000 });
  assert.equal(await dialog.locator('input').getAttribute('aria-invalid'), 'true', 'a wrong password marks the box');
  await shot('02-wrong');
  // 3. The right one: the switch goes through, no signing out.
  await dialog.locator('input').fill(PASSWORD);
  await dialog.locator('[data-dialog-confirm]').click();
  await p.waitForFunction(async () => { try { const a = await (await fetch('/api/v0/account', { cache: 'no-store' })).json(); return a.orgs?.find((o) => o.current)?.name === 'Fake Vitals Tech'; } catch { return false; } }, null, { timeout: 120000, polling: 2000 });
  // The new page (the other company) says so once ("Opened in …"), and its chats have drawn before the picture.
  await p.getByText('Opened in Fake Vitals Tech').first().waitFor({ timeout: 180000 });
  await p.waitForSelector('input[placeholder="Search chats"]', { timeout: 180000 });
  await p.waitForTimeout(1500);
  const w = await p.evaluate(() => ({ s: document.scrollingElement.scrollWidth, i: window.innerWidth }));
  assert.ok(w.s <= w.i + 1, `sideways scroll: ${w.s} > ${w.i}`);
  await shot('03-switched');
  console.log('PASS switch with proof', tag, failed.join(' | '));
} catch (e) {
  rc = 1; console.log('FAIL', tag, String(e).slice(0, 500), failed.join(' | '));
  await p.screenshot({ path: `${OUT}/fail-${tag}.jpg`, type: 'jpeg', quality: 70 }).catch(() => {});
}
await browser.close();
process.exit(rc);
