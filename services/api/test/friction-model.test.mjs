import test from 'node:test';
import assert from 'node:assert/strict';
import { alertTask, dropPct, featureOf, FUNNELS, funnelCounts, funnelPrefilter, heatPoints, matchStep, reached } from '../dist/friction-model.js';

// BUGKIT-TELEMETRY: funnels, heatmap points and friction tasks. Synthetic events only.
const ev = (kind, name = null, page = null) => ({ kind, name, page });
const [checkin, task] = FUNNELS;

test('a step matches its kinds and its name or page pattern', () => {
  assert.equal(matchStep(checkin.steps[1], ev('ui.click', 'button Check in', '/me')), true);
  assert.equal(matchStep(checkin.steps[1], ev('ui.click', 'button Check-in now', '/me')), true);
  assert.equal(matchStep(checkin.steps[1], ev('ui.key', 'button Check in', '/me')), false, 'wrong kind');
  assert.equal(matchStep(checkin.steps[0], ev('app.session')), true, 'a fresh session counts on its own');
  assert.equal(matchStep(checkin.steps[0], ev('nav.load', '/login', '/login')), true);
  assert.equal(matchStep(checkin.steps[0], ev('nav.load', '/tasks', '/tasks')), false);
});

test('a session reaches funnel steps only in order', () => {
  assert.equal(reached(task.steps, [ev('ui.click', 'button Done'), ev('ui.click', 'button New task'), ev('ui.submit', 'form create task')]), 2);
  assert.equal(reached(task.steps, [ev('ui.click', 'button New task'), ev('ui.submit', 'Save'), ev('ui.click', 'Mark complete')]), 3);
  assert.equal(reached(task.steps, []), 0);
});

test('funnel counts and the share lost at each step', () => {
  const sessions = new Map([
    ['s1', [ev('app.session'), ev('ui.click', 'button Check in')]],
    ['s2', [ev('app.session')]],
    ['s3', [ev('app.session'), ev('ui.click', 'button New task')]],
    ['s4', [ev('nav.load', '/login', '/login'), ev('ui.submit', 'check-in form')]],
  ]);
  const [c, t] = funnelCounts(FUNNELS, sessions);
  assert.deepEqual(c.steps.map((s) => s.sessions), [4, 2]);
  assert.equal(c.steps[1].dropPct, 50);
  assert.equal(c.steps[0].dropPct, null);
  assert.deepEqual(t.steps.map((s) => s.sessions), [1, 0, 0]);
  assert.equal(dropPct(0, 0), null);
  assert.equal(dropPct(3, 5), 0, 'never a negative loss');
});

test('the SQL prefilter covers every step', () => {
  const { kinds, pattern } = funnelPrefilter();
  for (const k of ['app.session', 'ui.click', 'ui.submit', 'ui.dialog.open', 'nav.load']) assert.ok(kinds.includes(k), k);
  const re = new RegExp(pattern, 'i');
  for (const s of ['button Check in', '/login', 'New task', 'Save', 'Done']) assert.ok(re.test(s), s);
});

test('heat points are viewport fractions; anything else is dropped', () => {
  const pts = heatPoints([{ kind: 'ui.rage', fx: 0.12345, fy: 0.5 }, { kind: 'ui.dead', fx: '0.3', fy: 0.9 }, { kind: 'ui.click', fx: 1.2, fy: 0.1 },
    { kind: 'ui.click', fx: null, fy: 0.2 }, { kind: 'ui.key', fx: 0.1, fy: 0.1 }]);
  assert.deepEqual(pts, [{ fx: 0.123, fy: 0.5, kind: 'rage' }, { fx: 0.3, fy: 0.9, kind: 'dead' }]);
  assert.equal(heatPoints(Array.from({ length: 50 }, () => ({ kind: 'ui.click', fx: 0.5, fy: 0.5 })), 10).length, 10);
});

test('an alert becomes a plain bug task with links to its details and a replay', () => {
  const a = { id: '00000000-0000-4000-8000-000000000001', kind: 'rage', route: '/tasks', target: 'button.save', label: 'button Save', hits: 7, people: 3, sample_session: 'EXMPsession0001' };
  const t = alertTask(a, '00000000-0000-4000-8000-0000000000aa');
  assert.match(t.title, /^Friction: rage clicks on \/tasks$/);
  assert.match(t.notes, /7 times, by 3 people/);
  assert.match(t.notes, /\/insights\?tab=friction&alert=00000000-0000-4000-8000-000000000001/);
  assert.match(t.notes, /\/telemetry\/replay\/EXMPsession0001/);
  assert.equal(t.projectId, '00000000-0000-4000-8000-0000000000aa');
  assert.equal(alertTask({ ...a, sample_session: null, people: 1 }, null).projectId, undefined);
  assert.match(alertTask({ ...a, people: 1 }, null).notes, /by 1 person/);
});

test('a screen belongs to the feature of its first path segment', () => {
  assert.equal(featureOf('/hr?tab'), 'hr');
  assert.equal(featureOf('/people/:id/files'), 'people');
  assert.equal(featureOf('/'), 'home');
  assert.equal(featureOf(null), 'home');
});
