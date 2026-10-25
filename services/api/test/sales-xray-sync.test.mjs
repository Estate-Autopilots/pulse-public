// XRAY-LINK: lead sync rules and the recording upload against a fictional Sales X-Ray. Every name, phone and e-mail
// here is made up. The rules are pure (sales-xray-sync.ts); the recording route runs through Fastify with the
// database stood in for (only the Sales X-Ray link and the call link row are touched).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

const dir = mkdtempSync(join(tmpdir(), 'sx-sync-keys-'));
writeFileSync(join(dir, 'ring'), `k1 ${randomBytes(32).toString('base64')}\n`);
chmodSync(join(dir, 'ring'), 0o600);
process.env.PULSE_DOCUMENT_KEY_FILE = join(dir, 'ring');
process.env.PULSE_SALES_XRAY_URL = 'https://salesxray.example.test';
process.env.PULSE_SALES_XRAY_UPLOADS = mkdtempSync(join(tmpdir(), 'sx-uploads-'));
process.env.PULSE_SALES_XRAY_SYNC = '0';

const { changed, clientPlan, leadBody, matchClient, mirrorFrom, newClient, sameValue, wantsClient, registerSalesXraySyncRoutes, PART } = await import('../dist/sales-xray-sync.js');
const { seal, loadKeyring } = await import('../dist/document-keys.js');
const { tokenContext } = await import('../dist/sales-xray.js');

const LEAD = '00000000-0000-4000-8000-00000000a001', CLIENT = '00000000-0000-4000-8000-00000000c001';
const row = (over = {}) => ({ lead_id: LEAD, revision: 2, name: 'Asha Test', company: 'Skyline Realty (test)', city: 'Pune', stage: 'interested', stage_label: 'Interested', owner_name: 'Fictional Seller', ...over });
const client = (over = {}) => ({ id: CLIENT, name: 'Skyline Realty (test)', company: null, email: null, phone: null, city: null, status: 'prospect', locked: [], source: 'manual', ...over });

test('values match the way people write them', () => {
  assert.ok(sameValue('phone', '+91 90000 00101', '09000000101'));
  assert.ok(!sameValue('phone', '+91 90000 00101', '+91 90000 00102'));
  assert.ok(sameValue('email', 'Asha@Example.TEST ', 'asha@example.test'));
  assert.ok(sameValue('city', 'pune', 'Pune'));
});

test('a lead copy changes only when Sales X-Ray says so', () => {
  const m = mirrorFrom(row(), { phone: '+919000000101', email: 'asha@example.test' }, null);
  assert.equal(m.phone, '+919000000101');
  assert.ok(!changed(row(), m), 'same revision and stage: nothing to read');
  assert.ok(changed(row({ revision: 3 }), m));
  assert.ok(changed(row({ stage: 'won' }), m));
  const again = mirrorFrom(row({ revision: 3 }), null, m);
  assert.equal(again.phone, '+919000000101', 'without a detail read the phone stays as it was');
});

test('which leads become clients', () => {
  const m = mirrorFrom(row(), null, null);
  assert.ok(!wantsClient('won', m));
  assert.ok(wantsClient('won', { ...m, stage: 'won' }));
  assert.ok(wantsClient('all', m));
  assert.ok(!wantsClient('all', { ...m, stage: 'lost' }));
  assert.deepEqual(newClient({ ...m, stage: 'won' }).status, 'active');
  assert.equal(newClient(m).name, 'Skyline Realty (test)');
});

test('a lead finds its client by e-mail, phone or company, only when one matches', () => {
  const m = { ...mirrorFrom(row(), { phone: '+919000000101', email: 'asha@example.test' }, null) };
  const a = client({ id: 'a', email: 'ASHA@example.test' }), b = client({ id: 'b', name: 'Other (test)', phone: '9000000101' }), c = client({ id: 'c', name: 'Other two (test)' });
  assert.equal(matchClient([a, b, c], m).id, 'a', 'e-mail first');
  assert.equal(matchClient([b, c], m).id, 'b', 'then the phone');
  assert.equal(matchClient([c, client({ id: 'd' })], m).id, 'd', 'then the company name');
  assert.equal(matchClient([client({ id: 'd' }), client({ id: 'e' })], { ...m, email: null, phone: null }), null, 'two clients with that name: no guess');
});

test('Pulse owns the client: empty fields fill, kept fields and different values stay', () => {
  const m = mirrorFrom(row({ stage: 'won' }), { phone: '+919000000101', email: 'asha@example.test' }, null);
  const plan = clientPlan(client({ city: 'Mumbai', locked: ['email'] }), m);
  assert.deepEqual(plan.fill, { company_name: 'Skyline Realty (test)', phone: '+919000000101' });
  assert.deepEqual(plan.conflicts, [{ field: 'city', pulse: 'Mumbai', salesXray: 'Pune' }]);
  assert.equal(plan.status, 'active', 'a won lead turns a Prospect Active');
  assert.equal(clientPlan(client({ status: 'paused' }), m).status, null, 'any other status is Pulse’s');
  assert.equal(clientPlan(client(), { ...m, stage: 'lost' }).status, null, 'losing never changes a client');
});

test('a client goes to Sales X-Ray as a lead with its own external id', () => {
  assert.deepEqual(leadBody(client({ phone: '+919000000101', city: 'Pune' }), 'Asha Test'),
    { name: 'Asha Test', phone: '+919000000101', company: 'Skyline Realty (test)', city: 'Pune', external_id: `pulse-client:${CLIENT}` });
});

// ----- recordings ------------------------------------------------------------------------------------------------
const ORG = '00000000-0000-4000-8000-000000001363', PERSON = '00000000-0000-4000-8000-000000000001', SXCALL = '00000000-0000-4000-8000-0000000000c9';
async function world(answer) {
  const ring = await loadKeyring();
  const box = (s) => ({ k: s.keyId, w: s.dataKey.toString('base64'), d: s.data.toString('base64') });
  const link = { base: 'https://salesxray.example.test', redirectUri: 'https://pulse.example.test/apps/sales-xray/callback', scopes: ['calls:read'], account: { kind: 'organisation', role: 'owner' },
    accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), access: box(seal(ring.ring, Buffer.from('sxa_fictional'), tokenContext(ORG, PERSON, 'access'))),
    refresh: box(seal(ring.ring, Buffer.from('sxr_fictional'), tokenContext(ORG, PERSON, 'refresh'))) };
  const saved = [], sent = [];
  const viewer = { email: 'seller@example.test', org: ORG, person: PERSON, role: 'admin', name: 'Fictional Seller', pod: null, via: 'password', username: 'seller', mustChange: false };
  const c = { query: async (sql, params) => {
    if (sql.includes('pulse.sales_xray(')) { const op = params[0]; return { rows: [{ d: op === 'link' || op === 'lock' ? link : { ok: true } }] }; }
    if (sql.includes('insert into pulse.sales_xray_call')) { saved.push(params); return { rows: [] }; }
    throw new Error(`unexpected SQL ${sql}`);
  } };
  const f = async (url, init) => { sent.push({ url, init }); return answer(url, init); };
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => reply.code(error.statusCode ?? 500).send({ error: error.message }));
  registerSalesXraySyncRoutes(app, { tx: async (_req, run) => run(c, viewer), f });
  return { app, saved, sent };
}
async function sendFile(app, bytes, extra = {}) {
  const start = await app.inject({ method: 'POST', url: '/api/v0/sales-xray/recordings', payload: { name: 'call.mp3', mime: 'audio/mpeg', size: bytes.length, consent: true, title: 'Fictional site visit call', ...extra } });
  assert.equal(start.statusCode, 200, start.body);
  const { uploadId, parts } = start.json();
  for (let i = 0; i < parts; i++) {
    const r = await app.inject({ method: 'POST', url: `/api/v0/sales-xray/recordings/${uploadId}/parts`, payload: { index: i, bytes: bytes.subarray(i * PART, (i + 1) * PART).toString('base64') } });
    assert.equal(r.statusCode, 200, r.body);
  }
  return app.inject({ method: 'POST', url: `/api/v0/sales-xray/recordings/${uploadId}/send` });
}

test('a recording needs the people’s agreement and a real media type', async () => {
  const { app } = await world(() => new Response(null, { status: 500 }));
  assert.equal((await app.inject({ method: 'POST', url: '/api/v0/sales-xray/recordings', payload: { name: 'x.mp3', mime: 'audio/mpeg', size: 10 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v0/sales-xray/recordings', payload: { name: 'x.exe', mime: 'application/x-msdownload', size: 10, consent: true } })).statusCode, 400);
});

test('a recording goes to Sales X-Ray whole, with its hash, and the call is linked', async () => {
  const bytes = randomBytes(PART + 1234);
  const { app, saved, sent } = await world((url, init) => {
    assert.equal(new URL(url).pathname, '/v1/api/calls');
    assert.equal(init.headers.authorization, 'Bearer sxa_fictional');
    assert.equal(init.headers['x-recording-consent'], 'participants-informed');
    assert.equal(Buffer.from(init.body).length, bytes.length);
    return new Response(JSON.stringify({ id: SXCALL, state: 'waiting_for_person', open_url: 'https://salesxray.example.test/analysis/calls/' + SXCALL }), { status: 202 });
  });
  const r = await sendFile(app, bytes, { clientId: '00000000-0000-4000-8000-00000000c001' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().sent, true);
  assert.equal(r.json().status, 'waiting');
  assert.equal(sent.length, 1);
  assert.equal(saved[0][0], SXCALL);
  assert.equal(saved[0][3], '00000000-0000-4000-8000-00000000c001');
  assert.deepEqual(readdirSync(process.env.PULSE_SALES_XRAY_UPLOADS), [], 'the file is gone once sent');
});

test('until Sales X-Ray takes recordings, Pulse says so and keeps nothing', async () => {
  const { app, saved } = await world(() => new Response(JSON.stringify({ detail: 'Not Found' }), { status: 404 }));
  const r = await sendFile(app, randomBytes(2048));
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().reason, 'upload_unsupported');
  assert.equal(saved.length, 0);
  assert.deepEqual(readdirSync(process.env.PULSE_SALES_XRAY_UPLOADS), []);
});

test('parts arrive in order or not at all', async () => {
  const { app } = await world(() => new Response(null, { status: 500 }));
  const start = (await app.inject({ method: 'POST', url: '/api/v0/sales-xray/recordings', payload: { name: 'c.m4a', mime: 'audio/mp4', size: PART + 10, consent: true } })).json();
  const skip = await app.inject({ method: 'POST', url: `/api/v0/sales-xray/recordings/${start.uploadId}/parts`, payload: { index: 1, bytes: 'AAAA' } });
  assert.equal(skip.statusCode, 409);
  const other = await app.inject({ method: 'POST', url: '/api/v0/sales-xray/recordings/00000000-0000-4000-8000-000000000bad/parts', payload: { index: 0, bytes: 'AAAA' } });
  assert.equal(other.statusCode, 404);
});
