// ORG journey J9 (TOP-JOURNEYS.md) in a real browser against a running Pulse (pulse-dev's origin by default):
//   (a) the owner opens the org switcher (Ctrl+Shift+O) → the second organisation → it opens at once (its chats and
//       tasks) → back to EA with one key;
//   (b) a freelancer invited by two organisations joins both from their links and sees both in the switcher;
//   (c) a client of EA joins, sees only the work shared with them, presses "Start your own Pulse" and switches between
//       their organisation and EA's client space.
// Desktop 1440×900 (light) and a phone pass at 390×844 (dark). Videos and screenshots go to J9_OUT.
//
//   J9_BASE=http://localhost:3200 J9_OWNER=user-668d21b6@estateautopilots.com J9_SECOND="Atlas Crest (rehearsal)" \
//   J9_OUT=~/ea-research/ux/journeys/J9 node services/api/test/org-journey.mjs
// On an Access address the web reads Cloudflare Access's identity header; the run sets it for the owner and, standing in
// for the public sign-in bypass the shared address needs, a placeholder one for the freelancer and the client, whose
// Pulse sign-in is their own account session.
import assert from 'node:assert/strict';
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';

const { chromium } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const BASE = process.env.J9_BASE ?? 'http://localhost:3200';
const OWNER = process.env.J9_OWNER ?? 'user-668d21b6@estateautopilots.com';
const SECOND = process.env.J9_SECOND ?? 'Atlas Crest (rehearsal)';
const OUT = process.env.J9_OUT ?? '/tmp/j9';
const run = Date.now().toString(36).slice(-5);
const PASSWORD = 'Journey-nine-pass-9'; // gitleaks:allow (a synthetic dev-only journey password)
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const steps = []; let shot = 0;
const step = (s) => { steps.push(s); console.log('·', s); };

async function context(name, { email, viewport = { width: 1440, height: 900 }, dark = false } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: dark ? 'dark' : 'light', recordVideo: { dir: `${OUT}/raw-${name}`, size: viewport },
    extraHTTPHeaders: email ? { 'cf-access-authenticated-user-email': email } : {} });
  const page = await ctx.newPage(); page.setDefaultTimeout(120_000); page.setDefaultNavigationTimeout(180_000);
  page.on('pageerror', (e) => console.log(`  [${name}] page error: ${e.message}`));
  return { ctx, page, name };
}
async function snap(page, label) { shot++; await page.screenshot({ path: `${OUT}/${String(shot).padStart(2, '0')}-${label}.png` }); }
async function finish({ ctx, page, name }) {
  const video = page.video(); await ctx.close();
  if (video) { const path = await video.path(); await rename(path, `${OUT}/J9-${name}.webm`).catch(() => {}); }
}
const trigger = (page) => page.locator('[aria-label^="Organisation: "]').first();
async function orgName(page) {
  const label = await trigger(page).getAttribute('aria-label').catch(() => null);
  return label ? label.replace(/^Organisation: /, '').replace(/\. Switch organisation$/, '') : null;
}
async function openSwitcher(page) {
  await page.keyboard.press('Control+Shift+O');
  await page.getByRole('dialog', { name: 'Switch organisation' }).waitFor();
}
async function switchTo(page, name) {
  const t0 = Date.now();
  await openSwitcher(page);
  await page.getByRole('dialog', { name: 'Switch organisation' }).getByRole('menuitemradio', { name: new RegExp(name.replace(/[()]/g, '\\$&')) }).click();
  await page.getByRole('status').filter({ hasText: 'Opening' }).waitFor({ timeout: 3000 }).catch(() => {});
  await page.waitForFunction((n) => document.querySelector('[aria-label^="Organisation: "]')?.getAttribute('aria-label')?.includes(n), name, { timeout: 120_000 });
  return Date.now() - t0;
}
async function inviteLink(page, kind, title) {
  await page.goto(`${BASE}/orgs`);
  await page.getByRole('group', { name: 'They join as' }).getByRole('button', { name: kind }).click();
  await page.getByLabel(/Their role/).fill(title);
  await page.getByRole('button', { name: 'Make link' }).click();
  const link = (await page.locator('code').filter({ hasText: '/join#' }).first().textContent())?.trim();
  assert.ok(link && /\/join#[A-Za-z0-9_-]{43}$/.test(link), `an invitation link: ${link}`);
  return link.replace(/^https?:\/\/[^/]+/, BASE);
}

const report = { base: BASE, run, checks: 0, timings: {} };
const ok = (c, m) => { report.checks++; assert.ok(c, m); };
try {
  // ------------------------------------------------------------------------------------------------ (a) the owner
  const owner = await context('owner', { email: OWNER });
  let p = owner.page;
  await p.goto(`${BASE}/dashboard`); await trigger(p).waitFor();
  const home = await orgName(p); ok(home, 'the sidebar names the organisation'); step(`owner in ${home}`);
  await openSwitcher(p); await snap(p, 'owner-switcher');
  ok(await p.getByRole('dialog').getByRole('menuitemradio', { name: new RegExp(SECOND.replace(/[()]/g, '\\$&')) }).count() === 1, `${SECOND} is in the switcher`);
  await p.keyboard.press('Escape');
  report.timings.toSecond = await switchTo(p, SECOND); step(`switched to ${SECOND} in ${report.timings.toSecond} ms`);
  await snap(p, 'owner-second-org-home');
  await p.goto(`${BASE}/chats`); await p.waitForLoadState('networkidle').catch(() => {});
  ok(await orgName(p) === SECOND, 'chats open in the second organisation'); await snap(p, 'owner-second-org-chats');
  await p.goto(`${BASE}/tasks`); await p.waitForLoadState('networkidle').catch(() => {});
  ok(await orgName(p) === SECOND, 'tasks open in the second organisation'); await snap(p, 'owner-second-org-tasks');
  // Back with the number key: EA is second in the list (the active organisation is first).
  await openSwitcher(p); const t0 = Date.now(); await p.keyboard.press('2');
  await p.waitForFunction((n) => document.querySelector('[aria-label^="Organisation: "]')?.getAttribute('aria-label')?.includes(n), home, { timeout: 120_000 });
  report.timings.back = Date.now() - t0; ok(await orgName(p) === home, 'back in EA'); step(`back to ${home} with "2" in ${report.timings.back} ms`);

  // Invitations from both organisations for the freelancer, one for the client.
  const freelancerInEa = await inviteLink(p, 'Freelancer', `Video editor (J9 ${run})`); await snap(p, 'owner-invite-link');
  const clientInEa = await inviteLink(p, 'Client', `Client · J9 Homes ${run}`);
  await switchTo(p, SECOND);
  const freelancerInSecond = await inviteLink(p, 'Freelancer', `Motion designer (J9 ${run})`);
  await switchTo(p, home);
  step('owner made three invitation links (EA freelancer, EA client, second-org freelancer)');

  // ------------------------------------------------------------------------------------------------ (b) the freelancer
  const free = await context('freelancer', { email: `j9-freelancer-${run}@outside.example` });
  p = free.page;
  await p.goto(freelancerInEa); await p.getByRole('heading', { name: new RegExp(`Join ${home}`) }).waitFor();
  // Signed in through Access only (no Pulse person): the page offers the account form.
  const joinButton = p.getByRole('button', { name: /Create account and join/ });
  if (await joinButton.count()) {
    await p.getByLabel('Your name').fill(`Fara J9 ${run}`);
    await p.getByLabel('Your handle').fill(`fara${run}`);
    await p.getByLabel('Password').fill(PASSWORD);
    await snap(p, 'freelancer-join'); await joinButton.click();
  } else { await p.getByRole('button', { name: /^Join as/ }).click(); }
  await trigger(p).waitFor(); ok(await orgName(p) === home, 'the freelancer is in EA'); step('freelancer joined EA from the link');
  await p.goto(freelancerInSecond); await p.getByRole('button', { name: /^Join as @/ }).click();
  await trigger(p).waitFor(); ok(await orgName(p) === SECOND, 'and in the second organisation'); step('freelancer joined the second organisation while signed in');
  await openSwitcher(p); await snap(p, 'freelancer-two-orgs');
  ok(await p.getByRole('dialog').getByRole('menuitemradio').count() === 2, 'the freelancer sees both organisations');
  await p.keyboard.press('Escape');
  await p.goto(`${BASE}/orgs/profile`); await p.getByLabel('Headline').fill('Video editor · reels and walkthroughs');
  await p.getByRole('button', { name: 'Save profile' }).click(); await p.getByText('Saved.').waitFor(); await snap(p, 'freelancer-profile');
  step('freelancer saved the profile that travels');

  // ------------------------------------------------------------------------------------------------ (c) the client
  const client = await context('client', { email: `j9-client-${run}@outside.example` });
  p = client.page;
  await p.goto(clientInEa); await p.getByLabel('Your name').fill(`Cleo J9 ${run}`); await p.getByLabel('Your handle').fill(`cleo${run}`);
  await p.getByLabel('Password').fill(PASSWORD); await p.getByRole('button', { name: /Create account and join/ }).click();
  await p.waitForURL(/\/tasks/); ok(await orgName(p) === home, 'the client is in EA'); await snap(p, 'client-in-ea');
  const people = await p.request.get(`${BASE}/api/v0/people`); ok(people.status() === 403, 'a client does not see EA\'s people');
  step('client joined EA and sees their work only');
  await p.goto(`${BASE}/orgs`); await p.getByRole('link', { name: /Start your own Pulse/ }).first().click();
  await p.getByLabel('Organisation name').fill(`J9 Homes ${run}`);
  await p.getByRole('button', { name: /Real-estate developer/ }).click(); await snap(p, 'client-start-own');
  const t1 = Date.now(); await p.getByRole('button', { name: /^Start J9 Homes/ }).click();
  await p.waitForFunction((n) => document.querySelector('[aria-label^="Organisation: "]')?.getAttribute('aria-label')?.includes(n), `J9 Homes ${run}`, { timeout: 150_000 });
  report.timings.start = Date.now() - t1; ok(true, 'own Pulse started'); step(`client started "J9 Homes ${run}" in ${report.timings.start} ms`);
  await snap(p, 'client-own-org');
  await switchTo(p, home); await p.waitForURL(/\/tasks/); ok(true, 'back to EA as its client'); await snap(p, 'client-back-in-ea');
  await switchTo(p, `J9 Homes ${run}`); ok(await orgName(p) === `J9 Homes ${run}`, 'and into their own again');
  step('client switched between their own Pulse and EA\'s client space');

  // ------------------------------------------------------------------------------------------------ phone, dark
  const phone = await context('owner-phone', { email: OWNER, viewport: { width: 390, height: 844 }, dark: true });
  p = phone.page; await p.goto(`${BASE}/dashboard`); await p.waitForLoadState('networkidle').catch(() => {});
  await p.evaluate(() => window.dispatchEvent(new Event('pulse:orgs-open')));
  await p.getByRole('dialog', { name: 'Switch organisation' }).waitFor(); await snap(p, 'phone-switcher-dark');
  const box = await p.getByRole('dialog').boundingBox(); ok(box && box.width <= 390 && box.x >= 0, 'the switcher fits the phone');
  await p.getByRole('dialog').getByRole('menuitemradio', { name: new RegExp(SECOND.replace(/[()]/g, '\\$&')) }).click();
  await p.waitForLoadState('load'); await p.waitForTimeout(1500); await snap(p, 'phone-second-org-dark');
  // Leave the owner where he started.
  await p.evaluate(() => window.dispatchEvent(new Event('pulse:orgs-open')));
  await p.getByRole('dialog').getByRole('menuitemradio').nth(1).click(); await p.waitForLoadState('load');
  step('phone (390 px, dark): the switcher fits and switches');

  for (const c of [owner, free, client, phone]) await finish(c);
  for (const d of await readdir(OUT)) if (d.startsWith('raw-')) await import('node:fs/promises').then((fs) => fs.rm(`${OUT}/${d}`, { recursive: true, force: true }));
  report.steps = steps; report.pass = true;
  await writeFile(`${OUT}/J9.json`, JSON.stringify(report, null, 1));
  console.log(`J9: PASS (${report.checks} checks) · switch ${report.timings.toSecond} ms, back ${report.timings.back} ms, start ${report.timings.start} ms`);
} catch (e) {
  report.steps = steps; report.pass = false; report.error = String(e?.message ?? e);
  await writeFile(`${OUT}/J9.json`, JSON.stringify(report, null, 1));
  console.error('J9: FAIL', e); process.exitCode = 1;
} finally { await browser.close(); }
