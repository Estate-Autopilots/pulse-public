// ACCOUNT-META walk (owner, 15 Nov 2026): a person signs in only with the e-mails they name as their own; a company's
// sign-in opens that company only. Private API + web on a scratch DB seeded by account-meta-seed.sql (synthetic).
// It shoots Settings -> Account access for the personal and the company-only session, the add-an-e-mail step, and the
// sign-in page after "Send me a code", at 363 and 1440 in light and dark. Then it checks the rules through the API.
// Env: WEB, API, OUT.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const WEB = process.env.WEB, API = process.env.API, OUT = process.env.OUT ?? '/tmp/account-meta-shots';
const PERSONAL = 'acctmetaPersonalWalkToken0000000000000000001', COMPANY = 'acctmetaCompanyWalkToken00000000000000000002';
mkdirSync(OUT, { recursive: true });
const host = new URL(WEB).hostname;
const results = [];
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const step = async (name, fn) => { if (ONLY && !ONLY.test(name)) return; try { await fn(); results.push(['pass', name]); console.log('PASS', name); } catch (e) { results.push(['FAIL', name, String(e).slice(0, 300)]); console.log('FAIL', name, String(e).slice(0, 300)); } };

const browser = await chromium.launch();
async function page(width, dark, token) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 780 : 900 }, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: 1 });
  if (token) await ctx.addCookies([{ name: 'pulse_session', value: token, domain: host, path: '/', httpOnly: true }]);
  const p = await ctx.newPage(); p.setDefaultTimeout(120000);
  return { ctx, p };
}
const noSideways = async (p) => {
  const w = await p.evaluate(() => ({ s: document.scrollingElement.scrollWidth, i: window.innerWidth }));
  assert.ok(w.s <= w.i + 1, `sideways scroll: ${w.s} > ${w.i}`);
};
// Desktop: the whole page. Phone: what the screen shows (a full-page capture draws sticky bars mid-page).
const shot = async (p, name) => { await p.waitForTimeout(800); const phone = p.viewportSize().width < 500;
  await p.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 82, fullPage: !phone }); };

// 1. Account access, personal session and company-only session.
for (const [who, token] of [['personal', PERSONAL], ['company', COMPANY]]) {
  for (const [width, dark] of who === 'personal' ? [[1440, false], [1440, true], [363, false], [363, true]] : [[1440, false], [363, true]]) {
    await step(`access ${who} ${width} ${dark ? 'dark' : 'light'}`, async () => {
      const { ctx, p } = await page(width, dark, token);
      await p.goto(`${WEB}/settings?tab=account&part=access`, { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('[data-account-access]', { timeout: 180000 });
      const text = await p.locator('[data-account-access]').innerText();
      assert.match(text, /only e.mails that you alone read can sign you in/i);
      assert.match(text, /fake\.meta\.person@gmail\.com/); assert.match(text, /fake\.meta@fakeestate\.example/);
      assert.match(text, /admin@fakeestate\.example was removed/); assert.match(text, /because it is a shared mailbox/);
      if (who === 'company') { assert.match(text, /so you can only look here/); assert.ok(await p.locator('a', { hasText: 'Sign in as yourself' }).isVisible()); assert.equal(await p.locator('[data-email-row] button').count(), 0); }
      else { assert.equal(await p.locator('[data-email-row] button[aria-label^="Actions for"]').count(), 1, 'actions on the e-mail that is not the main one'); assert.doesNotMatch(text, /so you can only look here/); }
      await noSideways(p);
      await shot(p, `access-${who}-${width}-${dark ? 'dark' : 'light'}`);
      await ctx.close();
    });
  }
}

// 2. Adding an e-mail: the code step (mail goes to the API's sink). One code a minute per account: wait between the two.
for (const [width, dark] of [[1440, false], [363, true]]) {
  if (width === 363) await new Promise((done) => setTimeout(done, 62000));
  await step(`add e-mail code step ${width} ${dark ? 'dark' : 'light'}`, async () => {
    const { ctx, p } = await page(width, dark, PERSONAL);
    await p.goto(`${WEB}/settings?tab=account&part=access`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-account-access]', { timeout: 180000 });
    for (let tries = 0; ; tries++) {
      // The form opens from "+ Add an e-mail"; the dev server may hydrate late, so open it again on each try.
      if (!await p.locator('#aa-new-email').count()) await p.click('[data-add-open]');
      await p.fill('input[type=email]', `fake.meta.new${width}@gmail.com`);
      if (tries === 0) { // the inbox tick comes first: without it, nothing is sent
        await p.click('button:has-text("Send code")');
        await p.waitForSelector('text=Tick “Only I can read this inbox” first', { timeout: 20000 }).catch(() => {});
      }
      await p.check('[data-account-access] input[type=checkbox]');
      await p.click('button:has-text("Send code")');
      try { await p.waitForSelector('text=We sent a 6-digit code to', { timeout: 20000 }); break; } catch (e) { if (tries >= 2) throw e; }
    }
    assert.match(await p.locator('[data-account-access]').innerText(), new RegExp(`fake\\.meta\\.new${width}@gmail\\.com`));
    assert.ok(await p.locator('button', { hasText: /Send again in \d+ s/ }).isDisabled());
    await p.locator('input[name=code]').scrollIntoViewIfNeeded();
    await noSideways(p);
    await shot(p, `add-code-${width}-${dark ? 'dark' : 'light'}`);
    await ctx.close();
  });
}

// 3. The sign-in page after "Send me a code": the masked address, the countdown, the help.
for (const [width, dark] of [[1440, false], [1440, true], [363, false], [363, true]]) {
  await step(`sign-in code sent ${width} ${dark ? 'dark' : 'light'}`, async () => {
    const { ctx, p } = await page(width, dark, null);
    await p.goto(`${WEB}/login?google=off`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('input[name=username]', { timeout: 180000 });
    p.on('response', (r) => { if (r.url().includes('sign-in-code')) console.log('  sign-in-code', r.status()); });
    try { await p.fill('input[name=username]', 'user-ee6dcf51@gmail.com'); } catch (e) { await p.screenshot({ path: `${OUT}/fail-signin-${width}.jpg`, type: 'jpeg' }); throw e; }
    // The dev server hydrates late on this box: a click before hydration does nothing, so try up to three times.
    for (let tries = 0; ; tries++) {
      // Hydration resets the field when it lands after the typing: type again on each try.
      await p.fill('input[name=username]', 'user-ee6dcf51@gmail.com');
      await p.click('button:has-text("Send me a code")');
      try { await p.waitForSelector('text=a 6-digit code is on its way', { timeout: 20000 }); break; } catch (e) { if (tries >= 2) { await p.screenshot({ path: `${OUT}/fail-signin-${width}-${dark ? 'dark' : 'light'}.jpg`, type: 'jpeg' }); throw e; } }
    }
    const body = await p.locator('body').innerText();
    assert.match(body, /Code for f••••@gmail\.com/); assert.match(body, /If this e-mail has an account, a 6-digit code is on its way/); assert.match(body, /Not getting it\? Check spam/);
    assert.doesNotMatch(body, /fake\.meta\.person@gmail\.com/, 'the full address is not shown again');
    assert.match(body, /Send a new code in \d+ s/);
    await noSideways(p);
    await shot(p, `signin-sent-${width}-${dark ? 'dark' : 'light'}`);
    await ctx.close();
  });
}

// 4. /profile is the person's one profile (the menu's "My profile").
await step('profile page', async () => {
  const { ctx, p } = await page(1440, false, PERSONAL);
  const r = await p.goto(`${WEB}/profile`, { waitUntil: 'domcontentloaded' });
  assert.equal(r.status(), 200);
  await p.waitForSelector('text=Your profile in all companies', { timeout: 180000 });
  await ctx.close();
});

// 5. The rules through the API: a company-only session stays in its company and cannot change the sign-in.
const call = async (token, path, body) => {
  const r = await fetch(`${API}${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-pulse-session': token, 'content-type': 'application/json', 'x-pulse-client-ip': '203.0.113.9' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
await step('api: company session cannot switch or change e-mails; personal session can switch', async () => {
  const fvm = 'f1000000-0000-4000-8000-0000000000a1', fem = 'f2000000-0000-4000-8000-0000000000a2';
  const sw = await call(COMPANY, '/api/v0/account/switch', { org: fvm });
  assert.equal(sw.status, 403); assert.match(sw.data.error, /sign in as yourself/);
  const add = await call(COMPANY, '/api/v0/account/emails', { action: 'start', email: 'user-e714be3c@gmail.com' });
  assert.equal(add.status, 403); assert.match(add.data.error, /Sign in as yourself/);
  const shared = await call(PERSONAL, '/api/v0/account/emails', { action: 'start', email: 'billing@fakeestate.example' });
  assert.equal(shared.status, 400); assert.match(shared.data.error, /shared mailbox/);
  const access = await call(COMPANY, '/api/v0/account/access');
  assert.equal(access.status, 200); assert.equal(access.data.personalSession, false); assert.equal(access.data.protected, true);
  const moved = await call(PERSONAL, '/api/v0/account/switch', { org: fem });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
});

await browser.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`WALK ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
