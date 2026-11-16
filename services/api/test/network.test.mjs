// PULSE-NETWORK (EST-1038/1026/1027): the connector reads its key from a file, never sends it anywhere but the network,
// acts for a member only by handle, maps the network's refusals to plain errors, and opens only for leaders.
import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { networkAllowed, networkCall, networkConfig, memberHandle } from '../dist/network.js';

const KEY = 'pnc_0123abcd_' + 'x'.repeat(40);
const keyFile = (content) => { const dir = mkdtempSync(join(tmpdir(), 'pn-')); const f = join(dir, 'key'); writeFileSync(f, content, { mode: 0o600 }); return f; };
const fake = (status, body, seen = []) => async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); };

test('config needs both the address and a well-formed key file, and trims the address', async () => {
  assert.equal(await networkConfig({}), null);
  assert.equal(await networkConfig({ PULSE_NETWORK_URL: 'https://network.example.test' }), null);
  assert.equal(await networkConfig({ PULSE_NETWORK_URL: 'https://network.example.test', PULSE_NETWORK_CONNECTOR_KEY_FILE: '/nonexistent/key' }), null);
  assert.equal(await networkConfig({ PULSE_NETWORK_URL: 'https://network.example.test', PULSE_NETWORK_CONNECTOR_KEY_FILE: keyFile('not-a-key') }), null);
  assert.equal(await networkConfig({ PULSE_NETWORK_URL: 'ftp://x', PULSE_NETWORK_CONNECTOR_KEY_FILE: keyFile(KEY) }), null);
  assert.deepEqual(await networkConfig({ PULSE_NETWORK_URL: 'https://network.example.test/', PULSE_NETWORK_CONNECTOR_KEY_FILE: keyFile(KEY + '\n') }),
    { url: 'https://network.example.test', key: KEY });
});

test('calls carry the connector key as a bearer token and act for a member only when asked', async () => {
  const seen = [], cfg = { url: 'https://network.example.test', key: KEY };
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
  const cfg = { url: 'https://network.example.test', key: KEY };
  await assert.rejects(networkCall(cfg, 'GET', '/x', undefined, undefined, fake(403, { error: 'Pulse Network is open to CEOs and leaders first.' })),
    (e) => e.statusCode === 403 && /leaders first/.test(e.message));
  await assert.rejects(networkCall(cfg, 'GET', '/x', undefined, undefined, fake(401, { error: 'Send your key' })), (e) => e.statusCode === 502 && !e.message.includes(KEY));
  await assert.rejects(networkCall(cfg, 'GET', '/x', undefined, undefined, async () => { throw new Error('ECONNREFUSED ' + KEY); }),
    (e) => e.statusCode === 502 && !e.message.includes(KEY));
});

test('a member handle is fetched once and then kept for ten minutes', async () => {
  const seen = [], cfg = { url: 'https://network.example.test', key: KEY }, who = { email: 'lead@company.test', name: 'Lead', title: 'Head of Ops', pulseRef: 'p1' };
  assert.equal(await memberHandle(cfg, who, fake(200, { handle: 'lead' }, seen), 1_000), 'lead');
  assert.equal(await memberHandle(cfg, who, fake(200, { handle: 'other' }, seen), 2_000), 'lead');
  assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(seen[0].init.body), { email: 'lead@company.test', name: 'Lead', title: 'Head of Ops', role: 'leader', pulse_ref: 'p1' });
  await assert.rejects(memberHandle({ ...cfg }, { ...who, email: 'bad@company.test' }, fake(200, { handle: '../x' }), 3_000), (e) => e.statusCode === 502);
});

test('only leaders and organisation admins open the network', () => {
  const v = (role) => ({ email: 'a@b.test', org: 'o', person: 'p', role, name: 'A', pod: null, via: 'password', username: 'a', mustChange: false });
  assert.equal(networkAllowed(v('admin')), true);
  assert.equal(networkAllowed(v('leadership')), true);
  for (const role of ['member', 'manager', 'hr', 'accountant']) assert.equal(networkAllowed(v(role)), false);
});
