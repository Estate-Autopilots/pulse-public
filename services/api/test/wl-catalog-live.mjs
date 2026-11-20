// WL-CATALOG-2 live walk (tests/core/test_wl_catalog_live.py, PULSE_WLA_LIVE=1): right after the owner imports 5 NEW
// items with Billing → Catalogue → Import a price list (preview, then import), a salesperson asks bhrātā in plain words
// for a quotation with them, and says yes. Billing is set as Willow Lane's is in production (18 Nov 2026): no approval
// step (quote_approval off), and an AI employee's quotation at catalogue prices is approved by the rule up to ₹10 lakh.
// The API of this checkout runs in-process on a scratch database; the real AI runtime (services/coworker/runner.mjs)
// answers on this server's subscriptions. walk.json goes into PULSE_WLA_OUT. Every person, client, product and price is
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

// The 5 new items: the kinds Willow Lane's catalogue does not have yet (WL-CATALOG report, section 4). Invented prices.
const NEW = [
  { name: 'Solar panel 540 Wp mono PERC', unit: 'nos', rate: '11,111', gst: '5', sac: '85414300', qty: 10 },
  { name: 'Module mounting structure (per panel)', unit: 'nos', rate: '2,222', gst: '18', sac: '73089090', qty: 10 },
  { name: 'Net metering application', unit: 'nos', rate: '3,333', gst: '18', sac: '998399', qty: 1 },
  { name: 'Earthing kit', unit: 'set', rate: '5,555', gst: '18', sac: '85359090', qty: 1 },
  { name: 'Lightning arrester', unit: 'nos', rate: '4,444', gst: '18', sac: '85354010', qty: 1 },
];
// PULSE_WLC_ASK: the same request in other words (e.g. Hinglish); the quantities must stay as in NEW.
const ASK = E.PULSE_WLC_ASK || 'Make quotation for Mr. Ramesh Synthetic, new client, Pune: 10 solar panels 540 Wp, 10 mounting structures, net metering application, 1 earthing kit and 1 lightning arrester';

async function q(sql, args = []) {
  const c = await own.connect();
  try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [ORG]); const r = await c.query(sql, args); await c.query('commit'); return r.rows; }
  catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}
const inject = (who, path, body) => app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-authenticated-user-email': who }, ...(body === undefined ? {} : { payload: body }) });
async function call(who, path, body) {
  const r = await inject(who, path, body);
  assert.ok(r.statusCode < 300, `${path}: ${r.statusCode} ${r.body.slice(0, 300)}`);
  return r.headers['content-type']?.includes('json') ? r.json() : r.rawPayload;
}

// --- the synthetic Willow Lane, billing set as production's ----------------------------------------------------------------
await call(OWNER.email, 'erp/settings', { company: { legalName: 'Willow Lane Synthetic Energy LLP', tradeName: 'Willow Lane (synthetic)', gstin: '27AAXFV2138F1ZR',
  address: ['Unit 4, Synthetic Solar Park', 'Pune 411045, Maharashtra'], email: 'billing@willowlane-synthetic.example', phone: '+91 90000 00000' }, dueDays: 15, roundTotal: true,
  quoteApproval: false, quoteAutoApprove: true, quoteAutoLimit: 100000000 });
for (const [code, name, rupees, gst, kind, hsn] of SUITE.catalogue) await call(OWNER.email, 'erp/items', { kind, code, name, sac: hsn, unit: 'nos', price: rupees * 100, gstRate: gst, status: 'active' });

const checks = {}; let failure = null;
const turns = [];
let said = '', runtime = null;
try {
  // --- 1. the import, as the screen does it ------------------------------------------------------------------------------
  const rows = NEW.map(({ name, unit, rate, gst, sac }) => ({ name, unit, rate, gst, sac }));
  const seller = SALES[0], bhrata = AGENTS.find((a) => !a.finance);
  const sellerTry = await inject(seller.email, 'erp/catalog/import', { fileName: 'Synthetic price list', rows, dryRun: true });
  checks.sellerCannotImport = sellerTry.statusCode === 403;
  const preview = await call(OWNER.email, 'erp/catalog/import', { fileName: 'Synthetic price list (WL-CATALOG-2)', rows, dryRun: true });
  checks.previewFiveNew = preview.created === 5 && preview.updated === 0 && preview.skipped.length === 0;
  const imp = await call(OWNER.email, 'erp/catalog/import', { fileName: 'Synthetic price list (WL-CATALOG-2)', rows });
  const made = await q("select id::text, name, price::bigint price, gst_rate::float8 gst, sac, kind, status from pulse.erp_item where source->>'batch'=$1 order by name", [imp.batch]);
  checks.fiveImportedActive = made.length === 5 && made.every((m) => m.status === 'active');
  log('import', imp.batch, made.map((m) => `${m.name} ₹${m.price / 100} ${m.gst}% ${m.sac} ${m.kind} ${m.status}`).join(' | '));

  // --- 2. the runtime, and the salesperson's chat ------------------------------------------------------------------------
  const cfg = join(OUT, 'coworker.json');
  await writeFile(cfg, JSON.stringify({ pulse: origin, poll: 2, agents: AGENTS.map((a) => ({ username: a.username, keyFile: a.keyFile })) }));
  runtime = spawn(process.execPath, ['services/coworker/runner.mjs'], { cwd: '../..', env: { ...E, PULSE_COWORKER_CONFIG: cfg, PULSE_COWORKER_DEBUG_REFUSALS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  runtime.stdout.on('data', (b) => { said += b; }); runtime.stderr.on('data', (b) => { said += b; });

  async function reply(dm, agent, after, ms = 420000) {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await delay(1000)) {
      const r = await q('select body, attachments, created_at from pulse.chat_message where channel_id=$1 and author_id=$2 and created_at>$3 and removed_at is null order by created_at', [dm, agent, after]);
      const busy = await q("select count(*)::int n from pulse.agent_event e join pulse.chat_message m on m.id=e.subject_id where m.channel_id=$1 and e.state in ('queued','leased','dispatching')", [dm]);
      if (r.length && !busy[0].n) return { text: r.map((x) => x.body).join('\n---\n'), files: r.flatMap((x) => (x.attachments ?? []).map((a) => a.name ?? a.url ?? '?')), first: Math.round((new Date(r[0].created_at) - after) / 100) / 10 };
    }
    return null;
  }
  async function say(who, agent, dm, text, label) {
    const t = new Date();
    await call(who.email, `chats/${dm}/messages`, { body: text, attachments: [], clientId: randomUUID() });
    const a = await reply(dm, agent.id, t);
    const seconds = Math.round((Date.now() - t) / 100) / 10;
    const runs = await q('select engine, engine_tier tier, route_class cls, tokens, seconds::float8 s, tools_used tools, state, error_code err, fallback_from fb from pulse.agent_run where agent_id=$1 and started_at>=$2 order by started_at', [agent.id, t]);
    turns.push({ step: label, to: agent.username, said: text, answer: a?.text ?? null, files: a?.files ?? [], seconds, firstReply: a?.first ?? null, runs });
    log(label, `${seconds}s`, (a?.text ?? '(no answer)').replace(/\s+/g, ' ').slice(0, 300));
    return a?.text ?? '';
  }
  const docIn = (text) => text.match(/\/erp\/documents\/([0-9a-f-]{36})/)?.[1] ?? null;
  const linesOf = (id) => q(`select l.position, l.description, l.qty::float8 qty, l.rate::bigint rate, coalesce(l.discount_percent,0)::float8 + l.discount::float8 disc, l.item_id::text item, i.price::bigint catalogue, i.name item_name, i.code
      from pulse.erp_line l left join pulse.erp_item i on i.id=l.item_id where l.document_id=$1 order by l.position`, [id]);

  const dm = (await call(seller.email, 'chats/direct', { personId: bhrata.id })).id;
  const started = new Date();
  const drafted = await say(seller, bhrata, dm, ASK, 'the 5 new items, client named → draft');
  let qid = docIn(drafted) ?? (await q("select id::text from pulse.erp_document where doc_type='quotation' and created_at>=$1 order by created_at desc limit 1", [started]))[0]?.id ?? null;
  checks.drafted = !!qid;
  const lines0 = qid ? await linesOf(qid) : [];
  const ids = new Set(made.map((m) => m.id));
  checks.allFiveOnTheQuote = NEW.every((n) => lines0.some((l) => l.item_name === n.name));
  checks.newLinesAtCataloguePrice = lines0.filter((l) => ids.has(l.item)).every((l) => Number(l.rate) === Number(l.catalogue) && !l.disc);
  checks.qtyAsAsked = NEW.every((n) => lines0.some((l) => l.item_name === n.name && l.qty === n.qty));
  checks.everyLineACatalogueItem = lines0.length > 0 && lines0.every((l) => !!l.item);
  checks.noPriceInvented = lines0.every((l) => l.item && Number(l.rate) === Number(l.catalogue));

  const yes = await say(seller, bhrata, dm, 'Yes, submit it', 'yes → submitted');
  qid ??= docIn(yes);
  const [doc] = qid ? await q("select status, number, total::bigint total, (select count(*)::int from pulse.erp_event e where e.subject_id=d.id and e.kind='approved_by_rule') by_rule from pulse.erp_document d where d.id=$1", [qid]) : [{}];
  checks.issuedByRule = doc?.status === 'issued' && !!doc?.number && doc?.by_rule > 0;
  checks.numberInAnswer = !!doc?.number && (yes.includes(doc.number) || drafted.includes(doc.number));
  const pdf = qid ? await inject(OWNER.email, `erp/documents/${qid}/pdf`) : null;
  checks.pdfRenders = pdf?.statusCode === 200 && pdf.rawPayload.subarray(0, 5).toString() === '%PDF-';
  await delay(5000); // QUOTE-FAST posts the filed PDF into the chat after the approval
  checks.pdfInChat = (await q("select count(*)::int n from pulse.chat_message where channel_id=$1 and created_at>=$2 and attachments::text ilike '%.pdf%'", [dm, started]))[0].n > 0;

  // --- 3. Undo of the import after the quotation: the items are archived, the issued quotation keeps its lines ------------
  const undone = await call(OWNER.email, `erp/catalog/imports/${imp.batch}/undo`, {});
  const after = await q("select count(*) filter (where status='archived')::int archived from pulse.erp_item where source->>'batch'=$1", [imp.batch]);
  const lines1 = qid ? await linesOf(qid) : [];
  checks.undoArchivesFive = undone.archived === 5 && after[0].archived === 5;
  checks.quoteKeepsLinesAfterUndo = lines1.length === lines0.length && lines1.every((l, i) => l.description === lines0[i].description && Number(l.rate) === Number(lines0[i].rate));

  const refused = said.split('\n').filter((l) => /refused|was refused|failed/i.test(l)).map((l) => l.slice(0, 300));
  const walk = { at: new Date().toISOString(), config: { provider: E.PULSE_WLA_PROVIDER ?? 'claude', model: E.PULSE_WLA_MODEL ?? 'claude-opus-5-5', effort: 'high', lane: 'thinking' },
    billing: { quoteApproval: false, quoteAutoApprove: true, quoteAutoLimit: 100000000 }, import: { batch: imp.batch, preview: { created: preview.created, updated: preview.updated, skipped: preview.skipped.length }, made }, undo: undone,
    checks, quotation: { id: qid, ...doc, total: Number(doc?.total ?? 0), lines: lines0.map((l) => `${l.qty} × ${l.description} @ ₹${l.rate / 100} (catalogue ₹${l.catalogue / 100})${l.disc ? ` −${l.disc}%` : ''} [${l.code ?? 'imported'}]`) },
    turns, refused, failure };
  await writeFile(join(OUT, 'walk.json'), JSON.stringify(walk, null, 1));
  log('checks', JSON.stringify(checks));
} catch (e) {
  failure = String(e?.stack ?? e).slice(0, 2000);
  await writeFile(join(OUT, 'walk.json'), JSON.stringify({ at: new Date().toISOString(), checks, turns, failure }, null, 1));
  throw e;
} finally {
  await writeFile(join(OUT, 'runtime.log'), said.slice(-200000)).catch(() => {});
  runtime?.kill('SIGTERM');
  await delay(500);
  await app.close().catch(() => {});
  await pool.end(); await own.end();
}
