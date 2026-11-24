// WL-DOCS (18 Nov 2026): an AI employee's selling paperwork over /api/v1/mcp with its own key, on real PostgreSQL and
// row security. Run by tests/core/test_wl_docs.py. Synthetic data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
const { createApp } = await import('../dist/app.js');

const W = JSON.parse(process.env.TEST_W), key = process.env.TEST_KEY, EXPLORE = !!process.env.WL_DOCS_EXPLORE;
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 4 }), app = createApp(pool, pool);
for (const level of ['info', 'warn', 'error']) app.log[level] = () => {};
if (EXPLORE) app.log.error = (...x) => { try { console.error('API-ERROR', JSON.stringify(x, (k, v) => v instanceof Error ? { message: v.message, code: v.code, where: v.where, detail: v.detail, stack: String(v.stack).slice(0, 600) } : v).slice(0, 3000)); } catch { console.error('API-ERROR', String(x[0]?.err?.message ?? x[0])); } };
app.log.child = () => app.log;
const report = [];
async function mcp(bearer, method, params = {}) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/mcp', payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } });
  let j = null;
  try { j = JSON.parse(r.body); } catch {
    const data = r.body.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean).at(-1);
    j = data ? JSON.parse(data) : null;
  }
  return { status: r.statusCode, j };
}
const tool = async (name, args = {}, bearer = key) => {
  const { status, j } = await mcp(bearer, 'tools/call', { name, arguments: args });
  const text = (j?.result?.content ?? []).map(c => c.text).join('');
  let data = j?.result?.structuredContent ?? null;
  if (!data && text) { try { data = JSON.parse(text); } catch { data = null; } }
  const out = { name, status, error: status !== 200 || !!j?.result?.isError || !!j?.error, data, text: text || JSON.stringify(j?.error ?? null) };
  report.push({ tool: name, args, error: out.error, said: out.text.slice(0, 700) });
  return out;
};
const ok = async (name, args, bearer) => { const r = await tool(name, args, bearer); if (!EXPLORE) assert.equal(r.error, false, `${name}: ${r.text}`); return r.data ?? {}; };
const token = async (email, scopes) => {
  const r = await app.inject({ method: 'POST', url: '/api/v0/api-tokens', headers: { 'cf-access-authenticated-user-email': email }, payload: { name: 'WL-DOCS (synthetic)', scopes, days: 7 } });
  assert.equal(r.statusCode, 201, r.body); return r.json().token;
};
const v1 = async (bearer, method, url, payload) => {
  const r = await app.inject({ method, url, headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': randomUUID() }, payload });
  report.push({ http: `${method} ${url}`, status: r.statusCode, said: r.body.slice(0, 500) });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return null; } })() };
};

try {
  const listed = await mcp(key, 'tools/list');
  assert.equal(listed.status, 200, JSON.stringify(listed.j));
  const names = (listed.j?.result?.tools ?? []).map(t => t.name);
  report.push({ tools: names.length, billing: names.filter(n => /quot|invoice|proforma|payment|billing|pdf|credit/.test(n)), docs: names.filter(n => /doc/.test(n)) });
  const founder = await token(W.founderEmail, ['billing.read', 'billing.write', 'companies.read', 'companies.write', 'tasks.read', 'docs.read', 'chats.read']);

  const me = await ok('whoami');
  if (!EXPLORE) assert.equal(me.id, W.agent);
  await ok('search_people', { query: 'Dev' });
  // Calls a model words loosely (Willow Lane's AI employees were refused these with 400, 7 and 16 Nov 2026).
  for (const args of [{ status: 'pending', limit: 20 }, { status: 'in_progress', who: 'all' }, { who: 'anyone', status: 'completed', limit: '500' }]) {
    const r = await ok('list_tasks', args);
    if (!EXPLORE) assert.ok(Array.isArray(r.items), `list_tasks ${JSON.stringify(args)}`);
  }

  // A salesperson's quotation from words -> submitted -> a person approves -> read back -> sent.
  const d = await ok('draft_quotation', { client: 'TEST Rajendra Fagare', newClient: true, items: [{ words: '5 kW system' }], lang: 'en', requestId: `q-${randomUUID()}` });
  const qid = d.quotation?.id;
  const s = await ok('draft_quotation', { draftId: qid, submit: true, lang: 'en', requestId: `s-${randomUUID()}` });
  report.push({ submitted: s.status, waitingFor: s.quotation?.waitingFor ?? null });
  if (!EXPLORE) { assert.equal(d.status, 'drafted'); assert.equal(s.status, 'submitted'); assert.equal(s.quotation.waitingFor, 'Neha Founder'); }
  const ap = await v1(founder, 'POST', `/api/v1/billing/quotations/${qid}/approve`, { confirm: true });
  const got = await ok('get_billing_document', { documentId: qid });
  report.push({ approved: ap.status, number: got.document?.number ?? got.number ?? null, keys: Object.keys(got.document ?? got) });
  if (!EXPLORE) { assert.equal(ap.status, 200); assert.equal(got.status, 'issued'); assert.match(got.number, /^QT\//); assert.ok(got.url.endsWith(qid)); }
  // An AI employee never approves (a person's own decision), whatever its access.
  const self = await tool('approve_quotation', { documentId: qid, confirm: true, requestId: `a-${randomUUID()}` });
  if (!EXPLORE) assert.equal(self.error, true, 'an AI employee does not approve a quotation');
  const sent = await ok('send_quotation', { documentId: qid, confirm: true, requestId: `x-${randomUUID()}` });
  if (!EXPLORE) { assert.equal(sent.quotation.status, 'sent'); assert.match(sent.acceptUrl, /^https:\/\//); }
  await ok('list_quotations', { status: 'sent' });

  // An invoice drafted from the approved quotation; a person issues it. Recording money stays a person's: the refusal
  // says so in plain words (the AI prepares the entry and asks).
  const inv = await ok('create_invoice', { quotationId: qid, requestId: `i-${randomUUID()}` });
  const iid = inv.invoice?.id;
  const is = await v1(founder, 'POST', `/api/v1/billing/invoices/${iid}/issue`, { confirm: true });
  report.push({ issued: is.status });
  if (!EXPLORE) { assert.equal(inv.invoice.status, 'draft'); assert.equal(inv.invoice.total, got.total); assert.equal(is.status, 200); }
  const pay = await tool('record_payment', { documentId: iid, amount: 5000000, method: 'upi', reference: 'SYNTH-UTR-1', confirm: true, requestId: `r-${randomUUID()}` });
  if (!EXPLORE) { assert.equal(pay.error, true); assert.match(pay.text, /payments.*are a person's/); }
  const invs = await ok('list_invoices', {});
  if (!EXPLORE) assert.deepEqual(invs.items.map(i => [i.id, i.status, i.due]), [[iid, 'issued', got.total]]);

  // A doc written in the group is shared there; changed; read back; sent to a colleague to read.
  const doc = await ok('create_doc', { title: 'Synthetic site visit checklist', markdown: '## Before the visit\n- Roof photos\n- Last electricity bill', shareWithChat: W.group, requestId: `d-${randomUUID()}` });
  const did = doc.doc?.id;
  await ok('update_doc', { docId: did, markdown: '## Before the visit\n- Roof photos\n- Last electricity bill\n- Sanctioned load', requestId: `u-${randomUUID()}` });
  const read = await ok('get_doc', { docId: did });
  // send_doc with the reader under the name a model reaches for (personId): it is "to".
  const req = await ok('send_doc', { docId: did, personId: W.member, ask: 'read', requestId: `e-${randomUUID()}` });
  if (!EXPLORE) {
    assert.equal(doc.doc.access, 'people'); assert.match(doc.openBeside, /^\/docs\/[0-9a-f-]{36}$/);
    assert.deepEqual(doc.doc.sharedWith.map(x => x.personId).sort(), [W.founder, W.member].sort(), "shared with the chat's people, not the AI itself");
    assert.equal(read.doc.version, 2); assert.equal(req.request.ask, 'read');
  }

  // A message in its group, and a task for a colleague.
  // (The company has a team chat with a stale member: the roster clean-up a person's visit runs. An AI employee's
  // send_message was refused 403 "An AI employee cannot delete in chat_member" because of it.)
  const msg = await ok('send_message', { chatId: W.group, body: 'The site visit checklist is ready (synthetic).', requestId: `m-${randomUUID()}` });
  const task = await ok('create_task', { title: 'Synthetic: call TEST Rajendra Fagare about the 5 kW quotation', assigneeId: W.member, requestId: `t-${randomUUID()}` });
  if (!EXPLORE) {
    assert.match(msg.id, /^[0-9a-f-]{36}$/); assert.equal(task.assigned, true); assert.equal(task.assigneeName, 'Dev Member');
    const thread = await v1(founder, 'GET', `/api/v1/chats/${W.group}/messages`);
    assert.ok(thread.body.items.some(m => m.id === msg.id && m.authorId === W.agent), 'the message is in the group, from the AI employee');
  }

  console.log(JSON.stringify({ report }, null, 1));
  console.log('wl-docs runner: ok');
} catch (e) {
  console.log(JSON.stringify({ report }, null, 1));
  throw e;
} finally {
  await app.close().catch(() => {});
  await pool.end();
}
