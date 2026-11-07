import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLocal, allowedActions, actionRequest, badge, celebration, clockOffset, deriveView, liveSeconds, demoPayload, stopwatch, duration, addClock, friendlyClock, wallMinutes } from '../src/index.js';

// 8 Oct 2026, 09:40 IST = 04:10 UTC.
const IST = (hhmm, date = '2026-10-08') => Date.parse(`${date}T${hhmm}:00+05:30`);

test('time helpers', () => {
  assert.equal(stopwatch(0), '0:00:00');
  assert.equal(stopwatch(4 * 3600 + 5 * 60 + 9), '4:05:09');
  assert.equal(duration(35 * 60), '35 min');
  assert.equal(duration(125 * 60), '2 h 05 min');
  assert.equal(addClock('10:00', 15), '10:15');
  assert.equal(addClock('23:50', 20), '00:10');
  assert.equal(friendlyClock('19:00'), '7:00 pm');
  assert.equal(friendlyClock('00:30'), '12:30 am');
  assert.equal(wallMinutes(IST('09:40'), 330), 9 * 60 + 40);
});

test('before the shift: one-click check-in, waking up close to the start, countdown', () => {
  const p = demoPayload('out', IST('09:40'));
  const v = deriveView(p, IST('09:40'));
  assert.equal(v.state, 'out');
  assert.equal(v.mood, 'waking');
  assert.deepEqual(v.actions.map((a) => a.id), ['check-in']);
  assert.ok(v.actions[0].primary);
  assert.equal(v.timer.display, '0:20:00');
  assert.equal(v.timer.label, 'until your shift');
  assert.match(v.subtitle, /On time until 10:15 am/);
  assert.ok(v.showModes);
  assert.equal(deriveView(p, IST('07:00')).mood, 'idle');
  assert.equal(deriveView(p, IST('03:00')).mood, 'sleepy');
});

test('after the grace period the person is told a check-in counts as late', () => {
  const p = demoPayload('out', IST('10:40'));
  const v = deriveView(p, IST('10:40'));
  assert.equal(v.chip.tone, 'warning');
  assert.match(v.subtitle, /marks you late/);
  assert.equal(v.timer, null);
});

test('checked in: live timer excludes breaks; break and check-out offered', () => {
  const p = demoPayload('out', IST('09:58'));
  const inP = applyLocal(p, 'check-in', IST('09:58'), { mode: 'office' });
  assert.equal(inP.state, 'in');
  assert.equal(inP.entry.late, 0);
  let v = deriveView(inP, IST('11:58'));
  assert.equal(v.timer.display, '2:00:00');
  assert.deepEqual(v.actions.map((a) => a.id), ['break-start', 'check-out']);
  assert.equal(v.mood, 'in');
  const onBreak = applyLocal(inP, 'break-start', IST('12:00'));
  v = deriveView(onBreak, IST('12:15'));
  assert.equal(v.state, 'break');
  assert.equal(v.timer.display, '0:15:00');
  assert.deepEqual(v.actions.map((a) => a.id), ['break-end', 'check-out']);
  assert.ok(v.actions[0].primary);
  const back = applyLocal(onBreak, 'break-end', IST('12:30'));
  assert.equal(liveSeconds(back.entry, IST('13:00')).worked, (3 * 60 + 2 - 30) * 60);
  const out = applyLocal(back, 'check-out', IST('19:05'));
  v = deriveView(out, IST('19:30'));
  assert.equal(v.state, 'done');
  assert.equal(v.mood, 'done');
  assert.equal(v.timer.running, false);
  assert.equal(liveSeconds(out.entry, IST('23:00')).worked, liveSeconds(out.entry, IST('19:05')).worked, 'the clock stops at check-out');
  assert.equal(deriveView(out, IST('23:30')).mood, 'sleepy');
});

test('a late check-in is marked late like My desk (after the grace minutes)', () => {
  const p = demoPayload('out', IST('10:20'));
  const late = applyLocal(p, 'check-in', IST('10:20'));
  assert.equal(late.entry.late, 20);
  assert.equal(deriveView(late, IST('10:21')).chip.tone, 'warning');
  const grace = applyLocal(p, 'check-in', IST('10:14'));
  assert.equal(grace.entry.late, 0);
});

test('checking in again after checking out turns the gap into a break', () => {
  const done = demoPayload('done', IST('15:00'));
  const again = applyLocal(done, 'check-in', IST('15:30'));
  assert.equal(again.state, 'in');
  assert.equal(again.entry.out, null);
  assert.ok(again.entry.closedBreakSeconds >= 30 * 60);
});

test('days off, leave and holidays still allow checking in', () => {
  for (const s of ['off', 'leave', 'holiday']) {
    const v = deriveView(demoPayload(s, IST('11:00')), IST('11:00'));
    assert.deepEqual(v.actions.map((a) => a.id), ['check-in']);
    assert.match(v.actions[0].label, /anyway/);
  }
  assert.match(deriveView(demoPayload('holiday', IST('11:00')), IST('11:00')).title, /Diwali/);
});

test('celebrations: first check-in and streak milestones only', () => {
  assert.match(celebration(demoPayload('in', IST('10:00'), { first: true })), /first check-in/);
  assert.match(celebration(demoPayload('in', IST('10:00'), { onTime: 5 })), /5 on-time days/);
  assert.equal(celebration(demoPayload('in', IST('10:00'), { onTime: 4 })), null);
  assert.equal(deriveView(demoPayload('in', IST('10:00'), { onTime: 5 }), IST('10:00'), { celebrate: true }).mood, 'celebrate');
});

test('managers see how many requests wait for them', () => {
  const v = deriveView(demoPayload('in', IST('11:00'), { waiting: 3 }), IST('11:00'));
  assert.equal(v.waiting.count, 3);
  assert.match(v.waiting.label, /3 requests are waiting/);
  assert.equal(deriveView(demoPayload('in', IST('11:00')), IST('11:00')).waiting, null);
});

test('action requests match the My desk API', () => {
  assert.deepEqual(actionRequest('check-in', { mode: 'wfh' }), { path: 'attendance/check-in', body: { mode: 'wfh' } });
  assert.deepEqual(actionRequest('break-start'), { path: 'attendance/break', body: { action: 'start' } });
  assert.deepEqual(actionRequest('break-end'), { path: 'attendance/break', body: { action: 'end' } });
  assert.deepEqual(actionRequest('check-out'), { path: 'attendance/check-out', body: {} });
  assert.throws(() => actionRequest('nap'));
  assert.deepEqual(allowedActions('break', true), ['break-end', 'check-out']);
  assert.deepEqual(allowedActions('break', false), []);
  assert.deepEqual(allowedActions('break'), []);
});

test('badge and clock offset', () => {
  const p = demoPayload('in', IST('12:00'));
  assert.equal(badge(p, IST('12:00')).tone, 'success');
  assert.equal(badge(demoPayload('break', IST('12:00')), IST('12:00')).text, 'BRK');
  assert.equal(badge(demoPayload('out', IST('09:00')), IST('09:00')).text, 'IN?');
  assert.equal(badge(null).text, '');
  assert.equal(clockOffset({ now: new Date(1000).toISOString() }, 400), 600);
  assert.equal(clockOffset(null), 0);
});

test('attendance gate defaults off unless the payload explicitly enables it', () => {
  for (const attendanceEnabled of [false, undefined]) {
    const p = { ...demoPayload('in', IST('11:00')), attendanceEnabled };
    const view = deriveView(p, IST('11:00'));
    assert.equal(view.state, 'disabled');
    assert.equal(view.title, 'Attendance is off for your organisation');
    assert.deepEqual(view.actions, []);
    assert.equal(view.timer, null);
    assert.deepEqual(badge(p), { text: '', tone: 'neutral', title: 'Attendance is off for your organisation' });
  }
  const enabled = deriveView(demoPayload('out', IST('09:40')), IST('09:40'));
  assert.deepEqual(enabled.actions.map((a) => a.id), ['check-in']);
});

test('loading view before the first answer', () => {
  const v = deriveView(null);
  assert.equal(v.state, 'loading');
  assert.deepEqual(v.actions, []);
});

test('PRESENCE-ONBOARD: an office arrival is the same one-tap question on every surface; Break and Back everywhere', () => {
  const p = { ...demoPayload('out', IST('09:58')), arrival: { at: '2026-10-08T04:27:00Z', office: 'Synthetic Studio' } };
  const v = deriveView(p, IST('09:58'));
  assert.equal(v.title, 'You’re at Synthetic Studio');
  assert.match(v.subtitle, /One tap checks you in/);
  assert.equal(v.mood, 'waking');
  assert.deepEqual(v.actions.map((a) => [a.id, a.label, a.primary]), [['check-in', 'Check in', true]]);
  assert.deepEqual(deriveView(demoPayload('in', IST('11:00')), IST('11:00')).actions.map((a) => a.label), ['Break', 'Check out']);
  assert.deepEqual(deriveView(demoPayload('break', IST('13:10')), IST('13:10')).actions.map((a) => a.label), ['Back', 'Check out']);
});
