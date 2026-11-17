// LAND-CAPTAIN-10 (12 Nov 2026): the production hangs of 10-12 Nov. listEvents asked which areas the key holds by
// opening a second transaction INSIDE its own; resolving a key takes the key's row FOR UPDATE (pulse.service_key_auth)
// until its transaction ends, so the inner transaction waited for the call's own lock while the call waited for it, and
// every pool client queued behind (caught live 12 Nov 20:10). The areas are now resolved before the call's transaction:
// a v1 call never holds two database clients at once.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { heldScopes } from '../dist/v1.js';

const ORG = '00000000-0000-4000-8000-000000001611', VIEWER = '00000000-0000-4000-8000-0000000000ee';
const SECRET = 'a'.repeat(43), APP = `psvc_00000000-0000-4000-8000-0000000000aa_${SECRET}`;
const HELD = new Set(['events.read', 'tasks.read']);   // the synthetic key holds these two areas

function world() {
  const sql = []; let out = 0, most = 0, nested = 0;
  const client = () => ({
    release() { out--; },
    query: async (text, args) => {
      sql.push(text);
      if (/v1_service_principal/.test(text)) return { rows: [{ v: args[1] === createHash('sha256').update(SECRET).digest('hex') && HELD.has(args[2]) ? 'token' : null }] };
      if (text.includes('service_key_hash')) return { rows: [{ v: createHash('sha256').update(SECRET).digest('hex') }] };
      if (text.includes('current_viewer()')) return { rows: [{ id: VIEWER, actor: 'service:synthetic' }] };
      if (text.includes('v1_events_after')) return { rows: [{ v: [] }] };
      if (text.includes('v1_replay')) return { rows: [{ v: null }] };
      return { rows: [] };
    } });
  const pool = { connect: async () => { out++; most = Math.max(most, out); if (out > 1) nested++; return client(); }, query: async () => ({ rows: [] }) };
  const app = createApp({ query: async (text) => ({ rows: text.includes('host_org') ? [{ org_id: ORG, sign_in: 'password', status: 'active', rehearsal: false }] : [{ org_id: ORG }] }) }, pool);
  return { app, sql, stats: () => ({ out, most, nested }) };
}

test('listEvents never opens a second transaction inside its own (the 12 Nov deadlock)', async () => {
  const w = world();
  try {
    const r = await w.app.inject({ method: 'GET', url: '/api/v1/events', headers: { authorization: `Bearer ${APP}` } });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().items, []);
    const s = w.stats();
    assert.equal(s.out, 0, 'every client went back');
    assert.equal(s.most, 1, 'at most one database client at a time for one call');
    assert.equal(s.nested, 0);
    // The areas were still each asked of the database (a fresh transaction each, before the call's), and the events read
    // only for the area the key holds.
    assert.ok(w.sql.filter((q) => /v1_service_principal/.test(q)).length >= 2);
    assert.ok(w.sql.some((q) => q.includes('v1_events_after')));
  } finally { await w.app.close(); }
});

test('the activity alias too', async () => {
  const w = world();
  try {
    const r = await w.app.inject({ method: 'GET', url: '/api/v1/events/activity', headers: { authorization: `Bearer ${APP}` } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(w.stats().most, 1);
  } finally { await w.app.close(); }
});

test('inside a call, an area the operation did not declare is refused at once, never resolved on a nested transaction', () => {
  const request = {};
  assert.throws(() => heldScopes(request, ['tasks.read']), /not declared in the operation's keyScopes/);
});
