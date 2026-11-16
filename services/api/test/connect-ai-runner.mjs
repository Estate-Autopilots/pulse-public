// AI-CONNECT (owner, 8 Nov 2026: "test it ourselves: how you log in, choose Claude, and connect"): Settings → Connect
// your AI and the sign-in an AI app goes through, end to end on a disposable synthetic company (tests/core/test_connect_ai.py).
// Always: an app registers itself, the person allows only some groups, the token holds only those, the app shows under
// Connected apps with when it was last used, Disconnect ends it at once, and a colleague without admin rights does not
// see the company's AI. With PULSE_AUTH_BROWSER=1 the same in a real browser (1440 light, 390 dark): the page, the six
// apps, the consent screen with its tick boxes, Allow, the app in the list, Disconnect. Screenshots go to CONNECT_AI_SHOTS.
// Nothing leaves this machine; the redirect address is a synthetic one the browser never reaches.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createApp } from '../dist/app.js';

const pool = new pg.Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool), ADMIN = process.env.TEST_ADMIN_EMAIL, MEMBER = process.env.TEST_MEMBER_EMAIL;
const shots = process.env.CONNECT_AI_SHOTS || join(tmpdir(), 'connect-ai-shots');
const REDIRECT = 'https://claude.example/api/mcp/auth_callback';
let apiChecks = 0, browserChecks = 0;

const as = (who) => ({ 'cf-access-authenticated-user-email': who });
const call = async (path, who, method = 'GET', body, expected = 200) => {
  apiChecks++;
  const r = await app.inject({ url: '/api/v0/' + path, method, headers: as(who), ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `${method} ${path}: ${r.body}`);
  return r.json();
};
const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };
const register = async (name) => {
  const r = await app.inject({ url: '/api/v0/oauth/register', method: 'POST', payload: { client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' } });
  assert.equal(r.statusCode, 201, r.body); apiChecks++; return r.json().client_id;
};
const exchange = async (client, code, verifier) => {
  const r = await app.inject({ url: '/api/v0/oauth/token', method: 'POST', payload: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client, redirect_uri: REDIRECT } });
  assert.equal(r.statusCode, 200, r.body); apiChecks++; return r.json();
};
const mcp = async (token, method, params, expected = 200) => {
  const r = await app.inject({ url: '/api/v1/mcp', method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    payload: { jsonrpc: '2.0', id: 1, method, params } });
  apiChecks++; assert.equal(r.statusCode, expected, r.body);
  if (expected !== 200) return null;
  const text = r.body.startsWith('event:') ? r.body.split('\n').find((l) => l.startsWith('data:')).slice(5) : r.body;
  return JSON.parse(text).result;
};

let browser, web;
try {
  // ---- API: sign in, allow some groups, the connection is listed with "last used", Disconnect ends it ----------------
  const client = await register('Synthetic Claude (connect-ai)');
  const { verifier, challenge } = pkce();
  const ask = { client_id: client, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'synthetic' };
  const consent = await call('oauth/authorize?' + new URLSearchParams(ask), ADMIN);
  assert.equal(consent.app.name, 'Synthetic Claude (connect-ai)'); assert.ok(consent.scopes.length >= 20, 'an app that asks for nothing gets asked about everything');
  // What the consent form sends after the person unticks Chats and Other areas (apps/web/app/lib/oauth-web.mjs consentBody).
  const { consentBody } = await import('../../../apps/web/app/lib/oauth-web.mjs');
  const form = new URLSearchParams({ ...ask, choose: '1', decision: 'approve' });
  for (const g of ['read', 'write', 'contracts', 'quotes']) form.append('grant', g);
  const { body } = consentBody(form);
  const back = new URL((await call('oauth/authorize', ADMIN, 'POST', body)).redirect);
  assert.equal(back.searchParams.get('state'), 'synthetic');
  const tokens = await exchange(client, back.searchParams.get('code'), verifier);
  for (const s of ['docs.read', 'tasks.write', 'contracts.write', 'billing.read']) assert.ok(tokens.scope.split(' ').includes(s), `granted ${s}`);
  for (const s of ['chats.read', 'hr.read', 'people.write']) assert.ok(!tokens.scope.split(' ').includes(s), `not granted ${s}`);
  const tools = (await mcp(tokens.access_token, 'tools/list', {})).tools.map((t) => t.name);
  // Quotes (list_quotations, create_quotation) also need the company's billing set up and a Finance/Leadership role; this
  // synthetic company has no billing, so they are checked by the Claude Code run on pulse-dev (reports/AI-CONNECT.md).
  for (const t of ['list_docs', 'create_doc', 'update_doc', 'list_tasks', 'create_task', 'update_task', 'list_projects', 'list_contracts', 'get_contract', 'create_contract', 'update_contract', 'search'])
    assert.ok(tools.includes(t), `the app sees ${t}`);
  for (const t of ['send_message', 'read_messages', 'request_leave']) assert.ok(!tools.includes(t), `unticked: no ${t}`);
  const me = await mcp(tokens.access_token, 'tools/call', { name: 'whoami', arguments: {} });
  const who = me.structuredContent ?? JSON.parse(me.content[0].text);
  assert.equal(who.app, 'Synthetic Claude (connect-ai)'); assert.match(who.companyId, /^[0-9a-f-]{36}$/, 'whoami names the company id');
  // Contracts over MCP, as the brief asks: draft with this company as a party (orgId from whoami), change it, read it back.
  // (1830: the change ledger had stopped allowing contract.*, so this answered 400 before.)
  const out = (r) => r.structuredContent ?? JSON.parse(r.content[0].text);
  const made = await mcp(tokens.access_token, 'tools/call', { name: 'create_contract', arguments: { kind: 'services', title: 'Connect-ai contract (synthetic)',
    scope: 'Synthetic scope, version 1.', requestId: 'connect-ai-contract-create-1',
    parties: [{ kind: 'company', role: 'provider', orgId: who.companyId }, { kind: 'company', role: 'client', name: 'Synthetic Client Pvt Ltd (test)' }] } });
  assert.ok(!made.isError, JSON.stringify(made.content)); const contract = out(made).contract;
  const changed = await mcp(tokens.access_token, 'tools/call', { name: 'update_contract', arguments: { contractId: contract.id, scope: 'Synthetic scope, version 2.',
    deliverables: ['Synthetic deliverable'], requestId: 'connect-ai-contract-update-1' } });
  assert.ok(!changed.isError, JSON.stringify(changed.content));
  const read = out(await mcp(tokens.access_token, 'tools/call', { name: 'get_contract', arguments: { contractId: contract.id } }));
  assert.equal((read.contract ?? read).scope, 'Synthetic scope, version 2.');
  const mine = (await call('oauth/connections', ADMIN)).connections;
  const grant = mine.find((g) => g.app === 'Synthetic Claude (connect-ai)');
  assert.ok(grant, 'listed under Connected apps'); assert.ok(grant.lastUsedAt, 'with when it was last used');
  assert.ok(!(await call('oauth/connections', MEMBER)).connections.some((g) => g.id === grant.id), 'a colleague does not see it');
  await call(`oauth/connections/${grant.id}/end`, MEMBER, 'POST', {}, 404);
  // Company level: admins see where the AI employees run and which AI they use; a member does not.
  await call('ai', MEMBER, 'GET', undefined, 403);
  const ai = await call('ai', ADMIN);
  assert.ok(Array.isArray(ai.workspaces) && ai.cloud, 'admins read the company\'s AI and workspaces');
  await call(`oauth/connections/${grant.id}/end`, ADMIN, 'POST', {});
  await mcp(tokens.access_token, 'tools/list', {}, 401);
  assert.ok(!(await call('oauth/connections', ADMIN)).connections.some((g) => g.id === grant.id), 'gone after Disconnect');

  // ---- Browser: the page, the consent screen, Allow, Connected apps, Disconnect ---------------------------------------
  if (process.env.PULSE_AUTH_BROWSER === '1') {
    mkdirSync(shots, { recursive: true });
    const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const probe = createServer(); await new Promise((d) => probe.listen(0, '127.0.0.1', d)); const port = probe.address().port; await new Promise((d) => probe.close(d));
    const base = `http://127.0.0.1:${port}`;
    web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true, stdio: 'ignore',
      env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-connect-ai', PULSE_PUBLIC_LOGIN_ENABLED: '', PULSE_TELEMETRY: '0' } });
    for (let i = 0; i < 480; i++) { try { if ((await fetch(base + '/login')).status < 500) break; } catch { /* starting */ } await delay(250); if (i === 479) throw Error('web did not start'); }
    browser = await chromium.launch({ headless: true });
    const shot = async (page, name) => { await delay(500); await page.screenshot({ path: join(shots, name), fullPage: false }); };
    for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
      const tag = `${width}-${theme}`;
      const c = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 1000 }, colorScheme: theme, extraHTTPHeaders: as(ADMIN) });
      await c.addInitScript((t) => { localStorage.setItem('pulse.theme', t); }, theme);
      const page = await c.newPage(), errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('dialog', (d) => void d.accept());
      // 1. The page: six apps, Claude first, one Copy button with the address, three steps.
      await page.goto(`${base}/settings?tab=connect-ai`, { timeout: 240000 });
      await expect(page.getByRole('heading', { level: 1, name: 'Connect your AI' })).toBeVisible({ timeout: 120000 });
      // FIX-AI-EMPLOYEES (12 Nov 2026): the six apps are buttons, not tabs: Claude, ChatGPT and Gemini as big cards (Claude
      // chosen first), and Cursor or VS Code, any MCP app and an API key behind "More ways to connect".
      const pick = page.getByRole('group', { name: 'Pick your AI app' }), more = page.getByRole('group', { name: 'More ways to connect' });
      const moreWays = async () => { if (!(await more.isVisible())) await page.locator('summary').filter({ hasText: 'More ways to connect' }).click(); await expect(more).toBeVisible(); };
      await expect(pick.getByRole('button')).toHaveCount(3);
      await expect(pick.getByRole('button', { name: /Claude/, pressed: true })).toBeVisible();
      await moreWays(); await expect(more.getByRole('button')).toHaveCount(3); browserChecks++;
      await expect(page.getByRole('tabpanel', { name: 'Claude' }).getByRole('button', { name: 'Copy address' })).toBeVisible(); browserChecks++;
      await expect(page.getByRole('tabpanel').locator('code')).toHaveText(`${base}/mcp`); browserChecks++;
      await expect(page.getByRole('tabpanel').locator('ol > li')).toHaveCount(3); browserChecks++;
      await expect(page.getByRole('heading', { name: 'For your company' })).toBeVisible(); browserChecks++;
      // FIX-AI-EMPLOYEES: "For your company" is a section that opens (closed at first); its first list is now named
      // "Where your AI employees work" (LAND-CAPTAIN-10: the runner follows the screen).
      await page.getByRole('heading', { name: 'For your company' }).click();
      await expect(page.getByRole('heading', { level: 4, name: 'Where your AI employees work' })).toBeVisible({ timeout: 30000 }); browserChecks++;
      await shot(page, `01-connect-ai-claude-${tag}.png`);
      await pick.getByRole('button', { name: /ChatGPT/ }).click();
      await expect(page.getByRole('tabpanel', { name: 'ChatGPT' })).toContainText('Developer mode'); browserChecks++;
      await shot(page, `02-connect-ai-chatgpt-${tag}.png`);
      await pick.getByRole('button', { name: /Claude/ }).click();
      await page.getByRole('group', { name: 'Which one' }).getByRole('button', { name: 'Claude Code', pressed: false }).click();
      await expect(page.getByRole('tabpanel').locator('code')).toHaveText(`claude mcp add --transport http pulse ${base}/mcp`); browserChecks++;
      await moreWays(); await more.getByRole('button', { name: /Cursor or VS Code/ }).click();
      await expect(page.getByRole('link', { name: 'Add to Cursor' })).toHaveAttribute('href', /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=pulse&config=/); browserChecks++;
      await shot(page, `03-connect-ai-cursor-${tag}.png`);

      // 2. Claude's sign-in: it registered itself; the person is sent to the consent screen, unticks Chats, presses Allow.
      const appName = `Synthetic Claude ${tag}`;
      const r = await fetch(base + '/oauth/mcp/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: appName, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) });
      assert.equal(r.status, 201); const id = (await r.json()).client_id; browserChecks++;
      const p = pkce();
      let landed = null;
      await page.route('https://claude.example/**', (route) => { landed = route.request().url(); return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Back in the app</p>' }); });
      await page.goto(`${base}/oauth/mcp/authorize?${new URLSearchParams({ client_id: id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: p.challenge, code_challenge_method: 'S256', state: 's1' })}`);
      await expect(page.getByRole('heading', { name: `${appName} wants to use Pulse as you` })).toBeVisible({ timeout: 60000 }); browserChecks++;
      await expect(page.getByRole('checkbox')).toHaveCount(6); browserChecks++;
      await shot(page, `04-consent-${tag}.png`);
      await page.getByRole('checkbox', { name: /chats/i }).uncheck();
      await page.getByRole('button', { name: 'Allow' }).click();
      for (let i = 0; i < 80 && !landed; i++) await delay(250);
      assert.ok(landed, 'returned to the app'); browserChecks++;
      const t = await (await fetch(base + '/oauth/mcp/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: new URL(landed).searchParams.get('code'), code_verifier: p.verifier, client_id: id, redirect_uri: REDIRECT }) })).json();
      assert.ok(t.access_token && !/chats\./.test(t.scope) && /docs\.read/.test(t.scope), JSON.stringify({ scope: t.scope })); browserChecks++;
      const used = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }) });
      assert.equal(used.status, 200); browserChecks++;

      // 3. Back in Settings: the app is listed with when it was last used; Disconnect ends it at once.
      await page.goto(`${base}/settings?tab=connect-ai`);
      const row = page.getByRole('listitem').filter({ hasText: appName });
      await expect(row).toContainText('last used', { timeout: 30000 }); browserChecks++;
      await expect(row).not.toContainText('chats'); browserChecks++;
      await row.scrollIntoViewIfNeeded();
      await shot(page, `05-connected-apps-${tag}.png`);
      await row.getByRole('button', { name: 'Disconnect' }).click();
      // UI-DIALOGS (9 Nov 2026): Disconnect asks once in the app's own dialog.
      await page.getByRole('alertdialog', { name: `Disconnect ${appName}?` }).getByRole('button', { name: 'Disconnect', exact: true }).click();
      await expect(page.getByRole('listitem').filter({ hasText: appName })).toHaveCount(0, { timeout: 30000 }); browserChecks++;
      const after = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
      assert.equal(after.status, 401); browserChecks++;
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(sideways <= 1, `no sideways scroll at ${tag} (${sideways}px)`); browserChecks++;
      assert.deepEqual(errors, [], `no page errors at ${tag}`);
      await c.close();
    }
  }
  writeFileSync(process.env.CONNECT_AI_REPORT || join(tmpdir(), 'connect-ai.json'), JSON.stringify({ apiChecks, browserChecks }));
  console.log(`connect-ai: ${apiChecks} API checks, ${browserChecks} browser checks pass`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (web) { try { process.kill(-web.pid, 'SIGTERM'); } catch { /* gone */ } }
  // next dev rewrites these two files; put them back as the AGENT-UI walk does.
  if (web) { try { execFileSync('git', ['checkout', '--', 'apps/web/tsconfig.json', 'apps/web/next-env.d.ts'], { cwd: '../..', stdio: 'ignore' }); } catch { /* not a checkout */ } }
  await app.close(); await pool.end();
}
