// ONBOARD-CONFIG (owner, 13 Nov 2026, G3 T3.1.2): set a fresh company up from a transcript with the real `pulse` CLI
// (`pulse setup plan --from <file> --class private`, then `pulse setup apply`) against this API on real PostgreSQL and
// tenant row security, and over MCP. Run by tests/core/test_company_setup.py on a synthetic company; SETUP_SOURCE names
// another transcript for a timed proof (it only ever reaches the throwaway test database). Prints counts and timings,
// never the source's words or a token.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { applySetup } from '../dist/setup-config.js';

const W = JSON.parse(process.env.TEST_W);
const CLASS = process.env.SETUP_CLASS === 'public' ? 'public' : 'private';
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 3 }), app = createApp(pool, pool);
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
const dir = mkdtempSync(join(tmpdir(), 'company-setup-'));

const SYNTHETIC = `# Synthetic podcast: how a small agency runs, 2 Jan 2026

Host: So how is the agency set up?
Guest: We work in squads. Each squad has a squad captain, a growth strategist and two designers. The squad captain reports to me.
Our squads sit in two departments, the Creative department and the Performance department. The sales team is separate.
Every customer gets one squad. We onboard a customer in a week; our customers are builders mostly.
First we sign the customer, then the growth strategist writes the blueprint, after that the designers make the first set, and finally the squad captain reviews it with the customer.
Our goal is to sign 20 customers by 31 March 2027. We also run campaigns: every campaign has a growth strategist and a designer.
The growth strategist owns the campaign. A designer makes the creatives for every campaign. A campaign runs for six weeks.
We started a project called Atlas Launch for our own brand.
`;
const source = process.env.SETUP_SOURCE || join(dir, 'synthetic-podcast.md');
if (!process.env.SETUP_SOURCE) writeFileSync(source, SYNTHETIC);

async function rpc(token, method, params = {}) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/mcp', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    payload: { jsonrpc: '2.0', id: 1, method, params } });
  assert.equal(r.statusCode, 200, r.body);
  const v = r.body.split('\n').filter(s => s.startsWith('data:')).map(s => JSON.parse(s.slice(5))).find(x => x.id === 1);
  return v.result ?? v;
}
const inject = async (token, url, payload) => { const r = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() }, payload }); return { status: r.statusCode, body: r.json() }; };

await app.listen({ host: '127.0.0.1', port: 0 });
const host = `http://127.0.0.1:${app.server.address().port}`;
const CLI = new URL('../../../packages/pulse-cli/dist/cli.js', import.meta.url).pathname;
// The CLI runs as its own process while this one serves the API (a synchronous call would block the server).
const run = promisify(execFile);
const pulse = async (token, args) => {
  try { return { code: 0, out: (await run(process.execPath, [CLI, ...args], { env: { ...process.env, PULSE_HOST: host, PULSE_TOKEN: token, PULSE_CONFIG_DIR: dir }, encoding: 'utf8', maxBuffer: 64 << 20 })).stdout }; }
  catch (e) { return { code: e.code ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }; }
};
const ms = (t) => Math.round(performance.now() - t);
const timing = {};
try {
  // MCP: both tools are listed with their schema; plan writes nothing.
  const tools = (await rpc(W.admin, 'tools/list')).tools;
  const planTool = tools.find(t => t.name === 'plan_company_setup'), applyTool = tools.find(t => t.name === 'apply_company_setup');
  ok(planTool && applyTool, 'MCP lists plan_company_setup and apply_company_setup');
  ok(planTool.inputSchema.properties.proposal && applyTool.inputSchema.properties.dryRun, 'their inputs are the proposal and dryRun');

  // 1. pulse setup plan --from <file> --class private: the dry-run diff, read on this server.
  let t = performance.now();
  const plan = await pulse(W.admin, ['setup', 'plan', '--from', source, '--class', CLASS, '--json']);
  timing.planMs = ms(t);
  eq(plan.code, 0, `pulse setup plan: ${plan.out.slice(0, 2000)}`);
  const p = JSON.parse(plan.out);
  ok(p.items.length > 0 && p.counts.add > 0, 'the plan proposes something to add');
  ok(p.from && !p.from.includes('/'), 'from keeps the file name only');
  const human = await pulse(W.admin, ['setup', 'plan', '--from', source, '--class', CLASS]);
  ok(human.code === 0 && /SECTION\s+CHANGE\s+NAME\s+DETAIL/.test(human.out), 'the human answer is a table of what would change');
  const planFile = join(dir, 'plan.json');
  writeFileSync(planFile, plan.out);

  // 2. apply --dry-run with the saved plan: everything happens, then nothing stays.
  t = performance.now();
  const dry = await pulse(W.admin, ['setup', 'apply', '--from', source, '--class', CLASS, '--data', `@${planFile}`, '--dry-run', '--json']);
  timing.dryRunMs = ms(t);
  if (dry.code !== 0) {
    // The API keeps the database's reason to itself: replay the apply as the same person to say which rule refused it.
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('pulse.org_id',$1,true), set_config('pulse.viewer_id',$2,true)`, [W.org, W.adminId]);
      await applySetup(c, { email: '', org: W.org, person: W.adminId, role: 'admin', name: 'Setup admin', pod: null, via: 'password', username: null, mustChange: false },
        { from: 'source.md', text: SYNTHETIC, class: CLASS, dryRun: true });
      console.error('replay: no refusal');
    } catch (e) { console.error('replay refused:', e.message, e.code ?? '', e.table ?? '', e.where ?? ''); }
    finally { await c.query('rollback').catch(() => undefined); c.release(); }
  }
  eq(dry.code, 0, `dry run: ${dry.out.slice(0, 2000)}`);
  const d = JSON.parse(dry.out);
  ok(d.dryRun === true && d.made.length > 0 && d.made.every(m => m.id === ''), 'the dry run says what it would make, without ids');
  const again = JSON.parse((await pulse(W.admin, ['setup', 'plan', '--from', source, '--class', CLASS, '--json'])).out);
  eq(again.counts, p.counts, 'after the dry run the company is as it was');

  // 3. A person who is not leadership, and a key without docs.write, are refused.
  const member = await inject(W.editorToken, '/api/v1/workflows/setup/plan', { from: 'x.md', text: 'We work in pods.', class: 'private' });
  eq(member.status, 403, 'only leadership and admins set a company up');
  const narrow = await inject(W.narrow, '/api/v1/workflows/setup/apply', { from: 'x.md', text: 'We work in pods.', class: 'private' });
  eq(narrow.status, 403, 'a key without docs.write cannot apply');

  // 4. Apply for real (the reviewed plan), then again: nothing twice.
  t = performance.now();
  const applied = await pulse(W.admin, ['setup', 'apply', '--from', source, '--class', CLASS, '--data', `@${planFile}`, '--json']);
  timing.applyMs = ms(t);
  eq(applied.code, 0, `apply: ${applied.out.slice(0, 2000)}`);
  const a = JSON.parse(applied.out);
  ok(!a.left.some(l => l.label.startsWith('Ask ')), `an owner makes everything: ${JSON.stringify(a.left)}`);
  ok(a.dryRun === false && a.made.length === d.made.length && a.made.every(m => /^[0-9a-f-]{36}$/.test(m.id)), 'apply made what the dry run said, with ids');
  const twice = JSON.parse((await pulse(W.admin, ['setup', 'apply', '--from', source, '--class', CLASS, '--data', `@${planFile}`, '--json'])).out);
  eq(twice.made, [], 'sending it again makes nothing twice');
  ok(twice.counts.add === 0, 'and the plan now says everything is there');

  // 5. Private stays private: the source doc is in a folder open only to the person who ran it.
  const db = await pool.connect();
  try {
    await db.query('begin');
    await db.query(`select set_config('pulse.org_id',$1,true), set_config('pulse.viewer_id',$2,true)`, [W.org, W.editorId]);
    const srcTitle = a.made.find(m => m.kind === 'doc' && m.name.startsWith('Source: '))?.name;
    ok(srcTitle, 'the source became a doc');
    const seen = (await db.query('select title from pulse.doc where title=$1', [srcTitle])).rows.length;
    if (CLASS === 'private') eq(seen, 0, 'a colleague cannot see the private source');
    await db.query('rollback');
  } finally { db.release(); }
  const editorDocs = await app.inject({ method: 'GET', url: '/api/v1/docs?limit=100', headers: { authorization: `Bearer ${W.editorToken}` } });
  if (CLASS === 'private') ok(!editorDocs.json().items?.some(x => String(x.title).startsWith('Source: ')), 'nor through the API');
  ok(editorDocs.json().items?.some(x => x.title === 'How we are set up'), 'the summary (no words from the source) is the company\'s');

  // 6. What is left: only what people do.
  ok(Array.isArray(a.left) && a.left.every(l => l.label && l.href.startsWith('/')), 'left lists what is left, each with where to do it');

  const kinds = Object.fromEntries(['team', 'role', 'workflow', 'goal', 'project', 'doc'].map(k => [k, a.made.filter(m => m.kind === k).length]));
  const words = Object.fromEntries(Object.entries(p.proposal.words).filter(([k]) => !k.endsWith('s')));
  console.log(JSON.stringify({ ok: true, checks, class: CLASS, synthetic: !process.env.SETUP_SOURCE, timing, counts: p.counts, made: kinds, words,
    left: a.left.map(l => l.label), sections: [...new Set(p.items.map(i => i.section))], human: process.env.SETUP_SOURCE ? undefined : human.out.split('\n').slice(0, 30) }));
} finally {
  await app.close();
  await pool.end();
}
