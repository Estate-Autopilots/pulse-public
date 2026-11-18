// TOKENS-TELEMETRY: the Insights story's pure half: the journey map, the key-job funnels and the digest's thresholds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, FUNNELS, funnel, journeys, placeOf } from '../dist/telemetry-story-model.js';

test('places are templates; a tab is a place, other query words are not', () => {
  assert.equal(placeOf('/tasks/6f1a455d-ced2-504d-b8d5-5ae0efbe7c75'), '/tasks/:id');
  assert.equal(placeOf('/me?tab=attendance&x=1'), '/me?tab=attendance');
  assert.equal(placeOf('/erp/documents/123?print=1'), '/erp/documents/:id');
});

test('the journey map is step by step (acyclic), counts each session once per step, and marks where people left', () => {
  const v = (s, ...pages) => pages.map((page) => ({ s, page }));
  const j = journeys([...v('a', '/tasks', '/chats', '/tasks'), ...v('b', '/tasks', '/tasks'), ...v('c', '/chats', '/me', '/x', '/y', '/z')], { steps: 4, top: 6 });
  assert.equal(j.sessions, 3);
  for (const l of j.links) assert.ok(Number(l.source[0]) + 1 === Number(l.target[0]), `${l.source} -> ${l.target} goes one step on`);
  assert.equal(j.nodes.find((n) => n.name === '1 · /tasks').views, 2);
  assert.equal(j.links.find((l) => l.source === '1 · /tasks' && l.target === '2 · Left').value, 1, 'b opened /tasks twice in a row, then left');
  assert.equal(j.links.find((l) => l.source === '3 · /tasks' && l.target === '4 · Left').value, 1);
  assert.ok(!j.nodes.some((n) => n.step > 3), 'four steps at most');
  const many = journeys(Array.from({ length: 10 }, (_, i) => ({ s: `s${i}`, page: `/p${i}` })), { steps: 2, top: 3 });
  assert.equal(many.nodes.find((n) => n.name === '1 · Other').views, 7, 'beyond the top places: Other');
});

test('a funnel counts sessions that did each step in order, within 30 minutes, and only successful saves', () => {
  const task = FUNNELS.find((f) => f.key === 'task').steps;
  const r = (s, t, kind, name, status = null) => ({ s, t, kind, name, page: '/tasks', status });
  const rows = [r('a', 0, 'ui.dialog.open', 'New task'), r('a', 60000, 'api', 'POST /api/v0/work/tasks', 200),
    r('b', 0, 'ui.dialog.open', 'New task'), r('b', 1000, 'api', 'POST /api/v0/work/tasks', 400),
    r('c', 0, 'ui.dialog.open', 'New task'), r('c', 31 * 60000, 'api', 'POST /api/v0/work/tasks', 200),
    r('d', 0, 'api', 'POST /api/v0/work/tasks', 200)];
  assert.deepEqual(funnel(rows, task), [{ label: 'Opened New task', sessions: 3, kept: null }, { label: 'Task saved', sessions: 1, kept: 33 }]);
});

test('the digest calls a change better or worse only when it is real', () => {
  const [a, b, c, d, e] = digest([
    { key: 'route', label: 'r', unit: 'ms', now: 3400, before: 4500, lowerIsBetter: true, n: 50 },
    { key: 'api', label: 'a', unit: 'ms', now: 900, before: 800, lowerIsBetter: true, n: 50 },
    { key: 'errors', label: 'e', unit: 'count', now: 9, before: 3, lowerIsBetter: true },
    { key: 'people', label: 'p', unit: 'count', now: 16, before: 17, lowerIsBetter: false },
    { key: 'load', label: 'l', unit: 'ms', now: 9000, before: 3000, lowerIsBetter: true, n: 2 }]);
  assert.equal(a.verdict, 'better'); assert.equal(a.change, -24);
  assert.equal(b.verdict, 'same', '12% and 100 ms is noise');
  assert.equal(c.verdict, 'worse');
  assert.equal(d.verdict, 'same');
  assert.equal(e.verdict, 'same', 'two loads are not enough to say');
});
