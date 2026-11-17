// AI-AGENTS-2: the API and (PULSE_AUTH_BROWSER=1) a Playwright walk of an AI employee's profile (Work & queue,
// Capabilities as tool groups, Model & limits, Role & place with the triage's recipients), an AI's numbered answer in the
// chat, and Settings → AI, on a disposable synthetic company (tests/core/test_ai_agents_2_browser.py). Synthetic people
// and runs; nothing is sent anywhere. Screenshots go to AI_AGENTS_2_SHOTS.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import pg from 'pg';
import { createApp } from '../dist/app.js';

// AI-AGENTS-3: a synthetic Telegram bot name (nothing calls Telegram: the API only builds t.me links from it), so the
// Channels pane can make a one-time code and show its QR; jsQR (the web app's test decoder) reads the QR as drawn.
process.env.VITALS_TELEGRAM_BOT_USERNAME = 'ExampleTestBot'; process.env.VITALS_TELEGRAM_BOT_TOKEN = 'synthetic-not-a-token';
const jsQR = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('jsqr');

const pool = new pg.Pool(JSON.parse(process.env.TEST_API_CONFIG)), owner = new pg.Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
const worker = new pg.Pool(JSON.parse(process.env.TEST_WORKER_CONFIG));
const app = createApp(pool, pool), ADMIN = process.env.TEST_ADMIN_EMAIL, MEMBER = process.env.TEST_MEMBER;
const AI = process.env.TEST_AGENT, DM = process.env.TEST_DM, WATCHERS = JSON.parse(process.env.TEST_WATCHERS);
const shots = process.env.AI_AGENTS_2_SHOTS || join(tmpdir(), 'ai-agents-2-shots');
let apiChecks = 0, browserChecks = 0, web, browser;
const call = async (path, who, method = 'GET', body, expected = 200) => {
  apiChecks++;
  const r = await app.inject({ url: '/api/v0/' + path, method, headers: { 'cf-access-authenticated-user-email': who }, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `${method} ${path}: ${r.body}`);
  return r.json();
};
const restore = () => { try { execFileSync('git', ['checkout', '--', 'apps/web/tsconfig.json', 'apps/web/next-env.d.ts'], { cwd: '../..', stdio: 'ignore' }); } catch { /* not a checkout */ } };

try {
  // ---- API --------------------------------------------------------------------------------------------------------
  // The daily triage's recipients (2232): its managers set them, the profile reads them, a member cannot.
  let d = await call(`agents/${AI}/detail`, ADMIN);
  assert.deepEqual(d.ai.triageWatchers, [], 'nobody else yet'); assert.equal(d.ai.dailyTriage, true);
  await call(`agents/${AI}/settings`, ADMIN, 'POST', { triageWatchers: WATCHERS });
  d = await call(`agents/${AI}/detail`, ADMIN);
  assert.deepEqual([...d.ai.triageWatchers].sort(), [...WATCHERS].sort(), 'the two recipients are kept');
  await call(`agents/${AI}/settings`, MEMBER, 'POST', { triageWatchers: [] }, 403);
  await call(`agents/${AI}/settings`, ADMIN, 'POST', { triageWatchers: ['not-a-person'] }, 400);
  // The daily limit up to 5 crore tokens (2231).
  await call(`agents/${AI}/settings`, ADMIN, 'POST', { dailyTokenBudget: 30000000 });
  d = await call(`agents/${AI}/detail`, ADMIN);
  assert.equal(Number(d.settings.dailyTokenBudget), 30000000, '3 crore a day is kept');
  await call(`agents/${AI}/settings`, ADMIN, 'POST', { dailyTokenBudget: 60000000 }, 400);
  // Capabilities: every operation in its areas, in groups, not only the few with an MCP name.
  const caps = await call(`admin/runners/agents/${AI}/capabilities`, ADMIN);
  const areas = new Set(caps.tools.map((t) => t.area));
  assert.ok(caps.tools.length >= 40 && areas.size >= 4, `tools in groups (${caps.tools.length} in ${areas.size})`);
  assert.ok(caps.tools.some((t) => t.writes) && caps.tools.some((t) => !t.writes), 'reads and changes are told apart');
  // Its runs for Work & queue: three done today and one failed.
  const r = await call(`agents/${AI}/runs?limit=25`, ADMIN);
  assert.equal(r.runs.filter((x) => x.state === 'done').length, 3); assert.equal(r.runs.filter((x) => x.state === 'error').length, 1);
  apiChecks += 6;

  // ---- the browser walk --------------------------------------------------------------------------------------------
  if (process.env.PULSE_AUTH_BROWSER === '1') {
    mkdirSync(shots, { recursive: true });
    const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const probe = createServer(); await new Promise((ok) => probe.listen(0, '127.0.0.1', ok)); const port = probe.address().port; await new Promise((ok) => probe.close(ok));
    const base = `http://127.0.0.1:${port}`;
    web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true, stdio: 'ignore',
      env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-ai-agents-2', PULSE_PUBLIC_LOGIN_ENABLED: '' } });
    for (let i = 0; i < 480; i++) { try { if ((await fetch(base + '/login')).status < 500) break; } catch { /* starting */ } await delay(250); if (i === 479) throw Error('web did not start'); }
    browser = await chromium.launch({ headless: true });
    const ctx = async (width, theme) => {
      const c = await browser.newContext({ viewport: { width, height: width < 700 ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1, reducedMotion: 'reduce',
        ...(width < 700 ? { hasTouch: true, isMobile: true } : {}), extraHTTPHeaders: { 'cf-access-authenticated-user-email': ADMIN } });
      await c.addInitScript((t) => { localStorage.setItem('pulse.theme', t); localStorage.setItem('pulse.notify.browser.asked', '1'); }, theme);
      return c;
    };
    const shot = async (page, file, target) => {
      // The pane in question: brought to the top of the window, then the window's view (the shell scrolls its own box).
      await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' }).catch(() => {});
      // AI-AGENTS-3 (judge: "the heading is clipped under the top bar"): the pane's top just under the top bar.
      // Only the pane's own scroll box moves (the window itself never scrolls on a phone: that left a blank half).
      // A phone keeps round 4's scrolling (its shell is the page; moving the window left a blank strip under the tab bar).
      if (target && (page.viewportSize()?.width ?? 1440) < 700) await target.scrollIntoViewIfNeeded().catch(() => {});
      else if (target) await target.evaluate((el) => {
        let box = el.parentElement;
        while (box && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
        if (box) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 12; else el.scrollIntoView({ block: 'nearest' });
      }).catch(() => {});
      await delay(500);
      await page.screenshot({ path: join(shots, file) });
    };
    const noSideways = async (page, what) => {
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(wide <= 1, `no sideways scroll on ${what} (${wide}px)`); browserChecks++;
    };
    const profile = (s) => `${base}/people/${AI}?tab=ai&s=${s}`;
    const consoleErrors = [], problems = [];
    const pane = async (name, fn) => { try { await fn(); } catch (e) { problems.push(`${name}: ${String(e?.message ?? e).split('\n').slice(0, 4).join(' ').slice(0, 400)}`); } };
    { const c = await ctx(1440, 'light'), p = await c.newPage();
      for (const u of [profile('queue'), `${base}/chats?channel=${DM}`, `${base}/settings?tab=ai`]) await p.goto(u, { timeout: 300000 }).catch(() => {});
      await c.close(); }
    for (const [width, theme] of (process.env.AI_AGENTS_2_SIZES ? JSON.parse(process.env.AI_AGENTS_2_SIZES) : [[1440, 'light'], [1440, 'dark'], [363, 'light'], [363, 'dark']])) {
      const c = await ctx(width, theme), page = await c.newPage(), errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      // Every console error, with the page it came from, kept beside the shots (the dev "Issue" badge and glitch toast).
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push({ at: `${width}-${theme}`, url: page.url().replace(base, ''), text: m.text().slice(0, /hydrat/i.test(m.text()) ? 6000 : 600) }); });
      await pane(`1. Work & queue at ${width} ${theme}`, async () => {
        // 1. Work & queue: waiting, working now, done and failed today, the open task, the latest runs.
        await page.goto(profile('queue'), { timeout: 180000 });
        const pane = page.locator('#ai-pane-queue');
        await expect(pane.getByRole('heading', { name: 'Work & queue' })).toBeVisible({ timeout: 120000 });
        const tiles = pane.getByRole('group', { name: 'Its work at a glance' });
        await expect(tiles).toContainText('Done today'); await expect(tiles).toContainText('Failed today');
        await expect(pane.getByText('Draft the quotation for Harbor Crest (test)')).toBeVisible({ timeout: 60000 });
        await expect(pane.locator('[data-ai-runs] li')).toHaveCount(4);
        browserChecks += 4;
        await noSideways(page, `Work & queue at ${width}`);
        await shot(page, `queue-${width}-${theme}.png`, pane);
      });
      await pane(`2. Capabilities at ${width} ${theme}`, async () => {
        // 2. Capabilities: tool groups.
        await page.goto(profile('capabilities'), { timeout: 180000 });
        const groups = page.locator('[data-tool-groups] > li');
        await expect(groups.first()).toBeVisible({ timeout: 120000 });
        assert.ok(await groups.count() >= 4, 'four or more tool groups'); browserChecks += 2;
        await noSideways(page, `Capabilities at ${width}`);
        await shot(page, `capabilities-${width}-${theme}.png`, page.locator('#ai-pane-capabilities'));
        // AI-AGENTS-3 (owner: "root / read / sandbox can't be turned on"): a tier is chosen and the card keeps its choices
        // (the save's answer used to replace the row: "AI employees are off here" right after the first click).
        if (width === 1440 && theme === 'light' && process.env.TEST_SERVER) {
          const box = page.locator('li', { has: page.getByText('synthetic-box', { exact: true }) }).last();
          await expect(box.getByRole('group', { name: 'Tier on synthetic-box' })).toBeVisible({ timeout: 60000 });
          // A click on the card's body (its list of what it allows), not only on its title, chooses it.
          await box.getByLabel('Read-only: what it allows').click();
          await expect(box).toContainText('Now: Read-only', { timeout: 30000 });
          await expect(box).not.toContainText('AI employees are off here');
          await expect(box.getByRole('radio', { name: 'Read-write (sandboxed)' })).toBeEnabled();
          await box.getByText('Read-write (sandboxed)', { exact: true }).click();
          await expect(box).toContainText('Now: Read-write (sandboxed)', { timeout: 30000 });
          await box.getByText('Default', { exact: true }).click();
          await expect(box).toContainText('Now: Default', { timeout: 30000 });
          browserChecks += 4;
        }
      });
      await pane(`3. Model & limits at ${width} ${theme}`, async () => {
        // 3. Model & limits: the daily limit up to 5 crore, quick picks in lakh and crore.
        await page.goto(profile('model'), { timeout: 180000 });
        await expect(page.getByRole('button', { name: '1 crore' })).toBeVisible({ timeout: 120000 });
        await expect(page.getByLabel('Daily limit (tokens)')).toHaveValue('3,00,00,000');
        await expect(page.locator('#ai-pane-model')).not.toContainText('Loading the connected AI', { timeout: 60000 });
        browserChecks += 2;
        await noSideways(page, `Model & limits at ${width}`);
        await shot(page, `model-${width}-${theme}.png`, page.locator('#ai-pane-model'));
      });
      await pane(`4. Role & place at ${width} ${theme}`, async () => {
        // 4. Role & place: the daily triage and who else receives it.
        await page.goto(profile('role'), { timeout: 180000 });
        const to = page.getByRole('group', { name: 'Also send the triage to' });
        await expect(to).toBeVisible({ timeout: 120000 });
        await expect(page.locator('[data-triage-to]')).toContainText('2 more people get');
        browserChecks += 2;
        await noSideways(page, `Role & place at ${width}`);
        await shot(page, `role-${width}-${theme}.png`, page.locator('[data-triage-to]'));
      });
      await pane(`4b. Tools & training at ${width} ${theme}`, async () => {
        // 4b. Tools & training: the company's MCP servers (Settings → Connectors), not a text box.
        await page.goto(profile('tools'), { timeout: 180000 });
        const mcp = page.locator('[data-ai-mcp]');
        await expect(mcp).toContainText('Other apps it may use', { timeout: 120000 });
        await expect(mcp.getByRole('link', { name: 'Add an app' })).toHaveAttribute('href', '/settings?tab=connectors');
        assert.equal(await mcp.locator('textarea, input[type="text"]').count(), 0, 'no hand-typed MCP names');
        await expect(page.getByRole('group', { name: 'Add a section to its instructions' }).getByRole('button', { name: /Its job/ })).toBeVisible();
        browserChecks += 4;
        await noSideways(page, `Tools & training at ${width}`);
        await shot(page, `tools-${width}-${theme}.png`, mcp);
      });
      await pane(`4c. Channels at ${width} ${theme}`, async () => {
        // 4c. Channels: its own section (Telegram, WhatsApp, listening), the company's switches folded at the end.
        await page.goto(profile('channels'), { timeout: 180000 });
        const reach = page.getByTestId('agent-channels');
        await expect(reach).toBeVisible({ timeout: 120000 });
        await expect(page.locator('#ai-pane-channels').getByRole('heading', { name: 'Channels' })).toBeVisible();
        // AI-AGENTS-3: no card stays on "Checking…"; on a computer, Attach Telegram shows a QR that a phone reads.
        await expect(reach).not.toContainText('Checking…', { timeout: 60000 });
        browserChecks += 3;
        if (width >= 700) {
          await reach.getByRole('button', { name: 'Attach Telegram' }).click();
          const qr = reach.locator('svg[data-link-qr]');
          await expect(qr).toBeVisible({ timeout: 30000 });
          const link = await qr.getAttribute('data-link-qr');
          assert.match(link, /^https:\/\/t\.me\/ExampleTestBot\?start=\S{8,}$/, `the QR's link (${link})`);
          // What the browser drew, painted into pixels and read back by an independent decoder: a phone gets the same link.
          const px = await qr.evaluate(async (svg) => {
            const size = 336, img = new Image(), xml = new XMLSerializer().serializeToString(svg);
            img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`; await img.decode();
            const cv = document.createElement('canvas'); cv.width = size; cv.height = size; const g = cv.getContext('2d');
            g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); g.drawImage(img, 0, 0, size, size);
            return { size, data: Array.from(g.getImageData(0, 0, size, size).data) };
          });
          const read = jsQR(Uint8ClampedArray.from(px.data), px.size, px.size);
          assert.equal(read?.data, link, 'the QR on screen decodes to the same t.me link');
          await expect(reach.locator('[data-telegram-steps]')).toContainText('Point your phone’s camera at the code');
          browserChecks += 3;
        }
        await noSideways(page, `Channels at ${width}`);
        await shot(page, `channels-${width}-${theme}.png`, page.locator('#ai-pane-channels'));
      });
      await pane(`5. The chat at ${width} ${theme}`, async () => {
        // 5. The chat: the AI's numbered answer typeset (a list of three, a nested list, bold), no raw Markdown.
        await page.goto(`${base}/chats?channel=${DM}`, { timeout: 180000 });
        const md = page.locator('[data-agent-md]').last();
        await expect(md).toBeVisible({ timeout: 120000 });
        await expect(md.locator(':scope > ol > li')).toHaveCount(3);
        await expect(md.locator('ol li ul li')).toHaveCount(2);
        await expect(md.locator('strong').first()).toContainText('Harbor Crest');
        assert.ok(!(await md.innerText()).includes('**'), 'no raw ** in the answer');
        browserChecks += 4;
        await noSideways(page, `Chat at ${width}`);
        await shot(page, `chat-${width}-${theme}.png`, md);
      });
      await pane(`6. Settings → AI at ${width} ${theme}`, async () => {
        // 6. Settings → AI: the built-in workspace in plain words, cards with logos where an app has one.
        await page.goto(`${base}/settings?tab=ai`, { timeout: 180000 });
        const cloud = page.getByRole('article', { name: 'Pulse cloud workspace' });
        await expect(cloud).toBeVisible({ timeout: 120000 });
        await expect(cloud).not.toContainText('Waiting for the key');
        await expect(cloud).toContainText('Nothing to set up');
        browserChecks += 2;
        await noSideways(page, `Settings → AI at ${width}`);
        await shot(page, `settings-ai-${width}-${theme}.png`, page.getByText('Connected AI', { exact: true }).first());
      });
      writeFileSync(join(shots, 'console-errors.json'), JSON.stringify(consoleErrors, null, 1));
      if (errors.length) problems.push(`page errors at ${width} ${theme}: ${errors.join(' | ').slice(0, 400)}`); else browserChecks++;
      writeFileSync(join(shots, 'problems.json'), JSON.stringify(problems, null, 1));
      await c.close();
    }
    assert.deepEqual(problems, [], 'every screen as expected (problems.json beside the shots)');
  }
  writeFileSync(process.env.AI_AGENTS_2_REPORT || join(tmpdir(), 'ai-agents-2.json'), JSON.stringify({ apiChecks, browserChecks, shots, syntheticOnly: true }));
  console.log(JSON.stringify({ apiChecks, browserChecks, shots }));
} finally {
  await browser?.close().catch(() => {});
  if (web) { try { process.kill(-web.pid, 'SIGTERM'); } catch { /* gone */ } restore(); await delay(1500); rmSync('../../apps/web/.next-ai-agents-2', { recursive: true, force: true }); }
  await app.close().catch(() => {});
  await Promise.all([pool.end(), owner.end(), worker.end()]).catch(() => {});
}
