// AI-TOOLS-FIX (17 Nov 2026; EA bugs #25 and #31): an AI employee's Pulse tools over /api/v1/mcp on real PostgreSQL and
// row security (driven by tests/core/test_ai_tools_fix.py), with its own key (pak_) and with the token of a company-server
// job it asked for (pmt_). Synthetic people only.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { attachV1Seam } from '../dist/v1.js';

const { TEST_KEY: key, TEST_JOB_TOKEN: jobToken, TEST_PERSON: person, TEST_EMAIL: email, TEST_AGENT: agent } = process.env;
const seen = [];
attachV1Seam({ before: async ({ principal }, op) => { seen.push(`${op.operationId}:${principal.kind}:${principal.id}`); }, after: async (_c, _o, _i, answer) => answer });
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 3 });
// TEAM-TELEMETRY: SQL statements the API sends, to compare what an MCP call costs.
let queries = 0;
pool.on('connect', (client) => { const query = client.query.bind(client); client.query = (...a) => { queries += 1; return query(...a); }; });
const app = createApp(pool, pool);
for (const level of ['info', 'warn', 'error']) app.log[level] = () => {};
app.log.child = () => app.log;

/** One JSON-RPC call, as services/coworker/pulse-tools.mjs mcpCall sends it (a JSON or an SSE answer). */
async function mcp(bearer, method, params = {}, extra = {}) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/mcp', payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra } });
  let j = null;
  try { j = JSON.parse(r.body); } catch {
    const data = r.body.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean).at(-1);
    j = data ? JSON.parse(data) : null;
  }
  return { status: r.statusCode, j };
}
const tool = async (bearer, name, args = {}) => {
  const { status, j } = await mcp(bearer, 'tools/call', { name, arguments: args });
  assert.equal(status, 200, `${name}: ${JSON.stringify(j)}`);
  const text = (j?.result?.content ?? []).map(c => c.text).join('');
  return { error: !!j?.result?.isError, data: j?.result?.structuredContent ?? (text ? JSON.parse(text) : null), text };
};

try {
  // TEAM-TELEMETRY (21 Nov 2026): only tools/list works out every tool's availability. initialize and a refused
  // server/discover (a newer client's first try, protocol 2026-07-28) are still authenticated, but cheap.
  const cost = async (f) => { const before = queries; const r = await f(); return { ...r, n: queries - before }; };
  const init = await cost(() => mcp(key, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } }));
  assert.equal(init.status, 200, `initialize ${JSON.stringify(init.j)}`);
  assert.equal(init.j?.result?.protocolVersion, '2025-11-25');
  const listing = await cost(() => mcp(key, 'tools/list'));
  assert.equal(listing.status, 200);
  assert.ok((listing.j?.result?.tools ?? []).length > 5, 'tools/list still lists the tools');
  const discover = await cost(() => mcp(key, 'server/discover', {}, { 'mcp-protocol-version': '2026-07-28' }));
  assert.equal(discover.status, 400, 'a protocol this server does not speak is refused as before');
  assert.match(String(discover.j?.error?.message), /Unsupported protocol version: 2026-07-28/);
  assert.ok(init.n * 3 < listing.n && discover.n * 3 < listing.n, `queries: initialize ${init.n}, server/discover ${discover.n}, tools/list ${listing.n}`);
  const stranger = await mcp('pak_' + 'x'.repeat(40), 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } });
  assert.ok([401, 403].includes(stranger.status), `an unknown key is still refused on initialize: ${stranger.status}`);
  console.log(`TEAM-TELEMETRY mcp queries: initialize ${init.n}, server/discover ${discover.n}, tools/list ${listing.n}`);

  for (const [label, bearer] of [['its own key', key], ['its company-server job token', jobToken]]) {
    // EA bug #25: tools/list answered 403 "This key has no API v1 area grants here" for every AI employee's job token.
    const listed = await mcp(bearer, 'tools/list');
    assert.equal(listed.status, 200, `${label}: tools/list ${JSON.stringify(listed.j)}`);
    const names = new Set((listed.j?.result?.tools ?? []).map(t => t.name));
    for (const n of ['search_people', 'get_person', 'list_attendance', 'list_leave_requests', 'list_tasks']) assert.ok(names.has(n), `${label}: ${n} is listed`);
    if (bearer === jobToken) assert.ok(!names.has('request_leave') && !names.has('update_task'), 'a job token lists read tools only');

    // EA bug #31: search_people answered 403 "Sign in as a person to do this" for an AI employee. It sees what any
    // colleague sees: names, roles and work emails; never a phone (HR and admins only).
    const found = await tool(bearer, 'search_people', { query: 'synthetic' });
    assert.equal(found.error, false, `${label}: search_people ${found.text}`);
    const row = found.data.items.find(i => i.id === person);
    assert.ok(row, `${label}: the colleague is found`);
    assert.equal(row.workEmail, email); assert.equal(row.phone, null, 'no phone for an AI employee');
    const one = await tool(bearer, 'get_person', { personId: person });
    assert.equal(one.error, false, one.text); assert.equal(one.data.person.workEmail, email); assert.equal(one.data.signIn, null, 'no sign-in state (HR only)');

    // Attendance and leave as its person may see them: its own (none); not a colleague's, who is no report of its.
    for (const name of ['list_attendance', 'attendance']) {
      const att = await tool(bearer, name, { who: 'team' });
      assert.equal(att.error, false, `${label}: ${name} ${att.text}`);
      assert.ok(!att.data.items.some(i => i.personId === person), `${label}: ${name} shows no colleague it may not see`);
    }
    const leave = await tool(bearer, 'list_leave_requests', { who: 'everyone' });
    assert.equal(leave.error, false, `${label}: list_leave_requests ${leave.text}`);

    // What only a person does stays refused: its change list and undo (person-only), filing leave (staff only).
    const mine = await tool(bearer, 'list_my_changes');
    assert.equal(mine.error, true, `${label}: list_my_changes must stay person-only`); assert.match(mine.text, /Sign in as a person/);
  }
  const filed = await tool(key, 'request_leave', { kind: 'casual', fromDate: '2026-12-01', toDate: '2026-12-01' });
  assert.equal(filed.error, true, 'an AI employee files no leave'); assert.match(filed.text, /for staff/);

  // Every call ran as the AI employee itself, an 'ai' principal, with either bearer.
  const ran = seen.filter(s => s.startsWith('searchPeople:'));
  assert.equal(ran.length, 2, JSON.stringify(seen));
  assert.ok(ran.every(s => s === `searchPeople:ai:${agent}`), JSON.stringify(ran));
  console.log('ai-tools-fix runner: ok', seen.length, 'calls');
} finally {
  await app.close();
  await pool.end();
}
