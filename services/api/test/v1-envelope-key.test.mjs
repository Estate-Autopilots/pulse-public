// PULSE-BUGS (Suryoday Solar (Demo) bug #2): an MCP write called by its operationId (no named tool, e.g. createQuoteLead)
// without an idempotencyKey was refused 400 "Send a UUID Idempotency-Key for every write". It now gets a fresh key, as a
// named tool's write without requestId does; a key that is sent (in the arguments or the header) is kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cursorFirst, envelopeInput, v1Operations } from '../dist/v1.js';
import '../dist/v1-wl-reads.js'; // registers createQuoteLead

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('an envelope write with no key gets a fresh one; each call a new one', () => {
  const body = { name: 'Synthetic Customer', area: 'Pune', salespersonId: '00000000-0000-4000-8000-000000000001' };
  const a = envelopeInput({ method: 'POST' }, { body }, undefined), b = envelopeInput({ method: 'POST' }, { body }, undefined);
  assert.match(String(a.idempotencyKey), UUID);
  assert.match(String(b.idempotencyKey), UUID);
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
  assert.deepEqual(a.body, body, 'the body is untouched');
});

test('a key that is sent is kept, a read gets none, an unknown operation is left alone', () => {
  const sent = '00000000-0000-4000-8000-0000000000aa';
  assert.equal(envelopeInput({ method: 'POST' }, { body: {}, idempotencyKey: sent }, undefined).idempotencyKey, sent);
  assert.equal(envelopeInput({ method: 'POST' }, { body: {} }, sent).idempotencyKey, undefined, 'the transport header still decides');
  assert.equal(envelopeInput({ method: 'GET' }, { query: {} }, undefined).idempotencyKey, undefined);
  assert.equal(envelopeInput(undefined, { body: {} }, undefined).idempotencyKey, undefined);
});

test('createQuoteLead is such an operation: a write with no named tool', () => {
  const op = v1Operations().find((o) => o.operationId === 'createQuoteLead');
  assert.ok(op, 'createQuoteLead is registered');
  assert.equal(op.method, 'POST');
  assert.equal(op.mcp, undefined, 'called over MCP by its operationId, with the envelope');
});

// PULSE-BUGS (Estate Autopilots bug #33): a page of 100 triage tasks is cut by the AI engine before the last key; over MCP
// nextCursor comes first, so the next page can always be asked for. Other answers are left as they are.
test('a page answer names nextCursor first; other answers are untouched', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, title: 'Synthetic task '.repeat(20) }));
  const shown = cursorFirst({ items, nextCursor: 'cur_123' });
  assert.deepEqual(Object.keys(shown), ['nextCursor', 'items']);
  assert.ok(JSON.stringify(shown).slice(0, 2000).includes('"nextCursor":"cur_123"'), 'still there when the answer is cut short');
  assert.deepEqual(Object.keys(cursorFirst({ items: [], nextCursor: null })), ['nextCursor', 'items']);
  const plain = { task: { id: 'x' } };
  assert.equal(cursorFirst(plain), plain);
  assert.deepEqual(cursorFirst([1, 2]), [1, 2]);
  assert.equal(cursorFirst(null), null);
});
