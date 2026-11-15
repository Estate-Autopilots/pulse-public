// API-PLATFORM (owner, 5 Nov 2026: "complete control of Pulse through the API"): slice 1 on real PostgreSQL and tenant
// row security. Projects CRUD, the finance ledger (read, record an expense), HR (leave read and file, attendance read),
// their MCP tools, the new finance and hr areas on keys (a key without them is refused; keys made before keep their
// reach), the role rules underneath (a member's token never reads the ledger; an AI member never records money or files
// leave) and the company's API tier where keys are made. Synthetic people and figures only.
// Run by tests/core/test_api_platform.py.
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
async function api(token, method, url, payload, { key, status } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  if (method !== 'GET') headers['idempotency-key'] = key ?? randomUUID();
  const r = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });
  if (status !== undefined) { assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`); checks++; }
  return { status: r.statusCode, body: json(r) };
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
const WORK = ['tasks.read', 'tasks.write', 'projects.read', 'projects.write', 'people.read', 'search.read'];

try {
  // ------------------------------------------------------------------ the new areas on keys, and the plan's tier
  const listed = (await asPerson(W.adminEmail, 'GET', '/api/v0/api-tokens')).json();
  ok(['finance.read', 'finance.write', 'hr.read', 'hr.write'].every(s => listed.scopes.some(x => x.key === s && x.label !== s)), 'Settings offers finance and hr, in words');
  eq(listed.plan.tier, 'enterprise', 'a company without a plan row keeps everything (grandfathered)');
  const fin = (await makeToken(W.financeEmail, { name: 'Finance ledger script', scopes: ['finance.read', 'finance.write', 'people.read'], days: 7 })).token;
  const founder = (await makeToken(W.founderEmail, { name: 'Founder projects', scopes: [...WORK, 'finance.read'], days: 7 })).token;
  const member = (await makeToken(W.memberEmail, { name: 'Member leave', scopes: ['hr.read', 'hr.write', 'finance.read', 'tasks.read'], days: 7 })).token;
  const workOnly = (await makeToken(W.memberEmail, { name: 'Work only', scopes: ['tasks.read', 'people.read'], days: 7 })).token;
  const bot = (await makeToken(W.adminEmail, { kind: 'bot', name: 'Bhrata ledger (synthetic)', scopes: ['finance.read', 'finance.write', 'hr.read', 'hr.write', 'projects.read'], days: 7, agentId: W.agent })).token;

  // A key made before this slice (people.read only) keeps people/attendance and gains nothing new.
  await get(workOnly, '/api/v1/people/attendance', { status: 200 });
  await get(workOnly, '/api/v1/hr/attendance', { status: 403 });
  await get(workOnly, '/api/v1/finance/entries', { status: 403 });
  await get(null, '/api/v1/finance/entries', { status: 401 });
  await get(null, '/api/v1/hr/leave', { status: 401 });

  // ------------------------------------------------------------------ finance: the ledger and an expense
  const body = { amountPaise: 245000, gstPaise: 37373, date: '2026-11-03', category: 'Software & tools', vendor: 'Synthetic Cloud Ltd', note: 'Synthetic: November plan' };
  const unconfirmed = await post(fin, '/api/v1/finance/expenses', { ...body, confirm: false }, { status: 409 });
  ok(/Confirm first/.test(unconfirmed.body.detail), 'money waits for confirm true and says what would happen');
  const key = randomUUID();
  const made = await post(fin, '/api/v1/finance/expenses', { ...body, confirm: true }, { key, status: 200 });
  const again = await post(fin, '/api/v1/finance/expenses', { ...body, confirm: true }, { key, status: 200 });
  eq(again.body.entry.id, made.body.entry.id, 'the same Idempotency-Key records one expense');
  const e = made.body.entry;
  ok(e.kind === 'expense' && e.direction === 'out' && e.amountPaise === 245000 && e.gstPaise === 37373 && e.source === 'api' && e.changeId === undefined && made.body.changeId, 'recorded as the API, in paise');
  await post(fin, '/api/v1/finance/expenses', { ...body, amountPaise: 1, confirm: true, orgId: W.org }, { status: 400 });   // closed schema
  const ledger = (await get(fin, '/api/v1/finance/entries?month=2026-11', { status: 200 })).body;
  ok(ledger.items.some(x => x.id === e.id) && 'nextCursor' in ledger, 'the ledger lists it, with a cursor');
  const page = (await get(fin, '/api/v1/finance/entries?limit=1', { status: 200 })).body;
  ok(page.items.length === 1, 'limit pages the ledger');
  if (page.nextCursor) await get(fin, `/api/v1/finance/entries?limit=1&cursor=${page.nextCursor}`, { status: 200 });
  await get(fin, `/api/v1/finance/entries?limit=1&kind=income&cursor=${page.nextCursor ?? 'x'.repeat(48)}`, { status: 400 });   // a cursor is bound to its filters
  ok((await get(fin, '/api/v1/finance/expenses?query=synthetic%20cloud', { status: 200 })).body.items.some(x => x.id === e.id), 'list_expenses finds it by vendor');
  ok((await get(fin, '/api/v1/finance/entries?kind=income', { status: 200 })).body.items.every(x => x.kind === 'income'), 'kind filters');
  const one = (await get(fin, `/api/v1/finance/entries/${e.id}`, { status: 200 })).body;
  ok(one.entry.id === e.id && Array.isArray(one.history), 'get_finance_entry with its history');
  await get(fin, `/api/v1/finance/entries/${randomUUID()}`, { status: 404 });
  // The role underneath: the founder (leadership) reads; a member holding finance.read does not; an AI member records no money.
  await get(founder, '/api/v1/finance/entries', { status: 200 });
  await get(member, '/api/v1/finance/entries', { status: 403 });
  await get(bot, '/api/v1/finance/entries', { status: 403 });
  await post(bot, '/api/v1/finance/expenses', { ...body, confirm: true }, { status: 403 });
  await post(founder, '/api/v1/finance/expenses', { ...body, confirm: true }, { status: 403 });   // finance.read only

  // ------------------------------------------------------------------ projects: create, read, update, delete
  const p = (await post(founder, '/api/v1/projects', { name: 'Synthetic API platform pilot', summary: 'Synthetic', dueOn: '2026-12-20' }, { status: 200 })).body.project;
  const upd = await api(founder, 'PATCH', `/api/v1/projects/${p.id}`, { name: 'Synthetic API platform pilot (phase 1)', dueOn: '2026-12-31' }, { status: 200 });
  ok(upd.body.project.name.endsWith('(phase 1)') && upd.body.project.dueOn === '2026-12-31' && upd.body.changed.includes('name') && upd.body.changeId, 'update_project changes only what was sent');
  await api(founder, 'PATCH', `/api/v1/projects/${p.id}`, {}, { status: 400 });
  await api(founder, 'PATCH', `/api/v1/projects/${randomUUID()}`, { name: 'Nobody' }, { status: 404 });
  const memberWork = (await makeToken(W.memberEmail, { name: 'Member projects', scopes: ['projects.read', 'projects.write'], days: 1 })).token;
  ok([403, 404].includes((await api(memberWork, 'PATCH', `/api/v1/projects/${p.id}`, { name: 'Not mine' })).status), 'a member does not change someone else\'s project');
  ok([403, 404].includes((await api(memberWork, 'DELETE', `/api/v1/projects/${p.id}?confirm=true`)).status), 'nor deletes it');
  const ask = await api(founder, 'DELETE', `/api/v1/projects/${p.id}`, undefined, { status: 409 });
  ok(/Confirm first/.test(ask.body.detail), 'delete waits for confirm=true');
  const del = await api(founder, 'DELETE', `/api/v1/projects/${p.id}?confirm=true&note=Synthetic%20cleanup`, undefined, { status: 200 });
  ok(del.body.deleted && del.body.restoreUntil > new Date().toISOString(), 'deleted, restorable');
  await get(founder, `/api/v1/projects/${p.id}`, { status: 404 });

  // ------------------------------------------------------------------ HR: leave types, ask for leave, read it, attendance
  const types = (await get(member, '/api/v1/hr/leave/types', { status: 200 })).body.items;
  ok(types.some(t => t.key === 'unpaid' && t.active), 'list_leave_types');
  const leaveBody = { kind: 'unpaid', fromDate: W.leaveFrom, toDate: W.leaveTo, reason: 'Synthetic: family function' };
  const leave = await post(member, '/api/v1/hr/leave', leaveBody, { status: 200 });
  ok(leave.body.leave.status === 'pending' && leave.body.leave.personId === W.member && leave.body.leave.days > 0 && leave.body.changeId, 'request_leave files it as the person, pending');
  await post(member, '/api/v1/hr/leave', leaveBody, { status: 409 });   // overlapping leave, the screen's rule
  await post(member, '/api/v1/hr/leave', { ...leaveBody, kind: 'sabbatical_x' }, { status: 400 });
  await post(member, '/api/v1/hr/leave', { ...leaveBody, personId: W.founder }, { status: 403 });   // only HR files for someone
  const mine = (await get(member, '/api/v1/hr/leave', { status: 200 })).body.items;
  ok(mine.some(l => l.id === leave.body.leave.id) && mine.every(l => l.personId === W.member), 'list_leave_requests: mine');
  ok((await get(member, '/api/v1/hr/leave?who=everyone', { status: 200 })).body.items.every(l => l.personId === W.member), 'a member sees only their own leave, whatever they ask');
  await post(bot, '/api/v1/hr/leave', leaveBody, { status: 403 });   // an AI member takes no leave
  const att = (await get(member, `/api/v1/hr/attendance?from=2026-11-01&to=2026-11-05`, { status: 200 })).body;
  ok(att.items.every(x => x.personId === W.member), 'list_attendance: mine');
  await get(member, '/api/v1/hr/attendance?from=2026-01-01&to=2026-12-31', { status: 400 });

  // ------------------------------------------------------------------ MCP: the same operations as named tools
  const tools = (await rpc(fin, 'tools/list')).tools.map(t => t.name);
  ok(['list_finance_entries', 'list_expenses', 'get_finance_entry', 'record_expense'].every(n => tools.includes(n)) && !tools.includes('request_leave'), 'a finance key sees the ledger tools only');
  const hrTools = (await rpc(member, 'tools/list')).tools;
  ok(['list_leave_requests', 'list_leave_types', 'request_leave', 'list_attendance'].every(n => hrTools.some(t => t.name === n)), 'an hr key sees the HR tools');
  const pt = (await rpc(founder, 'tools/list')).tools;
  ok(pt.some(t => t.name === 'update_project') && pt.find(t => t.name === 'delete_project')?.annotations?.destructiveHint === true, 'delete_project is marked destructive');
  const viaMcp = await rpc(member, 'tools/call', { name: 'list_leave_types', arguments: {} });
  ok(!viaMcp.isError && viaMcp.structuredContent.items.length === types.length, 'list_leave_types over MCP');
  const mcpExpense = await rpc(fin, 'tools/call', { name: 'record_expense', arguments: { amountPaise: 9900, date: '2026-11-04', vendor: 'Synthetic Tea Stall', confirm: false } });
  ok(mcpExpense.isError && mcpExpense.structuredContent.status === 409, 'record_expense over MCP asks for confirm');

  // ------------------------------------------------------------------ the reference
  const doc = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
  ok(doc.paths['/api/v1/finance/expenses']?.post?.security?.[0]?.bearer?.[0] === 'finance.write' && doc.paths['/api/v1/hr/leave']?.get
    && doc.paths['/api/v1/projects/{projectId}']?.delete, 'openapi lists the new operations with their areas');

  console.log(JSON.stringify({ ok: true, checks }));
} finally {
  await app.close();
  await pool.end();
}
