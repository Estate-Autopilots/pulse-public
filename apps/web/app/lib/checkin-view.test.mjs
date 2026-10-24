import assert from 'node:assert/strict';
import test from 'node:test';
import { checkinView, clock, hm, words } from './checkin-view.mjs';

const at = Date.parse('2026-10-10T05:00:00Z');   // 10:30 India time
const day = (patch = {}) => ({ attendanceEnabled: true, state: 'out', entry: null, utcOffsetMinutes: 330, shiftStartsAt: '2026-10-10T04:30:00Z', shiftEndsAt: '2026-10-10T13:30:00Z',
  shift: { start: '10:00', end: '19:00', graceMinutes: 15, onTimeBy: '10:15', workingDay: true, mode: 'office' }, arrival: null, ...patch });
const entry = (patch = {}) => ({ id: 'e1', date: '2026-10-10', in: '2026-10-10T04:28:00Z', out: null, mode: 'office', late: 0, onBreak: false, breakStartedAt: null, closedBreakSeconds: 0, ...patch });

test('one tap to check in, the arrival question names the office', () => {
  const v = checkinView(day(), at);
  assert.equal(v.label, 'Check in'); assert.deepEqual(v.actions.map((a) => a.id), ['check-in']);
  assert.match(v.title, /shift started at 10:00/);
  const asked = checkinView(day({ arrival: { at: '2026-10-10T04:55:00Z', office: 'Synthetic Studio' } }), at);
  assert.equal(asked.label, 'Check in'); assert.equal(asked.tone, 'attention'); assert.match(asked.title, /You’re at Synthetic Studio/);
  assert.deepEqual(asked.arrival, { office: 'Synthetic Studio', at: '2026-10-10T04:55:00Z' });
  assert.equal(checkinView(day({ shift: { ...day().shift, workingDay: false } }), at).show, false, 'nothing on a day off');
  assert.equal(checkinView(day({ attendanceEnabled: false }), at).show, false, 'nothing when attendance is off');
  assert.equal(checkinView(null, at).show, false);
});

test('checked in: time worked, Break and Check out; on a break: On break with End break (EST-1196)', () => {
  const v = checkinView(day({ state: 'in', entry: entry() }), at);
  assert.equal(v.label, '32m worked'); assert.deepEqual(v.actions.map((a) => a.label), ['Break', 'Check out']);
  assert.match(v.title, /Checked in at 09:58/);
  const b = checkinView(day({ state: 'break', entry: entry({ onBreak: true, breakStartedAt: '2026-10-10T04:50:00Z' }) }), at);
  assert.equal(b.label, 'On break 10m'); assert.deepEqual(b.actions.map((a) => [a.label, !!a.primary]), [['End break', true], ['Check out', false]]);
  assert.equal(b.worked, 22 * 60, 'the break is not counted as work');
  const late = checkinView(day({ state: 'in', entry: entry() }), Date.parse('2026-10-10T14:10:00Z'));
  assert.equal(late.tone, 'attention'); assert.match(late.title, /shift ended at 19:00/); assert.equal(late.actions[1].primary, true);
  const done = checkinView(day({ state: 'done', entry: entry({ out: '2026-10-10T13:00:00Z' }) }), at);
  assert.equal(done.label, '8h 32m'); assert.deepEqual(done.actions.map((a) => a.label), ['Check in again']);
  const instant = checkinView(day({ state: 'done', entry: entry({ out: '2026-10-10T04:28:30Z' }) }), at);
  assert.equal(instant.label, 'Done', 'POLISH-2: no "0:00" for a day with nothing recorded');
});

test('a saved tap shows as saving, or saved offline, and offers nothing else (no double check-in)', () => {
  const v = checkinView(day(), at, [{ state: 'queued' }]);
  assert.equal(v.state, 'pending'); assert.deepEqual(v.actions, []);
  assert.equal(checkinView(day(), at, [{ state: 'queued' }], { online: false }).label, 'Saved · will sync');
  assert.equal(checkinView(day(), at, [{ state: 'accepted' }]).state, 'out', 'confirmed taps do not block');
});
test('EST-1195: a tap on its way to Pulse shows as saving at once, before anything is queued', () => {
  const v = checkinView(day(), at, [], { tapped: true });
  assert.equal(v.state, 'pending'); assert.equal(v.label, 'Saving…'); assert.deepEqual(v.actions, []);
  assert.equal(checkinView(day(), at, [], { tapped: false }).state, 'out');
  // UI Guard review: offline and not yet saved never says Saved; a real offline queued record still does.
  const offline = checkinView(day(), at, [], { online: false, tapped: true });
  assert.equal(offline.label, 'Saving…'); assert.doesNotMatch(`${offline.label} ${offline.title}`, /saved/i);
  assert.equal(checkinView(day(), at, [{ state: 'queued' }], { online: false, tapped: true }).label, 'Saved · will sync');
});

test('formats', () => {
  assert.equal(hm(3 * 3600 + 7 * 60 + 59), '3:07'); assert.equal(words(35 * 60), '35 min'); assert.equal(words(4 * 3600 + 300), '4 h 05 min');
  assert.equal(clock('2026-10-10T04:28:00Z', { utcOffsetMinutes: 330 }), '09:58');
});

test('POLISH-1: a check-out forgotten yesterday says so plainly instead of counting hours', () => {
  // Checked in yesterday at 17:46 and never out; it is 04:25 today (the owner's phone, 11 Oct).
  const night = Date.parse('2026-10-10T22:55:00Z');
  const open = day({ today: '2026-10-11', state: 'in', entry: entry({ date: '2026-10-10', in: '2026-10-10T12:16:00Z' }) });
  const v = checkinView(open, night);
  assert.equal(v.state, 'stale'); assert.equal(v.tone, 'attention');
  assert.equal(v.title, 'Still checked in since yesterday 17:46. Check out at the right time?');
  assert.equal(v.label, 'Since yesterday 17:46'); assert.equal(v.short, 'Check out?');
  assert.deepEqual(v.fix, { since: 'yesterday 17:46', date: '2026-10-10', entryId: 'e1', in: '17:46', suggested: '19:00', pending: false });
  assert.deepEqual(v.actions.map((a) => [a.id, !!a.primary]), [['check-out', false]], 'checking out now stays possible, never the main action');
  // Sent: nothing changed yet, it says so, and today can start.
  const sent = checkinView({ ...open, entry: { ...open.entry, correctionPending: true } }, night);
  assert.equal(sent.short, 'Sent'); assert.equal(sent.tone, 'neutral'); assert.match(sent.title, /approves it/);
  assert.deepEqual(sent.actions.map((a) => a.label), ['Check in for today']);
  // Older than yesterday: the day is named.
  const older = checkinView({ ...open, entry: { ...open.entry, date: '2026-10-08', in: '2026-10-08T12:16:00Z' } }, night);
  assert.equal(older.fix.since, 'Thu 8 Oct 17:46');
});

test('POLISH-1: far past the shift counts as forgotten; an evening check-in suggests an hour later; night shifts are fine', () => {
  const sameDay = day({ today: '2026-10-10', state: 'in', entry: entry() });          // in at 09:58, shift 10:00–19:00
  assert.equal(checkinView(sameDay, Date.parse('2026-10-10T17:00:00Z')).state, 'in', '22:30: late, but not yet forgotten');
  const far = checkinView(sameDay, Date.parse('2026-10-10T18:00:00Z'));               // 23:30, 13 h 32 min in
  assert.equal(far.state, 'stale'); assert.equal(far.fix.since, 'today 09:58'); assert.equal(far.fix.suggested, '19:00');
  const evening = checkinView(day({ today: '2026-10-11', state: 'in', entry: entry({ date: '2026-10-10', in: '2026-10-10T15:00:00Z' }) }), Date.parse('2026-10-10T19:00:00Z'));
  assert.equal(evening.fix.suggested, '21:30', 'in at 20:30, after the shift: an hour later');
  const nightShift = { ...day().shift, start: '22:00', end: '06:00' };
  const onNight = day({ today: '2026-10-11', shift: nightShift, state: 'in', entry: entry({ date: '2026-10-10', in: '2026-10-10T16:30:00Z' }) });
  assert.equal(checkinView(onNight, Date.parse('2026-10-10T23:00:00Z')).state, 'in', 'a night shift crossing midnight is normal');
  assert.equal(checkinView(onNight, Date.parse('2026-10-11T05:00:00Z')).state, 'stale', 'but not 12 h 30 min in');
  const onBreak = checkinView({ ...onNight, shift: day().shift, state: 'break', entry: { ...onNight.entry, onBreak: true, breakStartedAt: '2026-10-10T18:00:00Z' } }, Date.parse('2026-10-10T23:00:00Z'));
  assert.equal(onBreak.state, 'stale', 'a break left open since yesterday too');
});

test('POLISH-2: a check-in after the shift ended is not told to check out at once (QA-E2E P1-12)', () => {
  const evening = day({ state: 'in', entry: entry({ in: '2026-10-10T14:41:00Z' }) });   // in at 20:11, the shift ended 19:00
  const now = checkinView(evening, Date.parse('2026-10-10T14:45:00Z'));
  assert.equal(now.tone, 'success'); assert.match(now.title, /Checked in at 20:11, after your shift/);
  assert.equal(now.actions.find((a) => a.id === 'check-out').primary, false);
  const late = checkinView(evening, Date.parse('2026-10-10T18:42:00Z'));                  // four hours later
  assert.equal(late.tone, 'attention'); assert.match(late.title, /shift ended at 19:00/);
});

test('POLISH-2: a session Pulse closed for review asks for the time left, without blocking today', () => {
  const unresolved = { entryId: 'e0', date: '2026-10-09', in: '2026-10-09T04:32:00Z', proposedEnd: '2026-10-09T13:30:00Z', reason: 'day_ended', correctionPending: false };
  const v = checkinView(day({ today: '2026-10-10', unresolved }), at);
  assert.equal(v.state, 'out'); assert.deepEqual(v.actions.map((a) => a.id), ['check-in'], 'today starts as usual');
  assert.deepEqual(v.fix, { since: 'yesterday 10:02', day: 'yesterday', date: '2026-10-09', entryId: 'e0', in: '10:02', suggested: '19:00', pending: false, closed: true });
  assert.equal(checkinView(day({ today: '2026-10-10', unresolved: { ...unresolved, date: '2026-10-07', in: '2026-10-07T04:32:00Z' } }), at).fix.day, 'Wed 7 Oct');
  assert.equal(checkinView(day({ today: '2026-10-10', unresolved: { ...unresolved, correctionPending: true } }), at).fix, undefined, 'sent: nothing more to ask');
  const working = checkinView(day({ today: '2026-10-10', state: 'in', entry: entry(), unresolved }), at);
  assert.equal(working.state, 'in'); assert.equal(working.fix.closed, true);
});

test('ATT: with automatic check-out on, a shift that ended is not a question; Pulse says it checks out when they leave', () => {
  const auto = day({ state: 'in', entry: entry(), presence: { autoCheckIn: false, autoCheckOut: true, offices: [], sites: [] } });
  const late = checkinView(auto, Date.parse('2026-10-10T14:10:00Z'));
  assert.equal(late.tone, 'success'); assert.match(late.title, /Pulse checks you out when you leave/);
  assert.equal(late.actions.find((a) => a.id === 'check-out').primary, false);
  const automatic = checkinView(day({ state: 'in', entry: entry({ inVia: 'auto' }) }), at);
  assert.match(automatic.title, /\(automatically\)/);
  const out = checkinView(day({ state: 'done', entry: entry({ out: '2026-10-10T13:10:00Z', outVia: 'auto', outReason: 'left' }) }), Date.parse('2026-10-10T14:10:00Z'));
  assert.match(out.title, /out at 18:40 \(Pulse checked you out when you left\)/);
});

test('ATT: Pulse\'s one question shows on the control with the time they left, only for this session', () => {
  const q = { entryId: 'e1', kind: 'left', leftAt: '2026-10-10T13:10:00Z', askedAt: '2026-10-10T13:25:00Z', office: 'Synthetic Studio' };
  const v = checkinView(day({ state: 'in', entry: entry(), question: q }), Date.parse('2026-10-10T13:30:00Z'));
  assert.equal(v.tone, 'attention'); assert.equal(v.label, 'Still working?');
  assert.equal(v.title, 'You left Synthetic Studio at 18:40.');
  assert.deepEqual([v.question.entryId, v.question.leftAt], ['e1', '18:40']);
  const early = checkinView(day({ state: 'break', entry: entry({ onBreak: true, breakStartedAt: '2026-10-10T07:00:00Z' }), question: { ...q, kind: 'left_early' } }), Date.parse('2026-10-10T09:00:00Z'));
  assert.equal(early.label, 'Done for the day?');
  const other = checkinView(day({ state: 'in', entry: entry({ id: 'e2' }), question: q }), Date.parse('2026-10-10T13:30:00Z'));
  assert.equal(other.question, undefined, 'a question about another session is not shown');
});
