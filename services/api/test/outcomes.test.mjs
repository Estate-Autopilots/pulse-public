import test from 'node:test';
import assert from 'node:assert/strict';
import { abovePlan, fold, runs, usualWeek, weekList } from '../dist/outcomes.js';

test('a usual week is the middle of the weeks before, once there are three with credit', () => {
  assert.equal(usualWeek([0, 0, 5]), null);
  assert.equal(usualWeek([4, 0, 8, 6]), 6);
  assert.equal(usualWeek([2, 4, 6, 8]), 5);
  const p = abovePlan([4, 6, 8, 5, 20]);
  assert.deepEqual(p.map((x) => x.above), [0, 0, 0, 0, 14]);
  assert.equal(p[4].usual, 6);
});

test('streaks: the current run may start last week; the best run is the longest', () => {
  const weeks = new Set(['2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05']);
  assert.deepEqual(runs(weeks, '2026-10-05', 7, 10), { best: 4, current: 4 });
  assert.deepEqual(runs(weeks, '2026-10-12', 7, 10), { best: 4, current: 4 }, 'this week may still be empty');
  const sunday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0;
  assert.deepEqual(runs(new Set(['2026-10-09', '2026-10-10', '2026-10-12']), '2026-10-12', 1, 10, sunday), { best: 3, current: 3 }, 'Sunday 11 Oct is skipped');
});

test('series fold into the top few and Other, never a ninth colour', () => {
  const weeks = weekList('2026-10-05', 2);
  const rows = ['A', 'B', 'C', 'D', 'E', 'F'].map((k, i) => ({ key: k, label: k, week: weeks[1], points: 10 - i }));
  const s = fold(rows, weeks, 4);
  assert.deepEqual(s.map((x) => x.label), ['A', 'B', 'C', 'D', 'Other']);
  assert.deepEqual(s.at(-1).values, [0, 6 + 5]);
});
