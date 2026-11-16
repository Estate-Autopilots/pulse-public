// SWITCH-SMOOTH walk (owner, 16 Nov 2026: "Once you are in the Pulse account, switching between companies should be easy,
// easy, cheesy ... I don't even know what my password is"). The owner's path with synthetic stand-ins: signed in to
// "Fake Vitals Tech" with a company-only session from before 2125, they switch to Fake Estate Co, then Fake Closers Co,
// then their own workspace. The switcher shows the lock before anything starts; one proof (a code to their own e-mail,
// pasted, no password) and nothing asks again: not the next companies, not a later company sign-in on the same browser.
// Private API + web on a scratch DB seeded by tests/e2e/switch-smooth-seed.sql (the caller re-runs it before each run).
// The walk plays the mailbox: the code is read back from its hash in the scratch DB (DBURL, PSQL).
// Env: WEB, OUT, WIDTH (1440 | 363), DARK (1 | 0), DBURL, PSQL.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const WEB = process.env.WEB, OUT = process.env.OUT ?? '/tmp/switch-smooth-shots';
const WIDTH = Number(process.env.WIDTH ?? 1440), DARK = process.env.DARK === '1';
const FIRST = 'switchSmoothCompanyWalkToken0000000000000001', LATER = 'switchSmoothCompanyWalkToken0000000000000002';
const DEVICE = 'switchSmoothWalkDeviceKey-synthetic-0001';
const tag = `${WIDTH}-${DARK ? 'dark' : 'light'}`;
mkdirSync(OUT, { recursive: true });
const sql = (q) => execFileSync(process.env.PSQL ?? 'psql', [process.env.DBURL, '-XAtc', q], { encoding: 'utf8' }).trim();

/** The code the API mailed (the walk's mailbox): its hash is sha256(code:account:address). */
async function mailedCode() {
  for (let i = 0; i < 60; i++) {
    const row = sql("select code_hash || '|' || account_id || '|' || sent_to from pulse_priv.account_prove_code where account_id = 'a0000000-0000-4000-8000-0000000005a0' and code_hash is not null");
    if (row) {
      const [hash, account, to] = row.split('|');
      assert.equal(to, 'user-e5877109@gmail.com', 'the code goes to the person’s own e-mail');
      for (let n = 0; n < 1000000; n++) { const c = String(n).padStart(6, '0'); if (createHash('sha256').update(`${c}:${account}:${to}`).digest('hex') === hash) return c; }
      throw new Error('mailed code not found');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('no code was mailed');
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: WIDTH < 500 ? 780 : 900 }, colorScheme: DARK ? 'dark' : 'light', deviceScaleFactor: 1 });
const host = new URL(WEB).hostname;
await ctx.addCookies([{ name: 'pulse_session', value: FIRST, domain: host, path: '/', httpOnly: true },
  { name: 'pulse_device_key', value: DEVICE, domain: host, path: '/', httpOnly: true }]);
const calls = [];
ctx.on('response', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/v0/account/')) calls.push(`${r.request().method()} ${u.pathname} ${r.status()}`); });
let p = await ctx.newPage(); p.setDefaultTimeout(240000);
let prompts = 0;
const watchPrompts = (page) => page.exposeFunction('__ssPrompt', () => { prompts++; }).then(() => page.addInitScript(() => {
  new MutationObserver(() => { const d = document.querySelector('dialog[data-pulse-dialog="prompt"]'); if (d && !d.dataset.ssSeen) { d.dataset.ssSeen = '1'; window.__ssPrompt(); } })
    .observe(document, { childList: true, subtree: true });
}));
await watchPrompts(p);
const shot = async (name) => {
  await p.waitForTimeout(900);
  const w = await p.evaluate(() => ({ s: document.scrollingElement.scrollWidth, i: window.innerWidth }));
  assert.ok(w.s <= w.i + 1, `${name}: sideways scroll ${w.s} > ${w.i}`);
  await p.screenshot({ path: `${OUT}/${name}-${tag}.jpg`, type: 'jpeg', quality: 82 });
};
const current = async () => { try { return await p.evaluate(async () => { try { const a = await (await fetch('/api/v0/account', { cache: 'no-store' })).json(); const o = a.orgs?.find((x) => x.current); return o ? (o.mine ? 'mine' : o.name) : null; } catch { return null; } }); } catch { return null; } };
const until = async (name) => { for (let i = 0; i < 90; i++) { if (await current() === name) return; await p.waitForTimeout(2000); } assert.fail(`never reached ${name} (now ${await current()})`); };
const switcher = async () => {
  // The shell listens once the page's script has run (a first compile of `next dev` can take a minute): ask until it opens.
  const d = p.locator('[role="dialog"][aria-label^="Switch"]');
  for (let i = 0; i < 60 && !(await d.isVisible()); i++) {
    await p.evaluate(() => window.dispatchEvent(new Event('pulse:orgs-open')));
    await d.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  }
  await d.waitFor({ state: 'visible', timeout: 5000 });
  await p.waitForTimeout(1500); // account/crossing answers (the lock)
  return d;
};
const row = (d, name) => d.locator('[role="menuitemradio"]', { hasText: name });
const step = [];
let rc = 0;
try {
  await p.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('[data-viewer]', { timeout: 300000 });
  await p.waitForTimeout(1500);
  assert.equal(await current(), 'Fake Vitals Tech');

  // 1. The switcher knows before it starts: a lock and the reason on every other company.
  let d = await switcher();
  await row(d, 'Fake Estate Co').locator('[data-locked]').waitFor({ timeout: 30000 });
  assert.match(await row(d, 'Fake Estate Co').innerText(), /Confirm it’s you once/);
  assert.equal(await row(d, 'Fake Closers Co').getAttribute('data-locked'), '');
  await shot('01-switcher-locked'); step.push('lock shown');

  // 2. One tap: the code is on its way at once, the box is focused, no "Opening …" spins under it.
  await row(d, 'Fake Estate Co').click();
  const dialog = p.locator('dialog[data-pulse-dialog="prompt"]');
  await dialog.waitFor({ state: 'visible', timeout: 60000 });
  const text = await dialog.innerText();
  assert.match(text, /Confirm it's you/);
  assert.match(text, /We sent a 6-digit code to f••••@gmail\.com\. Paste it here to open Fake Estate Co\. This device won't ask again\./);
  assert.match(text, /Use my Pulse password instead/);
  const input = dialog.locator('input');
  assert.equal(await input.getAttribute('inputmode'), 'numeric');
  assert.equal(await input.getAttribute('autocomplete'), 'one-time-code');
  assert.equal(await input.getAttribute('type'), 'text', 'not a password box');
  assert.ok(await input.evaluate((el) => el === document.activeElement), 'the code box has the focus');
  assert.equal(await p.getByText('Opening Fake Estate Co…').count(), 0, 'no "Opening …" while it asks');
  await shot('02-code'); step.push('code asked');

  // 3. The code from the e-mail, pasted with a space: Fake Estate Co opens.
  const code = await mailedCode();
  await input.fill(`${code.slice(0, 3)} ${code.slice(3)}`);
  await dialog.locator('[data-dialog-confirm]').click();
  await until('Fake Estate Co');
  // "Opened in …" is the shell's own note (BUG-SWEEP-2 / ORG-PER-TAB); this walk records it but does not depend on it:
  // the company the tab is in (current()) is what this change is about.
  const opened = await p.getByText('Opened in Fake Estate Co').first().waitFor({ timeout: 30000 }).then(() => true, () => false);
  step.push(opened ? 'opened note' : 'no opened note (shell)');
  await p.waitForSelector('input[placeholder="Search chats"]', { timeout: 180000 });
  await shot('03-estate'); step.push('Fake Estate Co');

  // 4. Fake Closers Co: no lock, no question.
  d = await switcher();
  assert.equal(await d.locator('[data-locked]').count(), 0, 'nothing is locked after one proof');
  await shot('04-switcher-open');
  await row(d, 'Fake Closers Co').click();
  await until('Fake Closers Co');
  await p.waitForSelector('input[placeholder="Search chats"]', { timeout: 180000 });
  await shot('05-closers'); step.push('Fake Closers Co');

  // 5. Their own workspace (the personal space): no question either.
  d = await switcher();
  await d.locator('[role="menuitemradio"][data-mine]').click();
  await until('mine');
  await p.waitForSelector('[data-viewer]', { timeout: 180000 });
  await shot('06-workspace'); step.push('own workspace');

  // 6. Later, a company's own sign-in on this same browser (a new tab): this device is trusted, so it switches in one tap.
  await ctx.clearCookies({ name: 'pulse_view' }); // a fresh sign-in opens its own company first
  await ctx.addCookies([{ name: 'pulse_session', value: LATER, domain: host, path: '/', httpOnly: true }]);
  p = await ctx.newPage(); p.setDefaultTimeout(240000); await watchPrompts(p);
  await p.goto(`${WEB}/chats`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('[data-viewer]', { timeout: 300000 });
  assert.equal(await current(), 'Fake Vitals Tech');
  d = await switcher();
  assert.equal(await d.locator('[data-locked]').count(), 0, 'a later company sign-in on a trusted device is not locked');
  await row(d, 'Fake Estate Co').click();
  await until('Fake Estate Co');
  await p.waitForSelector('input[placeholder="Search chats"]', { timeout: 180000 });
  await shot('07-later-sign-in'); step.push('later sign-in, one tap');

  // 7. Settings -> Account access lists this device, with Forget.
  await p.goto(`${WEB}/settings?tab=account&part=access`, { waitUntil: 'domcontentloaded' });
  const dev = p.locator('[data-devices] [data-device-row]').first();
  await dev.waitFor({ timeout: 240000 });
  assert.match(await dev.innerText(), /this device/);
  assert.match(await dev.innerText(), /Confirmed with a code to your e-mail/);
  await p.locator('[data-devices]').scrollIntoViewIfNeeded();
  await shot('08-access-devices'); step.push('Account access');

  assert.equal(prompts, 1, `asked ${prompts} times`);
  assert.equal(calls.filter((c) => c.startsWith('POST /api/v0/account/prove-code')).length, 2, calls.join(' | '));
  assert.ok(!calls.some((c) => c.startsWith('POST /api/v0/account/prove ')), 'no password was asked for');
  console.log('PASS', tag, step.join(' -> '), '| prompts', prompts);
} catch (e) {
  rc = 1; console.log('FAIL', tag, 'after', step.join(' -> ') || 'start', String(e).slice(0, 600), '|', calls.slice(-12).join(' | '));
  await p.screenshot({ path: `${OUT}/fail-${tag}.jpg`, type: 'jpeg', quality: 70 }).catch(() => {});
}
await browser.close();
process.exit(rc);
