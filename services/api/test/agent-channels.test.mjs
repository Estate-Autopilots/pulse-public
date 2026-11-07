// AGENT-CHANNELS: the WhatsApp Cloud API webhook (Meta's handshake, the signature, the company's number) against a mock
// database, and the pure helpers. Synthetic data only; nothing is sent anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { codeIn, keyFile, registerAgentChannelRoutes, waCodeHash, whatsappAccounts } from '../dist/agent-channels.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const SECRET = 'synthetic-app-secret';
const ENV = { VITALS_WHATSAPP_KEY_FILE: '/nonexistent', VITALS_WHATSAPP_ORG: ORG, VITALS_WHATSAPP_PHONE_NUMBER_ID: '100000000000001',
  VITALS_WHATSAPP_APP_SECRET: SECRET, VITALS_WHATSAPP_VERIFY_TOKEN: 'synthetic-verify', VITALS_WHATSAPP_NUMBER: '919000000123' };

test('key files, accounts and codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-'));
  writeFileSync(join(dir, 'k'), '# synthetic\nVITALS_WHATSAPP_ORG=' + ORG + '\nexport VITALS_WHATSAPP_APP_SECRET="abc12345"\n');
  assert.deepEqual(keyFile(join(dir, 'k'), 'X'), { VITALS_WHATSAPP_ORG: ORG, VITALS_WHATSAPP_APP_SECRET: 'abc12345' });
  writeFileSync(join(dir, 'bare'), 'bare-token\n');
  assert.deepEqual(keyFile(join(dir, 'bare'), 'TOKEN'), { TOKEN: 'bare-token' });
  assert.deepEqual(keyFile(join(dir, 'missing'), 'TOKEN'), {});
  assert.equal(whatsappAccounts({ VITALS_WHATSAPP_KEY_FILE: '/nonexistent' }).length, 0, 'nothing configured: no account');
  assert.equal(whatsappAccounts({ ...ENV, VITALS_WHATSAPP_APP_SECRET: '' }).length, 0, 'an incomplete account is left out');
  const [a] = whatsappAccounts(ENV);
  assert.equal(a.org, ORG); assert.equal(a.number, '919000000123');
  assert.equal(codeIn('link abcd234567'), 'ABCD234567');
  assert.equal(codeIn('ABCD234567'), 'ABCD234567');
  assert.equal(codeIn('/start ABCD234567'), 'ABCD234567');
  assert.equal(codeIn('please link my phone'), null);
  assert.equal(waCodeHash('ABCD234567'), createHash('sha256').update('WAABCD234567').digest('hex'));
  assert.notEqual(waCodeHash('ABCD234567'), createHash('sha256').update('ABCD234567').digest('hex'), 'a WhatsApp code never links Telegram');
});

function server(env) {
  const queries = [];
  const client = { query: async (sql, args) => { queries.push({ sql, args }); return { rows: [{}] }; }, release() {} };
  const app = Fastify();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  registerAgentChannelRoutes(app, { tx: async () => { throw new Error('no session routes in this test'); }, pool: { connect: async () => client } });
  return { app, queries, restore: () => { for (const k of Object.keys(env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); } };
}

const payload = (text, from = '919000000123', number = '100000000000001') => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba-synthetic', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { phone_number_id: number }, messages: [{ id: 'wamid.synthetic', from, timestamp: '1791200000', type: 'text', text: { body: text } }] } }] }] });
const sign = (raw) => 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');

test('the webhook is off without a business number', async () => {
  const s = server({ VITALS_WHATSAPP_KEY_FILE: '/nonexistent' });
  try {
    assert.equal((await s.app.inject({ method: 'GET', url: '/api/v0/channels/whatsapp/hook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1' })).statusCode, 404);
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/v0/channels/whatsapp/hook', payload: '{}', headers: { 'content-type': 'application/json' } })).statusCode, 404);
  } finally { s.restore(); }
});

test("Meta's handshake, the signature and the message into the company's database", async () => {
  const s = server(ENV);
  try {
    const ok = await s.app.inject({ method: 'GET', url: '/api/v0/channels/whatsapp/hook?hub.mode=subscribe&hub.verify_token=synthetic-verify&hub.challenge=1158201444' });
    assert.equal(ok.statusCode, 200); assert.equal(ok.body, '1158201444');
    assert.equal((await s.app.inject({ method: 'GET', url: '/api/v0/channels/whatsapp/hook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1' })).statusCode, 403);
    const raw = payload('link ABCD234567');
    const bad = await s.app.inject({ method: 'POST', url: '/api/v0/channels/whatsapp/hook', payload: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' } });
    assert.equal(bad.statusCode, 401); assert.equal(s.queries.length, 0, 'an unsigned delivery never reaches the database');
    const other = payload('hello', '919000000123', '100000000000999');
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/v0/channels/whatsapp/hook', payload: other, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(other) } })).statusCode, 404);
    const r = await s.app.inject({ method: 'POST', url: '/api/v0/channels/whatsapp/hook', payload: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) } });
    assert.equal(r.statusCode, 200); assert.deepEqual(r.json(), { ok: true, handled: 1 });
    assert.deepEqual(s.queries.map((q) => q.sql), ['begin', "select set_config('pulse.org_id',$1,true)", 'select pulse.whatsapp_inbound($1,$2,$3)', 'commit']);
    assert.equal(s.queries[1].args[0], ORG);
    assert.deepEqual(s.queries[2].args, ['919000000123', 'link ABCD234567', waCodeHash('ABCD234567')]);
  } finally { s.restore(); }
});
