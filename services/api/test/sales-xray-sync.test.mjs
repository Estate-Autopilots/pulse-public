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
process.env.PULSE_SALES_XRAY = '1'; // the module on, as on pulse-dev (a client edit's push checks the switch)

const { changed, clientPlan, leadBody, matchClient, mirrorFrom, newClient, pushClientEdit, pushPlan, sameValue, wantsClient, registerSalesXraySyncRoutes, PART, RECONNECT } = await import('../dist/sales-xray-sync.js');
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
async function world(answer, scopes = ['calls:read', 'calls:write']) {
  const ring = await loadKeyring();
  const box = (s) => ({ k: s.keyId, w: s.dataKey.toString('base64'), d: s.data.toString('base64') });
  const link = { base: 'https://salesxray.example.test', redirectUri: 'https://pulse.example.test/apps/sales-xray/callback', scopes, account: { kind: 'organisation', role: 'owner' },
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
    assert.equal(init.headers['content-type'], 'application/octet-stream');
    assert.match(init.headers['x-source-sha256'], /^[0-9a-f]{64}$/);
    assert.match(init.headers['x-external-id'], /^pulse-recording:[0-9a-f-]{36}$/);
    // Sales X-Ray 1.3.0 (integrations/app_uploads.py): the answer is an upload that waits for the person.
    return new Response(JSON.stringify({ id: SXCALL, state: 'waiting_for_person', external_id: init.headers['x-external-id'], call_id: null, expires_at: '2026-11-05T10:00:00+00:00',
      open_url: 'https://salesxray.example.test/analysis/calls?app-upload=' + SXCALL }), { status: 202 });
  });
  const r = await sendFile(app, bytes, { clientId: '00000000-0000-4000-8000-00000000c001' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().sent, true);
  assert.equal(r.json().status, 'waiting');
  assert.equal(sent.length, 1);
  assert.equal(saved[0][0], SXCALL);
  assert.equal(saved[0][3], '00000000-0000-4000-8000-00000000c001');
  assert.equal(saved[0][7], 'waiting');
  assert.deepEqual(JSON.parse(saved[0][8]), { uploadId: SXCALL }, 'the row remembers the upload until the person adds it');
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

test('a connection without calls:write is asked to reconnect before any file moves', async () => {
  const { app, sent } = await world(() => new Response(null, { status: 500 }), ['calls:read', 'leads:read', 'leads:write', 'reports:read']);
  const r = await app.inject({ method: 'POST', url: '/api/v0/sales-xray/recordings', payload: { name: 'call.mp3', mime: 'audio/mpeg', size: 10, consent: true } });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, RECONNECT);
  assert.equal(sent.length, 0);
});

test('Sales X-Ray refusing calls:write reads as reconnect; Pulse off there reads as not yet', async () => {
  const scope = await world(() => new Response(JSON.stringify({ error: { code: 'scope', message: 'This key lacks calls:write.' } }), { status: 403 }));
  assert.equal((await sendFile(scope.app, randomBytes(64))).json().reason, 'reconnect');
  const off = await world(() => new Response(JSON.stringify({ error: { code: 'pulse_off', message: "Pulse isn't set up here." } }), { status: 404 }));
  assert.equal((await sendFile(off.app, randomBytes(64))).json().reason, 'upload_unsupported');
  const full = await world(() => new Response(JSON.stringify({ error: { code: 'inbox_full', message: '20 recordings are waiting for this person.' } }), { status: 429 }));
  assert.equal((await sendFile(full.app, randomBytes(64))).json().words, '20 recordings are waiting for this person.');
});

// ----- client edits to the lead (PATCH /v1/api/leads/{id}) and sent recordings the person added ------------------
function editWorld({ scopes = ['calls:read', 'calls:write', 'leads:read', 'leads:update', 'leads:write', 'reports:read'], answers = [], locked = ['company_name', 'city', 'email'], linkedRows = [] } = {}) {
  const logs = [], sql = [], sent = [];
  const viewer = { email: 'admin@example.test', org: ORG, person: PERSON, role: 'admin', name: 'Fictional Admin', pod: null, via: 'password', username: 'admin', mustChange: false };
  const mirror = { sxLeadId: LEAD, revision: 4, name: 'Asha Test', company: 'Skyline Realty (test)', city: 'Pune', phone: '+919000000101', email: 'asha@example.test', interest: null,
    stage: 'interested', stageLabel: 'Interested', ownerName: 'Fictional Seller', sourceLabel: null, sxCreatedAt: null, clientId: CLIENT, origin: 'sales_xray', goneAt: null };
  const cl = client({ company: 'Skyline Realty Pvt Ltd (test)', city: 'Mumbai', email: 'asha.new@example.test', phone: '+919000000101', locked });
  let link;
  const c = { query: async (q, params) => {
    sql.push(q);
    if (q.includes('pulse.sales_xray(')) { const op = params[0]; return { rows: [{ d: op === 'link' || op === 'lock' ? link : op === 'status' ? { connected: true, scopes } : { ok: true } }] }; }
    if (q.includes("doc_key='modules'")) return { rows: [{ body: { off: [], on: ['sales_xray'] } }] };
    if (q.includes('from pulse.sales_xray_lead where') && q.includes('client_id=$1')) return { rows: [mirror] };
    if (q.includes('from pulse.client c where c.id=$1')) return { rows: [cl] };
    if (q.includes('insert into pulse.sales_xray_sync_log')) { logs.push({ action: params[2], detail: params[5] }); return { rows: [] }; }
    if (q.includes('from pulse.sales_xray_call x where')) return { rows: linkedRows };
    return { rows: [] };
  } };
  const f = async (url, init) => {
    sent.push({ url, init });
    const next = answers.shift();
    return next ? next(url, init) : new Response(JSON.stringify({ error: { code: 'nope', message: 'No such path' } }), { status: 404 });
  };
  return { c, f, viewer, logs, sql, sent, ready: async () => {
    const ring = await loadKeyring();
    const box = (x) => ({ k: x.keyId, w: x.dataKey.toString('base64'), d: x.data.toString('base64') });
    link = { base: 'https://salesxray.example.test', redirectUri: 'https://pulse.example.test/apps/sales-xray/callback', scopes, account: { kind: 'organisation', role: 'owner' },
      accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), access: box(seal(ring.ring, Buffer.from('sxa_fictional'), tokenContext(ORG, PERSON, 'access'))),
      refresh: box(seal(ring.ring, Buffer.from('sxr_fictional'), tokenContext(ORG, PERSON, 'refresh'))) };
  } };
}
const ok = () => new Response(JSON.stringify({ change_id: '00000000-0000-4000-8000-0000000000d1', action: 'update', status: 'applied', replayed: false }), { status: 200 });
const refuse = (status, code, message) => () => new Response(JSON.stringify({ error: { code, message } }), { status });

test('a client edit sends only what a person set in Pulse, and never e-mail or phone', () => {
  const m = mirrorFrom(row(), { phone: '+919000000101', email: 'asha@example.test' }, null);
  const plan = pushPlan(client({ company: 'Skyline Realty Pvt Ltd (test)', city: 'Mumbai', email: 'asha.new@example.test', locked: ['company_name', 'email'] }), m);
  assert.deepEqual(plan.fields, { company: 'Skyline Realty Pvt Ltd (test)' }, 'city was filled from the lead (not kept), so it never goes back');
  assert.deepEqual(plan.review, [{ field: 'email', pulse: 'asha.new@example.test', salesXray: 'asha@example.test' }]);
  assert.deepEqual(pushPlan(client({ company: 'skyline realty (TEST)', locked: ['company_name'] }), m).fields, {}, 'the same value written differently sends nothing');
  assert.deepEqual(pushPlan(client({ company: null, locked: ['company_name'] }), m).fields, {}, 'an emptied field never clears the lead');
});

test('a linked client’s edit reaches its lead with PATCH, expected_revision and a fresh request id', async () => {
  const w = editWorld({ answers: [(url, init) => {
    assert.equal(init.method, 'PATCH');
    assert.equal(new URL(url).pathname, `/v1/api/leads/${LEAD}`);
    assert.equal(init.headers.authorization, 'Bearer sxa_fictional');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.fields, { company: 'Skyline Realty Pvt Ltd (test)', city: 'Mumbai' });
    assert.equal(body.expected_revision, 4);
    assert.match(body.request_id, /^pulse-edit-[0-9a-f-]{36}$/);
    return ok();
  }] });
  await w.ready();
  const r = await pushClientEdit(w.c, w.f, w.viewer, CLIENT);
  assert.deepEqual([r.pushed, r.fields], [true, ['company', 'city']]);
  assert.ok(w.sql.some((q) => q.includes('update pulse.sales_xray_lead set company=coalesce($2,company)')), 'Pulse’s copy of the lead follows, so the next sync sees no conflict');
  assert.deepEqual(w.logs.map((l) => l.action), ['conflict', 'updated'], 'the e-mail waits for a person in Sales X-Ray; the rest went');
  assert.match(w.logs[0].detail, /change it there/);
});

test('a lead changed in Sales X-Ray since: Pulse reads its revision and tries once more', async () => {
  const revisions = [];
  const w = editWorld({ answers: [
    (_u, init) => { revisions.push(JSON.parse(init.body).expected_revision); return refuse(409, 'changed_since', 'This lead changed. Read it and try again.')(); },
    (url) => { assert.equal(new URL(url).pathname, `/v1/api/leads/${LEAD}`); return new Response(JSON.stringify({ lead: { lead_id: LEAD, revision: 6 }, phone: null, email: null }), { status: 200 }); },
    (_u, init) => { revisions.push(JSON.parse(init.body).expected_revision); return ok(); },
  ] });
  await w.ready();
  assert.equal((await pushClientEdit(w.c, w.f, w.viewer, CLIENT)).pushed, true);
  assert.deepEqual(revisions, [4, 6]);
});

test('an old connection is asked to reconnect; the owner’s switch and caps come back in words', async () => {
  const old = editWorld({ scopes: ['calls:read', 'leads:read', 'leads:write', 'reports:read'] });
  await old.ready();
  const r = await pushClientEdit(old.c, old.f, old.viewer, CLIENT);
  assert.deepEqual([r.pushed, r.reason, r.words], [false, 'reconnect', RECONNECT]);
  assert.equal(old.sent.length, 0, 'nothing is sent without leads:update');
  assert.equal(old.logs.at(-1).action, 'failed');

  const off = editWorld({ answers: [refuse(403, 'action_off', 'An owner has turned off updates from apps in this workspace.')] });
  await off.ready();
  assert.match((await pushClientEdit(off.c, off.f, off.viewer, CLIENT)).words, /hasn.t allowed lead updates from apps/);
  const missing = editWorld({ answers: [refuse(403, 'scope_missing', "This connection doesn't have leads:update. Reconnect it and allow that.")] });
  await missing.ready();
  assert.equal((await pushClientEdit(missing.c, missing.f, missing.viewer, CLIENT)).reason, 'reconnect');
  const cap = editWorld({ answers: [refuse(429, 'cap_reached', 'This lead got 20 updates from apps in the last 24 hours.')] });
  await cap.ready();
  assert.equal((await pushClientEdit(cap.c, cap.f, cap.viewer, CLIENT)).words, 'This lead got 20 updates from apps in the last 24 hours.');
  const same = editWorld({ answers: [refuse(409, 'no_change', 'The lead already has those details.')] });
  await same.ready();
  assert.equal((await pushClientEdit(same.c, same.f, same.viewer, CLIENT)).pushed, true, 'already so counts as sent');
});

test('saving a client sends its edit a moment later, once for quick saves', async () => {
  const patches = [];
  const answer = (_u, init) => { patches.push(JSON.parse(init.body)); return ok(); };
  const w = editWorld({ answers: [answer, answer] });
  await w.ready();
  const app = Fastify();
  app.post('/api/v0/clients/:id', async () => ({ changed: 1 }));
  registerSalesXraySyncRoutes(app, { tx: async (_req, run) => run(w.c, w.viewer), f: w.f, editDelayMs: 20 });
  assert.equal((await app.inject({ method: 'POST', url: `/api/v0/clients/${CLIENT}`, payload: { city: 'Mumbai' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v0/clients/${CLIENT}`, payload: { companyName: 'Skyline Realty Pvt Ltd (test)' } })).statusCode, 200);
  await new Promise((r) => setTimeout(r, 120));
  await app.inject({ method: 'POST', url: `/api/v0/clients/${CLIENT}`, payload: { notes: 'Not a lead field' } });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(patches.length, 1, 'two quick saves send once, after the last; a notes edit sends nothing');
  assert.deepEqual(patches[0].fields, { company: 'Skyline Realty Pvt Ltd (test)', city: 'Mumbai' });
});

test('a sent recording the person added in Sales X-Ray becomes the call; a discarded one fails', async () => {
  const UPLOAD = '00000000-0000-4000-8000-0000000000e1', REAL = '00000000-0000-4000-8000-0000000000e2';
  const waiting = { id: '00000000-0000-4000-8000-0000000000e3', sxCallId: UPLOAD, status: 'waiting', checkedAt: null, summary: { uploadId: UPLOAD } };
  const added = editWorld({ linkedRows: [waiting], answers: [
    (url) => { assert.equal(new URL(url).pathname, `/v1/api/calls/uploads/${UPLOAD}`); return new Response(JSON.stringify({ id: UPLOAD, state: 'added', call_id: REAL, open_url: `https://salesxray.example.test/analysis/calls/${REAL}` }), { status: 200 }); },
    (url) => { assert.equal(new URL(url).pathname, `/v1/api/calls/${REAL}`); return new Response(JSON.stringify({ id: REAL, title: 'Fictional site visit call', has_report: false }), { status: 200 }); },
  ] });
  await added.ready();
  const app = Fastify();
  registerSalesXraySyncRoutes(app, { tx: async (_req, run) => run(added.c, added.viewer), f: added.f });
  assert.equal((await app.inject({ method: 'GET', url: `/api/v0/sales-xray/linked?client=${CLIENT}` })).statusCode, 200);
  assert.ok(added.sql.some((q) => q.includes("set sx_call_id=$2,status='analysing'")), 'the row takes the real call id');
  assert.equal(added.sent.length, 2, 'then reads the call as a linked one');

  const gone = editWorld({ linkedRows: [waiting], answers: [() => new Response(JSON.stringify({ id: UPLOAD, state: 'discarded', call_id: null }), { status: 200 })] });
  await gone.ready();
  const app2 = Fastify();
  registerSalesXraySyncRoutes(app2, { tx: async (_req, run) => run(gone.c, gone.viewer), f: gone.f });
  await app2.inject({ method: 'GET', url: `/api/v0/sales-xray/linked?client=${CLIENT}` });
  assert.ok(gone.sql.some((q) => q.includes("set status='failed'")));
});
