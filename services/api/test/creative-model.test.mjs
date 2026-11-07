import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, CREATIVE_SEED, homeRows, inputsFor, sortHome, sprintClock } from '../dist/creative-model.js';

// EST-1474: the sprint clock and CS Home rows. Synthetic sprints only.
const all = (pkg, day) => Object.fromEntries(inputsFor(CREATIVE_SEED, pkg).map((i) => [i.key, day]));
const due = (clock, key) => clock.items.find((i) => i.key === key).due;

test('each package asks for its inputs: Sell-Out adds founder dates, past buyers and the brand decision-maker', () => {
  assert.equal(inputsFor(CREATIVE_SEED, 'starter').length, 8);
  assert.equal(inputsFor(CREATIVE_SEED, 'growth').length, 8);
  assert.deepEqual(inputsFor(CREATIVE_SEED, 'sellout').slice(8).map((i) => i.key), ['founder_dates', 'past_buyers', 'brand_decision_maker']);
});

test('deliverable N is due on Day N of each package, with every input in by Day 1', () => {
  for (const [pkg, research, words, docs] of [['starter', 2, 4, 8], ['growth', 2, 5, 10], ['sellout', 3, 6, 14]]) {
    const c = sprintClock(CREATIVE_SEED, { package: pkg, dayOne: '2026-11-02' }, all(pkg, '2026-11-01'), {}, '2026-11-02');
    assert.equal(c.shift, 0, pkg); assert.equal(c.day, 1, pkg); assert.equal(c.missingInputs, 0, pkg);
    assert.equal(due(c, 'research_meet'), '2026-11-02', pkg);
    assert.equal(due(c, 'deep_research'), addDays('2026-11-02', research - 1), pkg);
    assert.equal(due(c, 'word_library'), addDays('2026-11-02', words - 1), pkg);
    assert.equal(due(c, 'docs_to_client'), addDays('2026-11-02', docs - 1), pkg);
  }
});

test('a late input moves the whole clock day for day; a missing one keeps moving it until it arrives', () => {
  const pkg = 'growth', r = { ...all(pkg, '2026-11-02'), maharera: '2026-11-05' };
  const late = sprintClock(CREATIVE_SEED, { package: pkg, dayOne: '2026-11-02' }, r, {}, '2026-11-06');
  assert.equal(late.shift, 3); assert.equal(late.lateInputs, 1);
  assert.equal(due(late, 'deep_research'), '2026-11-06');
  assert.equal(due(late, 'research_meet'), '2026-11-02', 'the research meet stays on Day 1');
  const missing = sprintClock(CREATIVE_SEED, { package: pkg, dayOne: '2026-11-02' }, { ...r, maharera: null }, {}, '2026-11-07');
  assert.equal(missing.shift, 5); assert.equal(missing.missingInputs, 1);
  assert.equal(due(missing, 'docs_to_client'), addDays('2026-11-02', 9 + 5));
  const before = sprintClock(CREATIVE_SEED, { package: pkg, dayOne: '2026-11-02' }, {}, {}, '2026-10-30');
  assert.equal(before.shift, 0, 'nothing is late before Day 1'); assert.equal(before.day, -2);
});

test('deliverables are done, overdue, due today or upcoming', () => {
  const c = sprintClock(CREATIVE_SEED, { package: 'starter', dayOne: '2026-11-02' }, all('starter', '2026-11-02'), { research_meet: '2026-11-02' }, '2026-11-03');
  const state = Object.fromEntries(c.items.map((i) => [i.key, i.state]));
  assert.equal(state.research_meet, 'done'); assert.equal(state.deep_research, 'today'); assert.equal(state.usp_map, 'upcoming');
  const later = sprintClock(CREATIVE_SEED, { package: 'starter', dayOne: '2026-11-02' }, all('starter', '2026-11-02'), {}, '2026-11-04');
  assert.equal(later.items.find((i) => i.key === 'deep_research').state, 'overdue');
});

test('CS Home: Day-1 alerts first (inputs missing, transcript not saved), then overdue, today and next; each row opens its screen', () => {
  const s = { id: '00000000-0000-4000-8000-000000000001', project: 'Riverside', package: 'growth' };
  const c = sprintClock(CREATIVE_SEED, { package: 'growth', dayOne: '2026-11-02' }, { ...all('growth', '2026-11-02'), offers: null }, {}, '2026-11-04');
  const rows = sortHome(homeRows(CREATIVE_SEED, s, c), 3);
  assert.deepEqual(rows.slice(0, 2).map((r) => r.key), ['inputs', 'research_meet']);
  assert.equal(rows.filter((r) => r.key === 'research_meet').length, 1, 'an alerted deliverable is listed once');
  assert.ok(rows.every((r) => r.href.startsWith(`/creative/sprints/${s.id}#`)));
  assert.equal(rows.filter((r) => r.state === 'upcoming').length, 3, 'upcoming rows are capped');
  assert.match(rows.find((r) => r.key === 'deep_research').detail, /Growth package/);
  const ontime = sprintClock(CREATIVE_SEED, { package: 'growth', dayOne: '2026-11-02' }, all('growth', '2026-11-01'), { research_meet: '2026-11-02' }, '2026-11-02');
  assert.ok(!homeRows(CREATIVE_SEED, s, ontime).some((r) => r.kind === 'alert'), 'no alert when inputs are in and the meet is saved');
});
