import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanBatch, cleanDetail, pathTemplate, scrub, TelemetryBudget, MAX_EVENTS } from '../dist/telemetry-model.js';

// TELEMETRY: what the API keeps of a browser's batch. Synthetic values only.
const received = Date.parse('2026-10-24T10:00:00Z');

test('a batch becomes rows on the server clock; unknown kinds, future and stale events are dropped', () => {
  const sentAt = received - 5000; // the browser's clock runs five seconds behind
  const out = cleanBatch({ v: 1, sid: 'synthetic-session-1', sentAt, app: { rel: 'dev-abc123', plat: 'android', shell: '1.1.4', dev: 'phone' }, ev: [
    { k: 'ui.click', t: sentAt - 1000, n: 'button Save changes', p: '/tasks/3f2a1b4c-1111-4222-8333-444455556666', d: 182.4, x: { sel: 'main>button.btn', paint: 16 } },
    { k: 'api', t: sentAt - 900, n: 'GET /api/v0/people/3f2a1b4c-1111-4222-8333-444455556666?q=private', d: 95, s: 200, r: 'req-0000-0001' },
    { k: 'api.server', t: sentAt }, { k: 'drop table', t: sentAt }, { k: 'ui.click', t: sentAt - 4 * 24 * 3600 * 1000 },
    { k: 'nav.route', t: sentAt + 3_600_000, n: '/hr?tab=leave', d: 300 },
  ] }, received);
  assert.equal(out.dropped, 3, 'api.server is the server\'s own; an unknown kind and a four-day-old event are dropped');
  assert.equal(out.rows.length, 3);
  const [click, api, future] = out.rows;
  assert.equal(click.at, new Date(received - 1000).toISOString(), 'moved onto the server clock');
  assert.equal(click.page, '/tasks/:id');
  assert.equal(click.duration_ms, 182);
  assert.deepEqual(click.detail, { sel: 'main>button.btn', paint: 16 });
  assert.equal(click.platform, 'android');
  assert.equal(click.shell_version, '1.1.4');
  assert.equal(click.session_id, 'synthetic-session-1');
  assert.equal(api.name, 'GET /api/v0/people/:id?q', 'the query keeps its keys only');
  assert.equal(api.status, 200);
  assert.equal(api.request_id, 'req-0000-0001');
  assert.equal(future.at, new Date(received).toISOString(), 'never in the future');
});

test('only a batch is a batch; a batch is capped', () => {
  for (const body of [null, 'x', [], {}, { ev: 'x' }]) assert.equal(cleanBatch(body, received), null);
  const many = cleanBatch({ sentAt: received, ev: Array.from({ length: MAX_EVENTS + 20 }, () => ({ k: 'ui.click', t: received })) }, received);
  assert.equal(many.rows.length, MAX_EVENTS);
  assert.equal(many.dropped, 20);
  const odd = cleanBatch({ sid: 'bad id!', app: { plat: 'toaster', rel: '<script>', shell: 'x' }, ev: [{ k: 'app.session' }] }, received);
  assert.deepEqual([odd.rows[0].session_id, odd.rows[0].platform, odd.rows[0].app_version, odd.rows[0].shell_version], [null, 'web', null, null]);
});

test('details keep small safe values; anything that could carry content is dropped', () => {
  assert.deepEqual(cleanDetail({ paint: 16.456, nav: true, sel: 'button.btn', fields: ['title', 'someone@example.test', 3],
    text: 'typed words', password: 'x', body: 'message', value: 'x', token: 'x', nested: { a: 1 }, 'bad key': 1 }),
    { paint: 16.46, nav: true, sel: 'button.btn', fields: ['title', ':email'] });
  assert.equal(cleanDetail('x'), null);
  assert.equal(cleanDetail({}), null);
  assert.equal(scrub('Open 3f2a1b4c-1111-4222-8333-444455556666 by someone@example.test, 98765 43210'), 'Open :id by :email, :n');
  assert.equal(pathTemplate('/api/v0/tasks/EA-T00123/notes'), '/api/v0/tasks/:id/notes');
});

test('the budget allows a person a steady stream and refuses a flood, per minute', () => {
  const budget = new TelemetryBudget(100, 3);
  assert.equal(budget.take('a', 40, 0), true);
  assert.equal(budget.take('a', 40, 1), true);
  assert.equal(budget.take('a', 40, 2), false, 'events per minute');
  assert.equal(budget.take('b', 1, 2), true, 'per person');
  assert.equal(budget.take('a', 1, 3), true);
  assert.equal(budget.take('a', 1, 4), false, 'batches per minute');
  assert.equal(budget.take('a', 40, 60_001), true, 'a new minute');
});
