// EST-1363: the Sales X-Ray app's API against a fictional Sales X-Ray. The database function (0710 pulse.sales_xray) is
// stood in for here, op for op; tests/core/test_sales_xray_app.py runs the real one. Checks: Pulse registers itself
// once, Connect sends PKCE S256 and a state bound to the person, the callback swaps the code with the verifier and seals
// the tokens, reads go as the person, an expiring token is refreshed, a dead connection is dropped, the MCP gateway
// forwards one message, disconnect revokes, Ask stays off until switched on, and an accountant is refused.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { registerSalesXrayRoutes, salesXrayBase } from '../dist/sales-xray.js';

const dir = mkdtempSync(join(tmpdir(), 'sx-keys-'));
writeFileSync(join(dir, 'ring'), `k1 ${randomBytes(32).toString('base64')}\n`);
chmodSync(join(dir, 'ring'), 0o600);
process.env.PULSE_DOCUMENT_KEY_FILE = join(dir, 'ring');
process.env.PULSE_PUBLIC_URL = 'https://pulse.example.test';
process.env.PULSE_SALES_XRAY_URL = 'https://salesxray.example.test';
delete process.env.PULSE_SALES_XRAY_ASK;
process.env.PULSE_SALES_XRAY = '1'; // the module on, as on pulse-dev (a save's push checks the switch)

const ORG = '00000000-0000-4000-8000-000000001363', PERSON = '00000000-0000-4000-8000-000000000001';
const CALL = '00000000-0000-4000-8000-0000000000c1';
const sha = (s) => createHash('sha256').update(s).digest('hex');
// What pulse.workflow holds for the company (the query already leaves out client workflows and archived ones).
const WORKFLOWS = [
  { id: '00000000-0000-4000-8000-0000000000f1', name: 'Fictional sales pipeline', updated_at: '2026-10-20T05:00:00Z', definition: { steps: [
    { id: 's1', title: 'Capture the lead', kind: 'task', module: 'lead_capture', personId: '00000000-0000-4000-8000-0000000000aa', role: 'Sales' },
    { id: 's2', title: 'Site visit', kind: 'task', module: 'site_visit' },
    { id: 'bad id with spaces', title: 'Ignored step', kind: 'task' },
    { id: 's3', title: 'Approve the quote', kind: 'approval' }] } },
  { id: '00000000-0000-4000-8000-0000000000f2', name: 'Empty draft', updated_at: '2026-10-19T05:00:00Z', definition: { steps: [] } },
];

/** pulse.sales_xray(op, b) for one company, the same rules as 0710: everything is the viewer's own. */
function database() {
  // NAV-CONNECT: the company the request is in (pulse.org under its row security), and the lead-sync stops.
  const db = { clients: new Map(), attempts: new Map(), links: new Map(), audit: [], org: { id: ORG, name: 'Fictional Homes', handle: 'fictionalhomes' }, syncStops: [] };
  const fn = (viewer, op, b) => {
    const me = viewer.person, key = `${b.base}|${b.redirectUri}`;
    if (op === 'client') { const c = db.clients.get(key); return c ? { clientId: c.clientId, secret: c.secret } : null; }
    if (op === 'client_save') { if (!db.clients.has(key)) db.clients.set(key, { clientId: b.clientId, secret: b.secret }); const c = db.clients.get(key); return { clientId: c.clientId, secret: c.secret }; }
    if (op === 'begin') { for (const [k, a] of db.attempts) if (a.person === me) db.attempts.delete(k); db.attempts.set(b.stateHash, { person: me, verifier: b.verifier, base: b.base, redirectUri: b.redirectUri }); return { ok: true }; }
    if (op === 'take') { const a = db.attempts.get(b.stateHash); if (!a || a.person !== me) return { error: 'state_invalid' }; db.attempts.delete(b.stateHash); return { verifier: a.verifier, base: a.base, redirectUri: a.redirectUri }; }
    if (op === 'link' || op === 'lock') return db.links.get(me) ?? null;
    if (op === 'save') { db.links.set(me, { base: b.base, redirectUri: b.redirectUri, access: b.access, accessExpiresAt: b.accessExpiresAt, refresh: b.refresh, scopes: b.scopes, account: b.account, connectedAt: new Date().toISOString() }); db.audit.push('sales_xray_connected'); return { ok: true }; }
    if (op === 'refreshed') { const l = db.links.get(me); Object.assign(l, { access: b.access, accessExpiresAt: b.accessExpiresAt, refresh: b.refresh }); return { ok: true }; }
    if (op === 'used') return { ok: true };
    if (op === 'drop') { if (db.links.delete(me)) db.audit.push('sales_xray_disconnected'); return { ok: true }; }
    if (op === 'status') { const l = db.links.get(me); return l ? { connected: true, base: l.base, scopes: l.scopes, account: l.account, connectedAt: l.connectedAt } : { connected: false }; }
    throw new Error(`unknown op ${op}`);
  };
  return { db, client: (viewer) => ({ query: async (sql, params) => {
    if (sql.includes('pulse.sales_xray(')) return { rows: [{ d: fn(viewer, params[0], JSON.parse(params[1])) }] };
    if (sql.includes('pulse.auth_allow')) return { rows: [{ ok: true }] };
    if (sql.includes('from pulse.org where id = pulse.current_org()')) return { rows: [{ ...db.org }] };
    if (sql.includes('update pulse.sales_xray_sync set enabled=false')) { db.syncStops.push(params); return { rows: [], rowCount: 1 }; }
    if (sql.includes('from pulse.workflow w')) return { rows: WORKFLOWS };
    // DE-EA: Sales X-Ray is a company-chosen module: this company's document switches it on (the server offers it).
    if (sql.includes("doc_key='modules'")) return { rows: [{ body: { off: [], on: ['sales_xray'] } }] };
    throw new Error(`unexpected SQL ${sql}`);
  } }) };
}

/** A fictional Sales X-Ray: registration, the token endpoint (code and refresh), revoke, the API and MCP. */
function salesXray() {
  // Sales X-Ray before 1.3.0 granted the first four scopes only; a test sets the full list to play 1.3.0.
  const sx = { workspace: { name: 'Fictional Homes', kind: 'organisation', role: 'member' }, scope: 'calls:read leads:read leads:write reports:read', registered: 0, codes: new Map(), access: new Set(), refresh: new Set(), revoked: [], calls: [], refreshFails: false, catalogues: [], ownerOnly: false };
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const tokens = () => { const a = `sxa_${randomBytes(30).toString('hex').slice(0, 40)}`, r = `sxr_${randomBytes(30).toString('hex').slice(0, 48)}`; sx.access.add(a); sx.refresh.add(r); return { access_token: a, refresh_token: r, expires_in: 3600, scope: sx.scope, token_type: 'Bearer' }; };
  const fetchImpl = async (url, init) => {
    const u = new URL(url), headers = init.headers ?? {};
    assert.equal(init.redirect, 'error', 'Pulse never follows a redirect from Sales X-Ray');
    sx.calls.push(`${init.method} ${u.pathname}`);
    if (u.pathname === '/v1/oauth/register') {
      sx.registered += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.client_name, 'Pulse');
      assert.deepEqual(body.redirect_uris, ['https://pulse.example.test/apps/sales-xray/callback']);
      return json(201, { client_id: 'sxc_' + 'A'.repeat(24), client_secret: 'sxcs_' + 'B'.repeat(40) });
    }
    if (u.pathname === '/v1/oauth/token') {
      assert.equal(headers.authorization, `Basic ${Buffer.from(`sxc_${'A'.repeat(24)}:sxcs_${'B'.repeat(40)}`).toString('base64')}`);
      const form = new URLSearchParams(init.body);
      if (form.get('grant_type') === 'authorization_code') {
        const want = sx.codes.get(form.get('code'));
        if (!want || createHash('sha256').update(form.get('code_verifier')).digest('base64url') !== want.challenge || form.get('redirect_uri') !== want.redirect) return json(400, { error: 'invalid_grant' });
        sx.codes.delete(form.get('code'));
        return json(200, tokens());
      }
      if (sx.refreshFails || !sx.refresh.delete(form.get('refresh_token'))) return json(400, { error: 'invalid_grant' });
      return json(200, tokens());
    }
    if (u.pathname === '/v1/oauth/revoke') { sx.revoked.push(new URLSearchParams(init.body).get('token')); return new Response(null, { status: 200 }); }
    const bearer = String(headers.authorization ?? '').replace(/^Bearer /, '');
    if (!sx.access.has(bearer)) return json(401, { error: { code: 'key_invalid', message: 'This API key is wrong, expired or revoked.' } });
    if (u.pathname === '/v1/api/me') return json(200, { reach: 'person', person: { name: 'Fictional Seller' }, workspace: sx.workspace });
    if (u.pathname === '/v1/api/calls') return json(200, { calls: [{ id: CALL, title: 'Fictional discovery call', created_at: '2026-10-19T10:00:00Z', duration_seconds: 600, has_report: true, open_url: 'https://salesxray.example.test/analysis/calls/' + CALL }], next_before: null });
    if (u.pathname === '/v1/api/leads') return u.searchParams.get('stage') === 'won' ? json(403, { error: { code: 'organisation_only', message: 'Leads are kept in organisations, not Personal.' } }) : json(200, { leads: [], total: 0, next_offset: null });
    if (u.pathname === '/v1/api/lead-journey/catalogue') {
      assert.equal(init.method, 'PUT');
      if (sx.ownerOnly) return json(403, { error: { code: 'owner_only', message: 'Owners and admins only.' } });
      const body = JSON.parse(init.body); sx.catalogues.push(body);
      return json(200, { kept: body.workflows.reduce((n, w) => n + w.steps.length, 0), offered: 1 });
    }
    if (u.pathname === '/v1/mcp') { const m = JSON.parse(init.body); return m.id === undefined ? new Response(null, { status: 202 }) : json(200, { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'list_calls' }] } }); }
    return json(404, { error: { code: 'nope', message: 'No such path' } });
  };
  return { sx, fetchImpl };
}

function world({ role = 'person', asker, extraRoutes, rollback = false } = {}) {
  const { db, client } = database(), { sx, fetchImpl } = salesXray();
  const viewer = { email: 'seller@example.test', org: ORG, person: PERSON, role, name: 'Fictional Seller', pod: null, via: 'password', username: 'seller', mustChange: false };
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => reply.code(error.statusCode ?? 500).send({ error: error.message }));
  // SX-NEXUS: `rollback` plays routes.ts's tx() faithfully: a request that throws leaves the connections as they were.
  const tx = rollback
    ? async (_req, run) => { const saved = structuredClone(db.links); try { return await run(client(viewer), viewer); } catch (e) { db.links = saved; throw e; } }
    : async (_req, run) => run(client(viewer), viewer);
  registerSalesXrayRoutes(app, { tx, fetchImpl, asker, catalogueDelayMs: 20 });
  if (extraRoutes) extraRoutes(app);
  const inject = (method, url, payload) => app.inject({ method, url, headers: { 'x-pulse-host': 'pulse.example.test' }, ...(payload ? { payload } : {}) });
  /** Play the person at Sales X-Ray: approve the consent and come back with a code. */
  const consent = async () => {
    const started = await inject('POST', '/api/v0/sales-xray/connect', {});
    assert.equal(started.statusCode, 200, started.body);
    const url = new URL(started.json().url), code = `sxo_${'C'.repeat(40)}`;
    sx.codes.set(code, { challenge: url.searchParams.get('code_challenge'), redirect: url.searchParams.get('redirect_uri') });
    return { url, code, state: url.searchParams.get('state') };
  };
  return { app, db, sx, inject, consent };
}

test('the return address is the Pulse address the person opened', async () => {
  const { returnAddress } = await import('../dist/sales-xray.js');
  assert.equal(returnAddress({ headers: { 'x-pulse-host': 'pulse-dev.example.test' } }), 'https://pulse-dev.example.test/apps/sales-xray/callback');
  assert.equal(returnAddress({ headers: { 'x-pulse-host': 'demo.localhost:3200' } }), 'http://demo.localhost:3200/apps/sales-xray/callback');
  assert.equal(returnAddress({ headers: { 'x-pulse-host': 'not a host' } }), 'https://pulse.example.test/apps/sales-xray/callback', 'else the install’s own address');
});

test('the Sales X-Ray address must be an https origin (or loopback http)', () => {
  assert.equal(salesXrayBase({ PULSE_SALES_XRAY_URL: 'https://salesxray-dev.example.test' }), 'https://salesxray-dev.example.test');
  assert.equal(salesXrayBase({ PULSE_SALES_XRAY_URL: 'http://127.0.0.1:8101' }), 'http://127.0.0.1:8101');
  for (const bad of ['http://salesxray.example.test', 'https://salesxray.example.test/v1', 'https://u:p@salesxray.example.test', 'nonsense', ''])
    assert.equal(salesXrayBase({ PULSE_SALES_XRAY_URL: bad }), null, bad);
});

test('connect, read as the person, refresh, gateway, disconnect', async () => {
  const w = world();
  assert.deepEqual((await w.inject('GET', '/api/v0/sales-xray/status')).json(), { configured: true, ask: false, connected: false, base: 'https://salesxray.example.test', company: { name: 'Fictional Homes', handle: 'fictionalhomes' } });
  assert.equal((await w.inject('GET', '/api/v0/sales-xray/calls')).statusCode, 409, 'nothing to read before Connect');

  const first = await w.consent();
  assert.equal(first.url.origin + first.url.pathname, 'https://salesxray.example.test/connect');
  assert.equal(first.url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(first.url.searchParams.get('scope'), 'calls:read reports:read leads:read leads:write leads:update calls:write');
  assert.match(first.url.searchParams.get('client_id'), /^sxc_/);
  await w.consent(); // a second Connect reuses the registration
  assert.equal(w.sx.registered, 1, 'Pulse registers itself once per company and address');
  assert.equal([...w.db.attempts.values()].length, 1, 'a new Connect replaces the person’s earlier attempt');
  const { code, state } = await w.consent();

  assert.equal((await w.inject('POST', '/api/v0/sales-xray/callback', { code, state: 'someone-else' })).statusCode, 400);
  const back = await w.inject('POST', '/api/v0/sales-xray/callback', { code, state });
  assert.equal(back.statusCode, 200, back.body);
  assert.deepEqual(back.json(), { connected: true, account: { person: 'Fictional Seller', workspace: 'Fictional Homes', kind: 'organisation', role: 'member', company: 'Fictional Homes', confirm: 'yes' },
    company: { name: 'Fictional Homes', handle: 'fictionalhomes' }, workflows: null });
  assert.equal((await w.inject('POST', '/api/v0/sales-xray/callback', { code, state })).statusCode, 400, 'the attempt works once');
  const stored = JSON.stringify([...w.db.links.values(), ...w.db.clients.values()]);
  for (const plain of [...w.sx.access, ...w.sx.refresh, 'sxcs_' + 'B'.repeat(40)]) assert.ok(!stored.includes(plain), 'tokens and the client secret are stored sealed only');
  assert.equal((await w.inject('GET', '/api/v0/sales-xray/status')).json().connected, true);

  const calls = await w.inject('GET', '/api/v0/sales-xray/calls');
  assert.equal(calls.statusCode, 200, calls.body);
  assert.equal(calls.json().calls[0].title, 'Fictional discovery call');
  assert.equal((await w.inject('GET', '/api/v0/sales-xray/calls?before=nope')).statusCode, 400);
  assert.equal((await w.inject('GET', '/api/v0/sales-xray/leads?stage=lost-cause')).statusCode, 400);
  const refused = await w.inject('GET', '/api/v0/sales-xray/leads?stage=won');
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().error, 'Leads are kept in organisations, not Personal.', 'Sales X-Ray’s own words come through');

  // An access token with under a minute left is refreshed first, with the client's secret.
  const link = w.db.links.get(PERSON);
  link.accessExpiresAt = new Date(Date.now() + 10_000).toISOString();
  const before = w.sx.calls.filter((c) => c === 'POST /v1/oauth/token').length;
  assert.equal((await w.inject('GET', '/api/v0/sales-xray/leads')).statusCode, 200);
  assert.equal(w.sx.calls.filter((c) => c === 'POST /v1/oauth/token').length, before + 1);
  assert.ok(Date.parse(w.db.links.get(PERSON).accessExpiresAt) > Date.now() + 3_000_000);

  const listed = await w.inject('POST', '/api/v0/sales-xray/mcp', { jsonrpc: '2.0', id: 7, method: 'tools/list' });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json(), { jsonrpc: '2.0', id: 7, result: { tools: [{ name: 'list_calls' }] } });
  assert.equal((await w.inject('POST', '/api/v0/sales-xray/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode, 202);
  assert.equal((await w.inject('POST', '/api/v0/sales-xray/mcp', { id: 1, method: 'ping' })).statusCode, 400);

  const refresh = [...w.sx.refresh][0];
  assert.equal((await w.inject('POST', '/api/v0/sales-xray/disconnect', {})).statusCode, 200);
  assert.deepEqual(w.sx.revoked, [refresh], 'disconnect ends the connection at Sales X-Ray');
  assert.equal(w.db.links.size, 0);
  assert.deepEqual(w.db.audit, ['sales_xray_connected', 'sales_xray_disconnected']);
});

test('a connection Sales X-Ray ended is dropped and the person is asked to connect again', async () => {
  const w = world();
  const { code, state } = await w.consent();
  await w.inject('POST', '/api/v0/sales-xray/callback', { code, state });
  w.db.links.get(PERSON).accessExpiresAt = new Date(Date.now() - 1000).toISOString();
  w.sx.refreshFails = true;
  const ended = await w.inject('GET', '/api/v0/sales-xray/calls');
  assert.equal(ended.statusCode, 409);
  assert.match(ended.json().error, /connection ended/);
  assert.equal(w.db.links.size, 0);
});

test('SX-NEXUS: a refresh outlives the work after it, so the rotated refresh token is never lost', async () => {
  const w = world({ rollback: true });
  const { code, state } = await w.consent();
  assert.equal((await w.inject('POST', '/api/v0/sales-xray/callback', { code, state })).statusCode, 200);
  const refreshes = () => w.sx.calls.filter((c) => c === 'POST /v1/oauth/token').length - 1; // the first is the code exchange
  assert.equal((await w.inject('GET', '/api/v0/sales-xray/calls')).statusCode, 200);
  assert.equal(refreshes(), 0, 'a token with more than 15 minutes left is used as it is');

  // Under a minute left, and the read after the refresh fails (Sales X-Ray has no such call): that request rolls back.
  w.db.links.get(PERSON).accessExpiresAt = new Date(Date.now() + 10_000).toISOString();
  const missing = await w.inject('GET', '/api/v0/sales-xray/calls/00000000-0000-4000-8000-0000000000c9');
  assert.equal(missing.statusCode, 404, missing.body);
  assert.equal(refreshes(), 1);
  assert.ok(Date.parse(w.db.links.get(PERSON).accessExpiresAt) > Date.now() + 3_000_000, 'the refresh is kept although the read failed');

  // An hour on, the next refresh sends the refresh token Sales X-Ray issued last (the old one is spent): still connected.
  w.db.links.get(PERSON).accessExpiresAt = new Date(Date.now() - 1000).toISOString();
  const later = await w.inject('GET', '/api/v0/sales-xray/calls');
  assert.equal(later.statusCode, 200, later.body);
  assert.equal(refreshes(), 2);
  assert.equal(w.db.links.size, 1, 'still connected');

  // With 10 minutes left the token is refreshed ahead of the work; the MCP gateway does the same.
  w.db.links.get(PERSON).accessExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  assert.equal((await w.inject('GET', '/api/v0/sales-xray/leads')).statusCode, 200);
  assert.equal(refreshes(), 3);
  w.db.links.get(PERSON).accessExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  assert.equal((await w.inject('POST', '/api/v0/sales-xray/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode, 200);
  assert.equal(refreshes(), 4);

  // Sales X-Ray refusing the refresh ends the connection; the end is kept and the person is told.
  w.db.links.get(PERSON).accessExpiresAt = new Date(Date.now() - 1000).toISOString();
  w.sx.refreshFails = true;
  const ended = await w.inject('GET', '/api/v0/sales-xray/leads');
  assert.equal(ended.statusCode, 409);
  assert.match(ended.json().error, /connection ended/);
  assert.equal(w.db.links.size, 0);
  assert.deepEqual(w.db.audit, ['sales_xray_connected', 'sales_xray_disconnected']);
});

test('cancelling at Sales X-Ray connects nothing', async () => {
  const w = world();
  const { state } = await w.consent();
  assert.deepEqual((await w.inject('POST', '/api/v0/sales-xray/callback', { state, error: 'access_denied' })).json(), { connected: false, reason: 'cancelled' });
  assert.equal(w.db.links.size, 0);
});

test('Ask is off until the server switches it on, and then asks with the person’s token', async () => {
  const seen = [];
  const w = world({ asker: async (input) => { seen.push(input); return 'You had one call: Fictional discovery call.'; } });
  const { code, state } = await w.consent();
  await w.inject('POST', '/api/v0/sales-xray/callback', { code, state });
  assert.equal((await w.inject('POST', '/api/v0/sales-xray/ask', { question: 'What happened on my last call?' })).statusCode, 404);
  process.env.PULSE_SALES_XRAY_ASK = '1';
  try {
    assert.equal((await w.inject('POST', '/api/v0/sales-xray/ask', { question: 'x' })).statusCode, 400);
    const asked = await w.inject('POST', '/api/v0/sales-xray/ask', { question: 'What happened on my last call?' });
    assert.equal(asked.statusCode, 200, asked.body);
    assert.equal(asked.json().answer, 'You had one call: Fictional discovery call.');
    assert.equal(seen[0].base, 'https://salesxray.example.test');
    assert.ok(w.sx.access.has(seen[0].token), 'the assistant reads with the person’s own access token');
  } finally { delete process.env.PULSE_SALES_XRAY_ASK; }
});

test('an accountant has no Sales X-Ray app', async () => {
  const w = world({ role: 'accountant' });
  for (const [method, url] of [['GET', '/api/v0/sales-xray/status'], ['POST', '/api/v0/sales-xray/connect']])
    assert.equal((await w.inject(method, url, method === 'POST' ? {} : undefined)).statusCode, 403, url);
});

test('an editor\u2019s workflows go to Sales X-Ray as stage suggestions: names only, on Connect, on request and after a save', async (t) => {
  const w = world({ role: 'admin', extraRoutes: (app) => app.post('/api/v0/workflows/:id', async () => ({ ok: true })) });
  const started = await w.inject('POST', '/api/v0/sales-xray/connect', {});
  assert.match(new URL(started.json().url).searchParams.get('scope'), /leads:write/, 'Pulse asks for leads:write to send stage suggestions');
  const { code, state } = await w.consent();
  const back = await w.inject('POST', '/api/v0/sales-xray/callback', { code, state });
  assert.equal(back.statusCode, 200, back.body);
  assert.equal(back.json().workflows.sent, true);
  assert.match(back.json().workflows.words, /Sent 3 workflow steps/);
  const sent = w.sx.catalogues[0];
  assert.equal(sent.source, 'pulse');
  assert.equal(sent.revision, '2026-10-20T05:00:00.000Z');
  assert.deepEqual(sent.workflows, [{ id: '00000000-0000-4000-8000-0000000000f1', name: 'Fictional sales pipeline', steps: [
    { id: 's1', name: 'Capture the lead', block: 'lead_capture', position: 1 },
    { id: 's2', name: 'Site visit', block: 'site_visit', position: 2 },
    { id: 's3', name: 'Approve the quote', block: 'approval', position: 3 }] }], 'step names only: no people, roles or empty workflows');

  const again = await w.inject('POST', '/api/v0/sales-xray/catalogue', {});
  assert.equal(again.json().sent, true);
  assert.equal(w.sx.catalogues.length, 2);

  // The debounce runs on mocked timers (node:test), so the result never depends on how busy the machine is: the clock
  // moves only when the test ticks it, and the send it starts is in-memory work drained without a wall-clock wait.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal((await w.inject('POST', '/api/v0/workflows/00000000-0000-4000-8000-0000000000f1', {})).statusCode, 200);
  assert.equal((await w.inject('POST', '/api/v0/workflows/00000000-0000-4000-8000-0000000000f1', {})).statusCode, 200);
  assert.equal(w.sx.catalogues.length, 2, 'nothing is sent while the saves keep coming');
  t.mock.timers.tick(20);
  t.mock.timers.reset();
  for (let i = 0; i < 10_000 && w.sx.catalogues.length < 3; i++) await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));   // a second, late send would land here
  assert.equal(w.sx.catalogues.length, 3, 'two quick saves send once, after the last');

  w.sx.ownerOnly = true;
  const refused = await w.inject('POST', '/api/v0/sales-xray/catalogue', {});
  assert.equal(refused.statusCode, 200);
  assert.deepEqual([refused.json().sent, refused.json().reason], [false, 'owner_only']);
});

test('only leadership and admins send workflows; a person\u2019s Connect sends nothing', async () => {
  const w = world({ role: 'person' });
  const { code, state } = await w.consent();
  const back = await w.inject('POST', '/api/v0/sales-xray/callback', { code, state });
  assert.equal(back.json().workflows, null);
  assert.equal((await w.inject('POST', '/api/v0/sales-xray/catalogue', {})).statusCode, 403);
  assert.equal(w.sx.catalogues.length, 0);
});

test('a connection made before leads:update and calls:write reads on and is asked to reconnect', async () => {
  const w = world();
  let { code, state } = await w.consent();
  assert.equal((await w.inject('POST', '/api/v0/sales-xray/callback', { code, state })).statusCode, 200);
  const old = (await w.inject('GET', '/api/v0/sales-xray/status')).json();
  assert.equal(old.connected, true);
  assert.deepEqual(old.missing, ['leads:update', 'calls:write'], 'the page shows Reconnect to allow updates');
  assert.equal((await w.inject('GET', '/api/v0/sales-xray/calls')).statusCode, 200, 'reading still works');
  w.sx.scope = 'calls:read calls:write leads:read leads:update leads:write reports:read'; // Sales X-Ray 1.3.0
  ({ code, state } = await w.consent());
  assert.equal((await w.inject('POST', '/api/v0/sales-xray/callback', { code, state })).statusCode, 200);
  assert.deepEqual((await w.inject('GET', '/api/v0/sales-xray/status')).json().missing, [], 'reconnected: nothing missing');
});

// NAV-CONNECT (owner, 17 Nov 2026: "When I connect from Estate Autopilots it opens salesxray.atlascrest.in, and there
// it opens Vitals Technology instead"). Synthetic companies only.
test('Connect tells Sales X-Ray which company it is for, and the consent address says so', async () => {
  const w = world();
  w.db.org = { id: ORG, name: 'Fictional Estates', handle: 'fictionalestates' };
  const { url } = await w.consent();
  assert.equal(url.searchParams.get('workspace_hint'), 'Fictional Estates');
  assert.equal(url.searchParams.get('pulse_org_name'), 'Fictional Estates');
  assert.equal(url.searchParams.get('pulse_org_hint'), 'fictionalestates');
  const started = await w.inject('POST', '/api/v0/sales-xray/connect', {});
  assert.deepEqual(started.json().company, { name: 'Fictional Estates', handle: 'fictionalestates' }, 'the page can name the company');
  const { companyHints } = await import('../dist/sales-xray.js');
  assert.deepEqual(companyHints({ id: ORG, name: 'X', handle: null }, { PULSE_SALES_XRAY_HINTS: '0' }), {}, 'the hints can be switched off');
});

test('another organisation\u2019s workspace is held: nothing reads through it until the person says it is right', async () => {
  const w = world({ role: 'leadership' });
  w.db.org = { id: ORG, name: 'Fictional Estates', handle: 'fictionalestates' };
  w.sx.workspace = { name: 'Fictional Technologies', kind: 'organisation', role: 'owner' };
  const { code, state } = await w.consent();
  const back = await w.inject('POST', '/api/v0/sales-xray/callback', { code, state });
  assert.equal(back.statusCode, 200, back.body);
  assert.equal(back.json().connected, false, 'not connected yet');
  assert.deepEqual(back.json().check, { company: 'Fictional Estates', workspace: 'Fictional Technologies', kind: 'organisation', match: 'no' });
  assert.equal(w.sx.catalogues.length, 0, 'no workflows went to another organisation');
  const status = (await w.inject('GET', '/api/v0/sales-xray/status')).json();
  assert.equal(status.check, true); assert.equal(status.match, 'no');
  for (const path of ['calls', 'leads']) {
    const held = await w.inject('GET', `/api/v0/sales-xray/${path}`);
    assert.equal(held.statusCode, 409, path);
    assert.match(held.json().error, /Say which Sales X-Ray organisation is Fictional Estates first/);
  }
  assert.equal((await w.inject('POST', '/api/v0/sales-xray/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode, 409, 'the assistant reads nothing either');
  // "Yes, it is": now it reads, and an editor's workflows go along.
  const yes = await w.inject('POST', '/api/v0/sales-xray/confirm', {});
  assert.equal(yes.statusCode, 200, yes.body);
  assert.equal(yes.json().account.confirm, 'yes');
  assert.equal(w.sx.catalogues.length, 1);
  assert.equal((await w.inject('GET', '/api/v0/sales-xray/calls')).statusCode, 200);
  assert.equal((await w.inject('GET', '/api/v0/sales-xray/status')).json().check, false);
});

test('a Personal workspace is held too; "Pick another" disconnects it at Sales X-Ray and stops the lead sync it ran', async () => {
  const w = world();
  w.sx.workspace = { name: null, kind: 'personal', role: null };
  const { code, state } = await w.consent();
  const back = (await w.inject('POST', '/api/v0/sales-xray/callback', { code, state })).json();
  assert.equal(back.check.match, 'personal');
  const refresh = [...w.sx.refresh][0];
  assert.equal((await w.inject('POST', '/api/v0/sales-xray/disconnect', {})).statusCode, 200);
  assert.deepEqual(w.sx.revoked, [refresh], 'the held connection ends at Sales X-Ray');
  assert.equal(w.db.links.size, 0);
  assert.equal(w.db.syncStops.length, 1, 'the company\u2019s lead sync, run as this person, stops with the reason');
  assert.equal(w.db.syncStops[0][0], PERSON);
  assert.match(w.db.syncStops[0][1], /^Lead sync stopped: Fictional Seller disconnected Sales X-Ray/);
});

test('a workspace named like the company connects at once; names compare without "Pvt Ltd", case or spaces', async () => {
  const { workspaceMatch, companyKey } = await import('../dist/sales-xray.js');
  const co = { id: ORG, name: 'Fictional Estates', handle: 'fictionalestates' };
  assert.equal(workspaceMatch({ workspace: 'FICTIONAL ESTATES PVT. LTD.', kind: 'organisation' }, co), 'yes');
  assert.equal(workspaceMatch({ workspace: 'fictionalestates', kind: 'organisation' }, co), 'yes', 'the handle');
  assert.equal(workspaceMatch({ workspace: 'Fictional Technologies', kind: 'organisation' }, co), 'no');
  assert.equal(workspaceMatch({ workspace: 'Fictional', kind: 'organisation' }, co), 'no', 'a part of the name is not the name');
  assert.equal(workspaceMatch({ workspace: null, kind: 'personal' }, co), 'personal');
  assert.equal(workspaceMatch({ workspace: 'Anything', kind: 'organisation', pulseOrg: ORG }, co), 'yes', 'Sales X-Ray naming the Pulse company decides');
  assert.equal(workspaceMatch({ workspace: 'Fictional Estates', kind: 'organisation', pulseOrg: '00000000-0000-4000-8000-00000000beef' }, co), 'no');
  assert.equal(companyKey('Vitals Technologies Pvt. Ltd.'), 'vitals');
  assert.equal(companyKey(null), '');
});
