// DOCS-EDITOR-8: "show me how" end to end on a disposable synthetic company (tests/core/test_show_me_how_browser.py). The
// AI employee's calls go through API v1 with its own key, as its runtime sends them. Always: MCP lists screen_show_me_how,
// it is a view action (sent at once at the view level), its result names the walkthrough, and one with no walkthrough
// shows nothing. With PULSE_AUTH_BROWSER=1 a real browser (1440 and 363, light and dark): in Chats with the AI, "how do I
// add a task?" opens the operator view on Work with the guide bar (Step 1 of 5) and the step's button lit in the page;
// Next lights the next one; pressing the lit button moves on by itself; Do it for me is a message in the chat; Stop
// showing ends it; the last step's Done celebrates; on the person's whole screen it waits for their own "Show me".
// Screenshots go to SHOW_ME_HOW_SHOTS. Synthetic company; nothing is sent anywhere.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createApp } from '../dist/app.js';

const pool = new pg.Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool), ADMIN = process.env.TEST_ADMIN_EMAIL, ADMIN_ID = process.env.TEST_ADMIN_ID;
const AGENT = process.env.TEST_AGENT_ID, AGENT_NAME = process.env.TEST_AGENT_NAME, KEY = process.env.TEST_AGENT_KEY;
const shots = process.env.SHOW_ME_HOW_SHOTS || join(tmpdir(), 'show-me-how-shots');
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
const guide = (question, tutorial) => v1('chats/screen/guide', { forPersonId: ADMIN_ID, question, ...(tutorial ? { tutorial } : {}), why: 'you asked how' });
const status = async (id) => (await v1(`chats/screen/actions/${id}`, undefined, 'GET')).action;
const settle = async (id, want = /^(done|failed|refused|expired)$/, ms = 240000) => {
  for (let t = 0; t < ms; t += 400) { const s = await status(id); if (want.test(s.state)) return s; await delay(400); }
  return status(id);
};

let browser, web;
const restore = () => { try { execFileSync('git', ['checkout', '--', 'apps/web/tsconfig.json', 'apps/web/next-env.d.ts'], { cwd: '../..', stdio: 'ignore' }); } catch { /* not a checkout */ } };
try {
  // ---- API: the tool, its level, its result -------------------------------------------------------------------------
  const listed = (await mcp('tools/list', {})).tools;
  const tool = listed.find((t) => t.name === 'screen_show_me_how');
  assert.ok(tool, 'MCP lists screen_show_me_how');
  assert.match(tool.description, /how do I/i); assert.deepEqual(tool.inputSchema.required?.includes('question'), true);
  const dm = (await call('chats/direct', ADMIN, 'POST', { personId: AGENT })).id;
  // Nobody asked it anything yet: it shows nobody anything.
  await v1('chats/screen/guide', { forPersonId: ADMIN_ID, question: 'How do I add a task?' }, 'POST', 403);
  await call(`chats/${dm}/messages`, ADMIN, 'POST', { body: 'Synthetic: how do I add a task?', attachments: [], clientId: randomUUID() });
  assert.equal((await call(`screen/agents/${AGENT}`, ADMIN, 'PUT', { level: 'view' })).level, 'view');
  const first = (await guide('How do I add a task?')).action;
  assert.equal(first.state, 'sent', 'showing how is a view action: sent at once at the view level'); assert.equal(first.needed, 'view');
  const ctl = (await mcp('tools/call', { name: 'screen_controls', arguments: {} })), ctlData = ctl.structuredContent ?? JSON.parse(ctl.content[0].text);
  assert.equal(ctlData.actions.find((a) => a.name === 'guide.play')?.now, true, 'screen_controls lists guide.play as allowed now');
  const browserWalk = process.env.PULSE_AUTH_BROWSER === '1';
  {
    // The browser's answers, as the person's screen sends them: the walkthrough it played, and "none fits".
    assert.equal((await call(`screen/actions/${first.id}/claim`, ADMIN, 'POST', {})).action.state, 'claimed');
    const r = await call(`screen/actions/${first.id}/done`, ADMIN, 'POST', { ok: true, result: { shown: true, tutorial: 'tasks-basics', title: 'Give and finish tasks', steps: ['1. Open Work'] } });
    assert.equal(r.action.state, 'done');
    assert.match(String((await status(first.id)).result), /tasks-basics/);
    const none = (await guide('how do I bake a cake')).action;
    await call(`screen/actions/${none.id}/claim`, ADMIN, 'POST', {});
    assert.equal((await call(`screen/actions/${none.id}/done`, ADMIN, 'POST', { ok: true, result: { shown: false, why: 'No walkthrough answers it yet' } })).bug ?? null, null, 'none fits: no bug');
    assert.match(String((await status(none.id)).result), /"shown":false/);
    // A person's no to their whole screen is their choice, not a bug.
    const no = (await guide('How do I add a task?')).action;
    await call(`screen/actions/${no.id}/claim`, ADMIN, 'POST', {});
    assert.equal((await call(`screen/actions/${no.id}/done`, ADMIN, 'POST', { ok: false, error: 'They chose not to be shown on their screen now: tell them the steps in words' })).bug, null);
    notes.push('API: listed, view level, result names the walkthrough, none-fits and a no are not bugs');
  }
  if (browserWalk) {
    mkdirSync(shots, { recursive: true });
    const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const probe = createServer(); await new Promise((d) => probe.listen(0, '127.0.0.1', d)); const port = probe.address().port; await new Promise((d) => probe.close(d));
    const base = `http://127.0.0.1:${port}`;
    web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true, stdio: 'ignore',
      env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-show-me-how', PULSE_PUBLIC_LOGIN_ENABLED: '', PULSE_TELEMETRY: '0' } });
    for (let i = 0; i < 480; i++) { try { if ((await fetch(base + '/login')).status < 500) break; } catch { /* starting */ } await delay(250); if (i === 479) throw Error('web did not start'); }
    // A development build compiles each page on its first visit (a minute or more): visit the walk's pages once first.
    for (const p of ['/chats', '/operator', '/tasks', '/tasks?embed=1', '/finance?tab=reconcile&embed=1', '/me?embed=1']) {
      await fetch(base + p, { headers: { 'cf-access-authenticated-user-email': ADMIN }, signal: AbortSignal.timeout(300000) }).catch(() => {});
    }
    browser = await chromium.launch({ headless: true });
    const shot = async (page, name) => { await delay(600); await page.screenshot({ path: join(shots, name), fullPage: false }); };
    for (const [width, theme, walk] of [[1440, 'light', true], [363, 'dark', true], [1440, 'dark', false], [363, 'light', false]]) {
      const tag = `${width}-${theme}`, phone = width < 900;
      // A fresh line from the person keeps the AI employee "helping" them (30 minutes).
      await call(`chats/${dm}/messages`, ADMIN, 'POST', { body: 'Synthetic: show me how, please', attachments: [], clientId: randomUUID() });
      const c = await browser.newContext({ viewport: { width, height: phone ? 800 : 900 }, colorScheme: theme, extraHTTPHeaders: { 'cf-access-authenticated-user-email': ADMIN } });
      await c.addInitScript((t) => { localStorage.setItem('pulse.theme', t); localStorage.setItem('pulse.sidebar.collapsed', 'false');
        document.addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = 'nextjs-portal{display:none!important}'; document.head.appendChild(st); }); }, theme);
      const page = await c.newPage(), errors = [], heard = [], said = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') said.push(`${m.location()?.url ?? ''} :: ${m.text().replace(/\s+/g, ' ').slice(0, 2500)}`); });
      page.on('response', (r) => { if (r.url().includes('/api/v0/screen/')) heard.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`); });
      const bar = page.locator('[data-guide][data-where="operator"]'), frame = page.frameLocator('iframe[title^="The page"]');
      const lit = frame.locator('[data-guide-target]');
      try {
        if (walk) {
          // In Chats with the AI: "how do I add a task?" opens the operator view on Work, the guide bar in the strip's place.
          await page.goto(`${base}/chats?channel=${dm}`, { timeout: 300000 });
          await expect(page.locator(`a[data-chat-operator="${dm}"]`)).toBeAttached({ timeout: 300000 }); await delay(3000);
          const g = (await guide('How do I add a task?')).action;
          await page.waitForURL(/\/operator\?channel=/, { timeout: 300000 });
          await expect(bar).toContainText('Step 1 of 5', { timeout: 300000 });
          await expect(bar).toContainText('Give and finish tasks');
          const s = await settle(g.id);
          assert.equal(s.state, 'done', `guide.play: ${JSON.stringify(s)}`);
          const res = JSON.parse(s.result ?? '{}');
          assert.equal(res.shown, true); assert.equal(res.tutorial, 'tasks-basics'); assert.match(String(res.on), /beside your chat/); assert.equal(res.steps.length, 5);
          await expect(lit).toHaveCount(1, { timeout: 90000 });
          await shot(page, `01-guide-step1-${tag}.png`); browserChecks += 6;
          // Next lights the next step's button.
          await bar.getByRole('button', { name: 'Next' }).click();
          await expect(bar).toContainText('Step 2 of 5');
          await expect(lit).toContainText('New task', { timeout: 60000 });
          await shot(page, `02-guide-step2-lit-${tag}.png`); browserChecks += 2;
          // The person presses the lit button: the guide moves on by itself (the form opens; Create task is next).
          await lit.click();
          await expect(bar).toContainText('Step 3 of 5', { timeout: 15000 });
          await delay(1500);
          await shot(page, `03-guide-moves-on-${tag}.png`); browserChecks += 1;
          notes.push(`${tag}: step 3 lit ${await lit.count()} element(s) (${(await lit.first().textContent().catch(() => '') ?? '').trim().slice(0, 40)})`);
          await frame.locator('body').press('Escape').catch(() => {});
          // Back goes back one step.
          await bar.getByRole('button', { name: 'Back' }).click();
          await expect(bar).toContainText('Step 2 of 5'); browserChecks++;
          // Do it for me: a message to the AI in the chat; the guide ends.
          await bar.getByRole('button', { name: 'Do it for me' }).click();
          await expect(bar).toHaveCount(0, { timeout: 15000 });
          const msgs = (await call(`chats/${dm}/messages?flat=1`, ADMIN)).messages;
          assert.ok(msgs.some((m) => /^Do it for me: “Give and finish tasks”/.test(m.body ?? '')), 'Do it for me is a message to the AI');
          if (!phone) await expect(page.getByRole('complementary', { name: `Chat with ${AGENT_NAME}` })).toContainText('Do it for me', { timeout: 20000 });
          await shot(page, `04-do-it-for-me-${tag}.png`); browserChecks += 3;
          // "How do I add a bank statement": Finance → Reconcile.
          const bank = (await guide('how do I add a bank statement?')).action;
          await expect(bar).toContainText('Add a bank statement', { timeout: 240000 });
          assert.equal((await settle(bank.id)).state, 'done');
          await delay(2500);
          await shot(page, `05-bank-step1-${tag}.png`); browserChecks += 2;
          await bar.getByRole('button', { name: 'Next' }).click();
          await expect(bar).toContainText('Step 2 of 5');
          await delay(6500);
          notes.push(`${tag}: bank step 2 ${await lit.count() ? `lit (${(await lit.first().textContent())?.trim().slice(0, 40)})` : 'not on the page (the note shows)'}`);
          await shot(page, `06-bank-step2-${tag}.png`);
          // Stop showing ends it; the strip is back.
          await bar.getByRole('button', { name: 'Stop showing' }).click();
          await expect(bar).toHaveCount(0); await expect(lit).toHaveCount(0); browserChecks += 2;
          // The last step's Done: a small celebration and "Nice work!".
          const again = (await guide('apply for leave', 'apply-for-leave')).action;
          await expect(bar).toContainText('Apply for leave', { timeout: 240000 });
          assert.equal((await settle(again.id)).state, 'done');
          for (let i = 0; i < 4; i++) await bar.getByRole('button', { name: 'Next' }).click();
          await bar.getByRole('button', { name: 'Done' }).click();
          await expect(bar).toContainText('Nice work!');
          await shot(page, `07-done-${tag}.png`);
          await bar.getByRole('button', { name: 'Close' }).click();
          await expect(bar).toHaveCount(0); browserChecks += 3;
          // No walkthrough for the question: nothing shown, no bug, the AI explains in words.
          const none = (await guide('how do I bake a cake')).action;
          const n = await settle(none.id);
          assert.equal(n.state, 'done'); assert.match(String(n.result), /"shown":false/); await expect(bar).toHaveCount(0); browserChecks += 2;
        } else {
          await page.goto(`${base}/operator?channel=${dm}&path=/tasks`, { timeout: 300000 });
          await expect(page.locator('[data-operator-strip]')).toContainText(/is ready|is thinking/, { timeout: 120000 });
          if (phone) await page.getByRole('radio', { name: 'Page', exact: true }).click();
          await expect(frame.locator('main')).toBeVisible({ timeout: 240000 });
          const g = (await guide('How do I add a task?')).action;
          await expect(bar).toContainText('Step 1 of 5', { timeout: 240000 });
          assert.equal((await settle(g.id)).state, 'done');
          await expect(lit).toHaveCount(1, { timeout: 90000 });
          await shot(page, `01-guide-step1-${tag}.png`);
          await bar.getByRole('button', { name: 'Next' }).click();
          await expect(lit).toContainText('New task', { timeout: 60000 });
          await shot(page, `02-guide-step2-lit-${tag}.png`); browserChecks += 3;
          await bar.getByRole('button', { name: 'Stop showing' }).click(); await expect(bar).toHaveCount(0);
        }
        const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(wide <= 1, `no sideways scroll at ${tag} (${wide}px)`); browserChecks++;
        // On the whole screen (no chat with it on screen): only after their own "Show me".
        await page.goto(`${base}/tasks`, { timeout: 300000 });
        await expect(page.locator('main')).toBeVisible({ timeout: 240000 }); await delay(2500);
        const whole = (await guide('How do I add a task?')).action;
        const tap = page.locator('[data-screen-tap]');
        await expect(tap).toContainText('can show you how to give and finish tasks, here on your screen', { timeout: 180000 });
        await shot(page, `08-whole-screen-asks-${tag}.png`);
        await tap.getByRole('button', { name: 'Show me' }).click();
        const card = page.locator('[data-guide][data-where="page"]');
        await expect(card).toContainText('Step 1 of 5', { timeout: 30000 });
        const w = await settle(whole.id);
        assert.equal(w.state, 'done'); assert.match(String(w.result), /whole screen/);
        await expect(page.locator('[data-guide-target]')).toHaveCount(1, { timeout: 30000 });
        await shot(page, `09-whole-screen-guide-${tag}.png`); browserChecks += 4;
        await card.getByRole('button', { name: 'Stop showing' }).click(); await expect(card).toHaveCount(0);
        assert.equal(await page.locator('[data-guide-target]').count(), 0, 'the ring goes with the guide'); browserChecks++;
        assert.deepEqual(errors, [], `no page errors at ${tag}`);
        writeFileSync(join(shots, `console-${tag}.txt`), said.join('\n'));
      } catch (e) {
        await shot(page, `fail-${tag}.png`).catch(() => {});
        writeFileSync(join(shots, `diag-${tag}.txt`), [`failed: ${String(e?.message ?? e).slice(0, 800)}`, `url: ${page.url()}`, '--- screen calls', ...heard.slice(-40), '--- page errors', ...errors.slice(-10), '--- console errors', ...said.slice(-20)].join('\n'));
        throw e;
      }
      await c.close();
    }
  }
} finally {
  await browser?.close().catch(() => {});
  if (web?.pid) { try { process.kill(-web.pid, 'SIGTERM'); } catch { /* gone */ } }
  restore();
  await app.close().catch(() => {}); await pool.end().catch(() => {});
}
writeFileSync(process.env.SHOW_ME_HOW_REPORT, JSON.stringify({ apiChecks, browserChecks, notes, shots }));
