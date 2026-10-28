// AUTH-UNIFY browser journey (Playwright): sign in once → switch EA → AC → EA with no sign-in again → sign out.
// Runs against a Pulse web (pulse-dev: http://127.0.0.1:3200) with a synthetic person who belongs to two organisations.
//   PULSE_WEB=http://127.0.0.1:3200 JOURNEY_USER=… JOURNEY_PASSWORD=… JOURNEY_ORG_A=<org id> JOURNEY_ORG_B=<org id> \
//   JOURNEY_SHOTS=/tmp/dir node tests/e2e/auth-unify-journey.mjs
// Prints one JSON line of checks; never prints the password. PLAYWRIGHT_CORE may point at playwright-core's index.mjs.
import assert from 'node:assert/strict';

const core = process.env.PLAYWRIGHT_CORE ?? 'playwright-core';
const { chromium } = await import(core);
const base = process.env.PULSE_WEB ?? 'http://127.0.0.1:3200';
const [user, password, orgA, orgB] = ['JOURNEY_USER', 'JOURNEY_PASSWORD', 'JOURNEY_ORG_A', 'JOURNEY_ORG_B'].map((k) => {
  const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v;
});
const shots = process.env.JOURNEY_SHOTS;
const checks = [];
const ok = (cond, what) => { assert.ok(cond, what); checks.push(what); };

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const me = () => page.evaluate(async () => { const r = await fetch('/api/v0/me', { cache: 'no-store' }); return { status: r.status, body: r.ok ? await r.json() : null }; });
  const cookie = async () => (await context.cookies()).find((c) => c.name === 'pulse_session')?.value ?? null;
  const shot = async (name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };

  // 1. Sign in once.
  // Wait for the page's script (a form sent before it loads would go out as a GET with the password in the address).
  await page.goto(`${base}/login`, { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => !!document.querySelector('form') && Object.keys(document.querySelector('form')).some((k) => k.startsWith('__react')), null, { timeout: 60000 });
  await page.locator('input[name="username"]').fill(user);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 90000 });
  let m = await me();
  ok(m.status === 200, 'signed in');
  const token = await cookie();
  ok(!!token, 'one session cookie');
  // "One password for all your workspaces" is asked once: later, for this journey.
  const later = page.getByRole('button', { name: 'Later' });
  if (await later.isVisible({ timeout: 4000 }).catch(() => false)) { await shot('1-unify-prompt'); await later.click(); checks.push('asked once for one password'); }
  if (m.body.org !== orgA) {   // landed in the workspace used last: start the journey from A
    await page.evaluate((org) => fetch('/api/v0/account/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ org }) }), orgA);
    await page.goto(`${base}/`); m = await me();
  }
  ok(m.body.org === orgA, 'in organisation A');
  // The app keeps live streams open (never network-idle): the page's load, then a moment for its script.
  await page.goto(`${base}/tasks`, { waitUntil: 'load', timeout: 120000 }); await page.waitForTimeout(3000);
  await shot('2-in-A');

  // 2. A → B → A through the switcher (Ctrl+Shift+O), no sign-in page in between, the same cookie throughout.
  for (const [to, label] of [[orgB, 'B'], [orgA, 'A']]) {
    await page.waitForLoadState('load', { timeout: 120000 }); await page.waitForTimeout(2000);
    await page.keyboard.press('Control+Shift+O');
    const dialog = page.getByRole('dialog', { name: 'Switch organisation' });
    // The rail's organisation tile sends the same event the shortcut does.
    if (!await dialog.isVisible({ timeout: 5000 }).catch(() => false)) await page.evaluate(() => window.dispatchEvent(new Event('pulse:orgs-open')));
    await dialog.waitFor({ timeout: 15000 }).catch(async (e) => { await shot(`fail-switcher-${label}`); throw e; });
    const names = await dialog.getByRole('menuitemradio').allInnerTexts();
    ok(names.length >= 2, `the switcher lists ${names.length} workspaces`);
    await shot(`3-switcher-to-${label}`);
    await dialog.getByRole('menuitemradio', { checked: false }).first().click();
    await page.waitForLoadState('load', { timeout: 120000 });
    await page.waitForFunction(async (org) => { const r = await fetch('/api/v0/me', { cache: 'no-store' }); return r.ok && (await r.json()).org === org; }, to, { timeout: 20000 });
    ok(!new URL(page.url()).pathname.startsWith('/login'), `switched to ${label} without the sign-in page`);
    ok(new URL(page.url()).pathname === '/tasks', `stayed on the equivalent page (${new URL(page.url()).pathname})`);
    m = await me();
    ok(m.status === 200 && m.body.org === to, `now in organisation ${label}`);
    ok((await cookie()) === token, `the same session after switching to ${label}`);
    await shot(`4-in-${label}`);
  }

  // 3. Sign out: the session ends everywhere.
  await page.evaluate(() => fetch('/api/v0/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  m = await me();
  ok(m.status === 401, 'signed out');
  await page.goto(`${base}/`);
  await page.waitForURL((u) => u.pathname.startsWith('/login'), { timeout: 15000 }).catch(() => {});
  ok(new URL(page.url()).pathname.startsWith('/login'), 'back at the sign-in page');
  console.log(JSON.stringify({ ok: true, checks }));
} finally {
  await browser.close();
}
