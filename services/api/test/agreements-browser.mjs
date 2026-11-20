// AGREEMENTS round 14 Nov in the browser (tests/core/test_agreements_offers.py::test_agreements_in_the_browser): the real
// API (this process) on a disposable synthetic company and the web app (`next start` when a build exists, else `next dev`).
// People → Agreements end to end, each step by the role that does it, at 1440 and 363 px, light and dark:
//   HR opens People → Agreements (the right panel says what the page is for) → "Make an offer letter" → someone new
//   (name, role, e-mail: added to Pulse, the offer form opens) → someone in Pulse → role, pay, joining date, probation,
//   notice, the letter drawn → "Ask a founder";
//   a founder picks it (where it stands, what happens next) → reviews and approves it → sends it;
//   the person, on a phone, finds it on their next visit: the letter's terms one by one, every one ticked, "I accept";
//   the pay record follows the accepted offer, the signed letter opens for them and shows in My pay → Letters;
//   HR sees it accepted in Pulse, with the signed letter.
// Fails on a page error or a 5xx answer. PULSE_AGREEMENTS_SCREENSHOTS=<dir> keeps the screenshots. Synthetic people only;
// nothing is sent to anyone.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { spawn } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../dist/app.js';
const R = JSON.parse(process.env.TEST_ROLES), ORG = process.env.PULSE_ORG_ID;
const keyFile = join(process.env.TEST_KEY_DIR, 'document-master.key');
await writeFile(keyFile, `agreements-2026-11 ${randomBytes(32).toString('base64')}\n`, { mode: 0o600 }); await chmod(keyFile, 0o600);
process.env.PULSE_DOCUMENT_KEY_FILE = keyFile;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const owner = new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
for (const p of [pool, owner]) p.on('error', (e) => console.error(`pool: ${e.code ?? e.message}`));
const shots = process.env.PULSE_AGREEMENTS_SCREENSHOTS; if (shots) await mkdir(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
// A built app (CI builds .next) starts in seconds; without one, `next dev` in its own folder compiles each page on its first visit.
const dist = process.env.NEXT_DIST_DIR ?? '.next', built = existsSync(join('../../apps/web', dist, 'BUILD_ID'));
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', built ? 'start' : 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web',
  env: { ...process.env, PULSE_API_URL: origin, PULSE_PUBLIC_URL: base, NODE_ENV: built ? 'production' : 'development', PULSE_PUBLIC_LOGIN_ENABLED: '0', NEXT_TELEMETRY_DISABLED: '1',
    NEXT_DIST_DIR: built ? dist : '.next-agreements-walk' }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
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
const deadline = setTimeout(() => { console.error('agreements-browser: no result after 30 minutes'); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 30 * 60_000);
deadline.unref();

let browser; const results = [], errors = [], pages = []; let checks = 0;
const ok = (condition, msg) => { checks++; assert.ok(condition, msg); };
async function own(sql, args = []) {
  const c = await owner.connect();
  try { await c.query('begin'); await c.query('set local role pulse_owner'); await c.query("select set_config('pulse.org_id',$1,true)", [ORG]); const r = await c.query(sql, args); await c.query('commit'); return r.rows; }
  catch (e) { await c.query('rollback').catch(() => null); throw e; } finally { c.release(); }
}
const ready = async (page) => { await page.waitForFunction(() => document.querySelector('main h1,main h2,main h3') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 240000 }); await page.waitForTimeout(400); };
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load', timeout: 300000 }); await ready(page); };
const posted = (page, re) => page.waitForResponse((r) => r.request().method() === 'POST' && new RegExp(`^/api/v0/(?:${re})$`).test(new URL(r.url()).pathname), { timeout: 60000 });
async function as(role, width = 1440, theme = 'light') {
  const phone = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 800 : 900 }, colorScheme: theme, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone,
    extraHTTPHeaders: { 'cf-access-authenticated-user-email': `${role}@comp.example` } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('theme', t); } catch { /* private mode */ } }, theme);
  const page = await ctx.newPage(); pages.push(page);
  page.on('pageerror', (e) => errors.push(`${role} ${width}: ${e.message.slice(0, 200)}`));
  page.on('response', (r) => { if (r.status() >= 500 && r.url().startsWith(base)) errors.push(`${role} ${width}: HTTP ${r.status()} ${r.url().slice(base.length)}`); });
  return page;
}
async function shot(page, name) { if (shots) { await page.waitForTimeout(500); await page.screenshot({ path: `${shots}/${name}.png` }); } }
async function noSideways(page, label) {
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  ok(w[0] <= w[1] + 1, `${label}: no sideways scroll (${w[0]} > ${w[1]})`);
}
async function flow(name, run) {
  const started = Date.now();
  try { await run(); results.push({ name, ok: true, ms: Date.now() - started }); console.log(`PASS ${name} (${Math.round((Date.now() - started) / 1000)} s)`); }
  catch (e) {
    const error = String(e?.message ?? e).split('\n').slice(0, 6).join(' | ').slice(0, 900);
    results.push({ name, ok: false, error }); console.log(`FAIL ${name}: ${error}`);
    if (shots) for (const [i, p] of pages.entries()) if (!p.isClosed()) await p.screenshot({ path: `${shots}/fail-${name}-${i}.png` }).catch(() => null);
  }
  for (const p of pages.splice(0)) await p.context().close().catch(() => null);
}
const today = (await own('select pulse.lifecycle_today()::text d'))[0].d;
const offerId = async () => (await own('select id::text from pulse.comp_offer where person_id=$1 order by created_at desc limit 1', [R.person]))[0]?.id;

try {
  for (let i = 0; i < 1200; i++) {
    try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(60000) })).ok) break; } catch { /* starting */ }
    if (serverExit !== null) throw Error(`next exited (${serverExit}): ${serverTail.trim().slice(-600)}`);
    await delay(500); if (i === 1199) throw Error('next did not start');
  }
  browser = await chromium.launch();

  await flow('1-hr-starts-an-offer-letter', async () => {
    const page = await as('hr', 1440, 'light'); await go(page, '/people/agreements');
    // Nothing picked: the right side says what the page is for and the next action.
    await expect(page.getByRole('heading', { name: 'Your team’s papers, in one place' })).toBeVisible({ timeout: 60000 });
    await expect(page.getByRole('button', { name: 'Make an offer letter' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Pay policy → letters' })).toBeVisible();
    await shot(page, 'workspace-1440-light');
    // Someone new: name, role and e-mail add them to Pulse, then People & pay's offer form opens for them.
    await page.getByRole('button', { name: 'Make an offer letter' }).click();
    await expect(page.getByRole('heading', { name: 'Who is it for?' })).toBeVisible();
    await page.getByRole('radio', { name: /Someone new/ }).click();
    await page.getByLabel('Full name').fill('Kavya Nair');
    await page.getByLabel('Role', { exact: true }).fill('Motion designer');
    await page.getByLabel('E-mail (optional)').fill('kavya.nair@comp.example');
    await shot(page, 'new-offer-someone-new-1440-light');
    const added = posted(page, 'people'); await page.getByRole('button', { name: 'Next: the offer' }).click(); ok((await added).ok(), 'someone new is added to Pulse');
    let d = page.getByRole('dialog', { name: /Offer for Kavya Nair/ });
    await expect(d).toBeVisible({ timeout: 60000 });
    await expect(d.getByLabel('Role')).toHaveValue('Motion designer');
    await d.getByRole('button', { name: 'Cancel' }).click();
    const kavya = await own("select p.status, pp.role from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.display_name='Kavya Nair'");
    ok(kavya.length === 1 && kavya[0].role === 'Motion designer', `Kavya is in Pulse with the role (${JSON.stringify(kavya)})`);
    // Someone in Pulse: Rifob, then the role, pay, joining date, probation and notice, with the letter drawn beside them.
    await page.getByRole('button', { name: 'Make an offer letter' }).click();
    const pick = page.getByLabel('Person'); await expect(pick.locator('option', { hasText: 'Rifob Mifos' })).toHaveCount(1, { timeout: 60000 });
    await pick.selectOption(await pick.locator('option', { hasText: 'Rifob Mifos' }).getAttribute('value'));
    await page.getByRole('button', { name: 'Next: the offer' }).click();
    d = page.getByRole('dialog', { name: /Offer for Rifob Mifos/ });
    await expect(d).toBeVisible({ timeout: 60000 });
    await d.getByLabel('Role').fill('Senior video editor');
    await d.getByLabel('Starts on').fill(today);
    await d.getByLabel('Gross pay a month').fill('48,000');
    await d.getByRole('textbox', { name: /^Probation, days/ }).fill('90');
    await d.getByLabel('Notice during probation, days').fill('15');
    await d.getByLabel('Other terms').fill('Work from the Pune studio; review after three months against the role KPIs.');
    await expect(d.getByText('The pay, by component (a month)')).toBeVisible({ timeout: 60000 });
    await expect(d.locator('[data-drawn="1"]').first()).toBeAttached({ timeout: 90000 });
    await shot(page, 'offer-form-1440-light');
    const saved = posted(page, 'comp/offers'); await d.getByRole('button', { name: 'Ask a founder' }).click(); ok((await saved).ok(), 'the offer is saved and goes to a founder');
    await expect(d).toBeHidden({ timeout: 60000 });
    await expect(page.getByRole('button', { name: /Rifob Mifos/ }).first()).toBeVisible({ timeout: 60000 });
    const st = await own('select status from pulse.comp_offer where id=$1', [await offerId()]);
    ok(st[0]?.status === 'proposed', `the offer waits for a founder (${st[0]?.status})`);
  });

  await flow('2-founder-approves-and-sends', async () => {
    const id = await offerId(); ok(id, 'an offer for Rifob');
    const page = await as('founder', 1440, 'dark'); await go(page, `/people/agreements?pick=offer:${id}`);
    await expect(page.getByRole('heading', { name: 'Rifob Mifos', level: 2 })).toBeVisible({ timeout: 60000 });
    await expect(page.getByText('What happens next')).toBeVisible();
    await shot(page, 'offer-to-approve-1440-dark');
    await page.getByRole('button', { name: 'Review and approve' }).click();
    const d = page.getByRole('dialog'); await expect(d).toBeVisible({ timeout: 60000 });
    const approved = posted(page, 'comp/offers/[^/]+/decide'); await d.getByRole('button', { name: 'Approve' }).click(); ok((await approved).ok(), 'approved: the letter is filed');
    await expect(page.getByRole('button', { name: 'Send the offer' })).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: 'Send the offer' }).click();
    const s = page.getByRole('dialog', { name: /Send the offer to Rifob Mifos/ }); await expect(s).toBeVisible({ timeout: 60000 });
    // Rifob is in Pulse: he answers there; no link is made.
    await s.getByLabel(/Make a link to share/).uncheck();
    const sent = posted(page, 'comp/offers/[^/]+/send'); await s.getByRole('button', { name: 'Send', exact: true }).click(); ok((await sent).ok(), 'sent by a founder');
    await page.getByRole('dialog', { name: 'The offer is sent' }).getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText(/Sent/).first()).toBeVisible({ timeout: 60000 });
    await shot(page, 'offer-sent-1440-dark');
    const st = await own('select status from pulse.comp_offer where id=$1', [id]);
    ok(st[0]?.status === 'sent', `sent (${st[0]?.status})`);
  });

  await flow('3-person-accepts-term-by-term-on-a-phone', async () => {
    const id = await offerId();
    const page = await as('person', 363, 'light'); await page.goto(base + '/me/pay', { waitUntil: 'load', timeout: 300000 });
    // The acceptance sheet (its header changes to "Done!" at the end, so it is found by its own label, not its words).
    const sheet = page.locator('[role="dialog"][aria-labelledby="policy-accept-title"]');
    await expect(sheet.getByText('A job offer for you')).toBeVisible({ timeout: 240000 });
    await expect(sheet.getByRole('heading', { name: 'Offer of employment: Senior video editor' })).toBeVisible();
    await noSideways(page, 'offer term 363');
    await shot(page, 'offer-term-1-363-light');
    const terms = await sheet.locator('nav[aria-label="Terms"] li').count(); // the rail is hidden on a phone; its items still count
    ok(terms >= 3, `the letter is split into its terms (${terms})`);
    for (let i = 0; i < terms; i++) {
      await expect(sheet.locator('#policy-term-title')).toBeVisible();
      if (i === 1) await shot(page, 'offer-term-pay-363-light');
      await sheet.getByRole('button', { name: 'I understand' }).click();
    }
    await expect(sheet.getByRole('heading', { name: 'Last step: accept the offer' })).toBeVisible();
    await expect(sheet.getByText('I accept this offer as Senior video editor.')).toBeVisible();
    await shot(page, 'offer-last-step-363-light');
    const accepted = posted(page, 'agreements/offers/[^/]+/accept'); await sheet.getByRole('button', { name: 'I accept' }).click(); ok((await accepted).ok(), 'accepted in Pulse');
    await expect(sheet.getByText(/Welcome aboard!/)).toBeVisible({ timeout: 60000 });
    await shot(page, 'offer-done-363-light');
    await sheet.getByRole('button', { name: 'Back to work' }).click();
    await expect(sheet).toBeHidden();
    // The pay record follows the accepted offer; the signed copy is filed for them and opens for them.
    const o = (await own('select status, answer_via, answer_name, signed_letter_id::text s from pulse.comp_offer where id=$1', [id]))[0];
    ok(o.status === 'accepted' && o.answer_via === 'pulse' && o.answer_name === 'Rifob Mifos' && o.s, `accepted in Pulse with a signed copy (${JSON.stringify(o)})`);
    const rec = await own('select status from pulse.comp_record where person_id=$1', [R.person]);
    ok(['probation', 'active'].includes(rec[0]?.status), `the pay record started from the offer (${rec[0]?.status})`);
    const ev = await own("select detail from pulse.comp_event where person_id=$1 and kind='offer.signed'", [R.person]);
    ok(ev.length === 1 && !JSON.stringify(ev[0].detail).includes('48000'), 'the terms ticked are in the timeline, without amounts');
    const pdf = await page.request.get(`${base}/api/v0/comp/letters/${o.s}/pdf`);
    ok(pdf.ok() && (await pdf.body()).subarray(0, 4).toString() === '%PDF', 'the signed letter opens for them');
    await go(page, '/me/pay');
    await expect(page.getByText(/Letters/).first()).toBeVisible({ timeout: 60000 });
    await noSideways(page, 'my pay 363');
    await shot(page, 'my-pay-after-363-light');
  });

  await flow('4-hr-sees-it-accepted', async () => {
    const id = await offerId();
    for (const [w, theme] of [[1440, 'light'], [363, 'dark']]) {
      const page = await as('hr', w, theme); await go(page, `/people/agreements?pick=offer:${id}`);
      await expect(page.getByRole('heading', { name: 'Rifob Mifos', level: 2 })).toBeVisible({ timeout: 60000 });
      await expect(page.getByText(/Accepted by Rifob Mifos on .* \(in Pulse, term by term\)/)).toBeVisible();
      await expect(page.getByRole('link', { name: 'Signed letter (PDF)' })).toBeVisible();
      if (w < 600) await noSideways(page, 'accepted offer 363');
      await shot(page, `offer-accepted-${w}-${theme}`);
      await page.context().close();
    }
    // The signed copy is in the person's HR documents: Documents → Letters made in Pulse, with Open.
    for (const [w, theme] of [[1440, 'light'], [363, 'dark']]) {
      const page = await as('hr', w, theme); await go(page, `/people/${R.person}?tab=documents`);
      // The signed copy's own row: the innermost block that holds both its "(accepted)" title and an Open link. (Matching
      // the panel by its title found the part's tab button of the same name instead, which holds no rows.)
      const signedRow = page.locator('div').filter({ has: page.getByText(/ \(accepted\)$/) }).filter({ has: page.getByRole('link', { name: 'Open' }) }).last();
      await expect(page.getByText('Letters made in Pulse', { exact: true }).first()).toBeVisible({ timeout: 90000 });
      // The tab shows its parts one at a time (Work documents first): open "Letters made in Pulse".
      const part = page.getByRole('button', { name: 'Letters made in Pulse', exact: true });
      if (await part.count()) await part.first().click();
      await expect(page.getByText(/ \(accepted\)$/).first()).toBeVisible();
      ok(await signedRow.count() >= 1 && await signedRow.getByRole('link', { name: 'Open' }).count() === 1, 'the signed copy opens from HR documents');
      if (w < 600) await noSideways(page, 'HR documents 363');
      await page.getByText(/ \(accepted\)$/).first().scrollIntoViewIfNeeded();
      await shot(page, `hr-documents-${w}-${theme}`);
      await page.context().close();
    }
    // With nothing picked on a phone: the list first, the accepted offer under "Signed and accepted".
    const page = await as('hr', 363, 'light'); await go(page, '/people/agreements');
    await expect(page.getByRole('heading', { name: /Signed and accepted/ })).toBeVisible({ timeout: 60000 });
    await noSideways(page, 'workspace 363');
    await shot(page, 'workspace-363-light');
  });
} finally {
  await browser?.close().catch(() => null);
  await stopServer();
  await app.close().catch(() => null); await pool.end().catch(() => null); await owner.end().catch(() => null);
}
const failed = results.filter((r) => !r.ok);
if (process.env.TEST_REPORT) await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks, results, errors, failed: failed.length + (errors.length ? 1 : 0) }, null, 2));
console.log(`agreements-browser: ${results.length - failed.length}/${results.length} flows, ${checks} checks${errors.length ? `; page errors: ${errors.join(' | ').slice(0, 1500)}` : ''}`);
process.exitCode = failed.length || errors.length ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 2000).unref();
