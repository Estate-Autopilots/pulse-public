import test from 'node:test';
import assert from 'node:assert/strict';
import {personalContext, personalContexts} from '../dist/hr.js';
// WORKFLOW-QA-2 (16 Nov 2026): the HR desk and "who is late" read every person's working days in one batch instead of
// 2-3 queries per person (26 people: ~80 round trips, 2.5-3.7 s). Each person must get exactly the context the
// one-person read gives: their own days, their own approved day-off work, their own week.
const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002';
const x = { today: '2026-11-16', clock: '10:00', zone: 'Asia/Kolkata', policy: { workDays: [1, 2, 3, 4, 5], shiftStart: '10:00', shiftEnd: '19:00', graceMinutes: 10 }, types: [], holidays: [], off: new Map() };
/** A fake client answering the two batch reads from per-person tables, as the database would. */
function client(days, weeks) {
  const asked = [];
  return { asked, query: async (sql, params) => {
    asked.push(sql);
    const ids = params[0];
    if (/hr_work_days/.test(sql)) return { rows: ids.map((who) => ({ who, days: weeks[who] })) };
    return { rows: ids.flatMap((who) => (days[who] ?? []).map((d) => ({ who, ...d }))) };
  } };
}
const days = {
  [A]: [{ day: '2026-11-14', approved: false, working: false }, { day: '2026-11-15', approved: true, working: true }],
  [B]: [{ day: '2026-11-14', approved: false, working: true }, { day: '2026-11-15', approved: false, working: false }],
};
const weeks = { [A]: [1, 2, 3, 4, 5], [B]: [1, 2, 3, 4, 5, 6] };

test('a batch gives each person their own days, day-off work and week, in two queries', async () => {
  const c = client(days, weeks);
  const all = await personalContexts(c, x, [A, B], '2026-11-14', '2026-11-15');
  assert.equal(c.asked.length, 2, 'two queries for everyone');
  assert.deepEqual([...all.get(A).dayWork], [['2026-11-14', false], ['2026-11-15', true]]);
  assert.deepEqual([...all.get(A).approvedWork], ['2026-11-15']);
  assert.deepEqual(all.get(A).policy.workDays, [1, 2, 3, 4, 5]);
  assert.deepEqual([...all.get(B).dayWork], [['2026-11-14', true], ['2026-11-15', false]]);
  assert.deepEqual([...all.get(B).approvedWork], []);
  assert.deepEqual(all.get(B).policy.workDays, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(all.get(A).fallbackWorkDays, [1, 2, 3, 4, 5], 'the company week is the fallback');
  assert.equal(all.get(B).policy.shiftStart, '10:00', 'the rest of the context is the company one');
});

test('one person read is the same as that person in a batch', async () => {
  const one = await personalContext(client(days, weeks), x, B, '2026-11-14', '2026-11-15');
  const many = (await personalContexts(client(days, weeks), x, [A, B], '2026-11-14', '2026-11-15')).get(B);
  assert.deepEqual({ ...one, dayWork: [...one.dayWork], approvedWork: [...one.approvedWork] }, { ...many, dayWork: [...many.dayWork], approvedWork: [...many.approvedWork] });
});

test('no people, no query; the same person twice is asked once; an id in capitals still finds its context', async () => {
  const c = client(days, weeks);
  assert.equal((await personalContexts(c, x, [], '2026-11-14', '2026-11-15')).size, 0);
  assert.equal(c.asked.length, 0);
  const twice = await personalContexts(c, x, [A, A], '2026-11-14', '2026-11-15');
  assert.equal(twice.size, 1);
  const upper = await personalContext(client(days, weeks), x, A.toUpperCase(), '2026-11-14', '2026-11-15');
  assert.deepEqual([...upper.approvedWork], ['2026-11-15']);
});

test('a person with no days in range still gets a context (nothing working, nothing approved)', async () => {
  const all = await personalContexts(client({}, { [A]: [1, 2, 3] }), x, [A], '2026-11-14', '2026-11-15');
  assert.equal(all.get(A).dayWork.size, 0);
  assert.deepEqual(all.get(A).policy.workDays, [1, 2, 3]);
});
