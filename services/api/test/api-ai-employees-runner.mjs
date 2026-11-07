// API-PLATFORM-2: the AI-employee admin API on real PostgreSQL and tenant row security (migration 1596). A company
// admin, with their own key, adds an AI employee, sets its tools and caps, makes it a bot key with chosen areas, sees
// the key used in its activity, and revokes it (confirm first). Members, AI members' keys and keys without people.write
// are refused; an AI employee's key never makes keys. Over REST and MCP. Synthetic data only.
// Run by tests/core/test_api_ai_employees.py.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
const { createApp } = await import('../dist/app.js');

const W = JSON.parse(process.env.TEST_W);
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 4 }), app = createApp(pool, pool);
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const json = r => { try { return r.json(); } catch { return r.body; } };
const asPerson = (email, method, url, payload) => app.inject({ method, url, headers: { 'cf-access-authenticated-user-email': email }, ...(payload ? { payload } : {}) });
async function api(token, method, url, payload, status) {
  const h = { authorization: `Bearer ${token}` };
  if (method !== 'GET') h['idempotency-key'] = randomUUID();
  const r = await app.inject({ method, url, headers: h, ...(payload !== undefined ? { payload } : {}) });
  if (status !== undefined) { assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`); checks++; }
  return { status: r.statusCode, body: json(r) };
}
async function rpc(token, method, params = {}) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/mcp', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    payload: { jsonrpc: '2.0', id: 1, method, params } });
  const v = r.body.split('\n').filter(s => s.startsWith('data:')).map(s => JSON.parse(s.slice(5))).find(x => x.id === 1);
  return v.result ?? v;
}
async function makeToken(email, body) {
  const r = await asPerson(email, 'POST', '/api/v0/api-tokens', body);
  assert.equal(r.statusCode, 201, r.body); checks++;
  return r.json().token;
}
const BASE = '/api/v1/people/ai-employees';

try {
  const admin = await makeToken(W.adminEmail, { name: 'AI admin (synthetic)', scopes: ['people.read', 'people.write', 'tasks.read'], days: 7 });
  const readOnly = await makeToken(W.adminEmail, { name: 'AI admin read (synthetic)', scopes: ['people.read'], days: 7 });
  const member = await makeToken(W.memberEmail, { name: 'Member (synthetic)', scopes: ['people.read', 'people.write'], days: 7 });
  const bot = await makeToken(W.adminEmail, { kind: 'bot', name: 'Existing bot (synthetic)', scopes: ['people.read', 'people.write'], days: 7, agentId: W.agent });

  // Who may: company admins with their own key.
  await api(member, 'GET', BASE, undefined, 403);
  await api(bot, 'GET', BASE, undefined, 403);
  await api(member, 'POST', BASE, { name: 'Synthetic Helper', title: 'Helper' }, 403);
  await api(readOnly, 'POST', BASE, { name: 'Synthetic Helper', title: 'Helper' }, 403);
  const before = (await api(admin, 'GET', BASE, undefined, 200)).body.items;
  ok(before.some(a => a.id === W.agent), 'admins list the AI employees');

  // Create, then set its tools, budget and monthly cap.
  const made = (await api(admin, 'POST', BASE, { name: 'Synthetic Ledger Aide', title: 'Ledger aide', lane: 'quick', tools: ['chats', 'tasks'], monthlyTokenCap: 50000 }, 200)).body.aiEmployee;
  ok(made.name === 'Synthetic Ledger Aide' && made.tools.includes('tasks') && made.monthlyTokenCap === 50000 && made.liveKeys === 0, 'created with tools and a cap, no key');
  await api(admin, 'POST', BASE, { name: 'X', title: 'Y', tools: ['rocket'] }, 400);
  const changed = (await api(admin, 'PATCH', `${BASE}/${made.id}`, { tools: ['chats', 'tasks', 'memory'], dailyTokenBudget: 20000, monthlyTokenCap: 5000 }, 200)).body.aiEmployee;
  ok(changed.tools.length === 3 && changed.dailyTokenBudget === 20000 && changed.monthlyTokenCap === 5000, 'tools, budget and cap changed');
  ok((await api(admin, 'PATCH', `${BASE}/${made.id}`, { monthlyTokenCap: null }, 200)).body.aiEmployee.monthlyTokenCap === null, 'null removes the cap');
  await api(admin, 'PATCH', `${BASE}/${made.id}`, { monthlyTokenCap: 5000 }, 200);
  await api(admin, 'PATCH', `${BASE}/${randomUUID()}`, { tools: ['chats'] }, 404);
  await api(member, 'PATCH', `${BASE}/${made.id}`, { tools: ['chats'] }, 403);

  // Keys: made with chosen areas, the secret once; used; seen in its activity; revoked with confirm.
  const k = (await api(admin, 'POST', `${BASE}/${made.id}/keys`, { name: 'Aide key (synthetic)', scopes: ['tasks.read', 'people.read', 'people.write'], days: 7 }, 200)).body;
  ok(/^pbk_/.test(k.token) && k.key.live && k.key.scopes.includes('tasks.read') && !JSON.stringify(k.key).includes(k.token), 'a key with its areas; the secret once');
  await api(k.token, 'GET', '/api/v1/tasks?limit=1', undefined, 200);
  await api(k.token, 'GET', '/api/v1/finance/entries', undefined, 403);   // not one of its areas
  await api(k.token, 'POST', `${BASE}/${made.id}/keys`, { name: 'Self-made', scopes: ['tasks.read'], days: 7 }, 403);   // a key never makes keys
  await api(k.token, 'GET', BASE, undefined, 403);
  const keys = (await api(admin, 'GET', `${BASE}/${made.id}/keys`, undefined, 200)).body.items;
  ok(keys.length === 1 && keys[0].id === k.key.id && !JSON.stringify(keys).includes('pbk_'), 'its keys, never a secret');
  const act = (await api(admin, 'GET', `${BASE}/${made.id}/activity?days=7`, undefined, 200)).body;
  ok(act.calls.some(c => c.operationId === 'listTasks' && c.status === 200) && act.refused >= 1 && act.monthlyTokenCap === 5000, `its activity (${JSON.stringify(act.calls)})`);
  await api(admin, 'GET', `${BASE}/${made.id}/activity?days=0`, undefined, 400);
  await api(admin, 'DELETE', `${BASE}/${made.id}/keys/${k.key.id}`, undefined, 409);
  await api(k.token, 'GET', '/api/v1/tasks?limit=1', undefined, 200);   // still live until confirmed
  await api(admin, 'DELETE', `${BASE}/${made.id}/keys/${k.key.id}?confirm=true`, undefined, 200);
  ok([401, 403].includes((await api(k.token, 'GET', '/api/v1/tasks?limit=1')).status), 'revoked at once');
  await api(admin, 'DELETE', `${BASE}/${made.id}/keys/${k.key.id}?confirm=true`, undefined, 404);

  // MCP: the same operations as named tools.
  const tools = (await rpc(admin, 'tools/list')).tools.map(x => x.name);
  ok(['list_ai_employees', 'create_ai_employee', 'update_ai_employee', 'get_ai_employee_activity', 'list_ai_employee_keys', 'create_ai_employee_key', 'revoke_ai_employee_key'].every(n => tools.includes(n)), 'the MCP tools');
  const viaMcp = await rpc(admin, 'tools/call', { name: 'list_ai_employees', arguments: {} });
  ok(!viaMcp.isError && viaMcp.structuredContent.items.some(a => a.id === made.id), 'list_ai_employees over MCP');
  const doc = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
  ok(doc.paths[`${BASE}/{agentId}/keys`]?.post?.security?.[0]?.bearer?.[0] === 'people.write', 'openapi');

  console.log(JSON.stringify({ ok: true, checks, agentId: made.id }));
} finally {
  await app.close();
  await pool.end();
}
