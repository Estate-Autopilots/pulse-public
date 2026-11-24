// AI-FIX-4 (20 Nov 2026, BUG-CENSUS BC-126): API keys were refused 429 on the catalogue, service leads, people and
// clients (47 in 14 days on production). Every service key on the install shared one 120-a-minute budget, and Willow Lane's
// bridge reads 110-160 a minute while it syncs (16-17 Nov). Now each verified key spends its own budget at its company's
// API tier per minute (as v1 calls do), never below 120, and says so in RateLimit headers. A bare Fastify app with
// withServiceKey on a stand-in database client: the key's hash matches, its scope is held, its company's tier is `tier`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { serviceScope, withServiceKey } from '../dist/service-key.js';

const ORG = '6f1a455d-0000-4000-8000-000000000126';
const secret = 'S'.repeat(43), stored = createHash('sha256').update(secret).digest('hex');
let tier = 5000;
const pool = { connect: async () => ({
  query: async (sql) => {
    if (sql.includes('service_key_hash')) return { rows: [{ hash: stored }] };
    if (sql.includes('service_key_auth')) return { rows: [{ ok: true }] };
    if (sql.includes('api_tier_per_minute')) return { rows: [{ org: ORG, n: tier }] };
    return { rows: [] };
  },
  release() {},
}) };
const app = Fastify({ logger: false });
serviceScope(app);
app.decorate('serviceKeyContext', { pool, installation: { readOrg: async () => ORG } });
app.get('/api/v1/service/clients', (request, reply) =>
  withServiceKey(request, reply, 'clients.read', async () => ({ items: [], nextCursor: null })));
const read = (keyId) => app.inject({ url: '/api/v1/service/clients', headers: { authorization: `Bearer psvc_${keyId}_${secret}` } });

test('a bridge reading 150 times in a minute is served, at its company\'s tier', async () => {
  tier = 5000;
  const bridge = randomUUID();
  let last;
  for (let i = 1; i <= 150; i++) {
    last = await read(bridge);
    assert.equal(last.statusCode, 200, `read ${i} of 150 answered ${last.statusCode} ${last.body}`);
  }
  assert.equal(last.headers['ratelimit-limit'], '5000');
  assert.equal(last.headers['ratelimit-remaining'], '4850', 'the bridge spent 150 of its own 5,000');
});

test('a key\'s own budget runs out at its tier (never below 120); other keys keep theirs', async () => {
  tier = 60; // Free: 60 a minute on v1; service keys keep the 120 they always had
  const busy = randomUUID(), quiet = randomUUID();
  for (let i = 1; i <= 120; i++) {
    const r = await read(busy);
    assert.equal(r.statusCode, 200, `read ${i} of 120 answered ${r.statusCode} ${r.body}`);
    assert.equal(r.headers['ratelimit-limit'], '120');
  }
  const refused = await read(busy);
  assert.equal(refused.statusCode, 429, 'the 121st read in the minute is refused');
  assert.deepEqual(refused.json(), { error: 'Service rate limit' });
  assert.equal(refused.headers['ratelimit-remaining'], '0');
  const after = Number(refused.headers['retry-after']);
  assert.ok(after >= 1 && after <= 60, `Retry-After is the window's own reset (${after})`);
  const other = await read(quiet);
  assert.equal(other.statusCode, 200, 'another key is not starved by the busy one');
  assert.equal(other.headers['ratelimit-remaining'], '119');
});
