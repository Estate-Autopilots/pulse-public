// FIX-CHAT-AI live (tests/core/test_fix_chat_ai_live.py, PULSE_FCA_LIVE=1): the API and web of this checkout on a
// synthetic company, the real AI runtime (services/coworker/runner.mjs, this server's Claude sign-in) for an Accounts
// Assistant, and the admin's browser recorded (video) while it works their screen. Writes live.json (what happened and
// the tokens of each request, from its runs) and the video into PULSE_FCA_LIVE_DIR.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const OUT = process.env.PULSE_FCA_LIVE_DIR; await mkdir(OUT, { recursive: true });
const ADMIN = process.env.TEST_ADMIN_EMAIL, AGENT = process.env.TEST_AGENT_ID;
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web',
  env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'development', PULSE_PUBLIC_LOGIN_ENABLED: '0', NEXT_TELEMETRY_DISABLED: '1' }, stdio: 'ignore' });
const call = async (path, body) => {
  const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': ADMIN }, ...(body === undefined ? {} : { payload: body }) });
  assert.ok(r.statusCode < 300, `${path}: ${r.statusCode} ${r.body.slice(0, 300)}`);
  return r.headers['content-type']?.includes('json') ? r.json() : null;
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const runsSince = async (t) => (await pool.query("select coalesce(sum(tokens),0)::int t, count(*)::int n, string_agg(coalesce(engine,'-'),',') e from pulse.agent_run where agent_id=$1 and started_at>$2", [AGENT, t])).rows[0];
let runtime, browser; const report = {};
try {
  // A synthetic company's billing and a draft quotation with four lines (one of them "Model-led video").
  await call('erp/settings', { company: { legalName: 'Synthetic Studio LLP', tradeName: 'Synthetic Studio', gstin: '27AAXFV2138F1ZR', address: ['Unit 7, Synthetic Business Park', 'Pune 411045, Maharashtra'],
    email: 'billing@synthetic.example', phone: '+91 90000 00000' }, dueDays: 15, roundTotal: true, quoteApproval: true });
  const item = async (name, price) => (await call('erp/items', { kind: 'service', name, sac: '999612', unit: 'nos', price, gstRate: 18, status: 'active' })).id;
  const items = [['Site visit', 1200000], ['Design plan', 4500000], ['Model-led video', 1800000], ['Final delivery', 4950000]];
  const ids = []; for (const [n, p] of items) ids.push(await item(n, p));
  const quote = (await call('erp/documents', { docType: 'quotation', buyer: { name: 'Lotus Interiors (synthetic)' } })).id;
  const d = await call(`erp/documents/${quote}`);
  await call(`erp/documents/${quote}`, { ...d.document, lines: items.map(([n, p], i) => ({ itemId: ids[i], description: n, sac: '999612', unit: 'nos', qty: 1, rate: p, gstRate: 18 })) });
  log('quotation', quote);
  // The admin's direct chat with the assistant.
  const dm = (await call('chats/direct', { personId: AGENT })).id;
  assert.ok(dm, 'a direct chat with the assistant');
  // The real runtime for the assistant (this checkout's runner), polling every 2 s.
  const cfg = join(OUT, 'coworker.json');
  await writeFile(cfg, JSON.stringify({ pulse: origin, poll: 2, agents: [{ username: process.env.TEST_AGENT_USERNAME, keyFile: process.env.TEST_AGENT_KEYFILE }] }));
  runtime = spawn(process.execPath, ['services/coworker/runner.mjs'], { cwd: '../..', env: { ...process.env, PULSE_COWORKER_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
  let said = ''; runtime.stdout.on('data', (b) => { said += b; process.stdout.write(`[runtime] ${b}`); }); runtime.stderr.on('data', (b) => process.stdout.write(`[runtime!] ${b}`));
  for (let i = 0; i < 300; i++) { try { const r = await fetch(`${base}/healthz`); if (r.status < 500) break; } catch { /* not yet */ } await delay(1000); }
  browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', recordVideo: { dir: OUT, size: { width: 1440, height: 900 } },
    extraHTTPHeaders: { 'cf-access-authenticated-user-email': ADMIN } });
  await ctx.addInitScript(() => { localStorage.setItem('pulse.theme', 'light'); localStorage.setItem('pulse.notify.browser.asked', '1'); });
  const page = await ctx.newPage(); page.on('pageerror', (e) => log('page error', e.message.slice(0, 160)));
  const send = async (body) => { const t = new Date(); await call(`chats/${dm}/messages`, { body, attachments: [], clientId: randomUUID() }); return t; };
  const reply = async (after, ms = 240000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await delay(1500)) {
      const r = (await pool.query("select body from pulse.chat_message where channel_id=$1 and author_id=$2 and created_at>$3 order by created_at desc limit 1", [dm, AGENT, after])).rows[0];
      if (r) return r.body;
      // A prompt at the top ("wants to click “Remove”"): the admin allows it once, as a person would.
      const allow = page.getByRole('button', { name: 'Allow once' });
      if (await allow.count()) { log('allow once'); await allow.first().click().catch(() => {}); }
    }
    return null;
  };
  // 1. "open finance": done on the screen at once, no model call.
  await page.goto(`${base}/erp/documents/${quote}`, { waitUntil: 'load', timeout: 300000 }); await page.waitForTimeout(4000);
  let t = await send('open finance');
  const r1 = await reply(t, 90000);
  await page.waitForURL(/\/finance/, { timeout: 30000 }).catch(() => {});
  report.finance = { reply: r1, opened: /\/finance/.test(page.url()), ...(await runsSince(t)) };
  report.finance.tokens = report.finance.t; log('finance', JSON.stringify(report.finance));
  await page.waitForTimeout(2500);
  // 2. "remove the model-led video line", with the quotation open in front of them.
  await page.goto(`${base}/erp/documents/${quote}`, { waitUntil: 'load', timeout: 300000 }); await page.waitForTimeout(4000);
  await page.screenshot({ path: join(OUT, 'live-01-quotation-before.png') });
  t = await send('remove the model-led video line');
  let shot = 2; const snap = setInterval(() => { if (shot < 9) void page.screenshot({ path: join(OUT, `live-0${shot++}-working.png`) }).catch(() => {}); }, 6000);
  const r2 = await reply(t, 360000);
  clearInterval(snap);
  await page.waitForTimeout(3000);
  const lines = (await pool.query("select description from pulse.erp_line where document_id=$1 order by position", [quote])).rows.map((x) => x.description);
  await page.screenshot({ path: join(OUT, 'live-09-after.png') });
  report.removeLine = { reply: r2, lines, removed: !lines.includes('Model-led video'), ...(await runsSince(t)) };
  report.removeLine.tokens = report.removeLine.t; log('remove line', JSON.stringify(report.removeLine));
  report.screenActions = (await pool.query("select action, state, needed, decision, coalesce(error,'') error from pulse.agent_ui_action where agent_id=$1 order by created_at", [AGENT])).rows;
  report.runtimeLog = said.split('\n').filter((l) => /prompt|round|screen|tool|event/.test(l)).slice(-60);
  await ctx.close();
  const vids = (await readdir(OUT)).filter((f) => f.endsWith('.webm'));
  if (vids[0]) await rename(join(OUT, vids[0]), join(OUT, 'fix-chat-ai-live-1440.webm'));
  await writeFile(join(OUT, 'live.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ finance: report.finance, removeLine: report.removeLine }));
} finally {
  runtime?.kill('SIGTERM'); await browser?.close().catch(() => {}); web.kill('SIGTERM'); await app.close(); await pool.end();
}
