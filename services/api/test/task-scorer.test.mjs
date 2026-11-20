import test from 'node:test';
import assert from 'node:assert/strict';
import { heuristicScorer, taskScorer, hoursLabel } from '../dist/ai/task-scorer.js';
import { workLabels } from '../dist/work-model.js';

const base = { title: 'Edit the Northstar reel', category: 'video_edit', categoryLabel: 'Video editing', dueOn: null, today: '2026-10-10', project: null, similar: null };

test('the seam returns the transparent heuristic scorer (no keys, no calls out)', async () => {
  assert.equal(taskScorer(), heuristicScorer);
  const s = await taskScorer().suggest(base);
  assert.equal(s.model, 'pip-heuristic');
  assert.ok(s.reason.length > 10 && s.reason.length <= 180 && !s.reason.includes('\n'), 'one line');
});

test('effort comes from similar finished work when there is enough of it, else the usual for the kind of work', async () => {
  const usual = await heuristicScorer.suggest(base);
  assert.equal(usual.effortMinutes, 180);
  assert.equal(usual.confidence, 'medium');
  const learned = await heuristicScorer.suggest({ ...base, similar: { n: 6, minutes: 95, minutesN: 5, cycleDays: 1, value: null, points: null } });
  assert.equal(learned.effortMinutes, 90);
  assert.equal(learned.confidence, 'high');
  assert.match(learned.reason, /like 5 past video editing tasks/);
  const unknown = await heuristicScorer.suggest({ ...base, title: 'Leadership offsite', category: null, categoryLabel: null });
  assert.equal(unknown.confidence, 'low');
  assert.equal(unknown.effortMinutes, 60);
});

test('the title, the deadline and client work move importance and value', async () => {
  const small = await heuristicScorer.suggest({ ...base, title: 'Quick check of the reel' });
  const big = await heuristicScorer.suggest({ ...base, title: 'Full brand film for Northstar' });
  assert.ok(small.effortMinutes < 180 && big.effortMinutes > 180);
  assert.ok(big.valuePoints > small.valuePoints);
  const three = await heuristicScorer.suggest({ ...base, title: 'Edit 3 reels for Lakeview' });
  assert.ok(three.effortMinutes > 300, 'three pieces take longer');
  assert.equal((await heuristicScorer.suggest({ ...base, dueOn: '2026-10-11' })).importance, 'high');
  assert.equal((await heuristicScorer.suggest({ ...base, dueOn: '2026-10-09' })).importance, 'urgent');
  assert.equal((await heuristicScorer.suggest({ ...base, title: 'Idea: explore AI captions' })).importance, 'low');
  assert.equal((await heuristicScorer.suggest({ ...base, priority: 'low', dueOn: '2026-10-10' })).importance, 'low', 'the creator’s choice stands');
  const internal = await heuristicScorer.suggest({ ...base, project: { name: 'Website relaunch', kind: 'internal', packageBand: null } });
  const client = await heuristicScorer.suggest({ ...base, project: { name: 'Northstar Heights', kind: 'fulfilment', packageBand: 4 } });
  assert.ok(client.valuePoints > internal.valuePoints);
  assert.equal(client.importance, 'high', 'a top-quarter package is important');
  assert.match(client.reason, /client work for Northstar Heights/);
  assert.ok(client.basis.some((b) => /top quarter/.test(b)));
});

test('RELEASE-5: the owner\'s Office presence task is setup and admin work of about an hour, not a quick client call', async () => {
  // The database reads its title as setup_admin (tests/core/test_work_domains.py); its "check-in" is Pulse's attendance,
  // not a quick check, so the size is not halved (before: client service, 15 min, 1 point).
  const title = 'Add the office Wi-Fi and IP in Office presence, and test arrival check-in with 2 people';
  const s = await heuristicScorer.suggest({ ...base, title, category: 'setup_admin', categoryLabel: 'Setup and admin' });
  assert.equal(s.effortMinutes, 60);
  assert.match(s.reason, /^About 1 h of setup and admin\.$/);
  assert.ok(!s.basis.some((b) => /small piece of work/.test(b)), 'a check-in is not a quick check');
  assert.equal(s.breakdown[0].detail, 'usual for setup and admin: about 1 h (about 1¼ points an hour)');
  assert.ok((await heuristicScorer.suggest({ ...base, title: 'Quick check of the check-in list' })).basis.some((b) => /small piece of work/.test(b)), 'a check still is');
});

test('value stays between 1 and 100 and leans toward what similar work was valued at', async () => {
  const tiny = await heuristicScorer.suggest({ ...base, title: 'Resend the link', category: 'client_service', categoryLabel: 'Client service' });
  assert.ok(tiny.valuePoints >= 1);
  const huge = await heuristicScorer.suggest({ ...base, title: 'Complete campaign overhaul', similar: { n: 4, minutes: 20000, minutesN: 4, cycleDays: 20, value: null, points: null }, dueOn: '2026-10-10',
    project: { name: 'Northstar', kind: 'fulfilment', packageBand: 4 } });
  assert.equal(huge.valuePoints, 100);
  const precedent = await heuristicScorer.suggest({ ...base, similar: { n: 5, minutes: null, minutesN: 0, cycleDays: null, value: 20, points: null } });
  assert.ok(precedent.valuePoints >= 10 && precedent.basis.some((b) => /valued at about 20 points/.test(b)));
});

test('hours read naturally', () => {
  assert.equal(hoursLabel(45), '45 min');
  assert.equal(hoursLabel(180), '3 h');
  assert.equal(hoursLabel(90), '1.5 h');
});

test('labels follow the business model', () => {
  assert.deepEqual([workLabels('agency').section, workLabels('agency').clientProjects, workLabels('agency').clients], ['Clients', 'Client projects', 'Clients']);
  assert.deepEqual([workLabels('product').section, workLabels('product').clientProjects, workLabels('product').clients, workLabels('product').packageChip], ['Products', 'Releases', 'Customers', 'Release']);
  assert.equal(workLabels('internal').section, null);
  assert.equal(workLabels('nonsense').model, 'agency');
});

// TASKS-4B: an explainable, consistent value: every signal's points in the breakdown, unlocks and the kind of work's
// usual value count, and leadership's past changes are learned from (three or more).
test('the breakdown explains the value: each signal with the points it added', async () => {
  const s = await heuristicScorer.suggest({ ...base, project: { name: 'Northstar Heights', kind: 'fulfilment', packageBand: 3 }, dueOn: '2026-10-11', unlocks: { tasks: 2, value: 16 } });
  assert.equal(s.version, '2');
  assert.deepEqual(s.breakdown.map((b) => b.signal), ['size', 'client', 'deadline', 'unlocks']);
  const sum = s.breakdown.reduce((n, b) => n + b.points, 0);
  assert.ok(Math.abs(sum - s.valuePoints) <= 1, `the steps add up to the value (${sum} ≈ ${s.valuePoints})`);
  assert.match(s.breakdown.find((b) => b.signal === 'unlocks').detail, /2 tasks wait on it, worth 16 points/);
  assert.match(s.reason, /unlocks 2 tasks/);
  assert.deepEqual(await heuristicScorer.suggest({ ...base, project: { name: 'Northstar Heights', kind: 'fulfilment', packageBand: 3 }, dueOn: '2026-10-11', unlocks: { tasks: 2, value: 16 } }), s, 'the same inputs give the same answer');
});

test('unlocks, the usual value of the kind of work and leadership’s changes move the value', async () => {
  const plain = await heuristicScorer.suggest(base);
  assert.ok((await heuristicScorer.suggest({ ...base, unlocks: { tasks: 3, value: 30 } })).valuePoints > plain.valuePoints, 'unlocking work is worth more');
  const usual = await heuristicScorer.suggest({ ...base, baseline: { n: 12, value: 12 } });
  assert.ok(usual.valuePoints > plain.valuePoints && usual.breakdown.some((b) => b.signal === 'baseline' && /12 accepted/.test(b.detail)));
  assert.equal((await heuristicScorer.suggest({ ...base, baseline: { n: 2, value: 12 } })).valuePoints, plain.valuePoints, 'two accepted are not a baseline yet');
  const learnt = await heuristicScorer.suggest({ ...base, learning: { n: 4, ratio: 2 } });
  assert.equal(learnt.valuePoints, Math.round(plain.valuePoints * 2));
  assert.match(learnt.breakdown.at(-1).detail, /changed Pip’s value for video editing 4 times, by \+100 %/);
  assert.equal((await heuristicScorer.suggest({ ...base, learning: { n: 2, ratio: 2 } })).valuePoints, plain.valuePoints, 'two changes are not a habit');
  assert.equal((await heuristicScorer.suggest({ ...base, learning: { n: 9, ratio: 9 } })).valuePoints, Math.round(plain.valuePoints * 2), 'at most double');
  const estimated = await heuristicScorer.suggest({ ...base, estimateMinutes: 480 });
  assert.equal(estimated.effortMinutes, 480);
  assert.match(estimated.breakdown[0].detail, /the estimate: about 8 h/);
});

// UX-5B: the value read as a cost of delay, and its priority (weighted shortest job first: cost of delay ÷ size).
test('priority: the cost of delay splits into its parts and is divided by the size', async () => {
  const s = await heuristicScorer.suggest({ ...base, project: { name: 'Northstar Heights', kind: 'fulfilment', packageBand: 3 }, dueOn: '2026-10-11', unlocks: { tasks: 2, value: 16 } });
  const p = s.priority;
  assert.equal(p.method, 'wsjf');
  assert.equal(p.costOfDelay, s.valuePoints, 'the value points are the cost of delay');
  assert.ok(Math.abs(p.businessValue + p.timeCriticality + p.enablement - p.costOfDelay) <= 0.2, 'the parts add up');
  assert.ok(p.timeCriticality > 0 && p.enablement > 0, 'a near deadline and waiting work both count');
  assert.equal(p.sizeHours, 3);
  assert.equal(p.score, Math.round((s.valuePoints / 3) * 10) / 10);
  assert.match(p.why, /^Client work for Northstar Heights, due in 1 day, unlocks 2 tasks, about 3 h: /);
});

test('priority: the quick job of the same worth goes first, and a big job for its value says so', async () => {
  const quick = await heuristicScorer.suggest({ ...base, estimateMinutes: 60, project: { name: 'Northstar', kind: 'fulfilment', packageBand: 4 }, dueOn: '2026-10-10' });
  const long = await heuristicScorer.suggest({ ...base, estimateMinutes: 600 });
  assert.ok(quick.priority.score > long.priority.score);
  assert.match(quick.priority.why, /worth doing early/);
  const huge = await heuristicScorer.suggest({ ...base, title: 'Complete campaign overhaul', estimateMinutes: 20000 });
  assert.equal(huge.valuePoints, 100);
  assert.ok(huge.priority.score < 1 && /split it or schedule it/.test(huge.priority.why));
});

test('priority: estimates are corrected by how long estimated work here really took, more surely with more tasks', async () => {
  const plain = await heuristicScorer.suggest({ ...base, estimateMinutes: 120 });
  const few = await heuristicScorer.suggest({ ...base, estimateMinutes: 120, calibration: { n: 3, ratio: 1.5 } });
  const many = await heuristicScorer.suggest({ ...base, estimateMinutes: 120, calibration: { n: 40, ratio: 1.5 } });
  assert.equal(plain.effortMinutes, 120);
  assert.ok(few.effortMinutes > 120 && few.effortMinutes < many.effortMinutes && many.effortMinutes <= 180, `${few.effortMinutes} < ${many.effortMinutes}`);
  assert.match(many.breakdown[0].detail, /×1\.44 for how long estimated work here really takes \(40 tasks\)/);
  assert.equal((await heuristicScorer.suggest({ ...base, estimateMinutes: 120, calibration: { n: 2, ratio: 3 } })).effortMinutes, 120, 'two tasks are not a record');
  assert.ok(many.priority.confidenceScore > plain.priority.confidenceScore);
  // Without an estimate the correction does not apply (similar work's own time is already real time).
  assert.equal((await heuristicScorer.suggest({ ...base, calibration: { n: 40, ratio: 2 } })).effortMinutes, 180);
});

test('priority: confidence grows with evidence about the size and the value', async () => {
  const none = await heuristicScorer.suggest({ ...base, title: 'Leadership offsite', category: null, categoryLabel: null });
  const kind = await heuristicScorer.suggest(base);
  const known = await heuristicScorer.suggest({ ...base, similar: { n: 6, minutes: 95, minutesN: 5, cycleDays: 1, value: 9, points: null }, baseline: { n: 12, value: 8 }, learning: { n: 10, ratio: 1.2 } });
  assert.deepEqual([none.priority.confidence, kind.priority.confidence, known.priority.confidence], ['low', 'medium', 'high']);
});
