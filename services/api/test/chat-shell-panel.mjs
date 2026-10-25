// CHAT-SHELL v2: every way the side panel opens, in one browser on a running Pulse (pulse-dev by default): a Pulse
// page (the page alone inside, signed in), a Google Doc, a Drive file and folder (Google's preview), a site that may
// be framed, a site that refuses (a card, never a blank box), back inside a page, resize by keyboard, hide, the tabs
// coming back after a reload, and the phone's sheet. Nothing is written. Screenshots in PULSE_JOURNEY_DIR.
//   PULSE_BASE=http://127.0.0.1:3200 PULSE_JOURNEY_DIR=~/ea-research/ux/journeys/chat-shell PLAYWRIGHT=<playwright/index.js> node services/api/test/chat-shell-panel.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? 'playwright');
const base = process.env.PULSE_BASE ?? 'http://127.0.0.1:3200', as = process.env.PULSE_AS ?? 'user-668d21b6@estateautopilots.com';
const dir = process.env.PULSE_JOURNEY_DIR ?? join(tmpdir(), 'chat-shell'); await mkdir(dir, { recursive: true });
const headers = { 'cf-access-authenticated-user-email': as };
const results = []; let failed = false;
const browser = await chromium.launch();
async function check(name, fn, ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: headers, ...ctxOpts });
  const page = await ctx.newPage();
  try { await fn(page); results.push(`PASS ${name}`); }
  catch (e) { failed = true; results.push(`FAIL ${name}: ${e.message.split('\n')[0].slice(0, 200)}`); }
  await page.screenshot({ path: join(dir, `panel-${name}.png`) }).catch(() => {});
  console.log(results.at(-1)); await ctx.close();
}
const panel = (p) => p.locator('aside[aria-label="Side panel"]');
const shown = (p) => p.locator('aside[aria-label="Side panel"] section:not([hidden])');
const open = (p, detail) => p.evaluate((d) => window.dispatchEvent(new CustomEvent('pulse:panel', { detail: d })), detail);
async function chats(p) { await p.goto(`${base}/chats`, { waitUntil: 'load', timeout: 180000 }); await p.locator('[data-chat-row]').first().waitFor({ timeout: 90000 }); await p.waitForTimeout(800); }
const frameSrc = (p) => shown(p).locator('iframe').getAttribute('src');

await check('pulse-page', async (p) => {
  await chats(p); await open(p, { href: '/me/steps' });
  const f = p.frameLocator('aside[aria-label="Side panel"] section:not([hidden]) iframe');
  await f.locator('main[data-embed]').waitFor({ timeout: 90000 });
  assert.equal(await f.locator('nav[aria-label="Main sections"]').count(), 0, 'no rail inside the panel');
  assert.equal(await f.locator('[data-shell-topbar]').count(), 0, 'no second top bar inside the panel');
  assert.equal(await f.locator('text=/Sign in/i').count(), 0, 'signed in inside the frame');
});
await check('back-inside-a-page', async (p) => {
  await chats(p); await open(p, { href: '/me' });
  const f = p.frameLocator('aside[aria-label="Side panel"] section:not([hidden]) iframe');
  await f.locator('main[data-embed]').waitFor({ timeout: 90000 });
  await p.evaluate(() => { const w = document.querySelector('aside[aria-label="Side panel"] section:not([hidden]) iframe').contentWindow; w.location.assign('/me/steps?embed=1'); });
  await p.waitForFunction(() => /\/me\/steps/.test(document.querySelector('aside[aria-label="Side panel"] section:not([hidden]) iframe').contentWindow.location.pathname), null, { timeout: 60000 });
  await panel(p).getByRole('button', { name: 'Back' }).click();
  await p.waitForFunction(() => document.querySelector('aside[aria-label="Side panel"] section:not([hidden]) iframe').contentWindow.location.pathname === '/me', null, { timeout: 60000 });
});
await check('google-doc', async (p) => {
  await chats(p); await open(p, { href: 'https://docs.google.com/document/d/1PulsePanelTestDocId00/edit' });
  assert.match(await frameSrc(p), /^https:\/\/docs\.google\.com\/document\/d\/1PulsePanelTestDocId00\/preview$/);
  assert.ok(await panel(p).getByRole('link', { name: 'Open in a new tab' }).count(), 'the way out to Google is always there');
});
await check('drive-file-and-folder', async (p) => {
  await chats(p); await open(p, { href: 'https://drive.google.com/file/d/1PulsePanelTestFile0/view' });
  assert.match(await frameSrc(p), /drive\.google\.com\/file\/d\/1PulsePanelTestFile0\/preview/);
  await open(p, { href: 'https://drive.google.com/drive/folders/1PulsePanelTestFolder' });
  assert.match(await frameSrc(p), /embeddedfolderview\?id=1PulsePanelTestFolder/);
  assert.equal(await panel(p).locator('[role="tab"]').count(), 2, 'two tabs');
});
await check('site-that-frames', async (p) => {
  await chats(p); await open(p, { href: 'https://example.com/' });
  await shown(p).locator('iframe, [class*="linkCard"]').first().waitFor({ timeout: 30000 });
  assert.equal(await shown(p).locator('iframe').count(), 1, 'example.com is framed');
});
await check('site-that-refuses', async (p) => {
  await chats(p); await open(p, { href: 'https://github.com/' });
  await shown(p).getByRole('link', { name: 'Open in a new tab' }).last().waitFor({ timeout: 30000 });
  assert.equal(await shown(p).locator('iframe').count(), 0, 'a card, not a blank frame');
});
await check('resize-hide-restore', async (p) => {
  await chats(p); await open(p, { href: '/me/steps' }); await panel(p).waitFor();
  const before = (await panel(p).boundingBox()).width;
  const edge = p.getByRole('separator', { name: 'Resize the side panel' }); await edge.focus(); await edge.press('ArrowLeft'); await edge.press('ArrowLeft');
  const after = (await panel(p).boundingBox()).width; assert.ok(after > before + 40, `wider by keyboard (${before} → ${after})`);
  await p.reload({ waitUntil: 'load' }); await p.locator('[data-chat-row]').first().waitFor({ timeout: 90000 });
  await panel(p).waitFor({ timeout: 30000 }); assert.ok(await panel(p).locator('[role="tab"]', { hasText: /steps/i }).count(), 'the tab is back after a reload');
  await panel(p).getByRole('button', { name: 'Hide the side panel' }).click(); await panel(p).waitFor({ state: 'detached', timeout: 5000 });
});
await check('phone-sheet', async (p) => {
  await chats(p); await open(p, { href: '/me/steps' });
  await p.locator('aside[aria-label="Side panel"][data-phone]').waitFor({ timeout: 30000 });
  const box = await panel(p).boundingBox(); assert.ok(box.width <= 390 && box.y > 20, 'a sheet from the bottom');
}, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await check('dark-theme', async (p) => { await chats(p); await open(p, { href: '/me/steps' }); await shown(p).locator('iframe').waitFor({ timeout: 60000 }); await p.waitForTimeout(3000); }, { colorScheme: 'dark' });

await browser.close();
await writeFile(join(dir, 'panel-results.txt'), `${new Date().toISOString()} ${base}\n${results.join('\n')}\n`);
if (failed) process.exit(1);
