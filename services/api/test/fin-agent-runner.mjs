// FIN-AGENT acceptance on a disposable tenant (tests/core/test_fin_agent.py). The real API (listening on a local port),
// the real AI runtime's job worker (services/coworker/jobs.mjs) with the AI employee's own key, and the real sandbox:
//  1. who: Finance readers see the AI analyst; a staff member is refused; an AI key reaches only its own jobs.
//  2. the fast reply: statements sent in a chat open a job at once and that message shows the progress, then the result.
//  3. eight synthetic statements (HDFC twice with overlapping months, ICICI .xlsx, SBI, Axis, Kotak, a text PDF, and an
//     export the standard importer refuses) are read, de-duplicated, matched and flagged; parser skills are proposed
//     with their tests passed in the sandbox.
//  4. people confirm a group (saved through the standard statement import), re-categorise another; an approver publishes
//     a parser skill (one whose tests failed is refused); the next statement of that bank is read by the skill, and the
//     rules learned from people's decisions sort those lines without a guess.
//  5. the same statement again adds nothing; a big file arrives in parts.
import assert from 'node:assert/strict'; import { Pool } from 'pg'; import { writeFile, readdir, readFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process'; import { join } from 'node:path'; import { tmpdir } from 'node:os'; import { randomUUID } from 'node:crypto';
import { createApp } from '../dist/app.js';
import { workJob, openFinanceJob, financeAsk } from '../../coworker/jobs.mjs';
import { sandboxPython, LIB, sandboxReady } from '../../coworker/sandbox.mjs';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), owner = new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
const app = createApp(pool, pool); const R = JSON.parse(process.env.TEST_ROLES); const ORG = process.env.PULSE_ORG_ID, KEY = process.env.TEST_AGENT_KEY, KEY2 = process.env.TEST_AGENT2_KEY;
let checks = 0; const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; }; const ok = (v, m) => { assert.ok(v, m); checks++; };
await app.listen({ port: 0, host: '127.0.0.1' }); const BASE = `http://127.0.0.1:${app.server.address().port}`;
async function call(path, body, as = 'founder') {
 const r = await fetch(`${BASE}/api/v0/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': as + '@finagent.example', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
 let data; try { data = await r.json(); } catch { data = null; } return { status: r.status, data };
}
const agent = (key) => ({ me: { tools: ['chats', 'billing', 'memory'] }, async call(method, path, body, { raw = false } = {}) {
 if (body === undefined && method !== 'GET') body = {};
 const r = await fetch(BASE + path, { method, headers: { 'x-pulse-agent-key': key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
 if (raw && r.ok) return new Uint8Array(await r.arrayBuffer());
 const d = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(d.error ?? `HTTP ${r.status}`); e.status = r.status; throw e; } return d;
} });
async function own(sql, args = []) { const c = await owner.connect(); try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [ORG]); const r = await c.query(sql, args); await c.query('commit'); return r.rows; } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); } }
const ai = agent(KEY), other = agent(KEY2);
const dir = await mkdtemp(join(tmpdir(), 'fin-agent-')); execFileSync(sandboxPython(), ['-I', join(LIB, 'synth.py'), dir]);
const names = (await readdir(dir)).sort(); const bytes = async (n) => readFile(join(dir, n));
async function startJob(files, title = 'Statements') {
 const meta = []; for (const n of files) { const b = await bytes(n); meta.push({ name: n, mime: 'application/octet-stream', size: b.length, parts: Math.max(1, Math.ceil(b.length / (1024 * 1024))), b }); }
 const r = await call('finance/agent/jobs', { agentId: R.ai, title, files: meta.map(({ b, ...m }) => m) }); eq(r.status, 200, `start a job: ${JSON.stringify(r.data)}`);
 for (const [fi, m] of meta.entries()) for (let p = 0; p < m.parts; p++) {
  const part = m.b.subarray(p * 1024 * 1024, (p + 1) * 1024 * 1024);
  const u = await call(`finance/agent/jobs/${r.data.id}/parts`, { file: fi, part: p, bytes: part.toString('base64') }); assert.equal(u.status, 200, JSON.stringify(u.data));
 }
 return r.data.id;
}
const run = async (who = ai) => workJob(who, { log: () => {} });
try {
 ok(sandboxReady(), 'the sandbox runs on this server');
 // 1. Who.
 eq((await call('finance/agent', undefined, 'staff')).status, 403, 'a staff member without Finance cannot open the AI analyst');
 eq((await call('finance/agent/review', { ids: [randomUUID()], decision: 'confirm' }, 'staff')).status, 403, 'nor confirm a line');
 let r = await call('finance/agent');
 eq([r.status, r.data.canWrite, r.data.canPublish, r.data.agents.map((a) => a.id)], [200, true, true, [R.ai]], 'leadership sees it, may publish, and the Finance AI employee is listed');
 eq((await call('finance/agent', undefined, 'fin')).data.canPublish, false, 'the Finance role checks lines but does not publish skills');
 eq((await call('finance/agent/jobs', { agentId: R.ai2, files: [{ name: 'a.csv', size: 10, parts: 1 }] })).status, 400, 'an AI employee without Finance & billing takes no finance job');

 // 2. The fast reply in a chat: the founder sends two statements to the AI employee directly.
 const ch = (await call('chats/direct', { personId: R.ai })).data.id; ok(ch, 'a direct chat with the AI employee');
 const att = [];
 for (const n of ['hdfc-EXMP1234-apr-jun-2026.csv', 'broken-coop-EXMP1357.csv']) { const f = await call(`chats/${ch}/files`, { name: n, mime: 'text/csv', bytes: (await bytes(n)).toString('base64') }); att.push({ id: f.data.id, name: n, mime: 'text/csv', size: (await bytes(n)).length }); }
 const msg = (await call(`chats/${ch}/messages`, { body: 'Here are the April statements, please reconcile', attachments: att, clientId: randomUUID() })).data.id; ok(msg, 'the message with two files');
 ok(financeAsk({ body: 'Here are the April statements, please reconcile', files: att }, ['billing']), 'it reads as a finance job');
 eq(financeAsk({ body: 'our logo', files: [{ id: att[0].id, name: 'logo.pdf' }] }, ['billing']), null, 'a logo PDF is not a statement');
 eq(financeAsk({ body: '', files: att }, ['chats']), null, 'without Finance & billing it is not its job');
 const opened = await ai.call('POST', '/api/v0/agent/jobs', { kind: 'fin.ingest', title: 'Reading 2 files', channelId: ch, sourceMessageId: msg, files: att.map((a) => a.id), clientId: randomUUID() });
 ok(opened.id && opened.statusMessageId && opened.files === 2, 'the job opened at once with both files');
 let status = (await own('select body from pulse.chat_message where id=$1', [opened.statusMessageId]))[0].body;
 ok(/^⏳ Reading 2 files\nGot it\. Give me a few seconds/.test(status), `the fast reply is in the chat: ${status}`);
 eq((await other.call('POST', '/api/v0/agent/jobs/claim', { kinds: ['fin.ingest'] })).job, null, 'another AI employee cannot take it');
 await assert.rejects(other.call('POST', '/api/v0/agent/jobs', { kind: 'fin.ingest', title: 'x', channelId: ch, files: [], clientId: randomUUID() }), /colleagues|not switched on/, 'nor open a job in a chat it is not in');
 eq(await run(), opened.id, 'the worker takes the chat job');
 let job = (await call(`finance/agent/jobs/${opened.id}`)).data;
 eq([job.status, job.progress], ['done', 100], `the job is done: ${job.error ?? ''}`);
 ok(job.steps.length >= 2 && job.seconds > 0, 'with its steps and time');
 status = (await own('select body,edited_at from pulse.chat_message where id=$1', [opened.statusMessageId]))[0];
 ok(status.edited_at && /^✅ Reading 2 files\nRead 2 files, /.test(status.body) && /Finance → AI analyst/.test(status.body), `the same message now says what it found: ${status.body}`);
 ok(job.result.files.find((f) => f.name.startsWith('broken')).parser === 'fallback', 'the export the standard import refused was read by the fallback');

 // 3. All eight statements from the page (the chat's two again: nothing twice).
 const all = names.filter((n) => !n.startsWith('large'));
 const jid = await startJob(all, 'All the statements');
 eq((await call(`finance/agent/jobs/${jid}`)).data.status, 'queued', 'every part arrived: queued');
 eq(await run(), jid, 'the worker takes it');
 job = (await call(`finance/agent/jobs/${jid}`)).data;
 eq(job.status, 'done', job.error ?? '');
 eq(job.result.files.length, 8, 'eight files');
 ok(job.result.files.every((f) => f.ok), 'all read');
 eq(job.result.totals.duplicates, 80, 'the overlapping HDFC months counted once');
 const kept = (await own('select count(*)::int n from pulse.fin_review_item where org_id=$1', [ORG]))[0].n;
 eq(kept, job.result.totals.rows, 'every line is in Pulse once (the chat job\'s lines were not added again)');
 ok(job.rowsOut < job.result.totals.rows, 'this job added only the new ones');
 r = await call('finance/agent/review?flag=unclear_category');
 ok(r.data.total > 0 && r.data.groups.some((g) => /Ravi Synthetic/.test(g.who)), 'unclear lines grouped by who was paid');
 r = await call('finance/agent/review?flag=missing_document'); ok(r.data.total > 0, 'missing bills and invoices are flagged');
 r = await call('finance/agent'); const parsers = r.data.skills.filter((s) => s.kind === 'parser');
 ok(parsers.length >= 4 && parsers.every((s) => s.status === 'proposed'), 'parser skills are proposed for the layouts it worked out');
 const hdfc = parsers.find((s) => s.name.startsWith('parser-hdfc'));
 eq([hdfc.testResult.passed > 0, hdfc.testResult.failed], [true, 0], 'with their tests passed in the sandbox');
 eq((await ai.call('GET', `/api/v0/agent/jobs/${jid}/context?lease=${randomUUID()}`).catch((e) => e.status)), 403, 'a finished job is nobody\'s to work on');

 // 4. People decide; the AI learns.
 const fb = (await call('finance/agent/review?q=facebook')).data.groups.find((g) => /Facebook/.test(g.who) && g.direction === 'out');
 const before = (await own("select count(*)::int n from pulse_priv.money_observation where org_id=$1 and dataset='money_sheet_transactions'", [ORG]))[0].n;
 r = await call('finance/agent/review', { who: fb.who, direction: 'out', decision: 'confirm' });
 eq([r.status, r.data.changed, r.data.saved], [200, fb.lines, fb.lines], 'one tap confirms the whole Facebook group and saves it');
 const after = (await own("select count(*)::int n from pulse_priv.money_observation where org_id=$1 and dataset='money_sheet_transactions'", [ORG]))[0].n;
 eq(after - before, fb.lines, 'through the standard statement import (Finance → Data sources)');
 const ravi = (await call('finance/agent/review?q=ravi')).data.groups.find((g) => /Ravi Synthetic/.test(g.who));
 r = await call('finance/agent/review', { who: ravi.who, direction: ravi.direction, decision: 'confirm', category: 'Freelancers' }, 'fin');
 eq(r.status, 403, 'the Finance role without the Money permission cannot save bank lines');
 r = await call('finance/agent/review', { who: ravi.who, direction: ravi.direction, decision: 'confirm', category: 'Freelancers' });
 eq(r.data.changed, ravi.lines, 'leadership confirms them as Freelancers');
 const myst = (await call('finance/agent/review?q=mystery')).data.groups[0];
 r = await call('finance/agent/review', { who: myst.who, direction: myst.direction, decision: 'set_aside' }, 'fin');
 eq(r.data.changed, myst.lines, 'the Finance role sets a group aside');
 eq((await call('finance/agent/review', { who: myst.who, direction: myst.direction, decision: 'reopen' }, 'fin')).data.changed, myst.lines, 'and brings it back');
 eq((await call(`finance/agent/skills/${hdfc.id}`, { publish: true }, 'fin')).status, 403, 'the Finance role cannot publish a skill');
 const [broken] = await own("select s.id from pulse.agent_skill s where s.org_id=$1 and s.kind='parser' and s.name<>$2 limit 1", [ORG, hdfc.name]);
 await own("update pulse.agent_skill_version set test_result='{\"passed\":1,\"failed\":1}' where skill_id=$1", [broken.id]);
 eq((await call(`finance/agent/skills/${broken.id}`, { publish: true })).status, 400, 'a skill whose tests fail is not published');
 r = await call(`finance/agent/skills/${hdfc.id}`, { publish: true });
 eq([r.status, r.data.status], [200, 'published'], 'leadership publishes the HDFC parser');
 // The next HDFC statement (a new account's file, same layout) is read by the skill; the learned rules sort Ravi.
 await writeFile(join(dir, 'hdfc-EXMP7777-aug-2026.csv'), (await bytes('hdfc-EXMP1234-may-jul-2026.csv')).toString().replace(/EXMP0001234/g, 'EXMP0007777'));
 names.push('hdfc-EXMP7777-aug-2026.csv');
 const j3 = await startJob(['hdfc-EXMP7777-aug-2026.csv'], 'Next month');
 eq(await run(), j3, 'the worker takes the next statement');
 job = (await call(`finance/agent/jobs/${j3}`)).data;
 eq(job.result.files[0].parser, `skill:${hdfc.name}@1`, 'the published parser read it, no guessing');
 eq(job.rowsOut, 160, 'another account\'s statement (named with the same year) adds every one of its lines: the account comes from the statement, not the year in its name');
 r = await call(`finance/agent/skills/${hdfc.id}`);
 eq([r.data.uses, r.data.modelCallsSaved, r.data.linesHandled > 0], [1, 1, true], 'its use and the model call it saved are counted');
 const learned = (await call('finance/agent')).data.skills.find((s) => s.name === 'categoriser-learned');
 ok(learned && learned.status === 'proposed' && learned.testResult.failed === 0, 'rules from people\'s decisions are proposed, tested');
 eq((await call(`finance/agent/skills/${learned.id}`, { publish: true })).data.status, 'published', 'and published');
 await writeFile(join(dir, 'hdfc-EXMP8888-next.csv'), (await bytes('hdfc-EXMP1234-may-jul-2026.csv')).toString().replace(/EXMP0001234/g, 'EXMP0008888'));
 names.push('hdfc-EXMP8888-next.csv');
 const j4 = await startJob(['hdfc-EXMP8888-next.csv'], 'Another account');
 eq(await run(), j4, 'the worker takes it');
 const raviNow = (await own("select category,flags,source from pulse.fin_review_item where org_id=$1 and job_id=$2 and counterparty ilike 'ravi%'", [ORG, j4]));
 ok(raviNow.length > 0 && raviNow.every((x) => x.category === 'Freelancers' && !x.flags.includes('unclear_category') && /categoriser-learned@/.test(x.source)), 'Ravi\'s lines are sorted by what people decided, with no unclear flag');
 job = (await call(`finance/agent/jobs/${j4}`)).data;
 ok(Object.keys(job.skillsUsed).some((k) => k.startsWith('categoriser-learned@')) && job.modelCalls === 0, 'learned skills used, no model call');

 // 5. Again: nothing twice.
 const j5 = await startJob(['sbi-EXMP4321-2026.csv'], 'SBI again'); eq(await run(), j5, 'the worker takes it');
 eq((await call(`finance/agent/jobs/${j5}`)).data.rowsOut, 0, 'the same statement again adds nothing');
 // Isolation: the other AI employee's key sees none of this AI employee's lines or jobs.
 eq((await own('select count(*)::int n from pulse.agent_job where org_id=$1 and agent_id=$2', [ORG, R.ai2]))[0].n, 0, 'the other AI employee has no jobs');
 const ovw = (await call('finance/agent')).data;
 ok(ovw.week.jobs >= 5 && ovw.week.lines > 0 && ovw.jobs.length >= 5, 'the page shows the week\'s jobs with lines and time');
 await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks, lines: kept, jobs: ovw.week.jobs }));
 console.log(`fin-agent: ${checks} checks`);
} finally { await app.close(); await pool.end(); await owner.end(); }
void openFinanceJob;
