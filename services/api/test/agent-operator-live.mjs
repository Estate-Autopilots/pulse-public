// AGENT-OPERATOR live (tests/core/test_agent_operator_live.py, PULSE_AOP_LIVE=1; spends real model tokens): the workflow
// video of T4.2.3. The API and web of this checkout on a synthetic company, the real AI runtime (services/coworker/
// runner.mjs on this server's own Claude/Codex sign-in, the company's "own Claude" through Pulse's tools, the same tools
// its MCP serves), and the person's operator view recorded at 1440: they ask in the chat; the Accounts Assistant makes the
// quotation, opens it in the page on the left, the person approves it (a click that approves asks them first), marks it
// accepted, then it makes the proforma on the page and drafts the invoice. Every step it could not do is filed as a bug
// by itself. Writes live.json, stills and operator-live-1440.webm into PULSE_AOP_LIVE_DIR. Invented people and lines.
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
const OUT = process.env.PULSE_AOP_LIVE_DIR; await mkdir(OUT, { recursive: true });
const ADMIN = process.env.TEST_ADMIN_EMAIL, AGENT = process.env.TEST_AGENT_ID;
const { chromium } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
// AOP_WEB_START=1: this checkout's production build (next build first; next start) instead of next dev, which compiles
// each page on its first visit (minutes on a busy server, as WL-QUOTE-LIVE found).
const START = process.env.AOP_WEB_START === '1';
const web = spawn(process.execPath, ['node_modules/next/dist/bin/next', START ? 'start' : 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web',
  env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: START ? 'production' : 'development', PULSE_PUBLIC_LOGIN_ENABLED: '0', NEXT_TELEMETRY_DISABLED: '1',
    ...(START ? {} : { NEXT_DIST_DIR: '.next-agent-operator' }), PULSE_TELEMETRY: '0' }, stdio: 'ignore' });
const call = async (path, body) => {
  const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': ADMIN }, ...(body === undefined ? {} : { payload: body }) });
  assert.ok(r.statusCode < 300, `${path}: ${r.statusCode} ${r.body.slice(0, 300)}`);
  return r.headers['content-type']?.includes('json') ? r.json() : null;
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const runsSince = async (t) => { try { return await runsSinceDb(t); } catch { return {}; } };
const runsSinceDb = async (t) => (await pool.query("select coalesce(sum(tokens),0)::int t, count(*)::int n, string_agg(coalesce(engine,'-'),',') e from pulse.agent_run where agent_id=$1 and started_at>$2", [AGENT, t])).rows[0];
// What there is to see, read through the API as the watching person (the tables are row-secured per company).
const docs = async () => ((await call('erp/documents'))?.documents ?? []).map((d) => ({ doc_type: d.docType ?? d.doc_type, status: d.status, number: d.number ?? null, buyer: d.buyerName ?? d.clientName ?? d.buyer?.name ?? null }));
const actions = async () => ((await call(`screen/agents/${AGENT}`))?.recent ?? []).map((r) => ({ action: r.action, state: r.state, needed: r.needed, decision: r.decision, error: r.error ?? '', text: r.args?.text ?? null }));
let runtime, browser; const report = { stages: [] };
try {
  // A synthetic company's billing: its details, three catalogue items.
  await call('erp/settings', { company: { legalName: 'Synthetic Interiors LLP', tradeName: 'Synthetic Interiors', gstin: '27AAXFV2138F1ZR', address: ['Unit 7, Synthetic Business Park', 'Pune 411045, Maharashtra'],
    email: 'billing@synthetic.example', phone: '+91 90000 00000' }, dueDays: 15, roundTotal: true, quoteApproval: true });
  for (const [name, price] of [['Modular kitchen', 18500000], ['Wardrobe', 9200000], ['Installation', 2500000]]) await call('erp/items', { kind: 'product', name, sac: '9403', unit: 'nos', price, gstRate: 18, status: 'active' });
  const dm = (await call('chats/direct', { personId: AGENT })).id;
  const cfg = join(OUT, 'coworker.json');
  await writeFile(cfg, JSON.stringify({ pulse: origin, poll: 2, agents: [{ username: process.env.TEST_AGENT_USERNAME, keyFile: process.env.TEST_AGENT_KEYFILE }] }));
  runtime = spawn(process.execPath, ['services/coworker/runner.mjs'], { cwd: '../..', env: { ...process.env, PULSE_COWORKER_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
  let said = ''; runtime.stdout.on('data', (b) => { said += b; process.stdout.write(`[runtime] ${b}`); }); runtime.stderr.on('data', (b) => process.stdout.write(`[runtime!] ${b}`));
  for (let i = 0; i < 300; i++) { try { const r = await fetch(`${base}/healthz`); if (r.status < 500) break; } catch { /* not yet */ } await delay(1000); }
  browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'] });
  // Warm the pages first (next dev compiles each on its first visit), so the recording does not show compiling.
  const warm = await browser.newContext({ extraHTTPHeaders: { 'cf-access-authenticated-user-email': ADMIN } }), wp = await warm.newPage();
  for (const p of [`/operator?channel=${dm}`, '/erp?embed=1', '/erp/documents?embed=1']) await wp.goto(base + p, { timeout: 400000 }).catch(() => {});
  await warm.close();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', recordVideo: { dir: OUT, size: { width: 1440, height: 900 } },
    extraHTTPHeaders: { 'cf-access-authenticated-user-email': ADMIN } });
  await ctx.addInitScript(() => { localStorage.setItem('pulse.theme', 'light'); localStorage.setItem('pulse.notify.browser.asked', '1'); });
  const page = await ctx.newPage(); page.on('pageerror', (e) => log('page error', e.message.slice(0, 160)));
  await page.goto(`${base}/operator?channel=${dm}&path=/erp`, { waitUntil: 'load', timeout: 300000 }); await page.waitForTimeout(5000);
  const box = page.getByRole('textbox', { name: /^Message / });
  const send = async (body) => { const t = new Date(); await box.fill(body); await page.waitForTimeout(600); await box.press('Enter'); return t; };
  const reply = async (after, ms = 420000) => {
    let last = null, quiet = 0;
    for (const t0 = Date.now(); Date.now() - t0 < ms; await delay(1500)) {
      const r = ((await call(`chats/${dm}/messages?flat=1`))?.messages ?? []).filter((m) => m.authorId === AGENT && new Date(m.createdAt) > after).at(-1);
      const busy = (await actions()).filter((x) => ['asked', 'sent', 'claimed'].includes(x.state)).length;
      if (r) { if (r.body === last && !busy) { if (++quiet >= 4) return r.body; } else { last = r.body; quiet = 0; } }
      // A question at the top ("wants to click “Approve”: only you can say yes"): the person says yes once.
      const allow = page.getByRole('button', { name: 'Allow once' });
      if (await allow.count()) { log('allow once'); await page.waitForTimeout(1500); await allow.first().click().catch(() => {}); }
    }
    return last;
  };
  const stage = async (name, ask, extra) => {
    const t = await send(ask); log(name, 'asked');
    let n = 0; const snap = setInterval(() => { if (n < 6) void page.screenshot({ path: join(OUT, `live-${name}-${n++}.png`) }).catch(() => {}); }, 12000);
    const r = await reply(t); clearInterval(snap);
    await page.waitForTimeout(2500); await page.screenshot({ path: join(OUT, `live-${name}-end.png`) });
    if (extra) await extra();
    const s = { name, ask, reply: r, docs: await docs(), ...(await runsSince(t)) }; report.stages.push(s); log(name, JSON.stringify(s).slice(0, 600));
  };
  await stage('1-quotation', 'Please make a quotation for our client Lotus Interiors (a new client, Pune): 1 Modular kitchen and 1 Wardrobe from our catalogue, plus Installation. Submit it to me for approval and open it on my screen so I can check it.');
  await stage('2-approve', 'Looks right. Approve it for me on the page (I will say yes when you ask), then mark it as accepted by the client: they said yes on the phone.');
  await stage('3-proforma-invoice', 'Great. Now make the proforma from it on the page, then draft the invoice from the quotation and open the invoice on my screen.');
  report.screenActions = (await actions()).reverse();
  report.bugs = ((await call('bug-reports'))?.rows ?? []).filter((b) => b.reporterId === AGENT).map((b) => ({ number: b.number, words: b.words, route: b.route, similar: b.similar }));
  report.runtimeLog = said.split('\n').filter((l) => /prompt|round|screen|tool|event|refus/.test(l)).slice(-80);
  await ctx.close();
  const vids = (await readdir(OUT)).filter((f) => f.endsWith('.webm') && !f.startsWith('operator-live'));
  if (vids[0]) await rename(join(OUT, vids[0]), join(OUT, 'operator-live-1440.webm'));
  await writeFile(join(OUT, 'live.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ stages: report.stages.map((s) => ({ name: s.name, docs: s.docs, tokens: s.t })), bugs: report.bugs.length }));
} finally {
  runtime?.kill('SIGTERM'); await browser?.close().catch(() => {}); web.kill('SIGTERM'); await app.close(); await pool.end();
}
