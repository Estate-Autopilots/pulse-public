// FIX-CHAT-AI in the browser: the real API and the web app on a disposable synthetic agency (tests/core/
// test_fix_chat_ai_browser.py). PULSE_FCA_WEB=dev runs `next dev` (no build needed); otherwise `next start` on a build.
// Optional screenshots: PULSE_FCA_SCREENSHOTS=<dir>.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool); let browserChecks = 0;
const E = JSON.parse(process.env.TEST_IDS);
const shots = process.env.PULSE_FCA_SCREENSHOTS;
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const dev = process.env.PULSE_FCA_WEB === 'dev';
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', dev ? 'dev' : 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web',
  env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: dev ? 'development' : 'production', PULSE_PUBLIC_LOGIN_ENABLED: '0', NEXT_TELEMETRY_DISABLED: '1' }, stdio: 'ignore' });
let browser;
const check = (condition, msg) => { browserChecks++; assert.ok(condition, msg); };
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load', timeout: dev ? 300000 : 90000 }); await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 60000 }); await page.waitForTimeout(600); };
const shot = async (page, name) => { if (shots) { await page.waitForTimeout(500); await page.screenshot({ path: `${shots}/${name}.png` }); } };
try {
  for (let i = 0; i < 300; i++) { try { const r = await fetch(`${base}/healthz`); if (r.status < 500) break; } catch { /* not yet */ } await delay(1000); }
  browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'] });
  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']]) {
    const phone = width < 600, tag = `${width}-${theme}`;
    const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, extraHTTPHeaders: { 'cf-access-authenticated-user-email': process.env.TEST_MEMBER }, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
    await ctx.addInitScript((t) => { localStorage.setItem('pulse.theme', t); localStorage.setItem('pulse.notify.browser.asked', '1'); sessionStorage.setItem('pulse.chat.dock.open', '1'); }, theme);
    const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    if (!phone) {
      // 1. The header chat: never open by itself (even where the old dock remembered "open"), a compact popover on a click.
      await go(page, '/dashboard');
      check(await page.locator('[data-chat-dock-panel]').count() === 0, 'the chat popover does not open by itself');
      await page.locator('[data-chat-dock]').click();
      const pop = page.locator('[data-chat-dock-panel]'); await expect(pop).toBeVisible({ timeout: 30000 }); browserChecks++;
      const box = await pop.boundingBox(); check(box.width <= 400 && box.height <= 600, `compact (${Math.round(box.width)}×${Math.round(box.height)})`);
      await expect(pop.locator('[data-dock-row]').first()).toBeVisible({ timeout: 30000 }); browserChecks++;
      check(await pop.locator('[data-dock-row]').count() >= 3, 'the recent conversations, not only the last one');
      await expect(pop.getByRole('link', { name: 'New message' })).toBeVisible(); browserChecks++;
      await shot(page, `01-chat-popover-list-${tag}`);
      await pop.locator(`[data-dock-row="${E.crew}"]`).click();
      await expect(pop.getByRole('log')).toBeVisible({ timeout: 30000 }); browserChecks++;
      await expect(pop.getByRole('textbox', { name: /^Message / })).toBeVisible(); browserChecks++;
      await shot(page, `02-chat-popover-conversation-${tag}`);
      await page.keyboard.press('Escape'); await expect(pop.locator('[data-dock-row]').first()).toBeVisible(); browserChecks++;
      await pop.getByRole('tab', { name: /Unread/ }).click(); await page.waitForTimeout(300);
      await page.keyboard.press('Escape'); await expect(pop).toHaveCount(0); browserChecks++;
      await page.locator('[data-chat-dock]').click(); await expect(pop).toBeVisible(); await page.mouse.click(700, 600); await expect(pop).toHaveCount(0); browserChecks++;
    }
    // 2. Chats: Chats · Groups · Calls tabs; direct chats in Chats, groups in Groups.
    await go(page, '/chats');
    const tabs = page.locator('[data-chat-sections]'); await expect(tabs).toBeVisible({ timeout: 60000 }); browserChecks++;
    await tabs.locator('[data-section="chats"]').click();
    await expect(page.locator(`[data-chat-row]`).first()).toBeVisible({ timeout: 30000 }); browserChecks++;
    check(await page.locator('nav[aria-label="Conversations"] [data-chat-row]').filter({ hasText: 'Sunrise shoot crew' }).count() === 0, 'groups are not under Chats');
    await shot(page, `03-chats-tab-chats-${tag}`);
    await tabs.locator('[data-section="groups"]').click();
    await expect(page.locator('nav[aria-label="Conversations"] [data-chat-row]').filter({ hasText: 'Sunrise shoot crew' })).toBeVisible({ timeout: 30000 }); browserChecks++;
    await shot(page, `04-chats-tab-groups-${tag}`);
    check(await fits(page), `no sideways scroll on Chats (${tag})`);
    // 3. Data review: out of the chat, one place.
    await go(page, '/chats/data');
    await expect(page.getByRole('heading', { name: 'Data review' })).toBeVisible({ timeout: 60000 }); browserChecks++;
    await expect(page.getByRole('link', { name: /Check voice-note transcripts/ })).toBeVisible(); browserChecks++;
    check(await fits(page), `no sideways scroll on Data review (${tag})`);
    await shot(page, `05-data-review-${tag}`);
    // 4. Calls: the log and, beside it (below on a phone), this week and who to call.
    await go(page, '/calls');
    await expect(page.getByRole('complementary', { name: 'Your calls this week' })).toBeVisible({ timeout: 60000 }); browserChecks++;
    await expect(page.getByRole('button', { name: /^Call / }).first()).toBeVisible({ timeout: 30000 }); browserChecks++;
    check(await fits(page), `no sideways scroll on Calls (${tag})`);
    await shot(page, `06-calls-${tag}`);
    check(!errors.length, `no page errors (${tag}): ${errors.join(' | ').slice(0, 300)}`);
    await ctx.close();
  }
  const report = { browserChecks };
  if (process.env.PULSE_FCA_REPORT) await writeFile(process.env.PULSE_FCA_REPORT, JSON.stringify(report));
  console.log(JSON.stringify(report));
} finally {
  await browser?.close().catch(() => {}); server.kill('SIGTERM'); await app.close(); await pool.end();
}
