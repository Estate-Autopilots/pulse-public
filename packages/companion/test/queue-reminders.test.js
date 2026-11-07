import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, prune, queuedRequest, settle, outcomeOf, projected, QUEUE_MAX_AGE_MS, dueReminders, reminderPlan, shouldPopUp, prefsWith, demoPayload, applyLocal, deriveView } from '../src/index.js';

const IST = (hhmm) => Date.parse(`2026-10-08T${hhmm}:00+05:30`);

test('offline queue keeps taps in order with their original time, collapses double clicks', () => {
  let q = enqueue([], 'check-in', IST('09:58'), { mode: 'office' }, 'a');
  q = enqueue(q, 'check-in', IST('09:58') + 1000, { mode: 'office' }, 'dup');
  assert.equal(q.length, 1, 'double click');
  q = enqueue(q, 'break-start', IST('12:00'), {}, 'b');
  q = enqueue(q, 'break-end', IST('12:30'), {}, 'c');
  assert.deepEqual(q.map((i) => i.id), ['a', 'b', 'c']);
  const req = queuedRequest(q[0]);
  assert.equal(req.action, 'check-in');
  assert.equal(req.extra.at, new Date(IST('09:58')).toISOString());
  assert.equal(req.extra.queueId, 'a');
  assert.equal(req.extra.mode, 'office');
});

test('offline queue projects the day the person will see', () => {
  let q = enqueue([], 'check-in', IST('09:58'), {}, 'a');
  q = enqueue(q, 'break-start', IST('12:00'), {}, 'b');
  const p = projected(demoPayload('out', IST('09:50')), q);
  assert.equal(p.state, 'break');
  assert.equal(p.pending, true);
  assert.match(deriveView(p, IST('12:05')).title, /break/);
});

test('settle: sent and refused items leave the queue; network failures retry', () => {
  let q = enqueue(enqueue([], 'check-in', 1, {}, 'a'), 'check-out', 10000, {}, 'b');
  q = settle(q, 'a', 'retry');
  assert.equal(q[0].tries, 1);
  q = settle(q, 'a', 'ok');
  assert.deepEqual(q.map((i) => i.id), ['b']);
  assert.equal(outcomeOf(null), 'ok');
  assert.equal(outcomeOf({ offline: true }), 'retry');
  assert.equal(outcomeOf({ gate: true }), 'retry');
  assert.equal(outcomeOf({ status: 503 }), 'retry');
  assert.equal(outcomeOf({ status: 429 }), 'retry');
  assert.equal(outcomeOf({ status: 409 }), 'rejected');
  assert.equal(outcomeOf({ status: 400 }), 'rejected');
});

test('items older than the server window are pruned so the person can ask for a correction', () => {
  const now = IST('15:00');
  const q = [{ id: 'old', action: 'check-in', at: now - QUEUE_MAX_AGE_MS - 1, body: {}, tries: 0 }, { id: 'new', action: 'check-out', at: now - 60000, body: {}, tries: 0 }];
  const { keep, expired } = prune(q, now);
  assert.deepEqual(keep.map((i) => i.id), ['new']);
  assert.deepEqual(expired.map((i) => i.id), ['old']);
});

test('queue limit', () => {
  let q = [];
  for (let i = 0; i < 50; i++) q = enqueue(q, i % 2 ? 'break-start' : 'break-end', i * 10000, {}, `i${i}`);
  assert.throws(() => enqueue(q, 'check-out', 999999, {}, 'x'), /Too many/);
});

test('reminder at shift start only when not checked in, once per day, switchable', () => {
  const p = demoPayload('out', IST('09:56'));
  assert.deepEqual(dueReminders(p, {}, IST('09:50')), []);
  const due = dueReminders(p, {}, IST('09:56'));
  assert.equal(due.length, 1);
  assert.equal(due[0].id, 'check-in:2026-10-08');
  assert.equal(due[0].action, 'check-in');
  assert.deepEqual(dueReminders(p, {}, IST('09:57'), ['check-in:2026-10-08']), []);
  assert.deepEqual(dueReminders(p, { checkIn: false }, IST('09:57')), []);
  assert.deepEqual(dueReminders(demoPayload('off', IST('09:56')), {}, IST('09:57')), []);
  assert.deepEqual(dueReminders(applyLocal(p, 'check-in', IST('09:55')), {}, IST('09:57')), []);
});

test('attendance reminders and startup popup stay off when the flag is false or missing', () => {
  for (const attendanceEnabled of [false, undefined]) {
    const p = { ...demoPayload('out', IST('09:56')), attendanceEnabled };
    assert.deepEqual(dueReminders(p, {}, IST('09:56')), []);
    assert.deepEqual(reminderPlan(p, {}, IST('09:00')), []);
    assert.equal(shouldPopUp(p, {}, IST('09:55')), null);
  }
});

test('back-from-break reminder after the chosen minutes, once per break', () => {
  const p = applyLocal(applyLocal(demoPayload('out', IST('09:50')), 'check-in', IST('09:55')), 'break-start', IST('13:00'));
  assert.deepEqual(dueReminders(p, {}, IST('13:20')), []);
  const due = dueReminders(p, {}, IST('13:31'));
  assert.equal(due[0].kind, 'break-back');
  assert.match(due[0].body, /31 min/);
  assert.equal(dueReminders(p, { breakMinutes: 45 }, IST('13:31')).length, 0);
  assert.equal(dueReminders(p, { breakBack: false }, IST('14:31')).length, 0);
});

test('check-out reminder at shift end while still in', () => {
  const p = applyLocal(demoPayload('out', IST('09:50')), 'check-in', IST('09:55'));
  assert.equal(dueReminders(p, {}, IST('18:59')).length, 0);
  assert.equal(dueReminders(p, {}, IST('19:00'))[0].kind, 'check-out');
  assert.equal(dueReminders(applyLocal(p, 'check-out', IST('19:00')), {}, IST('19:05')).length, 0);
  assert.equal(dueReminders(p, { checkOut: false }, IST('19:05')).length, 0);
});

test('reminder plan for the phone: today by state, later days at their shift start', () => {
  const p = demoPayload('out', IST('08:00'));
  const plan = reminderPlan(p, {}, IST('08:00'));
  assert.equal(plan[0].id, 'check-in:2026-10-08');
  assert.equal(plan[0].at, IST('10:00'));
  assert.ok(plan.some((r) => r.id === 'check-in:2026-10-09'));
  const inP = applyLocal(p, 'check-in', IST('09:58'));
  const inPlan = reminderPlan(inP, {}, IST('10:00'));
  assert.equal(inPlan[0].id, 'check-out:2026-10-08');
  assert.ok(!inPlan.some((r) => r.id === 'check-in:2026-10-08'));
  assert.equal(reminderPlan(p, { checkIn: false, checkOut: false, breakBack: false }, IST('08:00')).length, 0);
});

test('desktop pop-up at the workday start, once', () => {
  const p = demoPayload('out', IST('09:52'));
  assert.equal(shouldPopUp(p, {}, IST('09:40')), null);
  assert.equal(shouldPopUp(p, {}, IST('09:52')), 'pop:2026-10-08');
  assert.equal(shouldPopUp(p, {}, IST('09:53'), ['pop:2026-10-08']), null);
  assert.equal(shouldPopUp(p, { popAtStart: false }, IST('09:53')), null);
  assert.equal(shouldPopUp(applyLocal(p, 'check-in', IST('09:52')), {}, IST('09:53')), null);
});

test('prefs are sanitised', () => {
  const p = prefsWith({ breakMinutes: 2, checkIn: 'yes', unknown: true, mascot: false });
  assert.equal(p.breakMinutes, 5);
  assert.equal(p.checkIn, true);
  assert.equal(p.mascot, false);
  assert.equal('unknown' in p, false);
  assert.equal(prefsWith(null).autoCheckIn, false, 'automatic check-in is opt-in');
});

test('POLISH-2: "Shift is over" waits four hours after a check-in made after the shift (QA-E2E P2-19)', () => {
  const p = demoPayload('in', IST('20:11'));
  const after = { ...p, entry: { ...p.entry, in: new Date(IST('20:11')).toISOString() } };
  assert.ok(Date.parse(after.shiftEndsAt) <= IST('20:11'), 'the demo shift ends before 20:11');
  assert.deepEqual(dueReminders(after, {}, IST('20:12')).filter((r) => r.kind === 'check-out'), []);
  assert.equal(dueReminders(after, {}, IST('00:12') + 86400000).filter((r) => r.kind === 'check-out').length, 1);
  assert.equal(reminderPlan(after, {}, IST('20:12')).find((r) => r.kind === 'check-out')?.at, IST('20:11') + 4 * 3600000);
  const onTime = demoPayload('in', IST('17:00'));
  assert.equal(reminderPlan(onTime, {}, IST('17:00')).find((r) => r.kind === 'check-out')?.at, Date.parse(onTime.shiftEndsAt), 'a usual day: at the shift end');
});

test('ATT: no local "Shift is over" when Pulse checks out by itself; the check-in and break reminders stay', () => {
  const IST2 = (hhmm) => Date.parse(`2026-10-08T${hhmm}:00+05:30`);
  const inDay = applyLocal(demoPayload('out', IST2('09:50')), 'check-in', IST2('09:55'));
  const auto = { ...inDay, presence: { ...(inDay.presence ?? {}), autoCheckOut: true } };
  const late = Date.parse(auto.shiftEndsAt) + 10 * 60000;
  assert.equal(dueReminders(inDay, {}, late).some((r) => r.kind === 'check-out'), true, 'without automatic check-out the reminder stays');
  assert.equal(dueReminders(auto, {}, late).some((r) => r.kind === 'check-out'), false);
  assert.equal(reminderPlan(auto, {}, IST2('12:00')).some((r) => r.kind === 'check-out'), false);
});
