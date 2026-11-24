// AI-ACCESS (tests/core/test_ai_access.py drives this in phases on synthetic companies; nothing leaves this machine):
// one OAuth connection reaches every company where its person has an active staff seat, through the real MCP endpoint.
//   one:   list_my_organisations, org by handle and by id, the remembered default, use_organisation, X-Pulse-Org over
//          HTTP; a company without a seat (by handle, by id) refused with no fallback; Member's own "work: never"; the
//          default "delete: never"; A's "work: ask first" holds create_task (twice: asked, then still waiting).
//   two:   after the approver's yes, the same create_task goes through once; the next one asks again.
//   shots: (PULSE_AUTH_BROWSER=1) Settings → AI access as the Owner (admin of A and B) at 390, 834 and 1440, light and
//          dark: no sideways scroll, no page errors; screenshots go to AIA_SHOTS.
//   three: after the connection is revoked, it is refused.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import pg from 'pg';
import { createApp } from '../dist/app.js';

const pool = new pg.Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool), cfg = JSON.parse(process.env.AIA), phase = process.env.AIA_PHASE;
let checks = 0;

const rpc = async (token, method, params, expected = 200) => {
  const r = await app.inject({ url: '/api/v1/mcp', method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    payload: { jsonrpc: '2.0', id: 1, method, params } });
  checks++; assert.equal(r.statusCode, expected, r.body);
  if (expected !== 200) return null;
  const text = r.body.startsWith('event:') ? r.body.split('\n').find((l) => l.startsWith('data:')).slice(5) : r.body;
  return JSON.parse(text).result;
};
/** A tool call: its answer, or { error } with the refusal's status and words. */
const tool = async (token, name, args = {}) => {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  const body = r.structuredContent ?? JSON.parse(r.content[0].text);
  return r.isError ? { error: body } : body;
};
const ok = async (token, name, args) => { const x = await tool(token, name, args); assert.ok(!x.error, `${name} ${JSON.stringify(args)}: ${JSON.stringify(x.error)}`); return x; };
const no = async (token, name, args, status, words) => {
  const x = await tool(token, name, args);
  assert.ok(x.error, `${name} ${JSON.stringify(args)} should be refused, got ${JSON.stringify(x).slice(0, 300)}`);
  assert.equal(x.error.status, status, JSON.stringify(x.error)); assert.match(x.error.detail, words); checks++;
  return x.error;
};
let browser, web;
const K = cfg.kazuk, M = cfg.member, A = cfg.a, B = cfg.b, C = cfg.c;

try {
  if (phase === 'one') {
    // ---- one connection, every company with a seat ------------------------------------------------------------------
    const orgs = await ok(K, 'list_my_organisations');
    assert.deepEqual(orgs.items.map((o) => o.id).sort(), [A.id, B.id].sort(), 'Kazuk\'s Claude lists A and B');
    assert.equal(orgs.current.id, A.id); assert.ok(orgs.items.find((o) => o.id === A.id).home);
    let me = await ok(K, 'whoami', { org: B.handle });
    assert.equal(me.companyId, B.id); assert.equal(me.id, B.person, 'acts as his seat in B');
    me = await ok(K, 'whoami');
    assert.equal(me.companyId, B.id, 'the last company named is the default');
    assert.equal((await ok(K, 'list_my_organisations')).current.id, B.id);
    assert.equal((await ok(K, 'use_organisation', { org: A.id })).current.id, A.id);
    assert.equal((await ok(K, 'whoami')).companyId, A.id);
    await no(K, 'use_organisation', {}, 400, /Pass org/);
    // ---- isolation: no seat, no access, no fallback ------------------------------------------------------------------
    await no(K, 'whoami', { org: C.handle }, 403, /not in an organisation called/);
    await no(K, 'list_tasks', { org: C.id }, 403, /not in an organisation called/);
    assert.equal((await ok(K, 'whoami')).companyId, A.id, 'a refused company changes nothing');
    await no(M, 'whoami', { org: B.id }, 403, /not in an organisation called/);
    await no(M, 'list_tasks', { org: '@' + B.handle }, 403, /not in an organisation called/);
    assert.equal((await ok(M, 'whoami')).companyId, A.id);
    assert.equal((await ok(M, 'list_my_organisations')).items.length, 1);
    // HTTP: the same choice in X-Pulse-Org.
    const http = async (org, expected) => {
      const r = await app.inject({ url: '/api/v1/people/me', headers: { authorization: `Bearer ${K}`, 'x-pulse-org': org } });
      checks++; assert.equal(r.statusCode, expected, r.body); return r.json();
    };
    assert.equal((await http(B.handle, 200)).companyId, B.id);
    assert.match((await http(C.handle, 403)).detail, /not in an organisation called/);
    await ok(K, 'use_organisation', { org: A.handle });
    // ---- the company's AI rules ---------------------------------------------------------------------------------------
    await no(M, 'create_task', { title: 'AIA refused task (synthetic)' }, 403, /do not let a connected AI create or change work/);
    const made = await ok(K, 'create_task', { org: B.handle, title: 'AIA task in B (synthetic)', requestId: 'aia-task-in-b-1' });
    assert.ok(made.changeId, 'made in B: B keeps the defaults');
    await no(K, 'delete_project', { projectId: '00000000-0000-4000-8000-0000000000aa', confirm: 'true' }, 403, /delete or archive/);
    await ok(K, 'undo_change', { changeId: made.changeId }); // taking back its own change is work, not delete
    await no(K, 'create_task', { org: A.handle, title: 'AIA held task (synthetic)' }, 403, /needs a yes first/);
    await no(K, 'create_task', { org: A.handle, title: 'AIA held task (synthetic)' }, 403, /Still waiting/);
  } else if (phase === 'two') {
    const done = await ok(K, 'create_task', { org: A.handle, title: 'AIA held task (synthetic)' });
    assert.ok(done.id, 'after the yes, the same call goes through');
    await no(K, 'create_task', { org: A.handle, title: 'AIA held task (synthetic)' }, 403, /needs a yes first/);
  } else if (phase === 'shots') {
    const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const probe = createServer(); await new Promise((d) => probe.listen(0, '127.0.0.1', d)); const port = probe.address().port; await new Promise((d) => probe.close(d));
    const base = `http://127.0.0.1:${port}`;
    web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', detached: true, stdio: 'ignore',
      env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: `.next-ai-access-${process.pid}`, PULSE_PUBLIC_LOGIN_ENABLED: '', PULSE_TELEMETRY: '0' } });
    for (let i = 0; i < 1920; i++) { try { if ((await fetch(base + '/login')).status < 500) break; } catch { /* starting */ } await delay(250); if (i === 1919) throw Error('web did not start in 8 minutes'); }
    browser = await chromium.launch({ headless: true });
    const shots = process.env.AIA_SHOTS; mkdirSync(shots, { recursive: true });
    for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [834, 'light'], [834, 'dark'], [390, 'light'], [390, 'dark']]) {
      const tag = `${width}-${theme}`;
      const c = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : width < 1000 ? 1112 : 1000 }, colorScheme: theme,
        extraHTTPHeaders: { 'cf-access-authenticated-user-email': cfg.bossEmail } });
      await c.addInitScript((t) => { localStorage.setItem('pulse.theme', t); }, theme);
      const page = await c.newPage(), errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${base}/settings?tab=ai-access`, { timeout: 240000 });
      await expect(page.getByRole('heading', { name: 'Your own AI apps' })).toBeVisible({ timeout: 120000 }); checks++;
      await expect(page.getByRole('heading', { name: /Connected AI apps in/ })).toBeVisible(); checks++;
      await expect(page.getByText('Waiting for a yes').first()).toBeVisible(); checks++;
      await delay(600);
      await page.screenshot({ path: join(shots, `01-ai-access-top-${tag}.png`) });
      await page.getByRole('button', { name: /What it did/ }).first().click();
      await page.getByRole('heading', { name: /What AI apps may do in/ }).evaluate((el) => el.scrollIntoView({ block: 'start' })); await delay(500);
      await page.screenshot({ path: join(shots, `02-ai-access-rules-${tag}.png`) });
      await page.screenshot({ path: join(shots, `03-ai-access-full-${tag}.png`), fullPage: true });
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(sideways <= 1, `no sideways scroll at ${tag} (${sideways}px)`); checks++;
      assert.deepEqual(errors, [], `no page errors at ${tag}`);
      await c.close();
    }
  } else if (phase === 'three') {
    await rpc(K, 'tools/list', {}, 401);
  } else throw Error(`unknown phase ${phase}`);
  // Each call's receipt is written after its answer (v1-audit.ts); let them land before the test reads them.
  await delay(800);
  writeFileSync(process.env.AIA_REPORT, JSON.stringify({ checks }));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (web) { try { process.kill(-web.pid, 'SIGTERM'); } catch { /* gone */ } }
  // A per-run build folder: a dev server left by a killed run can never hold this run's lock; this run's is removed.
  if (web) { await delay(1500); try { execFileSync('rm', ['-rf', `.next-ai-access-${process.pid}`], { cwd: '../../apps/web', stdio: 'ignore' }); } catch { /* gone */ } }
  // next dev rewrites these two files; put them back as the connect-ai walk does.
  if (web) { try { execFileSync('git', ['checkout', '--', 'apps/web/tsconfig.json', 'apps/web/next-env.d.ts'], { cwd: '../..', stdio: 'ignore' }); } catch { /* not a checkout */ } }
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
