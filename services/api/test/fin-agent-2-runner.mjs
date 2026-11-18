// FIN-AGENT-2 acceptance on a disposable tenant (tests/core/test_fin_agent_2.py). The real API on a local port, the AI
// runtime's job worker (services/coworker/jobs.mjs) with the AI employee's own key, the real sandbox, and the runtime's
// test model (the stub engine) for the one AI call a job may make:
//  1. the AI step: the groups no rule knew get one model call; its guesses go on their lines, which stay to check; the
//     job counts the call and its tokens; a person keeping a guess is an agreement the next statement learns from.
//  2. learned skills as tools over /api/v1/mcp with the AI's key: list_skills, run_skill (rules on lines at once, no
//     model; a parser on a chat's files as a job whose chat message shows it), get_job; who may and who may not.
//  3. GST returns sent in a chat: a GST job (fin.gst) checks GSTR-1, GSTR-3B and GSTR-2B against Pulse, and the same
//     chat message says what differs.
import assert from 'node:assert/strict'; import { Pool } from 'pg'; import { writeFile, readdir, readFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process'; import { join } from 'node:path'; import { tmpdir } from 'node:os'; import { randomUUID } from 'node:crypto';
import { createApp } from '../dist/app.js';
import { workJob, financeAsk } from '../../coworker/jobs.mjs';
import { sandboxPython, LIB, sandboxReady } from '../../coworker/sandbox.mjs';
import { gstFixtures } from '../../coworker/gst-fixtures.mjs';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), owner = new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
const app = createApp(pool, pool); app.log.child = () => app.log;
const R = JSON.parse(process.env.TEST_ROLES); const ORG = process.env.PULSE_ORG_ID, KEY = process.env.TEST_AGENT_KEY, KEY2 = process.env.TEST_AGENT2_KEY;
let checks = 0; const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; }; const ok = (v, m) => { assert.ok(v, m); checks++; };
await app.listen({ port: 0, host: '127.0.0.1' }); const BASE = `http://127.0.0.1:${app.server.address().port}`;
async function call(path, body, as = 'founder') {
 const r = await fetch(`${BASE}/api/v0/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': as + '@finagent.example', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
 let data; try { data = await r.json(); } catch { data = null; } return { status: r.status, data };
}
let modelCalls = 0;
/** The AI employee's runtime: its key, and the runtime's test model for the AI step (the same path as runner.mjs's model()). */
const agent = (key) => ({ me: { tools: ['chats', 'billing', 'memory'], provider: 'claude' }, opts: { stub: true }, plan: async () => ({ usable: [] }),
 async model(rt, prompt, o) { modelCalls++; assert.equal(rt.provider, 'stub'); const text = await o.stub(prompt); return { text, tokens: Math.ceil(prompt.length / 4) + Math.ceil(text.length / 4) }; },
 async call(method, path, body, { raw = false } = {}) {
  if (body === undefined && method !== 'GET') body = {};
  const r = await fetch(BASE + path, { method, headers: { 'x-pulse-agent-key': key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (raw && r.ok) return new Uint8Array(await r.arrayBuffer());
  const d = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(d.error ?? `HTTP ${r.status}`); e.status = r.status; throw e; } return d;
 } });
async function own(sql, args = []) { const c = await owner.connect(); try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [ORG]); const r = await c.query(sql, args); await c.query('commit'); return r.rows; } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); } }
async function asPerson(person, sql, args = []) { const c = await pool.connect(); try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true), set_config('pulse.viewer_id',$2,true)", [ORG, person]); return (await c.query(sql, args)).rows; } finally { await c.query('rollback').catch(() => {}); c.release(); } }
/** One MCP call, as services/coworker/pulse-tools.mjs sends it. */
async function mcp(bearer, method, params = {}) {
 const r = await app.inject({ method: 'POST', url: '/api/v1/mcp', payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'idempotency-key': randomUUID() } });
 let j = null;
 try { j = JSON.parse(r.body); } catch { const d = r.body.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).at(-1); j = d ? JSON.parse(d) : null; }
 return { status: r.statusCode, j };
}
async function tool(bearer, name, args = {}) {
 const { status, j } = await mcp(bearer, 'tools/call', { name, arguments: args });
 assert.equal(status, 200, `${name}: ${JSON.stringify(j)}`);
 const text = (j?.result?.content ?? []).map((c) => c.text).join('');
 let data = j?.result?.structuredContent ?? null; if (!data && text) { try { data = JSON.parse(text); } catch { data = null; } }
 return { error: !!j?.result?.isError, data, text };
}
const ai = agent(KEY), other = agent(KEY2); other.me = { tools: ['chats', 'tasks'], provider: 'claude' };
const dir = await mkdtemp(join(tmpdir(), 'fin-agent-2-')); execFileSync(sandboxPython(), ['-I', join(LIB, 'synth.py'), dir]);
const bytes = async (n) => readFile(join(dir, n));
async function startJob(files, title) {
 const meta = []; for (const n of files) { const b = await bytes(n); meta.push({ name: n, mime: 'application/octet-stream', size: b.length, parts: 1, b }); }
 const r = await call('finance/agent/jobs', { agentId: R.ai, title, files: meta.map(({ b, ...m }) => m) }); assert.equal(r.status, 200, JSON.stringify(r.data));
 for (const [fi, m] of meta.entries()) assert.equal((await call(`finance/agent/jobs/${r.data.id}/parts`, { file: fi, part: 0, bytes: m.b.toString('base64') })).status, 200);
 return r.data.id;
}
async function attach(ch, name, data, mime = 'text/csv') { const f = await call(`chats/${ch}/files`, { name, mime, bytes: Buffer.from(data).toString('base64') }); assert.equal(f.status, 200, JSON.stringify(f.data)); return { id: f.data.id, name, mime, size: data.length }; }
const run = async (who = ai) => workJob(who, { log: () => {} });
try {
 ok(sandboxReady(), 'the sandbox runs on this server');
 // 1. The AI step.
 const statements = (await readdir(dir)).filter((n) => /^(hdfc-EXMP1234-apr|sbi)/.test(n)).sort();
 const j1 = await startJob(statements, 'Statements');
 eq(await run(), j1, 'the worker takes the job');
 let job = (await call(`finance/agent/jobs/${j1}`)).data;
 eq(job.status, 'done', job.error ?? '');
 eq(job.modelCalls, 1, 'one model call for the whole job, however many groups were unclear');
 ok(job.tokens > 0, 'with its tokens counted on the job');
 ok(job.result.ai.lines > 0 && job.result.ai.engine.startsWith('stub'), `the AI's guesses went on lines: ${JSON.stringify(job.result.ai)}`);
 ok(/\(the AI guessed \d+\)/.test(job.line), `the closing line says so: ${job.line}`);
 const ravi = await own("select category,flags,reasons,source,confidence::float c from pulse.fin_review_item where org_id=$1 and job_id=$2 and counterparty ilike 'ravi%'", [ORG, j1]);
 ok(ravi.length >= 2, 'Ravi Synthetic\'s freelance payments are in the job');
 ok(ravi.every((x) => x.category === 'Freelancers' && x.flags.includes('unclear_category') && /^The AI's guess: Freelancers/.test(x.reasons[0]) && x.source.startsWith('ai:stub') && x.c < 0.6),
  'each has the AI\'s guess, says so, and is still to check');
 const g = (await call('finance/agent/review?q=ravi')).data.groups.find((x) => /Ravi/.test(x.who));
 eq(g.category, 'Freelancers', 'the group shows the guess for one-tap confirm');
 const r1 = await call('finance/agent/review', { who: g.who, direction: g.direction, decision: 'confirm' });
 eq(r1.data.changed, g.lines, 'leadership keeps the guess with one tap');
 const agreed = (await own("select count(*) filter (where source like 'ai:%' and decided_category=category)::int n from pulse.fin_review_item where org_id=$1 and status='confirmed' and counterparty ilike 'ravi%'", [ORG]))[0].n;
 eq(agreed, g.lines, 'kept as guessed: agreements the next job learns from');
 await writeFile(join(dir, 'hdfc-EXMP7777-aug-2026.csv'), (await bytes('hdfc-EXMP1234-may-jul-2026.csv')).toString().replace(/EXMP0001234/g, 'EXMP0007777'));
 const before = modelCalls;
 const j2 = await startJob(['hdfc-EXMP7777-aug-2026.csv'], 'Next month');
 eq(await run(), j2, 'the worker takes the next statement');
 const raviNext = await own("select category,flags,source from pulse.fin_review_item where org_id=$1 and job_id=$2 and counterparty ilike 'ravi%'", [ORG, j2]);
 ok(raviNext.length > 0 && raviNext.every((x) => x.category === 'Freelancers' && !x.flags.includes('unclear_category') && !x.source.startsWith('ai:')), 'the next statement sorts Ravi without the AI and without a flag');
 ok(modelCalls - before <= 1, 'at most one call for what is still unknown');
 const learned = (await call('finance/agent')).data.skills.find((s) => s.name === 'categoriser-learned');
 ok(learned?.status === 'proposed', 'what people kept is proposed as a categoriser skill');

 // 2. Skills as tools.
 eq((await call(`finance/agent/skills/${learned.id}`, { publish: true })).data.status, 'published', 'an approver publishes the rules');
 const hdfc = (await call('finance/agent')).data.skills.find((s) => s.kind === 'parser' && s.name.startsWith('parser-hdfc'));
 ok(hdfc, 'the HDFC layout was learned as a parser skill');
 if (hdfc.status !== 'published') eq((await call(`finance/agent/skills/${hdfc.id}`, { publish: true })).data.status, 'published', 'and the HDFC parser');
 const listed = await mcp(KEY, 'tools/list');
 const names = new Set((listed.j?.result?.tools ?? []).map((t) => t.name));
 ok(['list_skills', 'run_skill', 'get_job'].every((n) => names.has(n)), 'the AI employee\'s MCP lists the skill tools');
 let t = await tool(KEY, 'list_skills', {});
 eq(t.error, false, t.text);
 const cat = t.data.items.find((s) => s.name === 'categoriser-learned');
 ok(cat && cat.kind === 'categoriser' && cat.rules >= 1, 'list_skills shows the published rules');
 ok(t.data.items.every((s) => s.version >= 1), 'published versions only');
 const usesBefore = (await call(`finance/agent/skills/${learned.id}`)).data.uses;
 t = await tool(KEY, 'run_skill', { name: 'categoriser-learned', lines: [{ text: 'IMPS/P2A/•••/RAVI SYNTHETIC/FREELANCE', direction: 'out' }, { text: 'UPI/NOBODY KNOWN', direction: 'out' }] });
 eq(t.error, false, t.text);
 eq(t.data.results.map((x) => x.category), ['Freelancers', null], 'rules on lines at once, with no model call');
 eq([t.data.matched, t.data.lines, modelCalls - before <= 1], [1, 2, true], 'one line known, one not');
 eq((await call(`finance/agent/skills/${learned.id}`)).data.uses, usesBefore + 1, 'the use is counted');
 {
  t = await tool(KEY, 'run_skill', { name: hdfc.name, lines: [{ text: 'x' }] });
  ok(t.error && /reads files/.test(t.text), `a parser is not run on lines: ${t.text}`);
  const ch = (await call('chats/direct', { personId: R.ai })).data.id;
  await writeFile(join(dir, 'hdfc-EXMP8888-sep-2026.csv'), (await bytes('hdfc-EXMP1234-may-jul-2026.csv')).toString().replace(/EXMP0001234/g, 'EXMP0008888'));
  const f = await attach(ch, 'hdfc-EXMP8888-sep-2026.csv', await bytes('hdfc-EXMP8888-sep-2026.csv'));
  const m0 = modelCalls;
  t = await tool(KEY, 'run_skill', { name: hdfc.name, chatId: ch, fileIds: [f.id] });
  eq(t.error, false, t.text);
  ok(t.data.jobId && t.data.statusMessageId, 'a parser on a chat\'s file is a job with its chat message');
  const again = await tool(KEY, 'run_skill', { name: hdfc.name, chatId: ch, fileIds: [f.id] });
  eq(again.data.jobId, t.data.jobId, 'asking twice opens the same job');
  eq(await run(), t.data.jobId, 'the worker runs it');
  const got = await tool(KEY, 'get_job', { jobId: t.data.jobId });
  eq([got.error, got.data.job.status, got.data.job.kind], [false, 'done', 'fin.skill'], got.text);
  eq(got.data.job.result.files[0].parser, `skill:${hdfc.name}@1`, 'read by the named skill');
  ok(got.data.job.rowsOut > 0 && modelCalls === m0, 'its lines are in Pulse, with no model call');
  const msg = (await own('select body from pulse.chat_message where id=$1', [t.data.statusMessageId]))[0].body;
  ok(/^✅ Running "/.test(msg), `the chat message shows the result: ${msg.slice(0, 120)}`);
  t = await tool(KEY2, 'run_skill', { name: hdfc.name, chatId: ch, fileIds: [f.id] });
  ok(t.error, 'an AI employee without Finance & billing cannot run a job with it');
 }
 t = await tool(KEY, 'get_job', { jobId: randomUUID() });
 ok(t.error, 'no other job is readable');
 const j2by2 = await tool(KEY2, 'get_job', { jobId: j1 });
 ok(j2by2.error, 'another AI employee cannot read this one\'s job');
 await assert.rejects(asPerson(R.staff, 'select pulse.agent_skill_catalog(null) v'), /learned skills are for/, 'a person without Finance is refused'); checks++;
 ok((await asPerson(R.fin, 'select pulse.agent_skill_catalog(null) v'))[0].v.length >= 1, 'the Finance role reads them');

 // 3. GST returns sent in a chat.
 const ch = (await call('chats/direct', { personId: R.ai })).data.id;
 const fx = gstFixtures();
 const files = [await attach(ch, 'GSTR1_102026.json', JSON.stringify(fx.gstr1), 'application/json'), await attach(ch, 'GSTR3B_102026.json', JSON.stringify(fx.gstr3b), 'application/json'),
  await attach(ch, 'R2B_102026.json', JSON.stringify(fx.gstr2b), 'application/json')];
 const body = 'October GST returns';
 const msg = (await call(`chats/${ch}/messages`, { body, attachments: files, clientId: randomUUID() })).data.id;
 const ask = financeAsk({ body, files }, ai.me.tools);
 eq([ask.kind, ask.gst], ['fin.gst', true], 'three GST returns are a GST job');
 const opened = await ai.call('POST', '/api/v0/agent/jobs', { kind: ask.kind, title: ask.title, channelId: ch, sourceMessageId: msg, files: ask.files, input: { asked: body, gst: 'true' }, clientId: randomUUID() });
 ok(opened.statusMessageId, 'the fast reply is in the chat');
 const m1 = modelCalls;
 eq(await run(), opened.id, 'the worker takes the GST job');
 job = (await call(`finance/agent/jobs/${opened.id}`)).data;
 eq(job.status, 'done', job.error ?? '');
 eq([job.result.gst.counts.gstr1_vs_3b, job.result.gst.counts.itc_over_2b, job.result.gst.counts.itc_no_payment], [1, 1, 2], `GST findings: ${JSON.stringify(job.result.gst.counts)}`);
 eq(modelCalls, m1, 'the GST check asks no model');
 const said = (await own('select body from pulse.chat_message where id=$1', [opened.statusMessageId]))[0].body;
 ok(/GST \(3 returns\): 3B shows ₹18,800 less GST than GSTR-1 in Oct 26; 3B claims ₹1,800 more credit than 2B in Oct 26; 2 supplier bills in 2B with no payment found\./.test(said), `the chat says what differs: ${said}`);
 const viaTool = await tool(KEY, 'get_job', { jobId: opened.id });
 ok(viaTool.data.job.result.gst.findings.some((x) => /DRC-01B/.test(x.what)), 'get_job hands the findings to the AI employee');
 await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks, modelCalls }));
 console.log(`fin-agent-2: ${checks} checks, ${modelCalls} model calls`);
} finally { await app.close(); await pool.end(); await owner.end(); }
