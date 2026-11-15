// KAZUK-REST slice 4 in the browser (tests/core/test_kazuk_rest_meetings.py): the real API on a disposable synthetic company
// and the web app under `next dev`, with Chromium's fake microphone. Start a meeting from Pip; the consent notice must be
// ticked before Start recording works; record a few seconds, stop, and land on the meeting with its consent line and audio;
// with transcripts off (no Whisper here) write the notes, get draft action items, make one a task. The list and the meeting
// at 1440 and 390, no sideways scroll, no page errors. Screenshots with PULSE_KR_SCREENSHOTS=<dir>. Everything is invented.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const emails = JSON.parse(process.env.TEST_EMAILS), shots = process.env.PULSE_KR_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-kr4', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
let browser, checks = 0, current = 'start', last;
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`kazuk-rest-meetings-browser-runner: no result after 25 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
async function context(role, width = 1440) {
  const phone = width < 600;
  return browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, permissions: ['microphone'],
    extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
}
async function open(c, path, name) {
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
  return page;
}
const shot = async (page, name, full = true) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: full }); };
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  // 1. The empty list, then Start a meeting from Pip's menu (the assistant).
  step(1);
  const c = await context('founder', 1440);
  const list = await open(c, '/meetings', 'meetings 1440');
  await seen(list.getByRole('heading', { name: 'Meetings' }));
  await seen(list.getByText('No meetings yet'));
  await fits(list, 'Meetings 1440'); await shot(list, 'meetings-empty-1440');
  const pip = list.getByRole('button', { name: /Open Pip.s menu/ });
  await seen(pip);
  await pip.click();
  await list.getByRole('menuitem', { name: /Start a meeting/ }).click();
  await list.waitForURL(/\/meetings\/new\?mode=record$/, { timeout: 240000 }); checks++;
  // 2. Consent first: Start recording stays off until it is ticked.
  step(2);
  const rec = list;
  // FIX-DOCS-WORK (owner, 10 Nov 2026: "recording should be on by default"): the notice sits with Start recording, and
  // pressing it is the consent (no box to tick); the meeting still keeps the consent line (step 3).
  await seen(rec.getByText('Tell everyone first.'));
  const startBtn = rec.getByRole('button', { name: 'Start recording' });
  await expect(rec.locator('[data-consent]')).toHaveCount(0); checks++;
  await rec.getByLabel('What is it about').fill('Synthetic launch review');
  await shot(rec, 'meeting-consent-1440');
  await expect(startBtn).toBeEnabled(); checks++;
  await startBtn.click();
  await seen(rec.locator('[data-recording]').getByText('Recording'), 60000);
  await delay(6500);
  await shot(rec, 'meeting-recording-1440', false);
  await rec.getByRole('button', { name: 'Stop and save' }).click();
  // 3. The meeting: consent line, audio, and (transcripts off) the notes box; notes give draft action items.
  step(3);
  await rec.waitForURL(/\/meetings\/[0-9a-f-]{36}/, { timeout: 240000 }); checks++;
  await seen(rec.locator('[data-consent-line]').getByText(/Consent confirmed by Synthetic Founder/));
  await seen(rec.locator('audio'));
  await seen(rec.getByText(/Transcripts are not switched on/));
  await rec.getByLabel('Meeting notes').fill('Good synthetic meeting.\nSynthetic Member will send the synthetic brochure by Monday.\nAction: book the synthetic site visit tomorrow\nThe synthetic weather will be fine.');
  await rec.getByRole('button', { name: 'Save and find action items' }).click();
  const drafts = rec.locator('[data-draft]');
  await expect(drafts).toHaveCount(2, { timeout: 60000 }); checks++;
  await expect(drafts.first().getByLabel('Task')).toHaveValue('Send the synthetic brochure'); checks++;
  await expect(drafts.nth(1).getByLabel('Task')).toHaveValue('Book the synthetic site visit'); checks++;
  await fits(rec, 'Meeting 1440'); await shot(rec, 'meeting-drafts-1440');
  await drafts.first().getByRole('button', { name: 'Make it a task' }).click();
  await seen(rec.getByRole('link', { name: 'Open the task' }));
  await expect(drafts).toHaveCount(1); checks++;
  await shot(rec, 'meeting-task-made-1440');
  const meetingUrl = rec.url().replace(base, '');
  await c.close();
  // 4. At 390: the list, the recorder's consent and the meeting fit the phone.
  step(4);
  const p = await context('founder', 390);
  const plist = await open(p, '/meetings', 'meetings 390');
  await seen(plist.getByText('Synthetic launch review'));
  await seen(plist.getByText('1 to confirm'));
  await fits(plist, 'Meetings 390'); await shot(plist, 'meetings-list-390');
  // MEETING-CAPTURE (360ad247, 10 Nov 2026): /meetings/new opens on Paste; the recorder and its consent notice are ?mode=record.
  const pnew = await open(p, '/meetings/new?mode=record', 'new 390');
  await seen(pnew.getByText('Tell everyone first.'));
  await fits(pnew, 'Start a meeting 390'); await shot(pnew, 'meeting-consent-390');
  const pm = await open(p, meetingUrl, 'meeting 390');
  await seen(pm.locator('[data-draft]'));
  await seen(pm.getByRole('link', { name: 'Open the task' }));
  await fits(pm, 'Meeting 390'); await shot(pm, 'meeting-390');
  await p.close();
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log(`kazuk-rest-meetings-browser-runner: ${checks} checks passed`);
} catch (e) {
  if (shots && last) await last.screenshot({ path: `${shots}/failure.png`, fullPage: true }).catch(() => undefined);
  console.error(e instanceof Error ? e.stack : e); process.exitCode = 1;
} finally {
  clearTimeout(deadline); await browser?.close().catch(() => undefined); stopServer(); await app.close().catch(() => undefined); await pool.end().catch(() => undefined);
}
