// PULSE-NETWORK (EST-1038/1026/1027): the connector reads its key from a file, never sends it anywhere but the network,
// acts for a member only by handle, maps the network's refusals to plain errors, and opens only for leaders.
import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import Fastify from 'fastify';
import { networkAllowed, networkCall, networkConfig, memberHandle, registerNetworkRoutes } from '../dist/network.js';

const ORG_A = '11111111-1111-4111-8111-111111111111', ORG_B = '22222222-2222-4222-8222-222222222222';
const viewer = (org = ORG_A, role = 'leadership') => ({ email: 'lead@company.test', org, role, person: 'p1', name: 'Lead', pod: null, via: 'password', username: 'lead', mustChange: false });
const install = (org = ORG_A) => ({ query: async (sql) => { assert.equal(sql, 'select pulse.install_org() as org_id'); return { rows: [{ org_id: org }] }; } });
const dirs = [];
test.after(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })));
const KEY = 'pnc_0123abcd_' + 'x'.repeat(40);
const keyFile = (content) => { const dir = mkdtempSync(join(tmpdir(), 'pn-')); dirs.push(dir); const f = join(dir, 'key'); writeFileSync(f, content, { mode: 0o600 }); return f; };
const fake = (status, body, seen = []) => async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); };

test('config needs both the address and a well-formed key file, and trims the address', async () => {
  assert.equal(await networkConfig(install(), viewer(), {}), null);
  assert.equal(await networkConfig(install(), viewer(), { PULSE_NETWORK_URL: 'https://network.example.test' }), null);
  assert.equal(await networkConfig(install(), viewer(), { PULSE_NETWORK_URL: 'https://network.example.test', PULSE_NETWORK_CONNECTOR_KEY_FILE: '/nonexistent/key' }), null);
  assert.equal(await networkConfig(install(), viewer(), { PULSE_NETWORK_URL: 'https://network.example.test', PULSE_NETWORK_CONNECTOR_KEY_FILE: keyFile('not-a-key') }), null);
  assert.equal(await networkConfig(install(), viewer(), { PULSE_NETWORK_URL: 'ftp://x', PULSE_NETWORK_CONNECTOR_KEY_FILE: keyFile(KEY) }), null);
  assert.deepEqual(await networkConfig(install(), viewer(), { PULSE_NETWORK_URL: 'https://network.example.test/', PULSE_NETWORK_CONNECTOR_KEY_FILE: keyFile(KEY + '\n') }),
    { org: ORG_A, url: 'https://network.example.test', key: KEY });
});

test('calls carry the connector key as a bearer token and act for a member only when asked', async () => {
  const seen = [], cfg = { org: ORG_A, url: 'https://network.example.test', key: KEY };
  await networkCall(cfg, 'POST', '/api/v1/posts', { title: 'Hi there' }, 'ops.lead', fake(201, { num: 7 }, seen));
  assert.equal(seen[0].url, 'https://network.example.test/api/v1/posts');
  assert.equal(seen[0].init.headers.authorization, 'Bearer ' + KEY);
  assert.equal(seen[0].init.headers['x-pulse-network-as'], 'ops.lead');
  assert.deepEqual(JSON.parse(seen[0].init.body), { title: 'Hi there' });
  await networkCall(cfg, 'GET', '/api/v1/feed', undefined, undefined, fake(200, { posts: [] }, seen));
  assert.equal(seen[1].init.headers['x-pulse-network-as'], undefined);
  assert.equal(seen[1].init.body, undefined);
});

test('refusals become plain errors; a bad key or a network fault is a 502 that never echoes the key', async () => {
  const cfg = { org: ORG_A, url: 'https://network.example.test', key: KEY };
  await assert.rejects(networkCall(cfg, 'GET', '/x', undefined, undefined, fake(403, { error: 'Pulse Network is open to CEOs and leaders first.' })),
    (e) => e.statusCode === 403 && /leaders first/.test(e.message));
  await assert.rejects(networkCall(cfg, 'GET', '/x', undefined, undefined, fake(401, { error: 'Send your key ' + KEY })), (e) => e.statusCode === 502 && !e.message.includes(KEY));
  await assert.rejects(networkCall(cfg, 'GET', '/x', undefined, undefined, async () => { throw new Error('ECONNREFUSED ' + KEY); }),
    (e) => e.statusCode === 502 && !e.message.includes(KEY));
});

test('a member handle is fetched once and then kept for ten minutes', async () => {
  const seen = [], cfg = { org: ORG_A, url: 'https://network.example.test', key: KEY }, who = { email: 'lead@company.test', name: 'Lead', title: 'Head of Ops', pulseRef: 'p1' };
  assert.equal(await memberHandle(cfg, who, fake(200, { handle: 'lead' }, seen), 1_000), 'lead');
  assert.equal(await memberHandle(cfg, who, fake(200, { handle: 'other' }, seen), 2_000), 'lead');
  assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(seen[0].init.body), { email: 'lead@company.test', name: 'Lead', title: 'Head of Ops', role: 'leader', pulse_ref: 'p1' });
  for (const changed of [{ org: ORG_B }, { key: KEY + 'rotated' }, { url: 'https://other.example.test' }]) {
    assert.equal(await memberHandle({ ...cfg, ...changed }, who, fake(200, { handle: 'other' }, seen), 3_000), 'other');
  }
  assert.equal(seen.length, 4);
  await assert.rejects(memberHandle({ ...cfg }, { ...who, email: 'bad@company.test' }, fake(200, { handle: '../x' }), 3_000), (e) => e.statusCode === 502);
});

test('only leaders and organisation admins open the network', () => {
  const v = (role) => ({ email: 'a@b.test', org: 'o', person: 'p', role, name: 'A', pod: null, via: 'password', username: 'a', mustChange: false });
  assert.equal(networkAllowed(v('admin')), true);
  assert.equal(networkAllowed(v('leadership')), true);
  for (const role of ['member', 'manager', 'hr', 'accountant']) assert.equal(networkAllowed(v(role)), false);
});

const configured = () => ({ PULSE_NETWORK_URL: 'https://network.example.test', PULSE_NETWORK_CONNECTOR_KEY_FILE: keyFile(KEY) });

test('install identity is authoritative, fails closed on lookup failure, and never trusts an env org hint', async () => {
  const env = { ...configured(), PULSE_ORG_ID: ORG_B };
  assert.equal(await networkConfig(install(), viewer(ORG_B), env), null);
  assert.equal((await networkConfig(install(), viewer(), env)).org, ORG_A);
  assert.equal((await networkConfig(install(ORG_B), viewer(ORG_B), env)).org, ORG_B);
  assert.equal(await networkConfig(install(null), viewer(), env), null);
  assert.equal(await networkConfig({ query: async () => { throw new Error('lookup unavailable'); } }, viewer(), env), null);
});

test('configuration revocation is immediate and malformed URLs cannot carry credentials', async () => {
  const env = configured();
  assert.ok(await networkConfig(install(), viewer(), env));
  rmSync(env.PULSE_NETWORK_CONNECTOR_KEY_FILE);
  assert.equal(await networkConfig(install(), viewer(), env), null);
  for (const url of ['https://user:secret@network.example.test', 'https://network.example.test/path', 'https://network.example.test?key=x', 'not a URL']) {
    assert.equal(await networkConfig(install(), viewer(), { ...configured(), PULSE_NETWORK_URL: url }), null);
  }
});

// Enumerate actual registrations (including status and sign-in) so newly added endpoints inherit the denial checks.
async function harness({ org = ORG_A, role = 'leadership', env = configured(), installed = ORG_A, lookupFails = false } = {}) {
  const app = Fastify(), routes = [], seen = [], queries = [];
  app.addHook('onRoute', route => { if (route.method !== 'HEAD') routes.push(route); });
  const client = { query: async sql => {
    queries.push(sql);
    if (sql === 'select pulse.install_org() as org_id') {
      if (lookupFails) throw new Error('lookup unavailable');
      return { rows: [{ org_id: installed }] };
    }
    return { rows: [{ email: 'lead@company.test', name: 'Lead', title: 'Leader' }] };
  } };
  const fetcher = async (url, init) => {
    seen.push({ url, init });
    const body = url.endsWith('/connector/member') ? { handle: 'synthetic.lead' }
      : url.endsWith('/connector/sign-in') ? { url: env.PULSE_NETWORK_URL + '/connect/synthetic-once' }
      : url.endsWith('/me') ? { handle: 'synthetic.lead', display_name: 'Lead' } : {};
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  registerNetworkRoutes(app, { tx: (_req, run) => run(client, viewer(org, role)), env, fetcher });
  await app.ready();
  const request = route => ({ method: route.method, url: route.url.replace(':slug', 'general').replace(':handle', 'other.lead').replace(':num', '1') + `?org=${ORG_A}&orgId=${ORG_A}&next=/`,
    headers: { host: 'install-a.example.test', 'x-pulse-org': ORG_A },
    ...(route.method === 'POST' ? { payload: { org: ORG_A, orgId: ORG_A, body: 'Synthetic message.', title: 'Synthetic request', to: 'other.lead', status: 'accepted' } } : {}) });
  return { app, routes, seen, queries, request };
}

test('every endpoint denies hosted org B before profile reads or outbound calls despite install-A hints', async t => {
  const h = await harness({ org: ORG_B });
  t.after(() => h.app.close());
  assert.equal(h.routes.length, 11);
  for (const route of h.routes) {
    const r = await h.app.inject(h.request(route));
    assert.equal(r.statusCode, route.url.endsWith('/status') ? 200 : 403, route.url);
    if (route.url.endsWith('/status')) assert.deepEqual(r.json(), { on: false, allowed: true });
    else { assert.equal(r.json().message, 'Pulse Network is not available for this company. Sign in directly on Pulse Network.'); assert.equal(r.json().url, undefined); }
    assert.ok(!r.body.includes(KEY));
  }
  assert.equal(h.seen.length, 0);
  assert.ok(h.queries.every(sql => sql === 'select pulse.install_org() as org_id'));
});

test('all endpoints fail closed for absent, unreadable, malformed or unknown installation configuration', async t => {
  const cases = [{ env: {} }, { env: { ...configured(), PULSE_NETWORK_CONNECTOR_KEY_FILE: '/nonexistent/key' } },
    { env: { ...configured(), PULSE_NETWORK_CONNECTOR_KEY_FILE: keyFile('malformed') } },
    { env: { ...configured(), PULSE_NETWORK_CONNECTOR_KEY_FILE: dirs[0] } },
    { installed: null }, { lookupFails: true }];
  for (const options of cases) {
    const h = await harness(options);
    t.after(() => h.app.close());
    for (const route of h.routes) {
      const r = await h.app.inject(h.request(route));
      assert.equal(r.statusCode, route.url.endsWith('/status') ? 200 : 403, route.url);
      if (route.url.endsWith('/status')) assert.equal(r.json().on, false);
      assert.ok(!r.body.includes(KEY));
    }
    assert.equal(h.seen.length, 0);
    assert.ok(h.queries.every(sql => sql === 'select pulse.install_org() as org_id'));
  }
});

test('leadership gate remains first across all endpoints', async t => {
  for (const role of ['person', 'manager', 'hr', 'accountant']) {
    const h = await harness({ role });
    t.after(() => h.app.close());
    for (const route of h.routes) {
      const r = await h.app.inject(h.request(route));
      assert.equal(r.statusCode, route.url.endsWith('/status') ? 200 : 403, route.url);
      if (route.url.endsWith('/status')) assert.deepEqual(r.json(), { on: false, allowed: false });
    }
    assert.equal(h.seen.length, 0);
    assert.equal(h.queries.length, 0);
  }
});

test('authenticated install org A retains every endpoint with conflicting payload, query and host hints', async t => {
  const h = await harness();
  t.after(() => h.app.close());
  for (const route of h.routes) {
    const req = h.request(route);
    req.url = req.url.replaceAll(ORG_A, ORG_B);
    req.headers = { host: 'hosted-b.example.test', 'x-pulse-org': ORG_B };
    if (req.payload) req.payload = { ...req.payload, org: ORG_B, orgId: ORG_B };
    const r = await h.app.inject(req);
    assert.equal(r.statusCode, 200, route.url + ': ' + r.body);
    if (route.url.endsWith('/status')) assert.deepEqual(r.json(), { on: true, allowed: true });
    if (route.url.endsWith('/sign-in')) assert.equal(r.json().url, 'https://network.example.test/connect/synthetic-once');
    assert.ok(!r.body.includes(KEY));
  }
  assert.ok(h.seen.some(r => r.url.endsWith('/connector/sign-in')));
  assert.ok(h.seen.some(r => r.url.endsWith('/connector/member')));
  assert.ok(h.seen.every(r => r.init.headers.authorization === 'Bearer ' + KEY));
  assert.ok(h.seen.every(r => !r.init.body || !r.init.body.includes(ORG_B)));
});
