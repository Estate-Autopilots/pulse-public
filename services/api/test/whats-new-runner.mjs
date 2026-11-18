// RELEASE-COMMS: /api/v0/whats-new and its share cards answer each person only their audiences (tests/core/test_whats_new.py
// sets up the people and one synthetic release note). Synthetic data only.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const call = async (url, token) => { const r = await app.inject({ method: 'GET', url, headers: { 'x-pulse-client-ip': randomBytes(6).toString('hex'), ...(token ? { 'x-pulse-session': token } : {}) } });
  return { status: r.statusCode, type: String(r.headers['content-type'] ?? ''), raw: r.rawPayload, body: String(r.headers['content-type'] ?? '').includes('json') && r.body ? r.json() : null }; };
const signIn = async (username) => { const r = await app.inject({ method: 'POST', url: '/api/v0/auth/sign-in', headers: { 'x-pulse-client-ip': randomBytes(6).toString('hex') }, payload: { username, password: 'Synthetic-account-2026!' } });
  assert.equal(r.statusCode, 200, `${username} signs in: ${r.body}`); return r.json().token; };
const id = Number(process.env.TEST_NOTE_ID);
try {
  const owner = await signIn('auth.admin'), member = await signIn('auth.person'), seller = await signIn('auth.noemail');
  assert.equal((await call('/api/v0/whats-new', null)).status, 401, 'signed out: no notes');
  assert.equal((await call(`/api/v0/whats-new/${id}/card/everyone`, null)).status, 401, 'signed out: no cards');

  const o = await call('/api/v0/whats-new', owner);
  assert.equal(o.status, 200);
  assert.equal(o.body.main, 'owner');
  assert.deepEqual(o.body.audiences, ['owner', 'managers', 'salespeople', 'hr', 'clients', 'everyone']);
  const on = o.body.notes.find((n) => n.id === id);
  assert.ok(on, 'the owner sees the release');
  assert.equal(on.headline, 'Synthetic release: faster task lists');
  assert.deepEqual(Object.keys(on.items).sort(), ['everyone', 'owner', 'salespeople']);
  assert.equal(on.pleaseCheck.length, 2);
  assert.deepEqual(on.knownIssues, ['Synthetic known issue']);
  assert.match(on.share.owner.imageUrl, new RegExp(`^/api/v0/whats-new/${id}/card/owner\\?v=[0-9a-f]{12}$`));
  assert.equal(on.share.owner.text, 'Synthetic owner text');
  assert.ok(!JSON.stringify(o.body).includes('data:image'), 'the list never carries a picture');

  const m = await call('/api/v0/whats-new', member);
  assert.equal(m.status, 200);
  assert.deepEqual(m.body.audiences, ['everyone']);
  const mn = m.body.notes.find((n) => n.id === id);
  assert.deepEqual(Object.keys(mn.items), ['everyone']);
  assert.deepEqual(mn.pleaseCheck.map((p) => p.text), ['Synthetic: open Tasks']);
  assert.deepEqual(Object.keys(mn.share), ['everyone']);

  const s = await call('/api/v0/whats-new', seller);
  assert.deepEqual(s.body.audiences, ['salespeople', 'everyone']);
  assert.deepEqual(Object.keys(s.body.notes.find((n) => n.id === id).items).sort(), ['everyone', 'salespeople']);

  assert.equal((await call('/api/v0/whats-new?limit=1', owner)).body.notes.length, 1, 'the newest one only');

  // Cards: the person's own audiences only; anything else is not found.
  const card = await call(`/api/v0/whats-new/${id}/card/owner`, owner);
  assert.equal(card.status, 200);
  assert.equal(card.type, 'image/jpeg');
  assert.deepEqual([...card.raw.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.equal((await call(`/api/v0/whats-new/${id}/card/owner`, member)).status, 404, 'a member never gets the owner card');
  assert.equal((await call(`/api/v0/whats-new/${id}/card/salespeople`, member)).status, 404);
  assert.equal((await call(`/api/v0/whats-new/${id}/card/everyone`, member)).status, 200);
  assert.equal((await call(`/api/v0/whats-new/${id}/card/salespeople`, seller)).status, 200);
  assert.equal((await call(`/api/v0/whats-new/${id}/card/owner`, seller)).status, 404);
  assert.equal((await call(`/api/v0/whats-new/${id}/card/hr`, owner)).status, 404, 'no card for that audience');
  assert.equal((await call(`/api/v0/whats-new/${id}/card/stranger`, owner)).status, 404);
  assert.equal((await call('/api/v0/whats-new/not-a-number/card/owner', owner)).status, 404);
  assert.equal((await call('/api/v0/whats-new/999999999/card/owner', owner)).status, 404);
  console.log('WHATS-NEW OK');
} finally {
  await app.close(); await pool.end();
}
