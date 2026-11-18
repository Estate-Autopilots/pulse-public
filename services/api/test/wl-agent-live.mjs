// WL-DOCS live walk (tests/core/test_wl_agent_live.py, PULSE_WLA_LIVE=1): a salesperson and the owner work with two AI
// employees set up as Willow Lane's are after their upgrade, on a synthetic copy of Willow Lane. The API of this checkout
// runs in-process on a scratch database and the real AI runtime (services/coworker/runner.mjs) answers on this server's
// subscriptions. Every turn is timed; walk.json goes into PULSE_WLA_OUT. Every person, client, product and price is
// invented; nothing leaves the server.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const E = process.env;
const pool = new Pool(JSON.parse(E.TEST_API_CONFIG)), own = new Pool(JSON.parse(E.TEST_OWNER_CONFIG));
const app = createApp(pool, pool);
const OUT = E.PULSE_WLA_OUT; await mkdir(OUT, { recursive: true });
const ORG = E.TEST_ORG, OWNER = { email: E.TEST_ADMIN_EMAIL, id: E.TEST_ADMIN_ID };
const SALES = JSON.parse(E.TEST_SALES), AGENTS = JSON.parse(E.TEST_AGENTS);
const SUITE = JSON.parse(readFileSync(new URL('../../../tests/core/wl_quote_live_scenarios.json', import.meta.url), 'utf8'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const origin = await app.listen({ host: '127.0.0.1', port: 0 });

async function q(sql, args = []) {
  const c = await own.connect();
  try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [ORG]); const r = await c.query(sql, args); await c.query('commit'); return r.rows; }
  catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}
async function call(who, path, body) {
  const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': who }, ...(body === undefined ? {} : { payload: body }) });
  assert.ok(r.statusCode < 300, `${path}: ${r.statusCode} ${r.body.slice(0, 300)}`);
  return r.headers['content-type']?.includes('json') ? r.json() : r.rawPayload;
}

// --- the synthetic Willow Lane: billing and its catalogue -------------------------------------------------------------------
await call(OWNER.email, 'erp/settings', { company: { legalName: 'Willow Lane Synthetic Energy LLP', tradeName: 'Willow Lane (synthetic)', gstin: '27AAXFV2138F1ZR',
  address: ['Unit 4, Synthetic Solar Park', 'Pune 411045, Maharashtra'], email: 'billing@willowlane-synthetic.example', phone: '+91 90000 00000' }, dueDays: 15, roundTotal: true, quoteApproval: true });
for (const [code, name, rupees, gst, kind, hsn] of SUITE.catalogue) await call(OWNER.email, 'erp/items', { kind, code, name, sac: hsn, unit: 'nos', price: rupees * 100, gstRate: gst, status: 'active' });

// --- the runtime ------------------------------------------------------------------------------------------------------------
const cfg = join(OUT, 'coworker.json');
await writeFile(cfg, JSON.stringify({ pulse: origin, poll: 2, agents: AGENTS.map((a) => ({ username: a.username, keyFile: a.keyFile })) }));
const runtime = spawn(process.execPath, ['services/coworker/runner.mjs'], { cwd: '../..', env: { ...E, PULSE_COWORKER_CONFIG: cfg, PULSE_COWORKER_DEBUG_REFUSALS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let said = '';
runtime.stdout.on('data', (b) => { said += b; }); runtime.stderr.on('data', (b) => { said += b; });

async function reply(dm, agent, after, ms = 420000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await delay(1000)) {
    const r = await q('select body, attachments, created_at from pulse.chat_message where channel_id=$1 and author_id=$2 and created_at>$3 and removed_at is null order by created_at', [dm, agent, after]);
    const busy = await q("select count(*)::int n from pulse.agent_event e join pulse.chat_message m on m.id=e.subject_id where m.channel_id=$1 and e.state in ('queued','leased','dispatching')", [dm]);
    if (r.length && !busy[0].n) return { text: r.map((x) => x.body).join('\n---\n'), files: r.flatMap((x) => (x.attachments ?? []).map((a) => a.name ?? a.url ?? '?')), first: Math.round((new Date(r[0].created_at) - after) / 100) / 10 };
  }
  return null;
}
const turns = [];
async function say(who, agent, dm, text, label) {
  const t = new Date();
  await call(who.email, `chats/${dm}/messages`, { body: text, attachments: [], clientId: randomUUID() });
  const a = await reply(dm, agent.id, t);
  const seconds = Math.round((Date.now() - t) / 100) / 10;
  const runs = await q("select engine, engine_tier tier, route_class cls, tokens, seconds::float8 s, tools_used tools, state, error_code err, fallback_from fb from pulse.agent_run where agent_id=$1 and started_at>=$2 order by started_at", [agent.id, t]);
  turns.push({ step: label, to: agent.username, said: text, answer: a?.text ?? null, files: a?.files ?? [], seconds, firstReply: a?.first ?? null, runs });
  log(label, `${seconds}s`, (a?.text ?? '(no answer)').replace(/\s+/g, ' ').slice(0, 220));
  return a?.text ?? '';
}
const docIn = (text) => text.match(/\/erp\/documents\/([0-9a-f-]{36})/)?.[1] ?? null;

const checks = {}; let failure = null;
try {
  const seller = SALES[0], bhrata = AGENTS.find((a) => !a.finance), fin = AGENTS.find((a) => a.finance);
  const dm = (await call(seller.email, 'chats/direct', { personId: bhrata.id })).id;
  const started = new Date();

  // 1. The salesperson's morning, as Willow Lane's did on 18 Nov 2026 (11:17-11:41 IST: 24 minutes to a final quote).
  await say(seller, bhrata, dm, 'Hi', 'hello');
  const asked = await say(seller, bhrata, dm, 'Want to make quotation for 5 kw', 'quote: 5 kW, no client');
  checks.asksWhichClient = /which client|client/i.test(asked) && !docIn(asked);
  checks.offersNoColleague = !/TEST Owner WL|TEST Sales/.test(asked);
  const drafted = await say(seller, bhrata, dm, 'Client Name Mr. Tihige Synthetic, new client', 'the client named → draft');
  let qid = docIn(drafted);
  checks.drafted = !!qid;
  const tQuote = new Date();
  const submitted = await say(seller, bhrata, dm, 'Yes', 'yes → submitted');
  qid ??= docIn(submitted);
  const [doc0] = qid ? await q('select status, task_id, total::bigint total, (select json_agg(i.code) from pulse.erp_line l join pulse.erp_item i on i.id=l.item_id where l.document_id=d.id) codes from pulse.erp_document d where d.id=$1', [qid]) : [{}];
  checks.submittedToOwner = !!doc0?.task_id || /approv/i.test(submitted);
  checks.lineIsThe5kW = (doc0?.codes ?? []).includes('PP-5.0');

  // 2. The owner approves in Pulse (a person's tap; the page's own Approve), then the salesperson asks for the final one.
  const tApprove = Date.now();
  if (qid) await call(OWNER.email, `erp/documents/${qid}/issue`, { draft: null }).catch((e) => { failure = `approve: ${String(e.message).slice(0, 200)}`; });
  const approveSeconds = Math.round((Date.now() - tApprove) / 100) / 10;
  const final = await say(seller, bhrata, dm, 'Check if he have approved and give me the final quot', 'approved? → the final quote');
  const [doc1] = qid ? await q('select status, number from pulse.erp_document where id=$1', [qid]) : [{}];
  checks.quotationIssued = doc1?.status === 'issued' && !!doc1?.number;
  checks.finalAnswerHasNumberAndLink = !!doc1?.number && final.includes(doc1.number) && !!docIn(final);
  const pdf = qid ? await app.inject({ url: `/api/v0/erp/documents/${qid}/pdf`, headers: { 'cf-access-authenticated-user-email': OWNER.email } }) : null;
  checks.pdfRenders = pdf?.statusCode === 200 && pdf.rawPayload.subarray(0, 5).toString() === '%PDF-';
  checks.pdfInChat = turns.some((t) => t.files.some((f) => /\.pdf$/i.test(String(f)))) || (await q("select count(*)::int n from pulse.chat_message where channel_id=$1 and created_at>=$2 and attachments::text ilike '%.pdf%'", [dm, started]))[0].n > 0;
  const quoteSeconds = turns.filter((t) => ['the client named → draft', 'yes → submitted', 'approved? → the final quote'].includes(t.step)).reduce((n, t) => n + t.seconds, 0) + approveSeconds;

  // 3. A document, written and shared in the chat.
  const docAnswer = await say(seller, bhrata, dm, 'Make a document: site visit checklist for Mr. Tihige Synthetic, 6 short points, and show it to me', 'a document in the chat');
  const docs = await q(`select d.id, d.title, d.access, (select coalesce(json_agg(s.person_id), '[]') from pulse.doc_share s where s.doc_id=d.id) shared from pulse.doc d where d.created_by=$1 and d.created_at>=$2 order by d.created_at`, [bhrata.id, started]);
  checks.docCreated = docs.length > 0;
  checks.docSharedWithSeller = docs.some((d) => d.access !== 'private' && d.shared.includes(seller.id));
  checks.docLinkInAnswer = docs.some((d) => docAnswer.includes(`/docs/${d.id}`));
  const opened = await q("select action, state, args->>'target' target from pulse.agent_ui_action where agent_id=$1 and target_id=$2 and created_at>=$3", [bhrata.id, seller.id, started]);
  checks.docOpenedBeside = opened.some((a) => a.action === 'panel.open' && docs.some((d) => String(a.target).includes(d.id)));

  // 4. A task for a colleague is a task, never a quotation.
  const quotesBefore = (await q("select count(*)::int n from pulse.erp_document where doc_type='quotation'"))[0].n;
  const taskAnswer = await say(seller, bhrata, dm, 'Assign TEST Owner WL a task to call Mr. Tihige Synthetic tomorrow at 11 am about the 5 kW quotation', 'a task for a colleague');
  const tasks = await q('select t.title, t.assignee_person_id assignee, t.due_at from pulse.task t where t.created_at>=$1 and t.deleted_at is null and t.title not ilike $2 order by t.created_at', [started, 'Approve quotation%']);
  checks.taskCreated = tasks.some((t) => t.assignee === OWNER.id);
  checks.taskNotQuotation = (await q("select count(*)::int n from pulse.erp_document where doc_type='quotation'"))[0].n === quotesBefore && !docIn(taskAnswer);

  // 5. The finance AI employee, for the owner: what is there, and the invoice draft from the approved quotation.
  const fdm = (await call(OWNER.email, 'chats/direct', { personId: fin.id })).id;
  const listed = await say({ email: OWNER.email }, fin, fdm, 'Which quotations do we have this month, and is anything waiting for my approval?', 'finance: quotations this month');
  checks.financeListsTheQuote = !!doc1?.number && listed.includes(doc1.number);
  const invAnswer = await say({ email: OWNER.email }, fin, fdm, `Make the invoice draft from quotation ${doc1?.number ?? ''} for Mr. Tihige Synthetic`, 'finance: invoice draft');
  const invoices = await q("select id, status, source_id from pulse.erp_document where doc_type='invoice' and created_at>=$1", [started]);
  checks.invoiceDrafted = invoices.some((i) => i.source_id === qid && i.status === 'draft');
  checks.invoiceLinkInAnswer = invoices.some((i) => invAnswer.includes(i.id));

  const refused = said.split('\n').filter((l) => /refused|was refused|failed/i.test(l)).map((l) => l.slice(0, 300));
  const walk = { at: new Date().toISOString(), config: { provider: E.PULSE_WLA_PROVIDER ?? 'claude', model: E.PULSE_WLA_MODEL ?? 'claude-opus-5-5', effort: 'high', lane: 'thinking' },
    checks, quoteToFinalSeconds: Math.round(quoteSeconds * 10) / 10, approveSeconds, askToSubmittedSeconds: Math.round((Date.now() - tQuote) / 1000) && turns.find((t) => t.step === 'yes → submitted')?.seconds,
    quotation: { id: qid, ...doc1, total: Number(doc0?.total ?? 0), codes: doc0?.codes ?? [] }, docs: docs.map((d) => ({ title: d.title, access: d.access, shared: d.shared.length })), tasks, invoices: invoices.length,
    turns, refused, failure };
  await writeFile(join(OUT, 'walk.json'), JSON.stringify(walk, null, 1));
  await writeFile(join(OUT, 'runtime.log'), said.slice(-200000));
  log('checks', JSON.stringify(checks));
} finally {
  runtime.kill('SIGTERM');
  await delay(500);
  await app.close().catch(() => {});
  await pool.end(); await own.end();
}
