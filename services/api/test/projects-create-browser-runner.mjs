// PROJECTS-CREATE in the browser (tests/core/test_projects_create.py): the real API on a disposable synthetic company and the
// web app under `next dev`. Work → Projects says where projects come from and has New project as its primary action;
// leadership gives an unplanned project a stage plan from its row (taking a ready-made one, as the company has none) and
// starts a planned project in a few fields; a new project with no tasks still shows, and the No stage plan chip finds it;
// a pod head starts one on a phone; a member sees New task and the one line about Billing. Phone (390) and desktop
// (1440), no sideways scroll, no page errors. Screenshots with PULSE_PC_SCREENSHOTS=<dir>. Everything is invented.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const E = JSON.parse(process.env.TEST_IDS), shots = process.env.PULSE_PC_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const emails = { admin: 'admin@estateautopilots.com', editor: E.editorEmail, head: E.headEmail };
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true,
  env: { ...process.env, PULSE_API_URL: origin, NEXT_DIST_DIR: '.next-pc', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverTail = '', serverExit = null;
server.stderr.on('data', (b) => { serverTail = (serverTail + b).slice(-2000); });
server.on('exit', (code, signal) => { serverExit = `${code ?? signal}`; });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
let browser, checks = 0, current = 'start', last;
const step = (n) => { current = n; console.log(`step ${n} at ${Math.round(process.uptime())} s`); };
const deadline = setTimeout(() => { console.error(`projects-create-browser-runner: no result after 25 minutes (step ${current})`); try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); }, 25 * 60_000);
deadline.unref();
const seen = async (locator, timeout = 180000) => { await expect(locator.first()).toBeVisible({ timeout }); checks++; };
const fits = async (page, what) => { const ok = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); assert.ok(ok, `${what} has no sideways scroll`); checks++; };
const errors = [];
async function context(role, width = 1440) {
  const phone = width < 600;
  return browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
}
async function open(c, path, name) {
  const page = await c.newPage(); last = page;
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base + path, { waitUntil: 'load', timeout: 300000 });
  return page;
}
const shot = async (page, name, full = true) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: full }); };
const call = async (role, path, body) => {
  const r = await fetch(`${base}/api/v0/${path}`, { method: body ? 'POST' : 'GET', headers: { 'cf-access-authenticated-user-email': emails[role], ...(body ? { 'content-type': 'application/json', origin: base } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); assert.ok(r.status < 300, `${path}: ${JSON.stringify(j)}`); return j;
};
const PROJECTS = '/tasks?view=projects';
try {
  for (let i = 0; i < 600; i++) { try { if ((await fetch(base + '/login', { signal: AbortSignal.timeout(30000) })).ok) break; } catch { /* starting */ } if (serverExit !== null) throw Error(`next dev exited (${serverExit}): ${serverTail.trim().slice(-600)}`); await delay(1000); }
  browser = await chromium.launch();
  // 1. Leadership: New project is the primary action, the page says where client projects come from, the late project is
  //    the first to start with, and its "no stage plan" is a button that gives it one (a ready-made plan, the company's first).
  step(1);
  {
    const c = await context('admin'), page = await open(c, PROJECTS, 'admin projects');
    const header = page.locator('[data-page-header]');
    await seen(header.getByRole('button', { name: 'New project' }));
    await expect(header.getByRole('button', { name: 'New task' })).toHaveCount(0); checks++;
    await seen(page.getByText(/projects start by themselves when the \w+ pays an invoice in/i));
    await seen(page.getByRole('link', { name: 'Billing' }));
    const start = page.getByRole('region', { name: 'Start with' }).or(page.locator('section[aria-label="Start with"]')).first();
    await seen(start.getByRole('link', { name: 'Synthetic Riverside launch' }));
    await seen(start.getByText(/1 late/));
    await seen(page.getByRole('navigation', { name: /Show / }).getByRole('link', { name: /No stage plan/ }));
    // The phone's + New never shows on a computer (C and N are its keys).
    await expect(page.locator('[data-phone-new]')).toBeHidden(); checks++;
    await fits(page, 'Work → Projects 1440'); await shot(page, 'projects-before-1440');
    await start.getByRole('button', { name: 'Choose a stage plan for Synthetic Riverside launch' }).click();
    const dlg = page.getByRole('dialog', { name: 'Choose a stage plan' });
    await seen(dlg.getByRole('radio', { name: /Simple project/ }), 60000);
    await dlg.getByRole('radio', { name: /Simple project/ }).click();
    await seen(dlg.getByText('Kick-off day'));
    await shot(page, 'plan-pick-1440', false);
    await dlg.getByRole('button', { name: 'Use this plan' }).click();
    await seen(page.getByText('Synthetic Riverside launch now runs in stages'), 60000);
    await seen(page.getByText(/Stage 0 · Kick-off/), 60000);
    await c.close();
  }
  // 2. Leadership starts a planned project in a few fields: name, lead, a stage plan (now one of the company's own).
  step(2);
  {
    const c = await context('admin'), page = await open(c, PROJECTS, 'admin new project');
    await page.locator('[data-page-header]').getByRole('button', { name: 'New project' }).click();
    const dlg = page.getByRole('dialog', { name: 'New project' });
    await seen(dlg.getByText(/projects start by themselves/i));
    await dlg.getByLabel('Name').fill('Synthetic office move');
    await expect(dlg.locator('select[name="leadId"] option', { hasText: 'Editor Two' })).toHaveCount(1, { timeout: 60000 }); checks++;
    await dlg.locator('select[name="leadId"]').selectOption({ label: 'Editor Two' });
    await seen(dlg.getByRole('radio', { name: /No stage plan/ }), 60000);
    await dlg.getByRole('radio', { name: /Simple project/ }).click();
    await seen(dlg.getByText('Kick-off day'));
    await shot(page, 'new-project-1440', false);
    await dlg.getByRole('button', { name: 'Create project' }).click();
    await page.waitForURL(/\/tasks\/projects\/[0-9a-f-]{36}/, { timeout: 120000 }); checks++;
    await seen(page.getByRole('heading', { name: 'Synthetic office move' }));
    await seen(page.getByRole('list', { name: 'Stages' }).getByText('Do the work'));
    await shot(page, 'new-project-page-1440');
    // A new project without tasks or a plan shows on Work → Projects, and the No stage plan chip finds it.
    await call('admin', 'work/projects', { type: 'internal', name: 'Synthetic brand refresh' });
    await page.goto(`${base}${PROJECTS}&f=noplan`, { waitUntil: 'load' });
    const list = page.getByRole('list', { name: 'Projects' });
    await seen(list.getByRole('link', { name: 'Synthetic brand refresh' }));
    await seen(list.getByRole('button', { name: 'Choose a stage plan for Synthetic brand refresh' }));
    await expect(list.getByRole('link', { name: 'Synthetic office move' })).toHaveCount(0); checks++;
    await page.goto(base + PROJECTS, { waitUntil: 'load' });
    await seen(page.getByRole('list', { name: 'Projects' }).getByRole('link', { name: 'Synthetic office move' }));
    await fits(page, 'Work → Projects after 1440'); await shot(page, 'projects-after-1440');
    await c.close();
  }
  // 3. A pod head on a phone: the same page fits, New project opens the same few fields, and a project without a plan is made.
  step(3);
  {
    const c = await context('head', 390), page = await open(c, PROJECTS, 'head projects phone');
    await seen(page.getByRole('button', { name: 'New project' }));
    await seen(page.getByText(/projects start by themselves/i));
    // On a phone, + New is always in view and opens the Create dialog.
    await seen(page.locator('[data-phone-new]'));
    await fits(page, 'Work → Projects 390'); await shot(page, 'projects-390');
    await page.locator('[data-phone-new]').click();
    await seen(page.getByRole('dialog').getByText(/Project/));
    await shot(page, 'phone-new-390', false);
    await page.goto(base + PROJECTS, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'New project' }).first().click();
    const dlg = page.getByRole('dialog', { name: 'New project' });
    await dlg.getByLabel('Name').fill('Synthetic hiring drive');
    await seen(dlg.getByRole('radio', { name: /No stage plan/ }), 60000);
    await fits(page, 'New project 390'); await shot(page, 'new-project-390', false);
    await dlg.getByRole('button', { name: 'Create project' }).click();
    await page.waitForURL(/\/tasks\/projects\/[0-9a-f-]{36}/, { timeout: 120000 }); checks++;
    await seen(page.getByRole('heading', { name: 'Synthetic hiring drive' }));
    await c.close();
  }
  // 4. A member (who does not start projects) keeps New task, and reads where projects come from.
  step(4);
  {
    const c = await context('editor', 390), page = await open(c, PROJECTS, 'editor projects phone');
    await seen(page.getByText(/projects start by themselves/i));
    const header = page.locator('[data-page-header]');
    await expect(header.getByRole('button', { name: 'New project' })).toHaveCount(0); checks++;
    await fits(page, 'Work → Projects member 390'); await shot(page, 'projects-member-390');
    await c.close();
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log(`projects-create-browser-runner: ${checks} checks passed`);
} catch (e) {
  if (last && shots) await last.screenshot({ path: `${shots}/failure.png`, fullPage: true }).catch(() => {});
  console.error(`step ${current}: ${e?.stack ?? e}`); console.error(serverTail.slice(-1500));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {}); stopServer(); await app.close().catch(() => {}); await pool.end().catch(() => {});
  clearTimeout(deadline);
}
