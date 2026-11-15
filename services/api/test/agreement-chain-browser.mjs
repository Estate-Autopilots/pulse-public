// AGREEMENTS rounds 3–4 in the browser (tests/core/test_agreement_chain.py::test_agreement_chain_in_the_browser): the
// real API (this process) on a disposable synthetic company and the web app (`next start` when a build exists, else `next
// dev`). The owner's "how to send a contract", step by step, as Finance and as the client on the signing link:
//   Templates → + Master Service Agreement → Save (the company's standard words, "In short" first, the Schedule last) →
//   the accepted quotation: "From lead to live", step 2, Make the agreement → the draft with "Fill the detailed sheet" →
//   Send to sign → the link → the client reads it signed out, asks for a change on a clause and signs → Finance marks the
//   request done and signs too → Make the invoice → Start onboarding → every onboarding task done: Live.
// Each step is shot at 1440 light (w01…w11, the walkthrough); the card's key steps also at 363 and in dark (the judge).
// Fails on a page error, a 5xx answer or sideways scroll on a phone. PULSE_AGREEMENTS_SCREENSHOTS=<dir> keeps the shots.
// Synthetic company, client and figures only; nothing is sent to anyone (the link is opened here, never shared).
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../dist/app.js';
const ORG = process.env.PULSE_ORG_ID, QUOTE = process.env.QUOTE, FIN = process.env.FIN_ID;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const owner = new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
for (const p of [pool, owner]) p.on('error', (e) => console.error(`pool: ${e.code ?? e.message}`));
const shots = process.env.PULSE_AGREEMENTS_SCREENSHOTS; if (shots) await mkdir(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const dist = process.env.NEXT_DIST_DIR ?? '.next', built = existsSync(join('../../apps/web', dist, 'BUILD_ID'));
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', built ? 'start' : 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web',
  env: { ...process.env, PULSE_API_URL: origin, PULSE_PUBLIC_URL: base, NODE_ENV: built ? 'production' : 'development', PULSE_PUBLIC_LOGIN_ENABLED: '0', NEXT_TELEMETRY_DISABLED: '1',
    NEXT_DIST_DIR: built ? dist : '.next-agreements-walk' }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
const deadline = setTimeout(() => { console.error('agreement-chain-browser: no result after 35 minutes'); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 35 * 60_000);
deadline.unref();

let browser; const results = [], errors = [], pages = []; let checks = 0;
const ok = (condition, msg) => { checks++; assert.ok(condition, msg); };
/** One transaction as a person of the company (or as the signing link, with no person): row security on. */
async function db(sql, args = [], viewer = FIN) {
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [ORG]);
    if (viewer) await c.query("select set_config('pulse.viewer_id',$1,true)", [viewer]);
    const r = await c.query(sql, args); await c.query('commit'); return r.rows;
  } catch (e) { await c.query('rollback').catch(() => null); throw e; } finally { c.release(); }
}
async function own(sql, args = []) {
  const c = await owner.connect();
  try { await c.query('begin'); await c.query('set local role pulse_owner'); await c.query("select set_config('pulse.org_id',$1,true)", [ORG]); const r = await c.query(sql, args); await c.query('commit'); return r.rows; }
  catch (e) { await c.query('rollback').catch(() => null); throw e; } finally { c.release(); }
}
const ready = async (page) => { await page.waitForFunction(() => document.querySelector('main h1,main h2,main h3') && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 240000 }); await page.waitForTimeout(400); };
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load', timeout: 300000 }); await ready(page); };
async function as(role, width = 1440, theme = 'light') {
  const phone = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 800 : 900 }, colorScheme: theme, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone,
    ...(role ? { extraHTTPHeaders: { 'cf-access-authenticated-user-email': `${role}@comp.example` } } : {}) });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('theme', t); } catch { /* private mode */ } }, theme);
  const page = await ctx.newPage(); pages.push(page);
  page.on('pageerror', (e) => errors.push(`${role} ${width}: ${e.message.slice(0, 200)}`));
  page.on('response', (r) => { if (r.status() >= 500 && r.url().startsWith(base)) errors.push(`${role} ${width}: HTTP ${r.status()} ${r.url().slice(base.length)}`); });
  return page;
}
const chainCard = (page) => page.getByRole('region', { name: 'From lead to live' });
async function shot(page, name) {
  if (!shots) return;
  await page.waitForTimeout(500);
  const card = chainCard(page);
  if (await card.count()) await card.first().scrollIntoViewIfNeeded().catch(() => null);
  await page.screenshot({ path: `${shots}/${name}.png` });
}
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
const VIEWS = [[1440, 'light'], [1440, 'dark'], [363, 'light'], [363, 'dark']];
/** The same page in every width and theme: the card says `text`, a phone has no sideways scroll. */
async function everyView(path, name, text) {
  for (const [w, theme] of VIEWS) {
    const page = await as('admin', w, theme); await go(page, path);
    await expect(chainCard(page)).toBeVisible({ timeout: 90000 });
    await expect(chainCard(page).getByText(text)).toBeVisible();
    if (w < 600) await noSideways(page, `${name} ${w}`);
    await shot(page, `${name}-${w}-${theme}`);
    await page.context().close();
  }
}
let contractId = null, invoiceId = null, link = null;
const W = (page, name) => shot(page, name); // the walkthrough's own shots (1440 light)

try {
  for (let i = 0; i < 1200; i++) {
    try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(60000) })).ok) break; } catch { /* starting */ }
    if (serverExit !== null) throw Error(`next exited (${serverExit}): ${serverTail.trim().slice(-600)}`);
    await delay(500); if (i === 1199) throw Error('next did not start');
  }
  browser = await chromium.launch();

  await flow('01-the-master-service-agreement-template', async () => {
    const page = await as('admin', 1440, 'light'); await go(page, '/contracts/templates');
    await page.getByRole('button', { name: 'Master Service Agreement' }).click();
    // It opens as the reader sees it (parts as headings, blanks as chips); unticking "See it filled" shows the words.
    await expect(page.locator('h3', { hasText: 'In short' }).first()).toBeVisible({ timeout: 60000 });
    await W(page, 'w01-template-msa-1440-light');
    await page.getByLabel('See it filled').uncheck();
    await expect(page.getByRole('textbox', { name: "The agreement's words" })).toHaveValue(/## In short[\s\S]*## Schedule \(the detailed sheet\)/);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved. New agreements use these words.')).toBeVisible({ timeout: 60000 });
    ok((await db("select count(*)::int n from pulse.contract_template where name='Master Service Agreement' and is_default"))[0].n === 1, 'the MSA is the standard template');
    const phone = await as('admin', 363, 'dark'); await go(phone, '/contracts/templates');
    await expect(phone.getByText('Master Service Agreement').first()).toBeVisible({ timeout: 60000 });
    await noSideways(phone, 'templates 363'); await shot(phone, 'templates-msa-363-dark');
  });

  await flow('02-the-accepted-quotation-makes-the-agreement', async () => {
    await everyView(`/erp/documents/${QUOTE}`, 'w02-quote-accepted', /it fills itself from the quotation and your template/);
    const page = await as('admin', 1440, 'light'); await go(page, `/erp/documents/${QUOTE}`);
    await chainCard(page).getByRole('button', { name: 'Make the agreement' }).click();
    // The agreement's page compiles on its first visit in next dev; on a loaded host that took over 2 minutes (15 Nov).
    await page.waitForURL(/\/contracts\/[0-9a-f-]{36}$/, { timeout: 300000 }); await ready(page);
    contractId = page.url().split('/').pop();
    await expect(page.getByRole('form', { name: 'Fill the detailed sheet' })).toBeVisible({ timeout: 90000 });
    ok(contractId, 'the agreement opened');
  });
  if (!contractId) throw Error('no agreement to go on with');

  await flow('03-fill-the-detailed-sheet-and-send', async () => {
    await everyView(`/contracts/${contractId}`, 'w03-agreement-draft', 'The agreement is a draft. Check the words and the detailed sheet, then send it to sign.');
    const page = await as('admin', 1440, 'light'); await go(page, `/contracts/${contractId}`);
    const sheet = page.getByRole('form', { name: 'Fill the detailed sheet' });
    for (const [label, value] of [['AI employees', 'Billing assistant, project coordinator'], ['People who use it', 'Up to 25'], ['Support hours', 'Mon–Sat, 10 am–7 pm'],
      ['Start date', '1 December 2026'], ['Review date', '1 March 2027'], ['What you provide', 'A point person and your client list'], ['Days of notice', '30'], ['City of the courts', 'Pune']]) {
      await sheet.getByLabel(label, { exact: true }).fill(value);
    }
    await sheet.scrollIntoViewIfNeeded(); await W(page, 'w04-sheet-filled-1440-light');
    await sheet.getByRole('button', { name: 'Save the sheet' }).click();
    await expect(sheet).toBeHidden({ timeout: 60000 });
    const words = (await db('select body from pulse.contract where id=$1', [contractId]))[0].body;
    ok(!/\{\{/.test(words) && /People who use it: Up to 25/.test(words), 'the sheet is in the words, no gap left');
    await page.getByRole('button', { name: 'Send to sign' }).first().click();
    const send = page.getByRole('form', { name: 'Send to sign' });
    await expect(send).toBeVisible(); await send.scrollIntoViewIfNeeded(); await W(page, 'w05-send-to-sign-1440-light');
    await send.getByRole('button', { name: /^Send/ }).last().click();
    const box = page.getByRole('textbox', { name: 'Signing link' });
    await expect(box).toBeVisible({ timeout: 60000 }); link = await box.inputValue();
    await page.getByRole('region', { name: 'Share the link' }).scrollIntoViewIfNeeded(); await W(page, 'w06-share-the-link-1440-light');
    ok(/\/accept\/sign\//.test(link), 'a signing link');
  });
  if (!link) throw Error('no signing link');
  const linkPath = new URL(link).pathname;

  await flow('04-the-client-reads-asks-and-signs', async () => {
    await everyView(`/contracts/${contractId}`, 'w07-agreement-sent', /Waiting for .+ to open it, comment or sign\./);
    const page = await as(null, 363, 'light'); await go(page, linkPath);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 90000 });
    await W(page, 'w08-client-reads-363-light');
    // Clause numbers follow the printed document since CONTRACTS-PRO ("In short" is clause 1), so the part is found by its title.
    const fee = page.locator('details').filter({ has: page.locator('summary', { hasText: /Fee and GST/ }) }).first();
    await fee.locator('summary').click().catch(() => null);
    await fee.getByRole('button', { name: 'Ask for a change' }).click();
    await fee.getByRole('textbox').fill('Can the first month be half, while we set up?');
    await fee.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('region', { name: 'Your questions' })).toBeVisible({ timeout: 60000 });
    await W(page, 'w09-client-asks-363-light');
    // Finance sees the request on the agreement, with who acts next, and marks it done.
    const fin = await as('admin', 1440, 'light'); await go(fin, `/contracts/${contractId}`);
    await expect(chainCard(fin).getByText(/asked for a change/)).toBeVisible({ timeout: 90000 });
    await W(fin, 'w10-request-on-the-agreement-1440-light');
    await fin.getByRole('region', { name: 'Requests from the client' }).getByRole('button', { name: 'Mark done' }).click();
    await expect(fin.getByRole('region', { name: 'Requests from the client' })).toBeHidden({ timeout: 60000 });
    // The client signs on the link.
    await go(page, linkPath);
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: 'Sign your agreement' });
    // CONTRACTS-PRO made Draw the sheet's first tab; this walk signs with a typed name.
    await dlg.getByRole('tab', { name: 'Type' }).click();
    await dlg.getByLabel('Your full name').fill('Diya Nair (synthetic)');
    await dlg.getByLabel('I agree to this agreement').check();
    await dlg.getByRole('button', { name: 'Sign now' }).click();
    await expect(page.getByText('You signed this agreement. Thank you!')).toBeVisible({ timeout: 60000 });
    await noSideways(page, 'signing link 363'); await W(page, 'w11-client-signed-363-light');
  });

  await flow('05-both-accept-and-the-invoice', async () => {
    // Once the client signed, the side still to sign is yours ("Next: You").
    await everyView(`/contracts/${contractId}`, 'w12-client-signed', /signed\. Now (you sign for .+|your side signs)\./);
    const page = await as('admin', 1440, 'light'); await go(page, `/contracts/${contractId}`);
    await page.getByRole('button', { name: 'Sign', exact: true }).first().click();
    const dlg = page.getByRole('dialog', { name: 'Sign your agreement' });
    await dlg.getByRole('tab', { name: 'Type' }).click();
    await dlg.getByLabel('Your full name').fill('Asha Kireteso');
    await dlg.getByLabel('I agree to this agreement').check();
    await dlg.getByRole('button', { name: 'Sign now' }).click();
    await expect(chainCard(page).getByText(/Everyone signed\. Make the first monthly invoice/)).toBeVisible({ timeout: 90000 });
    await W(page, 'w13-both-signed-1440-light');
    await chainCard(page).getByRole('button', { name: 'Make the invoice' }).click();
    await page.waitForURL(/\/erp\/documents\/[0-9a-f-]{36}$/, { timeout: 120000 }); await ready(page);
    invoiceId = page.url().split('/').pop();
    const d = (await db('select doc_type, status, source_id::text src from pulse.erp_document where id=$1', [invoiceId]))[0];
    ok(d.doc_type === 'invoice' && d.status === 'draft' && d.src === QUOTE, `the invoice draft is from the quotation (${JSON.stringify(d)})`);
  });

  if (invoiceId) await flow('06-onboarding-and-live', async () => {
    // A draft invoice says so; its own Issue is the page's main button and the card's Start onboarding is an ordinary one.
    await everyView(`/erp/documents/${invoiceId}`, 'w14-invoice-made', /This invoice is a draft: check it below and issue it\. Start the onboarding now/);
    const page = await as('admin', 1440, 'light'); await go(page, `/erp/documents/${invoiceId}`);
    ok(await chainCard(page).locator('[data-primary]').count() === 0, 'the draft invoice keeps one main button (Issue)');
    await chainCard(page).getByRole('button', { name: 'Start onboarding' }).click();
    await expect(chainCard(page).getByText(/Onboarding: 0 of 1 tasks done/)).toBeVisible({ timeout: 90000 });
    await W(page, 'w15-onboarding-1440-light');
    const pr = (await db('select project_id::text p from pulse.contract_link where contract_id=$1 and project_id is not null', [contractId]))[0]?.p;
    ok(pr, 'the onboarding project is linked to the agreement');
    await own("update pulse.task set status='done' where project_id=$1", [pr]);
    await everyView(`/erp/documents/${QUOTE}`, 'w16-live', /is live\. Every step is done\./);
  });
} finally {
  await browser?.close().catch(() => null);
  stopServer();
  await app.close().catch(() => null); await pool.end().catch(() => null); await owner.end().catch(() => null);
}
const failed = results.filter((r) => !r.ok);
if (process.env.TEST_REPORT) await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks, results, errors, failed: failed.length + (errors.length ? 1 : 0) }, null, 2));
console.log(`agreement-chain-browser: ${results.length - failed.length}/${results.length} flows, ${checks} checks${errors.length ? `; page errors: ${errors.join(' | ').slice(0, 1500)}` : ''}`);
process.exitCode = failed.length || errors.length ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 2000).unref();
