import test from 'node:test';
import assert from 'node:assert/strict';
import { causeOf, dayList, errorBudget, shape, thing } from '../dist/telemetry-errors-model.js';

// ERROR-SWEEP (17 Nov 2026): the error budget's causes, per day, new / back / known. Synthetic rows only.
const row = (day, kind, name, extra = {}) => ({ day, kind, name, status: null, page: '/tasks', person: 'p1', err: null, bg: false, who: null, n: 1, ...extra });
const days = dayList('2026-11-17', 14);

test('days run oldest first and end today', () => {
  assert.equal(days.length, 14);
  assert.equal(days[0], '2026-11-04');
  assert.equal(days[13], '2026-11-17');
});

test('one cause per message shape: ids and numbers do not split it', () => {
  assert.equal(shape('Task 4f0c2a1e-0000-4000-8000-000000000001 failed after 1200 ms'), 'Task :id failed after N ms');
  const a = causeOf(row('2026-11-17', 'error.js', 'x is undefined at 12'));
  const b = causeOf(row('2026-11-17', 'error.promise', 'x is undefined at 99'));
  assert.equal(a.key, b.key, 'a script error and an unhandled rejection with one message are one cause');
});

test('what is not an error a person hit is left out', () => {
  assert.equal(causeOf(row('2026-11-17', 'api', 'GET /api/v0/calls', { status: 0, err: 'network', bg: true })), null, 'device offline');
  assert.equal(causeOf(row('2026-11-17', 'api.server', 'GET /api/v1/billing/quotations', { status: 400, who: 'key', person: null })), null, 'an API key probe');
  assert.equal(causeOf(row('2026-11-17', 'api.server', 'POST /api/v0/auth/account-sign-in', { status: 401, who: 'anon', person: null })), null, 'signed out');
  assert.equal(causeOf(row('2026-11-17', 'api.server', 'GET /api/v0/briefs/tick', { status: 404 })), null, 'a switched-off module');
  assert.equal(causeOf(row('2026-11-17', 'api', 'POST /api/v0/ai/signin', { status: 500 })), null, 'a 500 is counted once, by the server');
});

test('what people hit is counted, by area', () => {
  assert.equal(causeOf(row('2026-11-17', 'error.stream', 'SSE /api/v0/calls/events')).area, 'live');
  assert.equal(causeOf(row('2026-11-17', 'api.server', 'POST /api/v0/ai/signin', { status: 500 })).area, 'server');
  assert.equal(causeOf(row('2026-11-17', 'api', 'GET /api/v0/calls', { status: 503 })).area, 'server', 'the API restarting');
  assert.equal(causeOf(row('2026-11-17', 'api.server', 'POST /api/v0/account/switch', { status: 403 })).area, 'refused');
  assert.equal(causeOf(row('2026-11-17', 'error.call', 'no-connect')).area, 'connection');
});

test('new, back and known; people first; per day with the new share', () => {
  const rows = [
    // known: every day for a week
    ...days.slice(6).map((d) => row(d, 'error.stream', 'SSE /api/v0/calls/events', { n: 10, person: 'p1' })),
    // new today: two people
    row('2026-11-17', 'error.js', 'Cannot read properties of undefined (reading \'x\')', { person: 'p2' }),
    row('2026-11-17', 'error.js', 'Cannot read properties of undefined (reading \'x\')', { person: 'p3' }),
    // back: seen in the look-back (before the 14 days), quiet since, again yesterday
    row('2026-10-30', 'api.server', 'POST /api/v0/money/import', { status: 500 }),
    row('2026-11-16', 'api.server', 'POST /api/v0/money/import', { status: 500 }),
  ];
  const b = errorBudget(rows, days);
  const byKey = Object.fromEntries(b.causes.map((c) => [c.key, c]));
  assert.equal(byKey['stream:SSE /api/v0/calls/events'].state, 'known');
  assert.equal(byKey['stream:SSE /api/v0/calls/events'].total, 80);
  assert.equal(byKey['error.js:Cannot read properties of undefined (reading \'x\')'].state, 'new');
  assert.equal(byKey['server:POST /api/v0/money/import:500'].state, 'back');
  assert.equal(byKey['server:POST /api/v0/money/import:500'].total, 1, 'the look-back is not counted in the days shown');
  assert.equal(b.causes[0].state, 'new', 'new causes lead');
  assert.deepEqual(b.causes.map((c) => c.state), ['new', 'back', 'known'], 'then the ones back again, then the rest');
  assert.equal(b.today.errors, 12);
  assert.equal(b.today.newCauses, 1);
  assert.equal(b.today.backCauses, 1);
  assert.deepEqual(b.perDay.at(-1), { day: '2026-11-17', total: 12, fresh: 2 });
  assert.deepEqual(b.perDay.at(-2), { day: '2026-11-16', total: 11, fresh: 0 });
});

test('a cause quiet in the days shown is not listed', () => {
  const b = errorBudget([row('2026-10-25', 'error.js', 'old')], days);
  assert.deepEqual(b.causes, []);
  assert.equal(b.perDay.reduce((a, d) => a + d.total, 0), 0);
});

test('every cause has a plain title; the code stays as the label', () => {
  assert.equal(thing('POST /api/v0/money/import'), 'money import');
  assert.equal(thing('GET /api/v0/tasks/:id/move'), 'tasks move');
  assert.equal(causeOf(row('2026-11-17', 'api.server', 'POST /api/v0/money/import', { status: 500 })).title, 'Money import failed on the server');
  assert.equal(causeOf(row('2026-11-17', 'api.server', 'POST /api/v0/account/tab-open', { status: 403 })).title, 'Account tab open: not allowed');
  assert.equal(causeOf(row('2026-11-17', 'error.stream', 'SSE /api/v0/calls/events')).title, 'Live updates stopped (calls)');
  assert.equal(causeOf(row('2026-11-17', 'api', 'GET /api/v0/tasks/reviews/count', { status: 503 })).title, 'Tasks reviews count did not load during an update');
  const js = causeOf(row('2026-11-17', 'error.js', "Cannot read properties of undefined (reading 'x')"));
  assert.equal(js.title, 'Something broke on a page');
  assert.match(js.label, /Cannot read properties/);
});
