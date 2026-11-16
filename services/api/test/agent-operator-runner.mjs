// AGENT-OPERATOR: the operator view end to end on a disposable synthetic company (tests/core/test_agent_operator_browser.py).
// The AI employee's calls go through API v1 with its own key, as its runtime sends them. Always: the upload/download tools
// are listed, a click that sends asks the person every time (confirm), and a failed step carrying the page is filed as a
// bug with the AI employee as reporter, once per problem ("happened again" after). With PULSE_AUTH_BROWSER=1 a real
// browser opens /operator (1440 and 363, light and dark): the page it works in on the left, the chat on the right; the AI
// opens a page in that frame, reads it, clicks; the "Only you can say yes" prompt over the page; a step that does not
// work with its bug number; Stop answers at once. Screenshots and a video of the 1440 walk go to AGENT_OPERATOR_SHOTS.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createApp } from '../dist/app.js';

const pool = new pg.Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool), ADMIN = process.env.TEST_ADMIN_EMAIL, ADMIN_ID = process.env.TEST_ADMIN_ID;
const AGENT = process.env.TEST_AGENT_ID, AGENT_NAME = process.env.TEST_AGENT_NAME, KEY = process.env.TEST_AGENT_KEY;
const shots = process.env.AGENT_OPERATOR_SHOTS || join(tmpdir(), 'agent-operator-shots');
let apiChecks = 0, browserChecks = 0;
const notes = [];

const call = async (path, who, method = 'GET', body, expected = 200) => {
  apiChecks++;
  const r = await app.inject({ url: '/api/v0/' + path, method, headers: { 'cf-access-authenticated-user-email': who }, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `${method} ${path}: ${r.body}`);
  return r.json();
};
const v1 = async (path, body, method = 'POST', expected = 200) => {
  apiChecks++;
  const r = await app.inject({ url: '/api/v1/' + path, method, headers: { authorization: `Bearer ${KEY}`, ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}) },
    ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `v1 ${method} ${path}: ${r.body}`);
  return r.json();
};
const mcp = async (method, params) => {
  apiChecks++;
  const r = await app.inject({ url: '/api/v1/mcp', method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method, params } });
  const raw = r.body, data = raw.trim().startsWith('{') ? raw : raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).at(-1);
  const j = JSON.parse(data); assert.ok(!j.error, `MCP ${method}: ${raw.slice(0, 400)}`); return j.result;
};
const screen = (path, body) => v1(`chats/screen/${path}`, { forPersonId: ADMIN_ID, ...body });
const status = async (id) => (await v1(`chats/screen/actions/${id}`, undefined, 'GET')).action;
const settle = async (id, want = /^(done|failed|refused|expired)$/, ms = 90000) => {
  for (let t = 0; t < ms; t += 400) { const s = await status(id); if (want.test(s.state)) return s; await delay(400); }
  return status(id);
};
// A tiny PNG (1x1), as a page picture for the API-only problem report.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let browser, web;
const restore = () => { try { execFileSync('git', ['checkout', '--', 'apps/web/tsconfig.json', 'apps/web/next-env.d.ts'], { cwd: '../..', stdio: 'ignore' }); } catch { /* not a checkout */ } };
try {
  // ---- API: the tools, confirm, bugs ------------------------------------------------------------------------------
  const listed = (await mcp('tools/list', {})).tools.map((t) => t.name);
  for (const t of ['screen_read', 'screen_click', 'screen_fill', 'screen_upload_file', 'screen_download_file']) assert.ok(listed.includes(t), `MCP lists ${t}`);
  const dm = (await call('chats/direct', ADMIN, 'POST', { personId: AGENT })).id;
  await call(`chats/${dm}/messages`, ADMIN, 'POST', { body: 'Synthetic: please work on the tasks page while I watch', attachments: [], clientId: randomUUID() });
  assert.equal((await call(`screen/agents/${AGENT}`, ADMIN, 'PUT', { level: 'admin' })).level, 'admin');
  // A click that sends asks the person, even at the admin level.
  const risky = (await screen('click', { target: 'b1', text: 'Send to client', why: 'to send the synthetic quotation' })).action;
  assert.equal(risky.state, 'asked'); assert.equal(risky.needed, 'confirm');
  const ask = (await call('screen/pending', ADMIN)).asks.find((a) => a.id === risky.id);
  assert.ok(ask && ask.mine && !ask.canAlways, 'only Allow once / No, for the person');
  await call(`screen/actions/${risky.id}/decide`, ADMIN, 'POST', { decision: 'always' }, 403);
  await call(`screen/actions/${risky.id}/decide`, ADMIN, 'POST', { decision: 'no' });
  assert.equal((await status(risky.id)).state, 'refused');
  assert.equal((await call(`screen/agents/${AGENT}`, ADMIN, 'PUT', { level: 'act' })).level, 'act');
  // A step that did not work, with its page: a bug by the AI employee; the same again is a note on it.
  const browserWalk = process.env.PULSE_AUTH_BROWSER === '1';
  if (!browserWalk) {
    const bugs = [];
    for (const n of [1, 2]) {
      const a = (await screen('click', { target: 'zz9', text: 'Add line' })).action;
      assert.equal((await call(`screen/actions/${a.id}/claim`, ADMIN, 'POST', {})).action.state, 'claimed');
      const r = await call(`screen/actions/${a.id}/done`, ADMIN, 'POST', { ok: false, error: `Nothing on their screen matches “zz${n}”. Read the screen again (screen_read) for the ids.`,
        problem: { route: '/erp/new?embed=1', screenshot: PNG } });
      assert.equal(r.action.state, 'failed'); assert.ok(r.bug?.number > 0, `bug filed (${JSON.stringify(r.bug)})`);
      bugs.push(r.bug);
    }
    assert.equal(bugs[0].again, false); assert.equal(bugs[1].again, true); assert.equal(bugs[1].number, bugs[0].number, 'one report per problem');
    const list = await call('bug-reports', ADMIN);
    const mine = (list.rows ?? []).find((b) => b.number === bugs[0].number);
    assert.ok(mine && mine.reporterId === AGENT && /could not click/.test(mine.words) && mine.route === '/erp/new' && mine.hasScreenshot, `the report (${JSON.stringify(mine)?.slice(0, 300)})`);
    // A person's own choice is not a bug: no problem sent, nothing filed.
    const said = (await screen('click', { target: 'b2', text: 'Open' })).action;
    await call(`screen/actions/${said.id}/claim`, ADMIN, 'POST', {});
    assert.equal((await call(`screen/actions/${said.id}/done`, ADMIN, 'POST', { ok: false, error: 'They pressed Stop: do no more screen steps until they ask again.' })).bug, null);
    notes.push(`bug #${bugs[0].number} filed by the AI employee, the second failure a note on it`);
  }

  if (browserWalk) {
    mkdirSync(shots, { recursive: true });
    const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const probe = createServer(); await new Promise((d) => probe.listen(0, '127.0.0.1', d)); const port = probe.address().port; await new Promise((d) => probe.close(d));
    const base = `http://127.0.0.1:${port}`;
    web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true, stdio: 'ignore',
      env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-agent-operator', PULSE_PUBLIC_LOGIN_ENABLED: '', PULSE_TELEMETRY: '0' } });
    for (let i = 0; i < 480; i++) { try { if ((await fetch(base + '/login')).status < 500) break; } catch { /* starting */ } await delay(250); if (i === 479) throw Error('web did not start'); }
    browser = await chromium.launch({ headless: true });
    const shot = async (page, name) => { await delay(500); await page.screenshot({ path: join(shots, name), fullPage: false }); };
    // A fresh line from the person keeps the AI employee "helping" them (30 minutes): once, for the whole walk.
    await call(`chats/${dm}/messages`, ADMIN, 'POST', { body: 'Synthetic: open Work and look at my tasks, please', attachments: [], clientId: randomUUID() });
    for (const [width, theme, walk] of [[1440, 'light', true], [363, 'dark', true], [1440, 'dark', false], [363, 'light', false]]) {
      const tag = `${width}-${theme}`, video = walk && width === 1440;
      const c = await browser.newContext({ viewport: { width, height: width < 600 ? 800 : 900 }, colorScheme: theme, extraHTTPHeaders: { 'cf-access-authenticated-user-email': ADMIN },
        ...(video ? { recordVideo: { dir: join(shots, 'video-raw'), size: { width: 1440, height: 900 } } } : {}) });
      await c.addInitScript((t) => { localStorage.setItem('pulse.theme', t); localStorage.setItem('pulse.sidebar.collapsed', 'false');
        // next dev's own issue badge is a development tool (production has none): kept out of the screenshots.
        document.addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = 'nextjs-portal{display:none!important}'; document.head.appendChild(st); }); }, theme);
      const page = await c.newPage(), errors = [], heard = [], said = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') said.push(`${m.location()?.url ?? ''} :: ${m.text().replace(/\s+/g, ' ').slice(0, 2500)}`); });
      page.on('response', (r) => { if (r.url().includes('/api/v0/screen/')) heard.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`); });
      try {
        await page.goto(`${base}/operator?channel=${dm}&path=/tasks`, { timeout: 300000 });
        const view = page.locator('[data-operator-view]'), strip = page.locator('[data-operator-strip]');
        await expect(strip).toContainText(/is ready|is thinking/, { timeout: 120000 });
        await expect(page.getByRole('complementary', { name: `Chat with ${AGENT_NAME}` })).toContainText('open Work', { timeout: 60000 });
        const frame = page.frameLocator('iframe[title^="The page"]');
        const phone = width < 900;
        if (phone) {
          // A phone shows one tab: the chat first (with what to ask), then the page.
          await expect(page.getByRole('complementary', { name: `Chat with ${AGENT_NAME}` })).toBeVisible();
          await expect(frame.locator('main')).toBeAttached({ timeout: 240000 });
          await shot(page, `01-operator-chat-${tag}.png`);
          await page.getByRole('radio', { name: 'Page', exact: true }).click();
        }
        await expect(frame.locator('main')).toBeVisible({ timeout: 240000 });
        await shot(page, `01-operator-${tag}.png`); browserChecks += 3;
        const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(wide <= 1, `no sideways scroll at ${tag} (${wide}px)`); browserChecks++;
        if (walk) {
          // It opens a page in the frame (the chat stays), reads it, and its step shows in the strip.
          const open = (await screen('page', { path: '/tasks?scope=me' })).action;
          assert.equal((await settle(open.id)).state, 'done', `page.open: ${JSON.stringify(await status(open.id))}`);
          await expect(strip).toContainText('Opened', { timeout: 20000 });
          assert.match(page.url(), /\/operator\?/, 'the person stays on the operator view');
          const read = (await screen('read', {})).action;
          const map = JSON.parse((await settle(read.id)).result ?? '{}');
          assert.match(String(map.path ?? ''), /^\/tasks/, `it read the framed page (${String(map.path)})`); browserChecks += 3;
          // A click that sends: "Only you can say yes" over the page; the person says No.
          const sendAsk = (await screen('click', { target: 'b1', text: 'Send to client', why: 'to send the synthetic quotation' })).action;
          const card = page.locator(`[data-screen-ask="${sendAsk.id}"]`);
          await expect(card).toContainText('Only you can say yes', { timeout: 30000 });
          await expect(card.getByRole('button', { name: 'Always' })).toHaveCount(0);
          await shot(page, `02-asks-first-${tag}.png`);
          await card.getByRole('button', { name: 'No' }).click();
          await expect(card).toHaveCount(0); browserChecks += 3;
          // A step that does not work: crossed in the strip with the bug it filed.
          const miss = (await screen('click', { target: 'zz-none', text: 'Add line' })).action;
          assert.equal((await settle(miss.id)).state, 'failed');
          const failed = strip.locator('[data-state="failed"]').last();
          await expect(failed).toContainText('Could not', { timeout: 30000 });
          await expect(failed.locator('a[title]')).toHaveAttribute('title', /problem #\d+/i, { timeout: 30000 });
          await expect(strip).toContainText('hit a problem', { timeout: 30000 });
          await shot(page, `03-step-failed-bug-${tag}.png`); browserChecks += 2;
          // Stop answers at once; Go on lets it work again.
          await page.getByRole('button', { name: 'Stop' }).click();
          await expect(strip).toContainText('is paused');
          const stopped = (await screen('sidebar', { open: true })).action;
          const s = await settle(stopped.id);
          assert.equal(s.state, 'failed'); assert.match(String(s.error), /pressed Stop/);
          await shot(page, `04-stopped-${tag}.png`);
          await page.getByRole('button', { name: 'Keep going' }).click();
          await expect(strip).not.toContainText('is paused'); browserChecks += 4;
          await expect(page.locator(`aside[aria-label="Chat with ${AGENT_NAME}"]`)).not.toContainText('is paused. Press Keep going');
        }
        assert.deepEqual(errors, [], `no page errors at ${tag}`);
        writeFileSync(join(shots, `console-${tag}.txt`), said.join('\n'));
      } catch (e) {
        await shot(page, `fail-${tag}.png`).catch(() => {});
        writeFileSync(join(shots, `diag-${tag}.txt`), [`failed: ${String(e?.message ?? e).slice(0, 800)}`, `url: ${page.url()}`, '--- screen calls', ...heard.slice(-40), '--- page errors', ...errors.slice(-10), '--- console errors', ...said.slice(-20)].join('\n'));
        throw e;
      }
      await c.close();
      if (video) {
        const raw = join(shots, 'video-raw'), got = readdirSync(raw).filter((f) => f.endsWith('.webm'));
        if (got.length) { renameSync(join(raw, got[0]), join(shots, `operator-walk-${tag}.webm`)); notes.push(`video operator-walk-${tag}.webm`); }
      }
    }
  }
} finally {
  await browser?.close().catch(() => {});
  if (web?.pid) { try { process.kill(-web.pid, 'SIGTERM'); } catch { /* gone */ } }
  restore();
  await app.close().catch(() => {}); await pool.end().catch(() => {});
}
writeFileSync(process.env.AGENT_OPERATOR_REPORT, JSON.stringify({ apiChecks, browserChecks, notes, shots }));
