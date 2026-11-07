// AGENT-API (owner, 4 Nov 2026): the work and money operations of API v1 and their MCP tools, on real PostgreSQL and
// tenant row security, with personal tokens and a bot key made through Settings → API keys. Auth, org isolation (a
// token of one organisation never reads or writes another's), idempotency, confirmations, audit and undo. Synthetic
// people, clients and figures only. Run by tests/core/test_agent_api.py.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const W = JSON.parse(process.env.TEST_W);
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 3 }), app = createApp(pool, pool);
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
const json = r => { try { return r.json(); } catch { return r.body; } };
const asPerson = (email, method, url, payload) => app.inject({ method, url, headers: { 'cf-access-authenticated-user-email': email }, ...(payload ? { payload } : {}) });
/** One API v1 call with a bearer token; writes carry a fresh Idempotency-Key unless one is given. */
async function api(token, method, url, payload, { key, status, host } = {}) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(host ? { 'x-pulse-host': host } : {}) };
  if (method !== 'GET') headers['idempotency-key'] = key ?? randomUUID();
  const r = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });
  if (status !== undefined) { assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`); checks++; }
  return { status: r.statusCode, body: json(r), headers: r.headers };
}
const get = (t, url, o) => api(t, 'GET', url, undefined, o);
const post = (t, url, body, o) => api(t, 'POST', url, body, o);
async function rpc(token, method, params = {}) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/mcp', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    payload: { jsonrpc: '2.0', id: 1, method, params } });
  assert.equal(r.statusCode, 200, r.body);
  const v = r.body.split('\n').filter(s => s.startsWith('data:')).map(s => JSON.parse(s.slice(5))).find(x => x.id === 1);
  return v.result ?? v;
}
async function makeToken(email, body, status = 201) {
  const r = await asPerson(email, 'POST', '/api/v0/api-tokens', body);
  assert.equal(r.statusCode, status, r.body); checks++;
  return r.json();
}
const ALL = ['tasks.read', 'tasks.write', 'projects.read', 'projects.write', 'people.read', 'people.write', 'chats.read', 'chats.write', 'billing.read', 'billing.write',
  'companies.read', 'companies.write', 'search.read'];

try {
  // ------------------------------------------------------------------ tokens: made in Settings, shown once, scoped
  const fin = await makeToken(W.financeEmail, { name: 'Finance scripts', scopes: ALL, days: 30 });
  ok(/^ppt_[A-Za-z0-9_-]{43}$/.test(fin.token), 'a personal token');
  ok(!JSON.stringify(fin.tokens).includes(fin.token), 'the list never holds a secret');
  const founder = (await makeToken(W.founderEmail, { name: 'Founder CLI', scopes: ALL, days: 30 })).token;
  const member = (await makeToken(W.memberEmail, { name: 'Member tasks', scopes: ['tasks.read', 'tasks.write', 'people.read', 'projects.read', 'chats.read', 'chats.write'], days: 7 })).token;
  await makeToken(W.memberEmail, { kind: 'bot', name: 'Not mine to make', scopes: ['tasks.read'], days: 7, agentId: W.agent }, 403);
  await makeToken(W.memberEmail, { name: 'Bad scope', scopes: ['money.everything'], days: 7 }, 400);
  const bot = (await makeToken(W.adminEmail, { kind: 'bot', name: 'Bhrata (synthetic)', scopes: ALL.filter(s => !s.startsWith('people.write')), days: 30, agentId: W.agent })).token;
  ok(bot.startsWith('pbk_'), 'a bot key');
  const listed = (await asPerson(W.adminEmail, 'GET', '/api/v0/api-tokens')).json();
  ok(listed.admin && listed.tokens.some(t => t.kind === 'bot' && t.personId === W.agent) && listed.agents.some(a => a.id === W.agent), 'admins see bot keys and AI members');
  ok(!(await asPerson(W.memberEmail, 'GET', '/api/v0/api-tokens')).json().tokens.some(t => t.kind === 'bot'), 'members see only their own');

  // ------------------------------------------------------------------ auth
  await get(null, '/api/v1/tasks', { status: 401 });
  await get('ppt_' + 'A'.repeat(43), '/api/v1/tasks', { status: 401 });
  await get(member, '/api/v1/billing/quotations', { status: 403 });   // a live token without the area
  const me = (await get(fin.token, '/api/v1/people/me', { status: 200 })).body;
  eq([me.id, me.app], [W.finance, 'Finance scripts (personal token)'], 'acts as its person, named as the app');
  const botMe = (await get(bot, '/api/v1/people/me', { status: 200 })).body;
  eq(botMe.id, W.agent, 'a bot key acts as its AI member');
  // Rotation: a new secret, the old one stops at once; revoke stops it.
  const spare = await makeToken(W.memberEmail, { name: 'Spare', scopes: ['tasks.read'], days: 7 });
  const rotated = (await asPerson(W.memberEmail, 'POST', `/api/v0/api-tokens/${spare.id}/rotate`, {})).json();
  await get(spare.token, '/api/v1/tasks', { status: 401 });
  await get(rotated.token, '/api/v1/tasks', { status: 200 });
  eq((await asPerson(W.memberEmail, 'POST', `/api/v0/api-tokens/${rotated.id}/revoke`, {})).statusCode, 200);
  await get(rotated.token, '/api/v1/tasks', { status: 401 });
  eq((await asPerson(W.memberEmail, 'POST', `/api/v0/api-tokens/${fin.id}/revoke`, {})).statusCode, 404, 'nobody revokes another person\'s token but an admin');
  // Review (5 Nov 2026): an admin never rotates a member's personal token (the new secret would act as that member),
  // and the list does not offer it; the admin may still revoke it, and rotates bot keys.
  const adminList = (await asPerson(W.adminEmail, 'GET', '/api/v0/api-tokens')).json().tokens;
  ok(adminList.some(t => t.id === fin.id && t.canRotate === false) && adminList.some(t => t.kind === 'bot' && t.canRotate === true), 'Rotate only on your own tokens and bot keys');
  const hijack = await asPerson(W.adminEmail, 'POST', `/api/v0/api-tokens/${fin.id}/rotate`, {});
  eq(hijack.statusCode, 404, 'an admin cannot rotate a member\'s personal token');
  ok(!/ppt_/.test(hijack.body), 'and gets no secret');
  await get(fin.token, '/api/v1/people/me', { status: 200 });   // the member's token still works
  const spareBot = await makeToken(W.adminEmail, { kind: 'bot', name: 'Spare bot', scopes: ['tasks.read'], days: 1, agentId: W.agent });
  const botRotated = await asPerson(W.adminEmail, 'POST', `/api/v0/api-tokens/${spareBot.id}/rotate`, {});
  eq(botRotated.statusCode, 200, 'an admin rotates a bot key');
  ok(botRotated.json().token.startsWith('pbk_'), 'a new bot key');
  const leaver = await makeToken(W.memberEmail, { name: 'Leaver', scopes: ['tasks.read'], days: 7 });
  eq((await asPerson(W.adminEmail, 'POST', `/api/v0/api-tokens/${leaver.id}/revoke`, {})).statusCode, 200, 'an admin revokes a member\'s token');
  await get(leaver.token, '/api/v1/tasks', { status: 401 });

  // ------------------------------------------------------------------ tasks: create, idempotency, update, comment, complete, undo
  const key = randomUUID();
  const made = await post(member, '/api/v1/tasks', { title: 'Synthetic: call the dealer back', dueOn: '2026-11-20', priority: 'high' }, { key, status: 200 });
  const again = await post(member, '/api/v1/tasks', { title: 'Synthetic: call the dealer back', dueOn: '2026-11-20', priority: 'high' }, { key, status: 200 });
  eq(again.body.id, made.body.id, 'the same Idempotency-Key replays the first answer');
  await post(member, '/api/v1/tasks', { title: 'Something else' }, { key, status: 409 });
  await post(member, '/api/v1/tasks', { title: 'No key' }, { key: 'not-a-uuid', status: 400 });
  await post(member, '/api/v1/tasks', { title: 'x', orgId: W.org }, { status: 400 });   // closed schema
  const taskId = made.body.id;
  ok(made.body.assigned === false && made.body.url.endsWith(`/tasks/${taskId}`), 'mine by default');
  const mine = (await get(member, '/api/v1/tasks', { status: 200 })).body.items;
  ok(mine.some(t => t.id === taskId && t.priority === 'high'), 'list_tasks shows it');
  const upd = await api(member, 'PATCH', `/api/v1/tasks/${taskId}`, { title: 'Synthetic: call the dealer back today', priority: 'urgent' }, { status: 200 });
  eq(upd.body.changed.sort(), ['priority', 'title']);
  await post(member, '/api/v1/tasks/comments', { taskId, body: 'Synthetic note: dealer asked for the 20 kW price' }, { status: 200 });
  await post(member, '/api/v1/tasks/comments', { body: 'nowhere' }, { status: 400 });
  const task = (await get(member, `/api/v1/tasks/${taskId}`, { status: 200 })).body;
  ok(task.comments.length === 1 && task.task.title.endsWith('today'), 'get_task reads comments');
  const done = await post(member, `/api/v1/tasks/${taskId}/complete`, {}, { status: 200 });
  ok(['done', 'in_review'].includes(done.body.status), 'completed');
  const readOnly = (await makeToken(W.memberEmail, { name: 'Read only', scopes: ['tasks.read'], days: 1 })).token;
  await post(readOnly, `/api/v1/people/me/changes/${done.body.changeId}/undo`, {}, { status: 403 });   // no write area at all
  // Review (5 Nov 2026): undo opens with the write's own area, so a work-only token undoes its own task changes.
  const undoer = member;
  await post(undoer, `/api/v1/people/me/changes/${done.body.changeId}/undo`, {}, { status: 200 });
  eq((await get(member, `/api/v1/tasks/${taskId}`)).body.task.status, 'open', 'undo puts it back');
  await post(undoer, `/api/v1/people/me/changes/${upd.body.changeId}/undo`, {}, { status: 200 });
  eq((await get(member, `/api/v1/tasks/${taskId}`)).body.task.title, 'Synthetic: call the dealer back', 'undo restores the fields');
  const changes = (await get(undoer, '/api/v1/people/me/changes', { status: 200 })).body.items;
  ok(changes.some(c => c.action === 'task.create' && c.app === 'Member tasks (personal token)' && c.undoUntil), 'the ledger names the app and the undo window');

  // ------------------------------------------------------------------ projects and stages
  const proj = await post(founder, '/api/v1/projects', { name: 'Synthetic: Majestic Infra rooftop', dueOn: '2026-12-15' }, { status: 200 });
  const projectId = proj.body.project.id;
  const inProj = await post(founder, '/api/v1/tasks', { title: 'Synthetic: site survey', projectId, assigneeId: W.finance }, { status: 200 });
  const p = (await get(founder, `/api/v1/projects/${projectId}`, { status: 200 })).body;
  ok(p.tasks.some(t => t.id === inProj.body.id) && Array.isArray(p.stages), 'get_project with its tasks and stages');
  ok((await get(founder, '/api/v1/projects?query=majestic', { status: 200 })).body.items.some(x => x.id === projectId), 'list_projects by words');
  // The founder (leadership) reassigns a task in their own project; a member cannot take someone else's task.
  const given = await post(founder, `/api/v1/tasks/${inProj.body.id}/assign`, { personId: W.founder }, { status: 200 });
  await post(member, `/api/v1/tasks/${inProj.body.id}/assign`, { personId: W.member }, {}).then(r => ok([403, 404].includes(r.status), 'a member cannot take another\'s task'));

  // ------------------------------------------------------------------ clients: find or create (Bhrata), forgiving search
  const none = await post(bot, '/api/v1/companies/clients/find-or-create', { name: 'Majestic Infra', phone: '+91 90000 00112' }, { status: 200 });
  eq(none.body.result, 'none', 'nobody yet: ask before adding');
  const created = await post(bot, '/api/v1/companies/clients/find-or-create', { name: 'Majestic Infra', phone: '+91 90000 00112', city: 'Pune', create: true }, { status: 200 });
  eq(created.body.result, 'created');
  const clientId = created.body.client.id;
  eq((await post(bot, '/api/v1/companies/clients/find-or-create', { name: 'majestic  infra' }, { status: 200 })).body.client?.id, clientId, 'found by name, case and spaces ignored');
  eq((await post(bot, '/api/v1/companies/clients/find-or-create', { name: 'Someone', phone: '9000000112' }, { status: 200 })).body.client?.id, clientId, 'found by phone');
  ok((await get(bot, '/api/v1/companies/clients?query=MAJESTICINFRA', { status: 200 })).body.items.some(c => c.id === clientId), 'search_clients forgiving');
  ok((await get(fin.token, '/api/v1/companies/contacts?query=asha', { status: 200 })).body.items.some(c => c.name === 'Asha Kireteso'), 'search_contacts');
  await post(member, '/api/v1/companies/clients', { name: 'Nope' }, { status: 403 });   // a member's token has no companies scope
  // Review (5 Nov 2026): a plain member's token reads Clients and Contacts as the screens show them, but no phone
  // numbers, e-mails or leads, and never a members-only project.
  const plain = (await makeToken(W.memberEmail, { name: 'Member clients', scopes: ['companies.read'], days: 1 })).token;
  const seen = (await get(plain, '/api/v1/companies/clients?query=majestic', { status: 200 })).body.items;
  ok(seen.some(c => c.id === clientId) && seen.every(c => c.phone === null && c.email === null), 'clients without phone or e-mail');
  ok(!(await get(plain, '/api/v1/companies/clients?query=9000000112', { status: 200 })).body.items.some(c => c.id === clientId), 'no lookup by phone');
  ok((await get(plain, '/api/v1/companies/contacts?query=asha', { status: 200 })).body.items.every(c => c.phone === null && c.email === null), 'contacts without phone or e-mail');
  await get(plain, '/api/v1/companies/leads?query=asha', { status: 403 });
  await get(founder, '/api/v1/companies/leads?query=asha', { status: 200 });
  const privateFor = (await get(plain, `/api/v1/companies/clients/${W.privateClient}`, { status: 200 })).body;
  ok(privateFor.projects.some(p => p.id === W.openProject) && !privateFor.projects.some(p => p.id === W.secretProject), 'a members-only project stays hidden');
  ok(privateFor.contacts.every(c => c.phone === null && c.email === null) && privateFor.client.phone === null, 'no phone on the client either');
  // Members-only means its people and admins (1455): an admin's token sees it, with the phone numbers.
  const adminRead = (await makeToken(W.adminEmail, { name: 'Admin clients', scopes: ['companies.read'], days: 1 })).token;
  ok((await get(adminRead, `/api/v1/companies/clients/${W.privateClient}`, { status: 200 })).body.projects.some(p => p.id === W.secretProject), 'an admin sees it');
  ok(!(await get(founder, `/api/v1/companies/clients/${W.privateClient}`, { status: 200 })).body.projects.some(p => p.id === W.secretProject), 'leadership not on it does not');

  // ------------------------------------------------------------------ catalogue and stock
  const item = await post(bot, '/api/v1/billing/catalogue', { kind: 'product', name: 'Pure Power 20.0', code: 'PP-20', price: 45000000, gstRate: 18, trackStock: true }, { status: 200 });
  const itemId = item.body.item.id;
  for (const q of ['purepower 20', 'Pure Power 20.0', 'pure power20.0', 'pp-20']) ok((await get(bot, `/api/v1/billing/catalogue?query=${encodeURIComponent(q)}`)).body.items.some(i => i.id === itemId), `catalogue finds "${q}"`);
  // Review (5 Nov 2026): an AI member drafts; stock is moved by a person (the database refuses it in a bot's session).
  await post(bot, `/api/v1/billing/stock/${itemId}/in`, { qty: 5, note: 'Synthetic delivery' }, { status: 403 });
  await post(bot, `/api/v1/billing/stock/${itemId}/count`, { onHand: 3, confirm: true }, { status: 403 });
  eq((await post(fin.token, `/api/v1/billing/stock/${itemId}/in`, { qty: 5, note: 'Synthetic delivery' }, { status: 200 })).body.onHand, 5);
  const noConfirm = await post(fin.token, `/api/v1/billing/stock/${itemId}/count`, { onHand: 3, confirm: false }, { status: 409 });
  ok(/Confirm first/.test(noConfirm.body.detail), 'refuses without confirm and says what would happen');
  eq((await post(fin.token, `/api/v1/billing/stock/${itemId}/count`, { onHand: 3, confirm: true }, { status: 200 })).body.onHand, 3);
  ok((await get(bot, '/api/v1/billing/stock', { status: 200 })).body.items.some(i => i.id === itemId && i.onHand === 3), 'list_stock');

  // ------------------------------------------------------------------ quotation: draft, submit, approve (a person), send, revise
  const q = await post(bot, '/api/v1/billing/quotations', { clientId, lines: [{ itemId, qty: 1 }] }, { status: 200 });
  const qid = q.body.quotation.id;
  eq([q.body.quotation.status, q.body.quotation.lines[0].rate, q.body.quotation.needsOwnerApproval], ['draft', 45000000, false], 'the catalogue price fills in');
  const sub = await post(bot, `/api/v1/billing/quotations/${qid}/submit`, {}, { status: 200 });
  eq(sub.body.approver, 'Neha Founder', 'the first leader approves');
  await post(bot, `/api/v1/billing/quotations/${qid}/submit`, {}, { status: 409 });
  const botApprove = await post(bot, `/api/v1/billing/quotations/${qid}/approve`, { confirm: true }, { status: 403 });
  ok(/person's decision/.test(botApprove.body.detail), 'a bot never approves');
  await post(bot, `/api/v1/billing/quotations/${qid}/send`, { confirm: true }, { status: 409 });   // not approved yet
  await post(founder, `/api/v1/billing/quotations/${qid}/approve`, { confirm: false }, { status: 409 });
  const approved = await post(founder, `/api/v1/billing/quotations/${qid}/approve`, { confirm: true }, { status: 200 });
  ok(approved.body.quotation.status === 'issued' && approved.body.quotation.number, 'approved and numbered');
  const number = approved.body.quotation.number;
  const sent = await post(bot, `/api/v1/billing/quotations/${qid}/send`, { confirm: true }, { status: 200 });
  ok(sent.body.acceptUrl.includes('/accept/') && sent.body.quotation.status === 'sent', 'sent with the client\'s link');
  await post(bot, `/api/v1/billing/quotations/${qid}/revise`, { reason: 'Synthetic: negotiated', lines: [{ itemId, qty: 1, rate: 43000000 }] }, { status: 403 });
  const rev = await post(fin.token, `/api/v1/billing/quotations/${qid}/revise`, { reason: 'Synthetic: negotiated', lines: [{ itemId, qty: 1, rate: 43000000 }] }, { status: 200 });
  eq([rev.body.revised, rev.body.quotation.status, rev.body.quotation.number, rev.body.quotation.lines[0].rate], [true, 'draft', number, 43000000], 'a revision keeps its number and reopens as a draft');
  await post(bot, `/api/v1/billing/quotations/${qid}/approve`, { confirm: true }, { status: 403 });   // still a person's click
  await post(founder, `/api/v1/billing/quotations/${qid}/approve`, { confirm: true }, { status: 200 });
  ok((await get(fin.token, '/api/v1/billing/quotations?query=majestic', { status: 200 })).body.items.some(x => x.id === qid && x.revision === 1), 'list_quotations');

  // ------------------------------------------------------------------ invoice and payment
  const inv = await post(fin.token, '/api/v1/billing/invoices', { quotationId: qid }, { status: 200 });
  const invId = inv.body.invoice.id;
  eq((await post(fin.token, '/api/v1/billing/invoices', { quotationId: qid }, { status: 200 })).body.invoice.id, invId, 'a retry opens the same draft');
  await post(bot, `/api/v1/billing/invoices/${invId}/issue`, { confirm: true }, { status: 403 });
  const issued = await post(fin.token, `/api/v1/billing/invoices/${invId}/issue`, { confirm: true }, { status: 200 });
  ok(issued.body.invoice.number && issued.body.invoice.due === issued.body.invoice.total, 'issued, all due');
  await post(fin.token, `/api/v1/billing/invoices/${invId}/payments`, { amount: 1000000 }, { status: 400 });   // confirm is required
  const paid = await post(fin.token, `/api/v1/billing/invoices/${invId}/payments`, { amount: 1000000, method: 'upi', reference: 'SYNTH-UTR-1', confirm: true }, { status: 200 });
  eq(paid.body.invoice.paid, 1000000);
  await post(bot, `/api/v1/billing/invoices/${invId}/payments`, { amount: 1000, method: 'upi', reference: 'SYNTH-BOT', confirm: true }, { status: 403 });
  // In an AI member's own database session (whatever the caller): no void, no cancel, no new payment, no price change.
  const asBot = async sql => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true),set_config('pulse.agent_session','on',true)", [W.org, W.agent]);
      ok(await c.query('select pulse.erp_can(true) v').then(r => r.rows[0].v === true), 'the bot still drafts in Billing');
      await c.query(sql.text, sql.values);
      return null;
    } catch (e) { return e; } finally { await c.query('rollback').catch(() => {}); c.release(); }
  };
  for (const [what, sql] of [
    ['void a payment', { text: 'select pulse.erp_payment_void((select id from pulse.erp_payment where document_id=$1 limit 1),$2)', values: [invId, 'Synthetic bot'] }],
    ['record a payment', { text: "select pulse.erp_payment_add($1,$2)", values: [invId, { amount: 1000, tds: 0, method: 'upi', receivedOn: '2026-11-05', reference: 'SYNTH-BOT-2', bankLineKey: null, note: '' }] }],
    ['change a catalogue price', { text: "update pulse.erp_item set price=price+1 where id=$1", values: [itemId] }],
  ]) {
    const e = await asBot(sql);
    ok(e && e.code === '42501' && /AI member/.test(e.message), `a bot cannot ${what}: ${e?.message}`);
  }
  const finUndo = fin.token;   // billing.write undoes a payment; people.write is not needed
  await post(finUndo, `/api/v1/people/me/changes/${paid.body.changeId}/undo`, {}, { status: 200 });
  eq((await get(fin.token, `/api/v1/billing/documents/${invId}`, { status: 200 })).body.paid, 0, 'undo voids the payment');
  const cancel = await asBot({ text: "select pulse.erp_document_mark($1,'cancel','Synthetic bot')", values: [invId] });
  ok(cancel && cancel.code === '42501' && /AI member/.test(cancel.message), `a bot cannot cancel an issued invoice: ${cancel?.message}`);
  ok((await get(fin.token, '/api/v1/billing/invoices?status=unpaid', { status: 200 })).body.items.some(x => x.id === invId), 'list_invoices unpaid');

  // ------------------------------------------------------------------ chats, calendar, attendance, organisations
  const group = await post(fin.token, '/api/v1/chats/groups', { name: 'Synthetic billing desk', memberIds: [W.founder] }, {});
  if (group.status === 200) {
    const msg = await post(fin.token, `/api/v1/chats/${group.body.groupId}/messages`, { body: 'Synthetic: quotation sent to Majestic Infra' }, { status: 200 });
    ok((await get(fin.token, `/api/v1/chats/${group.body.groupId}/messages`, { status: 200 })).body.items.some(m => m.id === msg.body.id), 'read_messages');
    ok((await get(fin.token, '/api/v1/chats/conversations', { status: 200 })).body.items.some(c => c.id === group.body.groupId), 'list_chats');
    await get(member, `/api/v1/chats/${group.body.groupId}/messages`, { status: 404 });   // not in it
  }
  const due = (await post(member, '/api/v1/tasks', { title: 'Synthetic: send the site photos', dueOn: '2026-11-25' }, { status: 200 })).body.id;
  const cal = (await get(member, '/api/v1/people/me/calendar?from=2026-11-01&to=2026-11-30', { status: 200 })).body;
  ok(cal.items.some(i => i.kind === 'task_due' && i.ref === due && i.date === '2026-11-25'), 'my_calendar shows my task due');
  await get(member, '/api/v1/people/me/calendar?from=2026-01-01&to=2026-12-31', { status: 400 });
  await get(member, '/api/v1/people/attendance?who=me', { status: 200 });
  ok((await get(member, '/api/v1/people/me/organisations', { status: 200 })).body.items.some(o => o.current), 'list_my_organisations');

  // ------------------------------------------------------------------ org isolation: a token of org B never reaches org A
  const other = W.otherToken;
  const otherMe = (await get(other, '/api/v1/people/me', { status: 200 })).body;
  eq(otherMe.id, W.otherPerson, 'the other organisation\'s token runs in its own organisation');
  await get(other, `/api/v1/tasks/${taskId}`, { status: 404 });
  await api(other, 'PATCH', `/api/v1/tasks/${taskId}`, { title: 'Hijack' }, { status: 404 });
  await post(other, `/api/v1/tasks/${taskId}/complete`, {}, { status: 404 });
  await get(other, `/api/v1/projects/${projectId}`, { status: 404 });
  ok(!(await get(other, '/api/v1/tasks?who=anyone&status=all', { status: 200 })).body.items.some(t => t.id === taskId), 'lists stay in their organisation');
  // Org B's token has Billing rights in org B (it lists its own quotations), so a 404 here is isolation, not a role.
  await get(other, '/api/v1/billing/quotations', { status: 200 });
  await get(other, `/api/v1/billing/documents/${qid}`, { status: 404 });
  await get(other, `/api/v1/companies/clients/${clientId}`, { status: 404 });
  await get(fin.token, '/api/v1/tasks', { host: W.otherHost, status: 401 });   // A's token at B's address resolves nothing
  await get(other, '/api/v1/tasks', { host: W.otherHost, status: 200 });

  // ------------------------------------------------------------------ MCP: tools follow the roles, writes idempotent by requestId
  const botTools = (await rpc(bot, 'tools/list')).tools.map(t => t.name);
  for (const name of ['find_or_create_client', 'create_quotation', 'revise_quotation', 'submit_quotation', 'approve_quotation', 'send_quotation', 'create_task', 'assign_task',
    'update_task', 'comment', 'create_project', 'add_catalog_item', 'record_stock_in', 'record_payment', 'search_catalogue', 'list_tasks']) ok(botTools.includes(name), `MCP has ${name}`);
  const memberTools = (await rpc(member, 'tools/list')).tools;
  ok(!memberTools.some(t => t.name === 'create_quotation') && memberTools.some(t => t.name === 'create_task'), 'tools follow the token\'s areas and roles');
  const approveTool = (await rpc(bot, 'tools/list')).tools.find(t => t.name === 'approve_quotation');
  ok(approveTool.annotations.destructiveHint === true && approveTool.inputSchema.properties.confirm, 'money tools are marked and take confirm');
  const call = args => rpc(bot, 'tools/call', { name: 'create_task', arguments: args });
  const t1 = await call({ title: 'Synthetic: follow up Majestic Infra', requestId: 'bhrata-msg-0001' });
  const t2 = await call({ title: 'Synthetic: follow up Majestic Infra', requestId: 'bhrata-msg-0001' });
  ok(!t1.isError && t1.structuredContent.id === t2.structuredContent.id, 'the same requestId makes one task');
  const refused = await rpc(bot, 'tools/call', { name: 'approve_quotation', arguments: { documentId: qid, confirm: true } });
  ok(refused.isError && [403, 409].includes(refused.structuredContent.status), 'the bot cannot approve through MCP either');

  // ------------------------------------------------------------------ device code sign-in (1511), through the API
  const cliClient = (await app.inject({ method: 'POST', url: '/api/v0/oauth/register', payload: { client_name: 'Synthetic CLI', redirect_uris: ['http://127.0.0.1/device'], token_endpoint_auth_method: 'none' } })).json();
  const askCode = async () => (await app.inject({ method: 'POST', url: '/api/v0/oauth/device_authorization', payload: { client_id: cliClient.client_id, scope: 'tasks.read people.read' } })).json();
  const poll = async code => (await app.inject({ method: 'POST', url: '/api/v0/oauth/token', payload: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code, client_id: cliClient.client_id } }));
  const dev = await askCode();
  ok(/^[B-Z]{4}-[B-Z]{4}$/.test(dev.user_code) && dev.verification_uri.endsWith('/oauth/device') && dev.interval === 5, 'a device code and where to approve it');
  eq((await poll(dev.device_code)).json().error, 'authorization_pending');
  eq((await poll(dev.device_code)).json().error, 'slow_down', 'polling faster than every 5 seconds is slowed');
  const peek = await asPerson(W.memberEmail, 'GET', `/api/v0/oauth/device?user_code=${dev.user_code}`);
  ok(peek.statusCode === 200 && peek.json().app.name === 'Synthetic CLI' && peek.json().scopes.length === 2, 'the person sees the app and the areas');
  eq((await asPerson(W.memberEmail, 'POST', '/api/v0/oauth/device', { user_code: dev.user_code.toLowerCase(), approve: true })).statusCode, 200);
  const devTok = (await poll(dev.device_code)).json();
  ok(/^pat_/.test(devTok.access_token) && devTok.scope === 'tasks.read people.read', 'the poll gets the tokens once approved');
  eq((await get(devTok.access_token, '/api/v1/people/me', { status: 200 })).body.id, W.member);
  eq((await poll(dev.device_code)).json().error, 'invalid_grant', 'a device code works once');
  const denied = await askCode();
  await asPerson(W.memberEmail, 'POST', '/api/v0/oauth/device', { user_code: denied.user_code, approve: false });
  eq((await poll(denied.device_code)).json().error, 'access_denied');
  eq((await asPerson(W.memberEmail, 'GET', '/api/v0/oauth/device?user_code=ZZZZ-ZZZZ')).statusCode, 404);

  // ------------------------------------------------------------------ the browser (PULSE_AUTH_BROWSER=1): Settings → API keys,
  // the device approval page and /developers, at 390 and 1440 px, with screenshots in PULSE_AGENT_API_SCREENSHOTS.
  let browserChecks = 0;
  if (process.env.PULSE_AUTH_BROWSER === '1') {
    const { spawn } = await import('node:child_process');
    const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
    const shots = process.env.PULSE_AGENT_API_SCREENSHOTS;
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const net = await import('node:net'); const probe = net.createServer(); await new Promise(done => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise(done => probe.close(done));
    const base = `http://127.0.0.1:${port}`;
    const web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web',
      env: { ...process.env, PULSE_API_URL: origin, PULSE_PUBLIC_URL: base, NODE_ENV: 'production', NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? '.next' }, stdio: 'ignore' });
    let browser;
    const fits = async (page, what) => { ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${what}: no sideways scroll at ${page.viewportSize().width} px`); browserChecks++; };
    const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}-${page.viewportSize().width}.png`, fullPage: true }); };
    try {
      for (let i = 0; i < 240; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 250)); if (i === 239) throw Error('web did not start'); }
      browser = await chromium.launch({ headless: true });
      for (const width of [390, 1440]) {
        const c = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': W.adminEmail } });
        c.on('dialog', d => void d.accept());
        const p = await c.newPage();
        p.on('pageerror', e => console.error('PAGEERROR', e.message));
        await p.goto(`${base}/settings?tab=api-keys`, { waitUntil: 'load' });
        await expect(p.getByRole('heading', { name: 'Your personal tokens' })).toBeVisible({ timeout: 60000 }); browserChecks++;
        await expect(p.getByRole('heading', { name: 'Bot keys' })).toBeVisible(); browserChecks++;
        await expect(p.getByRole('article', { name: 'Bhrata (synthetic)' })).toBeVisible(); browserChecks++;
        // Review (5 Nov 2026): an admin revokes a member's token but never rotates it; bot keys keep Rotate.
        const others = p.getByRole('article', { name: 'Finance scripts' });
        await expect(others.getByRole('button', { name: 'Revoke' })).toBeVisible(); browserChecks++;
        await expect(others.getByRole('button', { name: 'Rotate' })).toHaveCount(0); browserChecks++;
        await expect(p.getByRole('article', { name: 'Bhrata (synthetic)' }).getByRole('button', { name: 'Rotate' })).toBeVisible(); browserChecks++;
        await fits(p, 'API keys'); await shot(p, '01-api-keys');
        await p.getByRole('button', { name: 'New token' }).click();
        await p.getByLabel('Name').fill(`Synthetic laptop ${width}`);
        await shot(p, '02-new-token');
        await p.getByRole('button', { name: 'Make it' }).click();
        const shown = p.locator('code').filter({ hasText: /^ppt_/ });
        await expect(shown).toBeVisible(); browserChecks++;
        const secret = (await shown.textContent()).trim();
        eq((await get(secret, '/api/v1/tasks', { status: 200 })).status, 200, 'the token made on screen works');
        await fits(p, 'token shown once'); await shot(p, '03-token-shown');
        await p.getByRole('button', { name: 'I’ve stored it' }).click();
        await expect(shown).toHaveCount(0); browserChecks++;
        const card = p.getByRole('article', { name: `Synthetic laptop ${width}` });
        await card.getByRole('button', { name: 'Revoke' }).click();
        await expect(card).toHaveCount(0); browserChecks++;
        await get(secret, '/api/v1/tasks', { status: 401 });
        // The device approval page: enter the code, see the app and the areas, Allow.
        const d = await askCode();
        await p.goto(`${base}/oauth/device`, { waitUntil: 'load' });
        await p.getByPlaceholder('XXXX-XXXX').fill(d.user_code);
        await fits(p, 'device code entry'); await shot(p, '04-device-code');
        await p.getByRole('button', { name: 'Continue' }).click();
        await expect(p.getByRole('heading', { name: /Synthetic CLI wants to use Pulse as you/ })).toBeVisible(); browserChecks++;
        await fits(p, 'device consent'); await shot(p, '05-device-consent');
        await p.getByRole('button', { name: 'Allow' }).click();
        await expect(p.getByRole('heading', { name: 'Connected' })).toBeVisible(); browserChecks++;
        ok(/^pat_/.test((await poll(d.device_code)).json().access_token ?? ''), 'approved in the browser, signed in at the terminal');
        await p.goto(`${base}/developers`, { waitUntil: 'load' });
        await expect(p.getByRole('heading', { name: '3. The money path, step by step' })).toBeVisible(); browserChecks++;
        await fits(p, 'developers'); await shot(p, '06-developers');
        await c.close();
      }
    } finally { await browser?.close(); web.kill('SIGTERM'); }
  }

  // The audit receipts (one per call, as each token's own principal) are read by the pytest driver as the owner.
  console.log(JSON.stringify({ ok: true, checks, browserChecks, ids: { taskId, qid, invId, clientId } }));
} finally { await app.close(); await pool.end(); }
