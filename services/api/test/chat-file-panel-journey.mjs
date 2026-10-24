// FEATURES-1024 (CHAT-SHELL: "non-image chat files are not opened in the panel"), in a real browser against a running
// Pulse (pulse-dev by default), as a synthetic leader (Access identity): a PDF attached in a "(test)" group opens beside
// the chat (served inline as a PDF, its own viewer), not as a download; a zip still downloads. 1440 light, 1440 dark.
//   FILES_BASE=http://127.0.0.1:3200 FILES_OUT=~/ea-research/ux/journeys/FEATURES/chat-files node services/api/test/chat-file-panel-journey.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const { chromium } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const BASE = process.env.FILES_BASE ?? 'http://127.0.0.1:3200';
const OUT = process.env.FILES_OUT ?? '/tmp/chat-files';
const WHO = process.env.FILES_WHO ?? 'kedab.mifos@synthetic.invalid';
const run = Date.now().toString(36).slice(-5), PDF = `brochure-${run}.pdf`, ZIP = `assets-${run}.zip`;
await mkdir(OUT, { recursive: true });
const report = { base: BASE, run, checks: 0, steps: [], shots: [] };
const ok = (c, m) => { report.checks++; assert.ok(c, m); };
const step = (s) => { report.steps.push(s); console.log('·', s); };
// A one-page PDF ("Skyline Heights (test)"), small enough to read.
const pdf = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 52>>stream
BT /F1 18 Tf 24 70 Td (Skyline Heights \\(test\\)) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`);
const browser = await chromium.launch();
const post = (page, path, body = {}) => page.evaluate(async ([p, b]) => {
  const r = await fetch(`/api/v0/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p}: ${r.status} ${d.error ?? ''}`); return d;
}, [path, body]);
const get = (page, path) => page.evaluate(async (p) => (await fetch(`/api/v0/${p}`, { cache: 'no-store' })).json(), path);
const snap = async (page, name) => { const path = `${OUT}/${String(report.shots.length + 1).padStart(2, '0')}-${name}.png`; await page.screenshot({ path }); report.shots.push(path); };

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': WHO } });
const page = await ctx.newPage(); page.setDefaultTimeout(90_000); page.setDefaultNavigationTimeout(180_000);
try {
  await page.goto(`${BASE}/chats`);
  const opts = await get(page, 'work/options');
  const asha = opts.people.find((p) => /^Asha Kireteso/i.test(p.name)); ok(asha, 'a synthetic colleague');
  const group = (await post(page, 'chats/groups', { name: `Files (test ${run})`, memberIds: [asha.id] })).id;
  await page.goto(`${BASE}/chats?channel=${group}`);
  await page.locator('input[type="file"]').first().setInputFiles([{ name: PDF, mimeType: 'application/pdf', buffer: pdf }, { name: ZIP, mimeType: 'application/zip', buffer: Buffer.from('PK test archive') }]);
  const box = page.getByPlaceholder('Message');
  await page.waitForTimeout(1500);
  await box.fill(`The brochure and the assets (test ${run})`); await box.press('Enter');
  const pdfLink = page.getByRole('link', { name: new RegExp(PDF) }).last(); await pdfLink.waitFor();
  ok((await pdfLink.innerText()).includes('Open'), 'the PDF offers Open');
  ok((await page.getByRole('link', { name: new RegExp(ZIP) }).last().innerText()).includes('Download'), 'the zip still downloads');
  step('a PDF and a zip in the group: Open and Download');

  await pdfLink.click();
  const frame = page.locator(`iframe[title="${PDF}"]`); await frame.waitFor();
  const src = await frame.getAttribute('src');
  ok(/\/api\/v0\/chats\/files\/[\w-]+\?inline=1$/.test(src ?? ''), `framed inline: ${src}`);
  const r = await page.request.get(`${BASE}${src}`);
  ok(r.ok() && r.headers()['content-type']?.startsWith('application/pdf'), `served as a PDF (${r.status()} ${r.headers()['content-type']})`);
  ok(r.headers()['content-disposition']?.startsWith('inline'), 'inline, not a download');
  ok(!r.headers()['content-security-policy']?.includes('sandbox'), 'no sandbox, so Chrome can draw it');
  const zipId = (await get(page, `chats/${group}/messages`)).messages.flatMap((m) => m.attachments ?? []).find((a) => a.name === ZIP)?.id;
  const z = await page.request.get(`${BASE}/api/v0/chats/files/${zipId}?inline=1`);
  ok(z.headers()['content-disposition']?.startsWith('attachment') && z.headers()['content-security-policy']?.includes('sandbox'), 'a zip asked inline still downloads, sandboxed');
  await page.waitForTimeout(1500); await snap(page, 'pdf-in-panel-1440-light');
  step('the PDF opens beside the chat, served inline as a PDF');

  await page.emulateMedia({ colorScheme: 'dark' }); await page.reload();
  await page.getByRole('link', { name: new RegExp(PDF) }).last().waitFor();
  await page.waitForTimeout(1500); await snap(page, 'pdf-in-panel-1440-dark');
  report.ok = true;
} finally {
  await ctx.close(); await browser.close();
  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log(report.ok ? `chat-file-panel journey: PASS (${report.checks} checks)` : 'chat-file-panel journey: FAILED');
}
