// WL-QUOTE-LIVE suite (tests/core/test_wl_quote_live_suite.py, PULSE_WLQ_LIVE=1): scripted salesperson conversations with
// Bharata on a synthetic copy of Willow Lane. The API of this checkout runs in-process on a scratch database, the real AI
// runtime (services/coworker/runner.mjs) answers on this server's subscriptions, and voice turns are TTS audio sent as
// chat voice notes, transcribed by the server's own Whisper worker (tools/voice-transcribe.py). Each conversation is
// scored: client, items, prices, total, GST, approval, PDF. Writes runs.json (and the transcripts it heard) into
// PULSE_WLQ_OUT. Every person, client, product and price is invented; nothing leaves the server.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { computeDocument } from '@pulse/invoice-doc';

const E = process.env;
const pool = new Pool(JSON.parse(E.TEST_API_CONFIG)), own = new Pool(JSON.parse(E.TEST_OWNER_CONFIG));
const app = createApp(pool, pool);
const OUT = E.PULSE_WLQ_OUT; await mkdir(OUT, { recursive: true });
const ORG = E.TEST_ORG, OWNER = { email: E.TEST_ADMIN_EMAIL, id: E.TEST_ADMIN_ID };
const SALES = JSON.parse(E.TEST_SALES), AGENTS = JSON.parse(E.TEST_AGENTS);
const SUITE = JSON.parse(readFileSync(new URL('../../../tests/core/wl_quote_live_scenarios.json', import.meta.url), 'utf8'));
const ONLY = E.PULSE_WLQ_ONLY ? new RegExp(E.PULSE_WLQ_ONLY) : null, AUDIO = E.PULSE_WLQ_AUDIO ?? '';
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

// --- the synthetic Willow Lane: billing, catalogue, three existing clients with an approved quotation each ----------------
await call(OWNER.email, 'erp/settings', { company: { legalName: 'Willow Lane Synthetic Energy LLP', tradeName: 'Willow Lane (synthetic)', gstin: '27AAXFV2138F1ZR',
  address: ['Unit 4, Synthetic Solar Park', 'Pune 411045, Maharashtra'], email: 'billing@willowlane-synthetic.example', phone: '+91 90000 00000' }, dueDays: 15, roundTotal: true, quoteApproval: true });
const ITEM = {}, CODE = {};
for (const [code, name, rupees, gst, kind, hsn] of SUITE.catalogue) {
  const id = (await call(OWNER.email, 'erp/items', { kind, code, name, sac: hsn, unit: 'nos', price: rupees * 100, gstRate: gst, status: 'active' })).id;
  ITEM[code] = { id, name, price: rupees * 100, gst, hsn }; CODE[id] = code;
}
const rate = (code, r) => (r === null || r === undefined ? ITEM[code].price : r * 100);
const docLines = (lines) => Object.entries(lines).map(([code, [qty, r, disc]]) => ({ itemId: ITEM[code].id, description: ITEM[code].name, sac: ITEM[code].hsn, unit: 'nos', qty, rate: rate(code, r), gstRate: ITEM[code].gst, ...(disc ? { discountPercent: disc } : {}) }));
const CLIENT = {}; let WARM_DOC = null;
for (const c of SUITE.existing) {
  const id = (await call(OWNER.email, 'erp/documents', { docType: 'quotation', buyer: { name: c.name, phone: c.phone } })).id;
  const d = await call(OWNER.email, `erp/documents/${id}`);
  await call(OWNER.email, `erp/documents/${id}`, { ...d.document, lines: docLines(c.lines) });
  await call(OWNER.email, `erp/documents/${id}/issue`, { draft: null }).catch((e) => log('issue existing', c.name, String(e.message).slice(0, 160)));
  const [row] = await q('select client_id from pulse.erp_document where id=$1', [id]);
  CLIENT[c.name] = row?.client_id ?? null; WARM_DOC = id; log('existing client', c.name, CLIENT[c.name]);
}

// --- the runtime (every Bharata copy) and the server's own Whisper worker -------------------------------------------------
const cfg = join(OUT, 'coworker.json');
await writeFile(cfg, JSON.stringify({ pulse: origin, poll: 2, agents: AGENTS.map((a) => ({ username: a.username, keyFile: a.keyFile })) }));
const runtime = spawn(process.execPath, ['services/coworker/runner.mjs'], { cwd: '../..', env: { ...E, PULSE_COWORKER_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
let said = ''; const { appendFileSync } = await import('node:fs');
const seen = (b) => { said += b; for (const l of String(b).split('\n')) if (/refused|failed|budget/i.test(l)) appendFileSync(join(OUT, 'refusals.log'), l + '\n'); };
runtime.stdout.on('data', seen); runtime.stderr.on('data', seen);
// BHARATA-2: with the Hindi/Marathi engines (CHAT-VOICE-FIX's onnx-asr); without them hi/mr notes are never clear.
const whisper = spawn('uv', ['run', '--quiet', '--no-project', '--with', 'psycopg[binary]', '--with', 'faster-whisper', '--with', 'numpy', '--with', 'onnx-asr', '--with', 'huggingface-hub', 'python', 'tools/voice-transcribe.py'],
  { cwd: '../..', env: { ...E, PULSE_DATABASE_URL_WORKER: E.TEST_WORKER_DSN, PULSE_VOICE_THREADS: E.PULSE_VOICE_THREADS ?? '2' }, stdio: ['ignore', 'pipe', 'pipe'] });
let heardLog = ''; whisper.stdout.on('data', (b) => { heardLog += b; }); whisper.stderr.on('data', (b) => { heardLog += b; });
// Listening: the server's own listen worker (tools/listen-transcribe.py, its production model "small"), for listen turns.
const listener = SUITE.scenarios.some((x) => x.mode === 'listen' && (!ONLY || ONLY.test(x.id))) ? spawn('uv', ['run', '--quiet', '--no-project', '--with', 'psycopg[binary]', '--with', 'faster-whisper', '--with', 'numpy', 'python', 'tools/listen-transcribe.py'],
  { cwd: '../..', env: { ...E, PULSE_DATABASE_URL_WORKER: E.TEST_WORKER_DSN, PULSE_LISTEN_THREADS: E.PULSE_VOICE_THREADS ?? '2' }, stdio: ['ignore', 'pipe', 'pipe'] }) : null;
listener?.stdout.on('data', (b) => { heardLog += b; }); listener?.stderr.on('data', (b) => { heardLog += b; });

// --- one conversation ---------------------------------------------------------------------------------------------------
async function reply(dm, agent, after, ms = 300000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await delay(1500)) {
    const r = await q("select body, created_at from pulse.chat_message where channel_id=$1 and author_id=$2 and created_at>$3 and removed_at is null order by created_at", [dm, agent, after]);
    // The answer is in once its run is over (the early "Draft quotation ready" note comes before the final answer).
    const busy = await q("select count(*)::int n from pulse.agent_event e join pulse.chat_message m on m.id=e.subject_id where m.channel_id=$1 and e.state in ('queued','leased','dispatching')", [dm]);
    if (r.length && !busy[0].n) return r.map((x) => x.body).join('\n---\n');
  }
  return null;
}
async function voiceTurn(who, dm, file) {
  const bytes = readFileSync(file).toString('base64');
  const f = await call(who, `chats/${dm}/files`, { name: 'Voice message.ogg', mime: 'audio/ogg', bytes });
  const seconds = Math.max(1, Math.round(readFileSync(file).length / 4000));
  return call(who, `chats/${dm}/messages`, { body: '', attachments: [{ id: f.id, name: 'Voice message.ogg', mime: 'audio/ogg', voice: { seconds, peaks: [20, 50, 80, 60, 30] } }], clientId: randomUUID() });
}
const matches = (name, want) => want.split('|').some((w) => String(name ?? '').toLowerCase().replace(/\s+/g, ' ').includes(w.toLowerCase()));

async function score(s, docs, answer, dm, agent, started) {
  const r = { client: false, items: false, price: false, total: false, gst: false, approval: false, pdf: false };
  if (s.ask) {
    // No client named, or a price nobody gave: it asks, and drafts nothing at an invented price.
    const asked = s.ask === 'client' ? /which client|कौन|कोण|kis client|किस/i.test(answer ?? '') : /price|rate|कीमत|दाम|किंमत|भाव|दर/i.test(answer ?? '');
    const invented = docs.some((d) => d.lines.some((l) => !l.item_id && Number(l.rate) > 0));
    const fine = asked && !invented;
    for (const k of Object.keys(r)) r[k] = fine;
    if (s.client && s.ask === 'price') r.client = docs.length === 0 || docs.some((d) => matches(d.buyer?.name, s.client));
    return r;
  }
  const d = docs[docs.length - 1];
  if (!d) return r;
  r.client = matches(d.buyer?.name, s.client) && (s.new ? !Object.values(CLIENT).includes(d.client_id) : d.client_id === CLIENT[s.client.split('|')[0]]);
  const got = {}; for (const l of d.lines) { const c = CODE[l.item_id] ?? `free:${l.description}`; got[c] = (got[c] ?? 0) + Number(l.qty); }
  const want = Object.fromEntries(Object.entries(s.lines).map(([c, [qty]]) => [c, qty]));
  r.items = JSON.stringify(Object.entries(got).sort()) === JSON.stringify(Object.entries(want).sort());
  r.price = r.items && d.lines.every((l) => { const c = CODE[l.item_id]; const [, rr, disc] = s.lines[c]; return Number(l.rate) === rate(c, rr) && Math.abs(Number(l.discount_percent ?? 0) - (disc ?? 0)) < 0.01; })
    && (!s.reason || String(d.notes ?? '').trim().length > 3 || d.lines.some((l) => /because|repeat|advance|reason|कारण|क्योंकि/i.test(String(l.details ?? ''))));
  const exp = computeDocument({ lines: docLines(s.lines), sellerState: '27', placeOfSupply: '27', roundTotal: true });
  r.total = Number(d.total) === exp.total;
  r.gst = r.items && d.lines.every((l) => Number(l.gst_rate) === ITEM[CODE[l.item_id]]?.gst) && Number(d.tax ?? -1) === exp.tax;
  // A draft from an earlier conversation may already wait for approval: not this conversation's doing.
  r.approval = s.submit ? !!d.task_id : (!d.task_id || new Date(d.created_at) < started);
  const link = new RegExp(`/erp/documents/${d.id}`).test(answer ?? '');
  const pdf = await app.inject({ url: `/api/v0/erp/documents/${d.id}/pdf`, headers: { 'cf-access-authenticated-user-email': OWNER.email } });
  r.pdf = link && pdf.statusCode === 200 && pdf.rawPayload.subarray(0, 5).toString() === '%PDF-';
  if (s.telegram && r.approval) {
    // The owner taps ✅ Approve on the Telegram card (the bot's quote_card: …/erp/documents/<id>?do=approve), then the
    // Approve confirm on that page, which is this call; the quotation is numbered and its PDF filed.
    const card = await new Promise((done) => { const p = spawn('python3', ['-c', 'import json,sys; sys.path.insert(0,"services/workers/src"); from pulse_workers import vitals_bot as b; print(json.dumps(b.quote_card({"status":"draft","draft":True,"total":1}, sys.argv[1])[1]))', `https://app.example/erp/documents/${d.id}`], { cwd: '../..' }); let o = ''; p.stdout.on('data', (b) => { o += b; }); p.on('close', () => done(o)); });
    const button = JSON.parse(card || '{"inline_keyboard":[[{}]]}').inline_keyboard[0][0];
    let issued = false;
    if (/\?do=approve$/.test(button.url ?? '')) { await call(OWNER.email, `erp/documents/${d.id}/issue`, { draft: null }).catch((e) => log('approve', String(e.message).slice(0, 160))); issued = true; }
    const [after] = await q('select status, number, (select count(*)::int from pulse.erp_document_file f where f.document_id=d.id) files from pulse.erp_document d where d.id=$1', [d.id]).catch(() => [{}]);
    r.approval = issued && after?.status === 'issued' && !!after?.number;
    r.telegram = { button: button.text, url: button.url?.replace(/^https:\/\/app\.example/, ''), status: after?.status, number: after?.number };
  }
  return r;
}

async function conversation(s, i, w = i) {
  const who = SALES[i % SALES.length], agent = AGENTS[w % AGENTS.length];
  const dm = (await call(who.email, 'chats/direct', { personId: agent.id })).id;
  const started = new Date(); const turns = []; const heard = [];
  for (const [k, text] of s.turns.entries()) {
    const t = new Date();
    if (s.mode === 'listen') {
      // A meeting snippet heard by Listen (purpose "meeting": the quote-intent rule, not the session's purpose, asks for
      // the quotation); its transcript reaches Bharata as the salesperson's message in their chat.
      const file = join(AUDIO, `${s.id}-${k}.ogg`);
      if (!existsSync(file)) { turns.push({ said: text, error: 'no audio' }); break; }
      const bytes = readFileSync(file);
      const sess = await call(who.email, 'listen/sessions', { consent: true, title: `Synthetic site meeting ${s.id}`, purpose: 'meeting', agentId: agent.id });
      await call(who.email, `listen/sessions/${sess.id}/audio`, { seq: 0, mime: 'audio/ogg', ms: Math.max(1000, Math.round(bytes.length / 3)), audio: bytes.toString('base64') });
      await call(who.email, `listen/sessions/${sess.id}/stop`, {});
      const answer = await reply(dm, agent.id, t, 600000);
      const [h] = await q("select string_agg(text, ' ' order by seq, part) t from pulse.listen_segment where session_id=$1", [sess.id]).catch(() => [{}]);
      heard.push(h?.t ?? '(nothing heard)');
      turns.push({ said: text, answer, seconds: Math.round((Date.now() - t) / 1000), listen: true });
      if (!answer) break;
      continue;
    }
    if (s.mode === 'voice') {
      const file = join(AUDIO, `${s.id}-${k}.ogg`);
      if (!existsSync(file)) { turns.push({ said: text, error: 'no audio' }); break; }
      const m = await voiceTurn(who.email, dm, file);
      // What the server heard (the transcript the AI employee reads).
      // BHARATA-2: PULSE_WLQ_VOICE_WAIT (seconds, default 300) is how long a note may take to be heard: the Hindi/Marathi
      // engines on this busy server took 6-17 minutes (runs 4 and 6), which scored correct answers as none.
      const waits = Math.max(200, Math.round(Number(E.PULSE_WLQ_VOICE_WAIT ?? 300) / 1.5));
      for (let n = 0; n < waits; n++) { const [x] = await q("select state, body from pulse_priv.chat_voice_transcript where message_id=$1", [m.id]); if (x && ['done', 'failed'].includes(x.state)) { heard.push(x.body ?? `(${x.state})`); break; } await delay(1500); }
    } else await call(who.email, `chats/${dm}/messages`, { body: text, attachments: [], clientId: randomUUID() });
    const answer = await reply(dm, agent.id, t, s.mode === 'voice' ? Math.max(300000, Number(E.PULSE_WLQ_VOICE_WAIT ?? 300) * 1000) : 300000);
    turns.push({ said: text, answer, seconds: Math.round((Date.now() - t) / 1000) });
    if (!answer) break;
  }
  // A salesperson answers Bharata's question once (which client; the spelling of a name a voice note blurred), as a
  // person would. Not where asking is the expected answer (a missing price, no client named).
  const last = turns.at(-1)?.answer ?? '';
  if (!s.ask && last && /[?？]|did you mean|please confirm|which client|confirm (the|which)|पुष्टि|बताइए|बताएं|कृपया|बरोबर आहे|सांगा|स्पष्ट|kay aahe|kaay aahe|sanga|spashta|kya hai|bataiye|batayein/i.test(last) && !turns.some((x) => /\/erp\/documents\/[0-9a-f-]{36}/.test(x.answer ?? ''))) {
    const names = s.client.split('|'), name = s.lang === 'en' ? names[0] : names.at(-1);
    const text = s.lang === 'hi' ? `${name}${s.new ? ', नया क्लाइंट' : ''}। आगे बढ़ो।` : s.lang === 'mr' ? `${name}${s.new ? ', नवीन ग्राहक' : ''}. पुढे करा.` : `${name}${s.new ? ', a new client' : ''}. Please go ahead.`;
    const t = new Date();
    await call(who.email, `chats/${dm}/messages`, { body: text, attachments: [], clientId: randomUUID() });
    const answer = await reply(dm, agent.id, t);
    turns.push({ said: text, answer, seconds: Math.round((Date.now() - t) / 1000), followUp: true });
  }
  // Listen: Bharata drafts from the meeting and asks the listener whether to submit it (it offers, the person decides,
  // since names in a meeting come back misheard); the listener says yes once.
  const now = turns.at(-1)?.answer ?? '';
  if (s.mode === 'listen' && s.submit && /\/erp\/documents\/[0-9a-f-]{36}/.test(now) && /submit|approv|मंज़ूरी|मंजूरी|मंजुरी|सादर|जमा/i.test(now)) {
    const text = s.lang === 'hi' ? 'हाँ, मालिक को मंज़ूरी के लिए भेज दो।' : s.lang === 'mr' ? 'हो, मालकांकडे मंजुरीसाठी पाठवा.' : 'Yes, submit it to the owner for approval.';
    const t = new Date();
    await call(who.email, `chats/${dm}/messages`, { body: text, attachments: [], clientId: randomUUID() });
    turns.push({ said: text, answer: await reply(dm, agent.id, t), seconds: Math.round((Date.now() - t) / 1000), followUp: true });
  }
  const docs = await q(`select d.id, d.created_at, d.client_id, d.buyer, d.total::bigint total, (select coalesce(sum(l.cgst+l.sgst+l.igst),0) from pulse.erp_line l where l.document_id=d.id)::bigint tax, d.notes, d.task_id, d.status,
      coalesce((select json_agg(json_build_object('item_id',l.item_id,'description',l.description,'qty',l.qty,'rate',l.rate,'gst_rate',l.gst_rate,'discount_percent',l.discount_percent,'details',l.details) order by l.position) from pulse.erp_line l where l.document_id=d.id),'[]') lines
    from pulse.erp_document d where d.doc_type='quotation' and ((d.created_at>=$1 and d.created_by=$2) or d.id::text = any($3::text[])) order by d.updated_at`,
    [started, agent.id, [...new Set([...turns.map((t) => t.answer ?? '').join(' ').matchAll(/\/erp\/documents\/([0-9a-f-]{36})/g)].map((m) => m[1]))]]).catch((e) => { log('docs', e.message); return []; });
  const answer = turns.map((t) => t.answer ?? '').join('\n');
  const runs = await q('select coalesce(sum(tokens),0)::int tokens, count(*)::int n from pulse.agent_run where agent_id=$1 and started_at>=$2', [agent.id, started]);
  const sc = await score(s, docs, answer, dm, agent.id, started).catch((e) => ({ error: String(e.message).slice(0, 200) }));
  const keys = ['client', 'items', 'price', 'total', 'gst', 'approval', 'pdf'];
  const points = keys.filter((k) => sc[k] === true).length;
  const out = { id: s.id, lang: s.lang, mode: s.mode, tags: s.tags, followUp: turns.some((x) => x.followUp), score: sc, points, of: keys.length, pass: points === keys.length, heard, turns, tokens: runs[0]?.tokens ?? 0, modelRuns: runs[0]?.n ?? 0,
    seconds: Math.round((Date.now() - started) / 1000), doc: docs.at(-1) ? { id: docs.at(-1).id, buyer: docs.at(-1).buyer?.name, total: Number(docs.at(-1).total), lines: docs.at(-1).lines.map((l) => `${CODE[l.item_id] ?? l.description} ×${Number(l.qty)} @${Number(l.rate) / 100}${Number(l.discount_percent) ? ` −${Number(l.discount_percent)}%` : ''}`), drafts: docs.length } : null };
  log(s.id, out.pass ? 'PASS' : 'FAIL', `${points}/${keys.length}`, JSON.stringify(sc), `${out.seconds}s`, `${out.tokens} tokens`);
  return out;
}

// --- the recording: the owner's voice note → Bharata listening → the quotation opening beside the chat → Approve --------
async function video() {
  const { chromium } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
  const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
  const base = `http://127.0.0.1:${port}`, agent = AGENTS[0], s = SUITE.scenarios.find((x) => x.id === (E.PULSE_WLQ_VIDEO_ID ?? 'hi-11'));
  // PULSE_WLQ_WEB_DIR: a production build (next start) instead of next dev, which compiles each page on its first visit.
  const web = spawn(process.execPath, ['node_modules/next/dist/bin/next', E.PULSE_WLQ_WEB_DIR ? 'start' : 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: E.PULSE_WLQ_WEB_DIR || '../../apps/web',
    env: { ...E, PULSE_API_URL: origin, NODE_ENV: E.PULSE_WLQ_WEB_DIR ? 'production' : 'development', PULSE_PUBLIC_LOGIN_ENABLED: '0', NEXT_TELEMETRY_DISABLED: '1' }, stdio: 'ignore' });
  let browser; const v = { id: s.id };
  try {
    for (let i = 0; i < 300; i++) { try { const r = await fetch(`${base}/healthz`); if (r.status < 500) break; } catch { /* not yet */ } await delay(1000); }
    // next dev compiles a page on its first visit (minutes on a busy server): the chat and the quotation page first.
    for (const path of ['/chats', `/erp/documents/${WARM_DOC}`]) {
      const t0 = Date.now();
      for (let i = 0; i < 90; i++) { try { const r = await fetch(`${base}${path}`, { headers: { 'cf-access-authenticated-user-email': OWNER.email }, signal: AbortSignal.timeout(600000) }); if (r.status < 500) break; } catch { /* compiling */ } await delay(5000); }
      log('warm', path.split('/').slice(0, 3).join('/'), `${Math.round((Date.now() - t0) / 1000)}s`);
    }
    const dm = (await call(OWNER.email, 'chats/direct', { personId: agent.id })).id;
    // BHARATA-2: warm the voice worker first with a note between two people (no AI employee wakes): under load a cold
    // large-v3-turbo took 17 minutes to hear the recorded note (recording 7), and the recording had stopped waiting.
    const warmFile = join(AUDIO, `${E.PULSE_WLQ_WARM_ID ?? 'en-15'}-0.ogg`);
    if (existsSync(warmFile)) {
      const t0 = Date.now(), wdm = (await call(SALES[0].email, 'chats/direct', { personId: OWNER.id })).id, wm = await voiceTurn(SALES[0].email, wdm, warmFile);
      for (let n = 0; n < 1600; n++) { const [x] = await q("select state from pulse_priv.chat_voice_transcript where message_id=$1", [wm.id]); if (x && ['done', 'failed'].includes(x.state)) break; await delay(1500); }
      log('voice worker warm', `${Math.round((Date.now() - t0) / 1000)}s`);
    }
    browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', recordVideo: { dir: join(OUT, 'video'), size: { width: 1440, height: 900 } },
      extraHTTPHeaders: { 'cf-access-authenticated-user-email': OWNER.email } });
    await ctx.addInitScript(() => { localStorage.setItem('pulse.theme', 'light'); localStorage.setItem('pulse.notify.browser.asked', '1'); });
    const page = await ctx.newPage(); page.on('pageerror', (e) => log('page error', e.message.slice(0, 160)));
    await page.goto(`${base}/chats?channel=${dm}`, { waitUntil: 'load', timeout: 900000 }); await page.waitForTimeout(5000);
    const shot = (n) => page.screenshot({ path: join(OUT, `video-${n}.png`) }).catch(() => {});
    await shot('01-chat');
    const t = new Date();
    const m = await voiceTurn(OWNER.email, dm, join(AUDIO, `${s.id}-0.ogg`));
    v.listening = await page.locator('[data-ai-hearing]').first().waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
    await shot('02-listening');
    for (let n = 0; n < 800; n++) { const [x] = await q("select state, body from pulse_priv.chat_voice_transcript where message_id=$1", [m.id]); if (x && ['done', 'failed'].includes(x.state)) { v.heard = x.body; break; } await delay(1500); }
    await page.waitForTimeout(2500); await shot('03-heard');
    v.answer = await reply(dm, agent.id, t, 900000);
    const panel = page.locator('aside[aria-label="Side panel"] iframe');
    v.panel = await panel.first().waitFor({ timeout: 60000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(8000); await shot('04-quote-beside-chat');
    const [doc] = await q("select id from pulse.erp_document where doc_type='quotation' and created_by=$1 and created_at>=$2 order by created_at desc limit 1", [agent.id, t]);
    v.doc = doc?.id ?? null;
    if (v.panel && doc) {
      const f = page.frameLocator('aside[aria-label="Side panel"] iframe').first();
      const approve = f.getByRole('button', { name: /^Approve/ }).first();
      if (await approve.count()) {
        await approve.click(); await page.waitForTimeout(1500); await shot('05-approve-confirm');
        const ok = f.getByRole('button', { name: /^Approve (quotation|this)/ }).last();
        if (await ok.count()) await ok.click();
        await page.waitForTimeout(6000);
      }
      const [after] = await q('select status, number from pulse.erp_document where id=$1', [doc.id]);
      v.status = after?.status; v.number = after?.number;
      await shot('06-approved');
      // BHARATA-2: the issued quotation on its own page (its number), and its PDF as the client will get it.
      await page.goto(`${base}/erp/documents/${doc.id}`, { waitUntil: 'load', timeout: 300000 }).catch(() => {}); await page.waitForTimeout(6000); await shot('07-issued');
      const pdf = await app.inject({ url: `/api/v0/erp/documents/${doc.id}/pdf`, headers: { 'cf-access-authenticated-user-email': OWNER.email } });
      v.pdf = { status: pdf.statusCode, bytes: pdf.rawPayload.length, isPdf: pdf.rawPayload.subarray(0, 5).toString() === '%PDF-' };
      if (v.pdf.isPdf) await writeFile(join(OUT, 'video-08-quotation.pdf'), pdf.rawPayload);
    }
    await page.waitForTimeout(3000);
    await ctx.close();
    const { readdir, rename } = await import('node:fs/promises');
    const vids = (await readdir(join(OUT, 'video'))).filter((f) => f.endsWith('.webm'));
    if (vids[0]) { await rename(join(OUT, 'video', vids[0]), join(OUT, 'wl-quote-live-voice-to-approve-1440.webm')); v.video = join(OUT, 'wl-quote-live-voice-to-approve-1440.webm'); }
  } finally { await browser?.close().catch(() => {}); web.kill('SIGTERM'); }
  await writeFile(join(OUT, 'video.json'), JSON.stringify(v, null, 2)); log('video', JSON.stringify({ ...v, answer: v.answer?.slice(0, 200) }));
}

const list = E.PULSE_WLQ_SUITE === '0' ? [] : SUITE.scenarios.filter((s) => !ONLY || ONLY.test(s.id));
const results = []; let next = 0;
const rounds = Number(E.PULSE_WLQ_ROUNDS ?? 1);
try {
  for (let round = 1; round <= rounds; round++) {
    next = 0;
    // One worker per Bharata copy: each takes the next conversation (a copy answers one at a time).
    await Promise.all(AGENTS.map(async (_, w) => { for (let i; (i = next++) < list.length;) { const r = await conversation(list[i], i + (round - 1) * list.length, w).catch((e) => ({ id: list[i].id, error: String(e.message).slice(0, 300), points: 0, of: 7, pass: false })); results.push({ round, ...r }); await writeFile(join(OUT, 'runs.json'), JSON.stringify(results, null, 2)); } }));
  }
  if (E.PULSE_WLQ_VIDEO === '1') await video().catch((e) => log('video failed', String(e.stack ?? e).slice(0, 600)));
  await writeFile(join(OUT, 'runtime.log'), said.split('\n').filter((l) => /tool|round|prompt|failed|error|event/i.test(l)).slice(-400).join('\n'));
  await writeFile(join(OUT, 'whisper.log'), heardLog.slice(-20000));
  const pts = results.reduce((a, r) => a + (r.points ?? 0), 0), of = results.reduce((a, r) => a + (r.of ?? 7), 0);
  console.log(JSON.stringify({ conversations: results.length, passed: results.filter((r) => r.pass).length, points: pts, of }));
} finally {
  runtime.kill('SIGTERM'); whisper.kill('SIGTERM'); listener?.kill('SIGTERM'); await app.close(); await pool.end(); await own.end();
}
