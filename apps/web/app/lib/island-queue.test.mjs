import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPriority, nextArrival, PER_MINUTE, priorityIndex, shouldPreempt } from './island-queue.mjs';

const item = (n, tone) => ({ id: `i${n}`, title: `Arrival ${n}`, ...(tone ? { tone } : {}) });
const summary = (rest) => ({ id: 'summary', title: `${rest.length} new updates`, detail: rest.at(-1).title });

test('arrivals open one at a time, oldest first', () => {
  const r = nextArrival([item(1), item(2)], [], 1000, summary);
  assert.equal(r.item.id, 'i1');
  assert.deepEqual(r.queue.map((i) => i.id), ['i2']);
  assert.deepEqual(r.shown, [1000]);
});

test('a burst folds into one line; a problem is never folded away', () => {
  const r = nextArrival([item(1), item(2, 'error'), item(3), item(4), item(5)], [], 5000, summary);
  assert.equal(r.item.tone, 'error');
  assert.deepEqual(r.queue.map((i) => i.title), ['4 new updates']);
  assert.equal(r.queue[0].detail, 'Arrival 5');
});

test('more than eight a minute become one line; older openings stop counting', () => {
  const now = 120000;
  const busy = Array.from({ length: PER_MINUTE }, (_, i) => now - 1000 * (i + 1));
  const r = nextArrival([item(1), item(2)], busy, now, summary);
  assert.equal(r.item.title, '2 new updates');
  const calm = nextArrival([item(1)], busy.map((t) => t - 60000), now, summary);
  assert.equal(calm.item.id, 'i1');
  assert.deepEqual(calm.shown, [now]);
});

test("the app's own answer is never folded, even after a busy minute; a lone arrival opens as itself", () => {
  const now = 120000;
  const busy = Array.from({ length: PER_MINUTE }, (_, i) => now - 1000 * (i + 1));
  const r = nextArrival([item(1, 'success'), item(2), item(3)], busy, now, summary);
  assert.equal(r.item.id, 'i1');
  assert.deepEqual(r.queue.map((i) => i.title), ['2 new updates']);
  const lone = nextArrival([item(4)], busy, now, summary);
  assert.equal(lone.item.id, 'i4');
});

test('nothing waiting opens nothing', () => {
  assert.deepEqual(nextArrival([], [10], 20, summary), { item: null, queue: [], shown: [10] });
});

test('confirmations and open action requests move ahead of info notices', () => {
  const info = item(1, 'info');
  const update = item(2);
  const success = item(3, 'success');
  const action = { ...item(4), priority: 'action' };
  const queued = [info, update];

  queued.splice(priorityIndex(queued), 0, success);
  assert.deepEqual(queued.map((entry) => entry.id), ['i3', 'i1', 'i2']);
  assert.equal(shouldPreempt(info, success), true);
  assert.equal(shouldPreempt(success, action), false);

  queued.splice(priorityIndex(queued), 0, action);
  assert.deepEqual(queued.map((entry) => entry.id), ['i3', 'i4', 'i1', 'i2']);
  assert.equal(hasPriority(info), false);
  assert.equal(hasPriority(action), true);
  assert.equal(shouldPreempt(info, action), true);
});

test('a burst keeps the newest request on its own line, ahead of info notices (EST-1763)', () => {
  // A page loaded after a busy minute: an older request and updates wait, a role-brief notice is on show, then a
  // request arrives. It takes the notice's place (which comes back after it) and the burst folds behind it.
  const older = { ...item(1), priority: 'action' };
  const ask = { ...item(2), priority: 'action' };
  const brief = item(3, 'info');
  const queued = [older, item(4, 'info'), item(5), item(6)];
  assert.equal(shouldPreempt(brief, ask), true);
  const at = priorityIndex(queued, ask);
  queued.splice(at, 0, ask, { ...brief, again: true });
  const r = nextArrival(queued, [], 9000, summary);
  assert.equal(r.item.id, 'i2');
  assert.deepEqual(r.queue.map((i) => i.title), ['Arrival 3', 'Arrival 4', '3 new updates']);
  // Problems and the person's own answers still come first; only the newest request keeps its line.
  const first = nextArrival([item(7, 'success'), older, ask, item(8), item(9), item(10, 'error')], [], 9000, summary);
  assert.deepEqual([first.item, ...first.queue].map((i) => i.title), ['Arrival 10', 'Arrival 7', 'Arrival 2', '3 new updates']);
});

test("the person's own answer goes ahead of a request too, and a request on show makes way for it", () => {
  const action = { ...item(1), priority: 'action' };
  const success = item(2, 'success');
  const queued = [action, item(3, 'info')];
  queued.splice(priorityIndex(queued, success), 0, success);
  assert.deepEqual(queued.map((entry) => entry.id), ['i2', 'i1', 'i3']);
  assert.equal(shouldPreempt(action, success), true);
  assert.equal(shouldPreempt(success, item(4, 'error')), false);
});
