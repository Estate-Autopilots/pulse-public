// CONTRACTS-PRO (tests/core/test_contracts_pro.py::test_contracts_pro_in_the_browser): the real API (this process) on a
// disposable synthetic company and the web app. An admin makes a service agreement from the standard template with two
// parties (legal names, signatories, the deal), sees it typeset as its PDF, sends it; the client signs on a phone by
// uploading a photo of a signature (cleaned on the device); the admin signs by drawing; the signed PDF downloads with its
// certificate page. 1440 and 363 px, light and dark. PULSE_CONTRACTS_SCREENSHOTS=<dir> keeps the screenshots. Synthetic
// data only; nothing is sent to anyone.
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
await writeFile(keyFile, `contracts-pro-2026-11 ${randomBytes(32).toString('base64')}\n`, { mode: 0o600 }); await chmod(keyFile, 0o600);
process.env.PULSE_DOCUMENT_KEY_FILE = keyFile;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const owner = new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
for (const p of [pool, owner]) p.on('error', (e) => console.error(`pool: ${e.code ?? e.message}`));
const shots = process.env.PULSE_CONTRACTS_SCREENSHOTS; if (shots) await mkdir(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
// A built app (CI builds .next) starts in seconds; without one, `next dev` in its own folder compiles each page on its first visit.
const dist = process.env.NEXT_DIST_DIR ?? '.next', built = existsSync(join('../../apps/web', dist, 'BUILD_ID'));
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', built ? 'start' : 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web',
  env: { ...process.env, PULSE_API_URL: origin, PULSE_PUBLIC_URL: base, NODE_ENV: built ? 'production' : 'development', PULSE_PUBLIC_LOGIN_ENABLED: '0', NEXT_TELEMETRY_DISABLED: '1',
    NEXT_DIST_DIR: built ? dist : '.next-contracts-pro-walk' }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
const deadline = setTimeout(() => { console.error('contracts-pro-browser: no result after 30 minutes'); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 30 * 60_000);
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
const attempt = Date.now().toString(36).slice(-4);
const { appendFile } = await import('node:fs/promises');
const note = async (line) => { console.log(line); if (shots) await appendFile(`${shots}/walk-log.txt`, `${new Date().toISOString()} [${attempt}] ${line}\n`).catch(() => null); };
async function flow(name, run) {
  const started = Date.now();
  try { await run(); results.push({ name, ok: true, ms: Date.now() - started }); await note(`PASS ${name} (${Math.round((Date.now() - started) / 1000)} s)`); }
  catch (e) {
    const error = String(e?.message ?? e).split('\n').slice(0, 6).join(' | ').slice(0, 900);
    results.push({ name, ok: false, error }); await note(`FAIL ${name}: ${error}`);
    if (shots) for (const [i, p] of pages.entries()) if (!p.isClosed()) await p.screenshot({ path: `${shots}/fail-${attempt}-${name}-${i}.png` }).catch(() => null);
  }
  for (const p of pages.splice(0)) await p.context().close().catch(() => null);
}

// The synthetic photo of a signature on lined, unevenly lit paper, drawn here pixel by pixel and saved as a PNG (zlib):
// a blue pen stroke, ruled lines and a few specks. Nothing real is used.
const { deflateSync } = await import('node:zlib');
function png(w, h, rgba) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function signaturePhoto(w = 900, h = 360) {
  const px = Buffer.alloc(w * h * 4);
  const ink = (x, y) => { // a looping pen line: distance to the curve y = f(x) within the stroke's width
    if (x < 110 || x > 790) return false;
    const f = 190 + 70 * Math.sin((x - 110) / 38) * Math.exp(-((x - 110) / 900)) + (x < 240 ? -60 * Math.sin((x - 110) / 42) : 0);
    return Math.abs(y - f) < 4.5;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, paper = 186 + (54 * (x + y)) / (w + h);
    let r = paper, g = paper - 2, b = paper - 8;
    if ([90, 200, 310].some((ly) => Math.abs(y - ly) < 1)) { r = paper - 40; g = paper - 30; b = paper - 5; }
    if (ink(x, y)) { r = 31; g = 42; b = 107; }
    if ([[40, 40], [860, 60], [820, 330], [60, 320]].some(([sx, sy]) => Math.abs(x - sx) < 2 && Math.abs(y - sy) < 2)) { r = 50; g = 50; b = 50; }
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  }
  return png(w, h, px);
}
const photoPath = join(process.env.TEST_KEY_DIR, 'signature-photo.png'); await writeFile(photoPath, signaturePhoto());
const pdfPages = async (page) => { await page.waitForSelector('canvas[data-pdf-page]', { timeout: 120000 }); return page.locator('canvas[data-pdf-page]').count(); };
async function api(page, method, path, data) {
  let r;
  // `next dev` answers its own 404 page while it compiles the API proxy on a first request: try again for up to a minute.
  for (let i = 0; i < 20; i++) {
    r = await page.request.fetch(base + path, { method, data, headers: { origin: base, 'content-type': 'application/json' } });
    if (!(r.status() === 404 && /<!DOCTYPE html>/i.test(await r.text()))) break;
    await delay(3000);
  }
  ok(r.ok(), `${method} ${path} → ${r.status()} ${(await r.text()).slice(0, 200)}`); return r.json();
}
let id = null, link = null;
const wide = (w) => w >= 1100;

try {
  for (let i = 0; i < 1200; i++) {
    try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(60000) })).ok) break; } catch { /* starting */ }
    if (serverExit !== null) throw Error(`next exited (${serverExit}): ${serverTail.trim().slice(-600)}`);
    await delay(500); if (i === 1199) throw Error('next did not start');
  }
  browser = await chromium.launch();

  await flow('1-owner-makes-a-service-agreement-from-the-template', async () => {
    const page = await as('admin', 1440, 'light');
    await go(page, '/contracts');
    await page.request.get(`${base}/api/v0/contracts`).catch(() => null);
    const made = await api(page, 'POST', '/api/v0/contracts', { kind: 'retainer', title: 'Master Service Agreement',
      parties: [{ kind: 'company', role: 'provider', orgId: ORG }, { kind: 'company', role: 'client', name: 'Harbor Builders LLP' }] });
    id = made.contract.id; ok(!!id, 'the agreement is made');
    await go(page, `/contracts/${id}`);
    ok(await pdfPages(page) >= 1, 'the page shows the document itself');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Edit the agreement' })).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: /Start from a standard service agreement/ }).click();
    await page.getByRole('tab', { name: /Parties/ }).click();
    const legal = page.getByLabel('Full legal name');
    // POLISH-1115 ("the right parties"): our side starts as our own company (from its signing row), as on the letterhead.
    const ours = (await legal.nth(0).inputValue()).trim();
    ok(ours.length > 1, `our side starts as our own company (${ours})`);
    await page.getByLabel('Registered office').nth(0).fill('4th Floor, Example House, Baner Road, Pune 411045');
    await page.getByLabel('CIN').nth(0).fill('U74999MH2020PTC000001');
    await page.getByLabel('Who signs').nth(0).fill('Kedab Mifos');
    await page.getByLabel('Their title').nth(0).fill('Director');
    await page.getByLabel('What it is').nth(1).selectOption('llp');
    await page.getByLabel('Registered office').nth(1).fill('12 Sample Street, Kothrud, Pune 411038');
    await page.getByLabel('LLPIN').nth(0).fill('AAA-0001');
    await page.getByLabel('Who signs').nth(1).fill('Diya Nair');
    await page.getByLabel('Their title').nth(1).fill('Designated Partner');
    await page.getByRole('tab', { name: 'Deal', exact: true }).click();
    const fill = { Fee: '₹40,000 a month', GST: 'plus GST at 18%', Billing: 'monthly in advance, payable within 15 days of the invoice', 'Start date': '1 December 2026',
      'Review date': '1 March 2027', 'Notice period': '30 days’', Term: '12 months', 'Courts of': 'Pune' };
    for (const [k, v] of Object.entries(fill)) await page.getByLabel(k, { exact: true }).fill(v);
    await page.getByLabel('At (city)').fill('Pune');
    await page.getByRole('tab', { name: 'Words' }).click();
    await page.getByLabel('Add a standard clause').selectOption({ label: 'Limitation of liability' });
    await expect(page.getByText('Exactly as the PDF')).toBeVisible({ timeout: 120000 });
    await page.waitForTimeout(1500);
    // Diagnostic: does the preview's first canvas hold ink (a real drawing), or is it blank?
    const ink = await page.locator('section[aria-label="Preview"] canvas[data-pdf-page]').first().evaluate((c) => {
      const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, Math.min(c.height, 600)).data; let n = 0;
      for (let i = 0; i < d.length; i += 16) if (d[i + 3] > 0 && d[i] < 200) n++; return n; }).catch((e) => `error ${String(e).slice(0, 80)}`);
    await note(`preview canvas ink pixels: ${ink}`);
    ok(typeof ink === 'number' && ink > 50, `the live preview is drawn, not blank (${ink} ink pixels)`);
    await noSideways(page, 'editor 1440');
    await shot(page, 'editor-1440-light');
    const saved = posted(page, `contracts/${id}/words`); await page.getByRole('button', { name: 'Save', exact: true }).click(); ok((await saved).ok(), 'the words are saved');
    await expect(page.getByRole('heading', { name: 'Edit the agreement' })).toBeHidden({ timeout: 60000 });
    ok(await pdfPages(page) >= 3, 'the saved agreement is drawn on three or more pages');
    await page.waitForTimeout(1200);
    await shot(page, 'agreement-draft-1440-light');
    const words = (await own('select body from pulse.contract where id=$1', [id]))[0].body;
    ok(/^<!-- pulse:contract /.test(words) && words.includes(ours) && /## Limitation of liability/.test(words), 'the source holds the facts and the words');
  });

  for (const [w, theme] of [[363, 'light'], [363, 'dark'], [1440, 'dark']]) await flow(`2-draft-page-${w}-${theme}`, async () => {
    ok(!!id, 'the agreement from step 1');
    const page = await as('admin', w, theme); await go(page, `/contracts/${id}`);
    ok(await pdfPages(page) >= 3, `the document at ${w}`); await page.waitForTimeout(1200);
    await noSideways(page, `draft ${w} ${theme}`); await shot(page, `agreement-draft-${w}-${theme}`);
    if (w < 600) { await page.getByRole('button', { name: 'Edit', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Edit the agreement' })).toBeVisible({ timeout: 60000 });
      await page.waitForTimeout(800); await noSideways(page, `editor ${w}`); await shot(page, `editor-${w}-${theme}`); }
  });

  await flow('3-owner-sends-it', async () => {
    ok(!!id, 'the agreement from step 1');
    const page = await as('admin', 1440, 'light'); await go(page, `/contracts/${id}`);
    await page.getByRole('button', { name: 'Send to sign' }).first().click();
    await page.getByLabel(/Name of the person who signs for/).fill('Diya Nair');
    const sent = posted(page, `contracts/${id}/send-to-sign`); await page.getByRole('button', { name: 'Send to sign' }).last().click(); ok((await sent).ok(), 'sent');
    const box = page.getByLabel('Signing link'); await expect(box).toBeVisible({ timeout: 60000 });
    link = await box.inputValue(); ok(/\/accept\/sign\/[A-Za-z0-9_-]{43}$/.test(link), 'a signing link');
    await expect(page.getByText('Ready to send')).toBeHidden({ timeout: 60000 }); await pdfPages(page); await page.waitForTimeout(2500);
    await shot(page, 'sent-share-link-1440-light');
  });

  for (const [w, theme, sign] of [[363, 'dark', false], [1440, 'light', false], [363, 'light', true]]) await flow(`4-client-photo-${w}-${theme}${sign ? '-signs' : ''}`, async () => {
    ok(!!link, 'the signing link from step 3');
    const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 800 : 900 }, colorScheme: theme, isMobile: w < 600, hasTouch: w < 600 });
    await ctx.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('theme', t); } catch { /* private */ } }, theme);
    const page = await ctx.newPage(); pages.push(page);
    page.on('pageerror', (e) => errors.push(`client ${w}: ${e.message.slice(0, 200)}`));
    await page.goto(base + new URL(link).pathname, { waitUntil: 'load', timeout: 300000 });
    await expect(page.getByRole('heading', { name: 'The agreement' })).toBeVisible({ timeout: 120000 });
    const shown = await page.locator('body').innerText(); // the public layout and the page each have a <main>
    ok(!/\*\*|^#{1,3} |\{\{|pulse:contract/m.test(shown), "the client's page shows no raw Markdown, fields or facts line");
    ok(/1\. Definitions/.test(shown) && /Background/.test(shown), "clauses are numbered as in the document");
    if (w < 600 && !sign) await shot(page, `client-page-${w}-${theme}`);
    await page.getByRole('button', { name: /^Sign/ }).first().click();
    await page.getByRole('tab', { name: 'Photo', exact: true }).click();
    await page.locator('input[type=file]').setInputFiles(photoPath);
    await expect(page.getByRole('img', { name: 'Your signature, cleaned' })).toBeVisible({ timeout: 60000 });
    await page.waitForTimeout(600);
    await noSideways(page, `sign sheet ${w}`); await shot(page, `sign-upload-${w}-${theme}`);
    if (!sign) return;
    const name = page.getByLabel('Your full name'); if (!(await name.inputValue())) await name.fill('Diya Nair');
    await page.getByLabel('I agree to this agreement').check();
    const done = page.waitForResponse((r) => r.request().method() === 'POST' && /\/accept\/sign\//.test(r.url()), { timeout: 60000 });
    await page.getByRole('button', { name: 'Sign now' }).click(); ok((await done).ok(), 'the client signed with a photo');
    await page.waitForTimeout(1500); await shot(page, `client-signed-${w}-${theme}`);
    const row = (await own("select sign_kind, sign_image like 'data:image/png;base64,%' png from pulse.contract_party where contract_id=$1 and role='client'", [id]))[0];
    ok(row.sign_kind === 'uploaded' && row.png, `the photo is kept as an uploaded signature (${JSON.stringify(row)})`);
  });

  await flow('5-owner-signs-by-drawing-and-downloads', async () => {
    ok(!!id, 'the agreement from step 1');
    const page = await as('admin', 1440, 'dark'); await go(page, `/contracts/${id}`);
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    const pad = page.getByLabel('Signature box'); await expect(pad).toBeVisible();
    const b = await pad.boundingBox();
    await page.mouse.move(b.x + 30, b.y + 100); await page.mouse.down();
    for (let i = 0; i <= 40; i++) await page.mouse.move(b.x + 30 + i * 7, b.y + 80 + Math.sin(i / 3) * 35, { steps: 2 });
    await page.mouse.up();
    await page.getByLabel('Your full name').fill('Kedab Mifos');
    await page.getByLabel('I agree to this agreement').check();
    await shot(page, 'owner-draws-1440-dark');
    const signed = posted(page, `contracts/${id}/sign`); await page.getByRole('button', { name: 'Sign now' }).click(); ok((await signed).ok(), 'the owner signed by drawing');
    await page.waitForTimeout(2500); await go(page, `/contracts/${id}`);
    ok(await pdfPages(page) >= 4, 'the signed copy has its certificate page');
    const status = (await own('select status from pulse.contract where id=$1', [id]))[0].status; ok(status === 'active', `signed by everyone (${status})`);
    await page.waitForTimeout(1200); await shot(page, 'agreement-signed-1440-dark');
    const pdf = await page.request.get(`${base}/api/v0/contracts/${id}/pdf`); ok(pdf.ok(), 'the PDF downloads');
    const bytes = await pdf.body(); ok(bytes.subarray(0, 5).toString() === '%PDF-', 'a PDF');
    if (shots) await writeFile(`${shots}/signed-agreement.pdf`, bytes);
  });
  for (const [w, theme] of [[1440, 'light'], [363, 'light'], [363, 'dark']]) await flow(`6-signed-page-${w}-${theme}`, async () => {
    ok(!!id, 'the agreement from step 1');
    const page = await as('admin', w, theme); await go(page, `/contracts/${id}`);
    ok(await pdfPages(page) >= 4, `signed document at ${w}`); await page.waitForTimeout(1200);
    await noSideways(page, `signed ${w} ${theme}`); await shot(page, `agreement-signed-${w}-${theme}`);
  });
} finally {
  await browser?.close().catch(() => null);
  stopServer();
  await app.close().catch(() => null); await pool.end().catch(() => null); await owner.end().catch(() => null);
}
const failed = results.filter((r) => !r.ok);
if (process.env.TEST_REPORT) await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks, results, errors, failed: failed.length + (errors.length ? 1 : 0) }, null, 2));
console.log(`contracts-pro-browser: ${results.length - failed.length}/${results.length} flows, ${checks} checks${errors.length ? `; page errors: ${errors.join(' | ').slice(0, 1500)}` : ''}`);
process.exitCode = failed.length || errors.length ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 2000).unref();
