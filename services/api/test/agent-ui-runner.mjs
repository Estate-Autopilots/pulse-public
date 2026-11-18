// AGENT-UI-CONTROL: an AI employee drives the screen of the person it helps, end to end on a disposable synthetic company
// (tests/core/test_agent_ui_browser.py). The AI employee's calls go through API v1 and MCP with its own key, as its runtime
// sends them; with PULSE_AUTH_BROWSER=1 a real browser (1440 light, 390 dark) shows each one: the quotation PDF opened
// beside the chat, the sidebar folded and back, the prompt in the top tray (Allow once / Always), an emoji and a draft in
// the message box, the "Add client" card filled in as the person, a page and a side view, a file asked for and attached,
// and its screen control on the profile. Screenshots go to AGENT_UI_SHOTS. Nothing leaves this machine.
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
const app = createApp(pool, pool), ADMIN = process.env.TEST_ADMIN_EMAIL, MEMBER = process.env.TEST_MEMBER;
const AGENT = process.env.TEST_AGENT_ID, AGENT_NAME = process.env.TEST_AGENT_NAME, KEY = process.env.TEST_AGENT_KEY;
const ADMIN_ID = process.env.TEST_ADMIN_ID, MEMBER_ID = process.env.TEST_MEMBER_ID;
const shots = process.env.AGENT_UI_SHOTS || join(tmpdir(), 'agent-ui-shots');
let apiChecks = 0, browserChecks = 0;
const notes = [];

const call = async (path, who, method = 'GET', body, expected = 200) => {
  apiChecks++;
  const r = await app.inject({ url: '/api/v0/' + path, method, headers: { 'cf-access-authenticated-user-email': who }, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `${method} ${path}: ${r.body}`);
  return r.json();
};
/** The AI employee's own API v1 call, as its runtime makes it. */
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
/** A one-page synthetic quotation PDF (Helvetica, ASCII only). */
function syntheticPdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = `BT /F1 22 Tf 60 770 Td (${esc(lines[0])}) Tj /F1 12 Tf ${lines.slice(1).map((l) => `0 -26 Td (${esc(l)}) Tj`).join(' ')} ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

let browser, web;
const restore = () => { try { execFileSync('git', ['checkout', '--', 'apps/web/tsconfig.json', 'apps/web/next-env.d.ts'], { cwd: '../..', stdio: 'ignore' }); } catch { /* not a checkout */ } };
try {
  // ---- API: the tools, the rules, the audit ---------------------------------------------------------------------
  const listed = (await mcp('tools/list', {})).tools.map((t) => t.name);
  for (const t of ['screen_open_page', 'screen_open_side_panel', 'screen_close_side_panel', 'screen_sidebar', 'screen_open_tab', 'screen_point_at', 'screen_type_in_message_box',
    'screen_insert_emoji', 'screen_open_form', 'screen_ask_for_file', 'screen_microphone', 'screen_show_card', 'screen_action_status', 'screen_controls']) assert.ok(listed.includes(t), `MCP lists ${t}`);
  assert.ok(!listed.includes('create_task') && !listed.includes('create_project'), 'a standard AI employee proposes tasks and projects (cards), it is not offered create_task');
  const controls = await mcp('tools/call', { name: 'screen_controls', arguments: {} });
  const ctl = controls.structuredContent ?? JSON.parse(controls.content[0].text);
  assert.equal(ctl.level, 'view'); assert.equal(ctl.actions.find((a) => a.name === 'panel.open').now, true); assert.equal(ctl.actions.find((a) => a.name === 'emoji.insert').now, false);
  // Nobody wrote to it yet: it may drive nobody's screen.
  await v1('chats/screen/sidebar', { forPersonId: ADMIN_ID, open: false }, 'POST', 403);
  const dm = (await call('chats/direct', ADMIN, 'POST', { personId: AGENT })).id;
  assert.ok(dm, 'a direct chat with the AI employee');
  await call(`chats/${dm}/messages`, ADMIN, 'POST', { body: 'Synthetic: open the quotation for Riverside beside me, please', attachments: [], clientId: randomUUID() });
  const pdf = await call(`chats/${dm}/files`, ADMIN, 'POST', { name: 'Quotation Q-001 (synthetic).pdf', mime: 'application/pdf',
    bytes: syntheticPdf(['Quotation Q-001 (synthetic)', 'Riverside Synthetic Realty', '40 signboards, printed and fixed', 'Total: Rs 1,20,000 plus GST', 'Valid until 30 November 2026']).toString('base64') });
  // A colleague who did not write to it: refused, and the member gets no prompt to answer an admin-level screen.
  await v1('chats/screen/page', { forPersonId: MEMBER_ID, path: '/tasks' }, 'POST', 403);
  const status = async (id) => (await v1(`chats/screen/actions/${id}`, undefined, 'GET')).action;

  const browserWalk = process.env.PULSE_AUTH_BROWSER === '1';
  if (!browserWalk) {
    // Without a browser, the person's side through its own API: what to do and what to answer, a prompt answered, the
    // action taken and reported, a card filled in.
    await call(`chats/${dm}/messages`, ADMIN, 'POST', { body: 'Synthetic: show me the quotation', attachments: [], clientId: randomUUID() });
    const sent = (await screen('side-panel', { target: `file:${pdf.id}`, title: 'Quotation Q-001 (synthetic)' })).action;
    const asked = (await screen('emoji', { emoji: '🎉', why: 'to celebrate' })).action;
    assert.equal(sent.state, 'sent'); assert.equal(asked.state, 'asked');
    const p = await call('screen/pending', ADMIN);
    assert.ok(p.actions.some((a) => a.id === sent.id) && p.asks.some((a) => a.id === asked.id && a.canAlways), 'the admin\'s screen hears both');
    await call(`screen/actions/${asked.id}/decide`, MEMBER, 'POST', { decision: 'once' }, 403);
    await call(`screen/actions/${asked.id}/decide`, ADMIN, 'POST', { decision: 'once' });
    for (const id of [sent.id, asked.id]) {
      assert.equal((await call(`screen/actions/${id}/claim`, ADMIN, 'POST', {})).action.state, 'claimed');
      assert.equal((await call(`screen/actions/${id}/claim`, ADMIN, 'POST', {})).action, null, 'a second tab gets nothing');
      await call(`screen/actions/${id}/done`, ADMIN, 'POST', { ok: true, result: { opened: 'synthetic' } });
    }
    assert.equal((await status(sent.id)).state, 'done'); assert.match((await status(asked.id)).result, /synthetic/);
    const card = (await v1('chats/screen/cards', { forPersonId: ADMIN_ID, kind: 'client.add', title: 'Add the client', name: 'Riverside Synthetic Realty API',
      message: 'I could not find Riverside Synthetic Realty in Clients. Add them here and I will carry on.' })).card;
    assert.equal((await call(`screen/cards/${card.id}/submit`, ADMIN, 'POST', { values: { name: 'Riverside Synthetic Realty API' } })).state, 'done');
    await call(`screen/cards/${card.id}/submit`, ADMIN, 'POST', { values: { name: 'Again' } }, 409);
  }
  if (browserWalk) {
    mkdirSync(shots, { recursive: true });
    const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const probe = createServer(); await new Promise((d) => probe.listen(0, '127.0.0.1', d)); const port = probe.address().port; await new Promise((d) => probe.close(d));
    const base = `http://127.0.0.1:${port}`;
    web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true, stdio: 'ignore',
      env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-agent-ui', PULSE_PUBLIC_LOGIN_ENABLED: '', PULSE_TELEMETRY: '0' } });
    for (let i = 0; i < 480; i++) { try { if ((await fetch(base + '/login')).status < 500) break; } catch { /* starting */ } await delay(250); if (i === 479) throw Error('web did not start'); }
    browser = await chromium.launch({ headless: true });
    const ctx = async (who, width, theme) => {
      const c = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: theme, extraHTTPHeaders: { 'cf-access-authenticated-user-email': who } });
      await c.addInitScript((t) => { localStorage.setItem('pulse.theme', t); localStorage.setItem('pulse.sidebar.collapsed', 'false'); }, theme);
      return c;
    };
    // Cards and lines fade in for 220 ms: a screenshot waits for them to settle.
    const shot = async (page, name) => { await delay(450); await page.screenshot({ path: join(shots, name), fullPage: false }); };
    let n = 0;
    for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
      const phone = width < 600, tag = `${width}-${theme}`;
      const c = await ctx(ADMIN, width, theme), page = await c.newPage(), errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      // What to look at when a step fails: the screen calls the browser made, its console, the AI employee's last actions.
      const heard = [], said = [];
      page.on('response', (r) => { if (r.url().includes('/api/v0/screen/') || r.url().includes('/api/v0/chats/files/')) heard.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`); });
      page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) said.push(`${m.type()}: ${m.text()}`.slice(0, 400)); });
      try {
      await page.goto(`${base}/chats?channel=${dm}`, { timeout: 240000 });
      const box = page.getByRole('textbox', { name: /^Message / });
      await expect(box).toBeVisible({ timeout: 180000 });
      await call(`chats/${dm}/messages`, ADMIN, 'POST', { body: `Synthetic (${tag}): show me the quotation`, attachments: [], clientId: randomUUID() });
      await delay(1500); // the screen stream is open

      // 1. "Open the quotation in the side browser": the PDF opens beside the chat (PDF.js) within its View level, at once.
      const opened = (await screen('side-panel', { target: `file:${pdf.id}`, title: 'Quotation Q-001 (synthetic)', why: 'to show you the draft' })).action;
      assert.equal(opened.state, 'sent');
      const viewer = page.getByRole('dialog', { name: /^Viewing Quotation Q-001 \(synthetic\)/ });
      await expect(viewer).toBeVisible({ timeout: 30000 });
      await expect(page.locator('[data-screen-activity]')).toContainText(`Opened “Quotation Q-001 (synthetic)” beside the chat`);
      await expect(viewer.locator('canvas, img, iframe').first()).toBeVisible({ timeout: 30000 });
      await delay(1800); await shot(page, `01-quotation-beside-chat-${tag}.png`); browserChecks += 3;
      for (let i = 0; i < 20 && (await status(opened.id)).state !== 'done'; i++) await delay(250);
      assert.equal((await status(opened.id)).state, 'done'); browserChecks++;
      await page.keyboard.press('Escape');

      // 2. The sidebar folded away and back (a computer; a phone has none and says so).
      const side = (await screen('sidebar', { open: false })).action;
      if (!phone) {
        await expect(page.locator('[data-sidebar-collapsed="true"]')).toBeVisible({ timeout: 20000 });
        await shot(page, `02-sidebar-closed-${tag}.png`);
        await screen('sidebar', { open: true });
        await expect(page.locator('[data-sidebar-collapsed="false"]')).toBeVisible({ timeout: 20000 }); browserChecks += 2;
      } else {
        for (let i = 0; i < 40 && (await status(side.id)).state !== 'done'; i++) await delay(250);
        assert.match((await status(side.id)).result ?? '', /no sidebar/); browserChecks++;
      }

      // 3. Above its level it asks: the prompt at the top, one click allows. An emoji goes into the message box (never sent).
      const emoji = (await screen('emoji', { emoji: '🎉', why: 'to celebrate the signed quote' })).action;
      assert.equal(emoji.state, 'asked'); assert.match(emoji.message, /asked in the top bar/);
      const ask = page.locator(`[data-screen-ask="${emoji.id}"]`);
      await expect(ask).toContainText(`${AGENT_NAME} wants to add 🎉 to your message`, { timeout: 20000 });
      await expect(ask.getByRole('button', { name: 'Allow once' })).toBeVisible(); await expect(ask.getByRole('button', { name: 'Always' })).toBeVisible();
      await shot(page, `03-prompt-allow-once-always-${tag}.png`);
      await ask.getByRole('button', { name: 'Allow once' }).click();
      await expect(box).toHaveValue(/🎉/, { timeout: 20000 }); browserChecks += 4;

      // 4. Typing a draft: "Always" keeps it allowed; the next one needs no prompt.
      if (!phone) {
        const draft = (await screen('message-box', { text: 'Synthetic draft: the revised quotation is attached.' })).action;
        const ask2 = page.locator(`[data-screen-ask="${draft.id}"]`);
        await expect(ask2).toBeVisible({ timeout: 20000 });
        await ask2.getByRole('button', { name: 'Always' }).click();
        await expect(box).toHaveValue(/revised quotation is attached/, { timeout: 20000 });
        await expect(page.locator('[data-screen-activity]')).toBeVisible();
        const again = (await screen('message-box', { text: ' Synthetic: anything else?' })).action;
        assert.equal(again.state, 'sent');
        await expect(box).toHaveValue(/anything else\?/, { timeout: 20000 }); browserChecks += 4;
        await shot(page, `04-draft-typed-${tag}.png`);
      }
      await box.fill('');

      // 5. A client it cannot find: the "Add client" card in the chat, filled in as the person (they are an admin here).
      const card = (await v1('chats/screen/cards', { forPersonId: ADMIN_ID, kind: 'client.add', title: 'Add the client', name: `Riverside Synthetic Realty ${tag}`, phone: '+91 90000 0000' + (n++),
        message: `I could not find “Riverside Synthetic Realty” in Clients. Add them here and I will finish the quotation.` })).card;
      const cardBox = page.locator(`[data-agent-card="${card.id}"]`);
      await expect(cardBox).toBeVisible({ timeout: 30000 });
      await expect(cardBox.getByLabel(/Client name/)).toHaveValue(`Riverside Synthetic Realty ${tag}`);
      await cardBox.getByLabel(/City/).fill('Synthetic City');
      await cardBox.scrollIntoViewIfNeeded(); await shot(page, `05-card-add-client-${tag}.png`);
      await cardBox.getByRole('button', { name: 'Add client' }).click();
      await expect(cardBox).toContainText(`Added the client “Riverside Synthetic Realty ${tag}”`, { timeout: 20000 });
      await expect(page.getByRole('log', { name: 'Messages' })).toContainText(`Added the client “Riverside Synthetic Realty ${tag}”.`, { timeout: 20000 });
      await shot(page, `06-card-done-${tag}.png`); browserChecks += 4;

      // 6. A file it needs: asked (Act), allowed once, then one tap to choose; it is attached in the chat.
      const want = (await screen('file', { purpose: 'the signed quotation', accept: '.pdf' })).action;
      await page.locator(`[data-screen-ask="${want.id}"]`).getByRole('button', { name: 'Allow once' }).click({ timeout: 20000 });
      const tapCard = page.locator(`[data-screen-tap="${want.id}"]`);
      await expect(tapCard).toContainText('asks you for a file: the signed quotation', { timeout: 20000 });
      await shot(page, `07-asks-for-a-file-${tag}.png`);
      await tapCard.locator('input[type=file]').setInputFiles({ name: `Signed Q-001 ${tag} (synthetic).pdf`, mimeType: 'application/pdf', buffer: syntheticPdf(['Signed (synthetic)', 'Q-001']) });
      for (let i = 0; i < 60 && (await status(want.id)).state !== 'done'; i++) await delay(250);
      const got = await status(want.id); assert.equal(got.state, 'done', JSON.stringify(got)); assert.match(got.result, /Signed Q-001/);
      await expect(page.getByRole('log', { name: 'Messages' })).toContainText('Here you are: the signed quotation', { timeout: 20000 }); browserChecks += 3;

      // 7. Point at a control, then a page, then a page beside it (the side view, away from Chats), closed again.
      if (!phone) {
        const p = (await screen('point', { text: 'Attach a file' })).action;
        for (let i = 0; i < 40 && (await status(p.id)).state !== 'done'; i++) await delay(250);
        assert.equal((await status(p.id)).state, 'done'); await shot(page, `08-point-at-${tag}.png`); browserChecks++;
      }
      // AI-AGENTS-3 (owner: "Watch it work should not need a click"): from the chat with it, a page it opens comes up
      // beside the chat by itself (the operator view), and the step is done there; the person pressed nothing.
      const moved = (await screen('page', { path: '/tasks' })).action;
      await page.waitForURL(/\/operator\?channel=/, { timeout: 120000 });
      const besideFrame = page.frameLocator('iframe[title^="The page"]');
      await expect(besideFrame.locator('main').first()).toBeAttached({ timeout: 240000 });
      for (let i = 0; i < 120 && (await status(moved.id)).state !== 'done'; i++) await delay(250);
      assert.equal((await status(moved.id)).state, 'done', `page.open beside the chat: ${JSON.stringify(await status(moved.id))}`);
      assert.match(await page.locator('iframe[title^="The page"]').evaluate((f) => f.contentWindow?.location.pathname ?? ''), /^\/tasks/, 'the framed page is the one it opened');
      if (phone) await expect(page.getByRole('radio', { name: 'Page', exact: true })).toBeChecked({ timeout: 20000 });
      await delay(1500); await shot(page, `08b-opened-beside-the-chat-${tag}.png`); browserChecks += 3;
      // The side view away from Chats: the person goes to Work themselves; the stream opens again there.
      await page.goto(`${base}/tasks`, { timeout: 240000 }); await expect(page.locator('main').first()).toBeVisible({ timeout: 180000 }); await delay(1500);
      const sv = (await screen('side-panel', { target: '/me', title: 'My desk' })).action;
      await expect(page.locator('[data-side-view]')).toBeVisible({ timeout: 60000 });
      await expect(page.locator('[data-side-view] iframe')).toHaveAttribute('src', /\/me\?embed=1/);
      await expect(page.frameLocator('[data-side-view] iframe').locator('main').first()).toBeVisible({ timeout: 180000 });
      await delay(2500); await shot(page, `09-side-view-${tag}.png`);
      assert.ok(sv.id); await screen('side-panel/close', {});
      await expect(page.locator('[data-side-view]')).toHaveCount(0, { timeout: 20000 }); browserChecks += 3;
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(wide <= 1, `no sideways scroll at ${width}px (${wide})`); browserChecks++;

      // 8. An admin screen for a member: the member gets no prompt; the admin's tray asks for them.
      if (!phone) {
        const mdm = (await call('chats/direct', MEMBER, 'POST', { personId: AGENT })).id;
        await call(`chats/${mdm}/messages`, MEMBER, 'POST', { body: 'Synthetic: where do I change the AI settings?', attachments: [], clientId: randomUUID() });
        const adminAsk = (await v1('chats/screen/page', { forPersonId: MEMBER_ID, path: '/settings?tab=ai' })).action;
        assert.equal(adminAsk.state, 'asked');
        assert.equal((await call('screen/pending', MEMBER)).asks.length, 0, 'the member answers no admin-level prompt');
        const forMember = page.locator(`[data-screen-ask="${adminAsk.id}"]`);
        await expect(forMember).toContainText('wants to open Settings for', { timeout: 20000 });
        await shot(page, `10-admin-prompt-for-a-colleague-${tag}.png`);
        await forMember.getByRole('button', { name: 'No' }).click();
        await expect(forMember).toHaveCount(0); browserChecks += 3;
      }

      // 9. Its screen control on its profile: the level, what it may always do, the last actions.
      await page.goto(`${base}/people/${AGENT}?tab=ai`, { timeout: 240000 });
      await page.locator('#ai-tab-capabilities').click({ timeout: 120000 });
      const sc = page.locator('[data-screen-control]');
      await expect(sc).toContainText('Screen control', { timeout: 60000 });
      await expect(sc.getByRole('radio', { name: /View/ })).toBeChecked();
      if (!phone) await expect(sc).toContainText('Type in the message box');
      await expect(sc).toContainText('Last screen actions');
      await sc.scrollIntoViewIfNeeded(); await shot(page, `11-screen-control-${tag}.png`); browserChecks += 3;
      assert.deepEqual(errors, [], `no page errors at ${tag}`);
      } catch (e) {
        await shot(page, `fail-${tag}.png`).catch(() => {});
        const recent = (await call(`screen/agents/${AGENT}`, ADMIN).catch(() => ({ recent: [] }))).recent.slice(0, 6).map((r) => `${r.action} ${r.state} ${r.error ?? ''} ${JSON.stringify(r.result ?? null)}`);
        writeFileSync(join(shots, `diag-${tag}.txt`), [`failed: ${String(e?.message ?? e).slice(0, 600)}`, `url: ${page.url()}`, '--- screen calls', ...heard.slice(-30), '--- console', ...said.slice(-30),
          '--- page errors', ...errors.slice(-10), '--- last actions', ...recent].join('\n'));
        throw e;
      }
      await c.close();
    }
  }
  // Every action is a row: the AI employee's profile lists them for its admins.
  const settings = await call(`screen/agents/${AGENT}`, ADMIN);
  assert.ok(settings.recent.length >= (browserWalk ? 8 : 3) && settings.recent.some((r) => r.action === 'card.show'), `the audit trail (${settings.recent.length} rows)`);
  await call(`screen/agents/${AGENT}`, MEMBER, 'PUT', { level: 'admin' }, 403);
  const set = await call(`screen/agents/${AGENT}`, ADMIN, 'PUT', { level: 'off' });
  assert.equal(set.level, 'off');
  await v1('chats/screen/sidebar', { forPersonId: ADMIN_ID, open: true }, 'POST', 403);
  notes.push('level off refuses every screen action');
} finally {
  await browser?.close().catch(() => {});
  if (web?.pid) { try { process.kill(-web.pid, 'SIGTERM'); } catch { /* gone */ } }
  restore();
  await app.close().catch(() => {}); await pool.end().catch(() => {});
}
writeFileSync(process.env.AGENT_UI_REPORT, JSON.stringify({ apiChecks, browserChecks, notes, shots }));
