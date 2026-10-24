// R47 in the browser (tests/core/test_chat_history_import.py): the real API on a disposable synthetic agency and the
// web app under `next dev`. An admin previews a synthetic WhatsApp export on the page (read in the browser), decides each
// sender, picks the group and imports it; a member opens the history from the chat; HR outside the group cannot.
// Screenshots with PULSE_R47_SCREENSHOTS=<dir>. Every person, file and message is invented; nothing is sent anywhere.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
process.env.PULSE_CHAT_IMPORT = '1';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), shots = process.env.PULSE_R47_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const emails = { admin: 'admin@estateautopilots.com', member: process.env.TEST_MEMBER, hr: 'hr@estateautopilots.com' };
const fixture = fileURLToPath(new URL('../../../packages/chat-export/test/fixtures/android-24h-dmy.txt', import.meta.url));
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-r47', PULSE_PUBLIC_LOGIN_ENABLED: '0', NEXT_TELEMETRY_DISABLED: '1' }, stdio: 'ignore' });
let browser, checks = 0;
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const errors = [];
async function context(role, { width = 1440, theme = 'light' } = {}) {
  const phone = width < 600;
  const c = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
  await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('theme', t); } catch { /* private mode */ } }, theme);
  return c;
}
async function open(c, path, name) {
  const page = await c.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
  return page;
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await delay(500); if (i === 599) throw Error('next dev did not start'); }
  browser = await chromium.launch();
  // 1. The admin's preview: read on this device, every sender decided, nothing sent before Import.
  for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
    const c = await context('admin', { width, theme }), page = await open(c, '/chats/import', `import ${width}`);
    await seen(page.getByRole('heading', { name: 'Choose the export' }));
    const sent = []; page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/chats/imports')) sent.push(r.url()); });
    await page.locator('input[type=file]').setInputFiles(fixture);
    await seen(page.getByRole('heading', { name: 'Check the preview' }), 60000);
    const facts = await page.locator('dl dd').allInnerTexts();
    assert.deepEqual(facts.map((f) => f.split('\n')[0]), ['5', '2', '1', '3', '1', '3'], 'text, media, deleted, notices, multiline, senders');
    await seen(page.getByText(/only a phone number: Pulse shows and keeps “Number ending …”/));
    await seen(page.getByRole('cell', { name: 'Number ending 123' }));
    assert.equal(await page.getByText('+44 7700').count(), 0, 'the number itself is not shown');
    await seen(page.getByText('3 senders still to decide.'));
    assert.equal(sent.length, 0, 'the preview sent nothing');
    assert.ok(await fits(page), `import page fits ${width}`); checks++;
    await shot(page, `import-preview-${width}-${theme}`);
    if (width === 1440) {
      await page.getByLabel('Who is Mira Test').selectOption(E.editor);
      await page.getByLabel('Who is Kabir Sample').selectOption('kept');
      await page.getByLabel('Who is Number ending 123').selectOption('skip');
      await expect(page.getByText('still to decide')).toHaveCount(0); checks++;
      await page.getByLabel('Conversation').selectOption(E.group);
      await seen(page.getByText(/Only 3 members of Synthetic shoot crew will read it: Editor One, Editor Two, Pod Manager/));
      await page.getByLabel('Where the owner’s approval is recorded').fill('E15 synthetic approval record');
      await page.getByLabel(/Retention proposal/).fill('Proposal: keep while the group exists; legal review pending');
      const go = page.getByRole('button', { name: 'Import 6 messages' });
      await expect(go).toBeDisabled(); checks++;
      await page.getByRole('checkbox').check();
      await shot(page, 'import-ready-1440-light');
      await go.click();
      await seen(page.getByRole('status').filter({ hasText: 'Imported 6 new messages' }), 60000);
      assert.equal(sent.length, 1);
      await shot(page, 'import-done-1440-light');
      // The same file again is refused in plain words; the past imports list it without any text.
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Import 6 messages' }).click();
      await seen(page.getByRole('alert').filter({ hasText: 'This export was already imported into this conversation' }), 60000);
      await page.reload({ waitUntil: 'load' });
      await seen(page.getByRole('cell', { name: 'E15 synthetic approval record' }));
      assert.equal(await page.getByText('call sheet').count(), 0, 'the page lists provenance, never text');
    }
    await c.close();
  }
  // 2. A member opens the history from the chat: read-only, apart from the conversation.
  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light']]) {
    const c = await context('member', { width, theme }), page = await open(c, `/chats?channel=${E.group}`, `chat ${width} ${theme}`);
    const banner = page.getByRole('button', { name: '6 earlier messages imported from WhatsApp' });
    await seen(banner);
    const dialog = page.getByRole('dialog', { name: 'Imported WhatsApp history' });
    const historyRequest = (r) => new URL(r.url()).pathname === `/api/v0/chats/${E.group}/history` && r.method() === 'GET';
    const receipt = { width, theme, phase: 'click', requests: 0, statuses: [], failedRequests: 0, messages: null };
    page.on('request', r => { if (historyRequest(r)) receipt.requests++; });
    page.on('response', r => { if (historyRequest(r.request())) receipt.statuses.push(r.status()); });
    page.on('requestfailed', r => { if (historyRequest(r)) receipt.failedRequests++; });
    try {
      const loaded = page.waitForResponse(r => historyRequest(r.request()));
      await Promise.all([banner.click(), loaded.then(async response => {
        receipt.phase = 'response';
        assert.equal(response.status(), 200, 'a member can read imported history');
        const history = await response.json(); receipt.messages = history.messages?.length ?? null;
        assert.equal(receipt.messages, 6, 'the imported messages reach the browser');
      })]);
      receipt.phase = 'dialog'; await expect(dialog).toBeVisible();
      receipt.phase = 'message';
      await seen(dialog.getByText('Morning, call sheet for the synthetic shoot:', { exact: false }));
    } catch (e) {
      // Counts and UI state only: never dump requests, credentials or message bodies.
      console.error('history diagnostics', { ...receipt, dialogs: await dialog.count(), pageErrors: errors.length });
      await shot(page, `history-failed-${width}-${theme}`);
      throw e;
    }
    await seen(dialog.getByText('Caption for the synthetic still'));
    await seen(dialog.getByText('Photo, file or voice note (not imported)'));
    await seen(dialog.getByText(/Imported by Pod Manager on .* with the owner’s approval\. Times are as the exporting phone showed them \(Asia\/Kolkata\)\./));
    assert.equal(await dialog.getByText('7700').count(), 0, 'a skipped number is nowhere'); checks++;
    assert.ok(await fits(page), `history fits ${width}`); checks++;
    await shot(page, `history-${width}-${theme}`);
    await c.close();
  }
  // 3. HR, outside the group: no banner, no conversation, and the history answers 404.
  {
    const c = await context('hr'), page = await open(c, `/chats?channel=${E.group}`, 'hr chat');
    await seen(page.getByText('This conversation isn’t in your list'));
    const status = await page.evaluate(async (id) => (await fetch(`/api/v0/chats/${id}/history`)).status, E.group);
    assert.equal(status, 404); checks++;
    const importPage = await open(c, '/chats/import', 'hr import');
    await seen(importPage.getByText('Only an admin imports WhatsApp history.'));
    await c.close();
  }
  assert.deepEqual(errors, []);
  if (process.env.PULSE_R47_REPORT) writeFileSync(process.env.PULSE_R47_REPORT, JSON.stringify({ browserChecks: checks, screenshots: shots ?? null }));
  console.log(`browser checks: ${checks}`);
} finally { await browser?.close(); server.kill(); await app.close(); await pool.end(); }
