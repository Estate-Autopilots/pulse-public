// NEW-DOTS: /api/v0/whats-new/unseen, /seen and /dots answer each person only the changed pages they can open, and what
// they have seen is kept on the server (tests/core/test_new_dots.py sets up the people and one synthetic release note).
// Synthetic data only.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const call = async (method, url, token, payload) => {
  const r = await app.inject({ method, url, payload, headers: { 'x-pulse-client-ip': randomBytes(6).toString('hex'), ...(token ? { 'x-pulse-session': token } : {}) } });
  return { status: r.statusCode, body: String(r.headers['content-type'] ?? '').includes('json') && r.body ? r.json() : null };
};
const signIn = async (username) => { const r = await app.inject({ method: 'POST', url: '/api/v0/auth/sign-in', headers: { 'x-pulse-client-ip': randomBytes(6).toString('hex') }, payload: { username, password: 'Synthetic-account-2026!' } });
  assert.equal(r.statusCode, 200, `${username} signs in: ${r.body}`); return r.json().token; };
const id = Number(process.env.TEST_NOTE_ID);
const routes = (s) => s.items.filter((i) => i.note === id).map((i) => i.route).sort();
try {
  const owner = await signIn('auth.admin'), member = await signIn('auth.person'), seller = await signIn('auth.noemail');
  assert.equal((await call('GET', '/api/v0/whats-new/unseen', null)).status, 401, 'signed out: nothing');
  assert.equal((await call('POST', '/api/v0/whats-new/seen', null, { all: true })).status, 401);

  // Each person: only their audiences' changed pages, and only pages they can open.
  const o = await call('GET', '/api/v0/whats-new/unseen', owner);
  assert.equal(o.status, 200);
  assert.equal(o.body.on, true, 'dots are on by default');
  assert.deepEqual(routes(o.body), ['/audit', '/contracts', '/erp/documents', '/finance', '/tasks']);
  const m = await call('GET', '/api/v0/whats-new/unseen', member);
  assert.deepEqual(routes(m.body), ['/tasks'], 'a member never hears of Contracts, Audit, Finance or Billing');
  assert.ok(!JSON.stringify(m.body).includes('Synthetic: contracts'), 'nor reads their words');
  const s = await call('GET', '/api/v0/whats-new/unseen', seller);
  assert.deepEqual(routes(s.body), ['/erp/documents', '/tasks'], 'a salesperson: their Billing deals and everyone\'s');
  assert.equal(m.body.items.find((i) => i.note === id).text, 'Synthetic: tasks load faster');

  // Opening a page (or a page inside it) clears it, on the server: another device sees it gone too.
  const visit = await call('POST', '/api/v0/whats-new/seen', member, { path: '/tasks/abc?view=list' });
  assert.equal(visit.status, 200);
  assert.deepEqual(visit.body.cleared.map((i) => i.route), ['/tasks']);
  assert.deepEqual(routes(visit.body), []);
  const otherDevice = await signIn('auth.person');
  assert.deepEqual(routes((await call('GET', '/api/v0/whats-new/unseen', otherDevice)).body), [], 'seen on every device');
  // A page they cannot open is never listed, so visiting it clears nothing and stores nothing.
  assert.deepEqual((await call('POST', '/api/v0/whats-new/seen', member, { path: '/finance' })).body.cleared, []);
  // Someone else's visit is theirs alone.
  assert.ok(routes((await call('GET', '/api/v0/whats-new/unseen', seller)).body).includes('/tasks'));

  // The switch: off, then on again; it is the person's own.
  const off = await call('POST', '/api/v0/whats-new/dots', owner, { on: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.on, false);
  assert.equal((await call('GET', '/api/v0/whats-new/unseen', owner)).body.on, false);
  assert.equal((await call('GET', '/api/v0/whats-new/unseen', seller)).body.on, true, 'one person\'s switch is not another\'s');
  assert.equal((await call('POST', '/api/v0/whats-new/dots', owner, { on: true })).body.on, true);

  // Mark all as seen.
  const all = await call('POST', '/api/v0/whats-new/seen', owner, { all: true });
  assert.equal(all.status, 200);
  assert.deepEqual(routes(all.body), []);
  assert.equal((await call('GET', '/api/v0/whats-new/unseen', owner)).body.items.filter((i) => i.note === id).length, 0);

  // Bad requests.
  assert.equal((await call('POST', '/api/v0/whats-new/seen', member, { path: { tasks: 1 } })).status, 400);
  // An unknown field is dropped (the API's body rules), so it clears nothing.
  const stray = await call('POST', '/api/v0/whats-new/seen', seller, { route: '/tasks' });
  assert.equal(stray.status, 200);
  assert.deepEqual(stray.body.cleared, []);
  assert.equal((await call('POST', '/api/v0/whats-new/dots', member, {})).status, 400);
  assert.equal((await call('POST', '/api/v0/whats-new/dots', member, { on: 'yes' })).status, 400);
  console.log('NEW-DOTS OK');
} finally {
  await app.close(); await pool.end();
}
