// The companion view model: what the desktop panel, Chrome popup, web widget and phone card show for one
// /companion payload at one instant. Pure functions, so every surface (and the tests) agree on the same day.
import { addClock, duration, friendlyClock, shortDay, stopwatch, wallMinutes } from './time.js';

export const MOODS = ['idle', 'waking', 'in', 'break', 'done', 'celebrate', 'sleepy'];
export const ACTIONS = ['check-in', 'break-start', 'break-end', 'check-out'];
export const MODES = { office: 'Office', wfh: 'Home', field: 'On duty' };
const STREAK_MILESTONES = [3, 5, 10, 15, 20, 30, 50, 75, 100];

/** Server time minus device time, so timers and reminders follow Pulse's clock even on a skewed laptop. */
export function clockOffset(payload, localNow = Date.now()) {
  const server = Date.parse(payload?.now ?? '');
  return Number.isFinite(server) ? server - localNow : 0;
}

/** Seconds worked and on break for an attendance entry at a given instant (breaks never count as work). */
export function liveSeconds(entry, at) {
  if (!entry) return { worked: 0, onBreak: 0, breakTotal: 0 };
  const start = Date.parse(entry.in), end = entry.out ? Date.parse(entry.out) : at;
  const open = !entry.out && entry.onBreak && entry.breakStartedAt ? Math.max(0, (end - Date.parse(entry.breakStartedAt)) / 1000) : 0;
  const breakTotal = (entry.closedBreakSeconds ?? 0) + open;
  return { worked: Math.max(0, Math.floor((end - start) / 1000 - breakTotal)), onBreak: Math.floor(open), breakTotal: Math.floor(breakTotal) };
}

/** The API request behind each one-click action. */
export function actionRequest(action, extra = {}) {
  switch (action) {
    case 'check-in': return { path: 'attendance/check-in', body: { mode: 'office', ...extra } };
    case 'break-start': return { path: 'attendance/break', body: { action: 'start', ...extra } };
    case 'break-end': return { path: 'attendance/break', body: { action: 'end', ...extra } };
    case 'check-out': return { path: 'attendance/check-out', body: { ...extra } };
    default: throw new Error(`Unknown companion action ${action}`);
  }
}

/** Which actions make sense in a state; the API still has the last word (409 when they no longer do). */
export function allowedActions(state, attendanceEnabled) {
  if (attendanceEnabled !== true) return [];
  if (state === 'in') return ['break-start', 'check-out'];
  if (state === 'break') return ['break-end', 'check-out'];
  return ['check-in'];
}

/**
 * The payload after an action, applied locally: the panel answers instantly and an offline phone shows what it queued.
 * The next refresh replaces it with the server's own figures.
 */
export function applyLocal(payload, action, at, extra = {}) {
  if (!payload) return payload;
  const iso = new Date(at).toISOString();
  const entry = payload.entry ? { ...payload.entry } : null;
  const next = { ...payload, pending: true };
  if (action === 'check-in') {
    if (entry && entry.date === payload.today) {      // back after checking out today: the gap becomes a break
      const gap = entry.out ? Math.max(0, (at - Date.parse(entry.out)) / 1000) : 0;
      next.entry = { ...entry, out: null, onBreak: false, breakStartedAt: null, closedBreakSeconds: (entry.closedBreakSeconds ?? 0) + gap };
    } else {
      const start = Date.parse(payload.shiftStartsAt ?? ''), grace = (payload.shift?.graceMinutes ?? 0) * 60000;
      const late = payload.shift?.workingDay && Number.isFinite(start) && at > start + grace ? Math.round((at - start) / 60000) : 0;
      next.entry = { id: null, date: payload.today, in: iso, out: null, mode: extra.mode ?? 'office', late, onBreak: false, breakStartedAt: null, closedBreakSeconds: 0 };
    }
    next.state = 'in';
  } else if (action === 'break-start' && entry) {
    next.entry = { ...entry, onBreak: true, breakStartedAt: iso };
    next.state = 'break';
  } else if (action === 'break-end' && entry) {
    const open = entry.breakStartedAt ? Math.max(0, (at - Date.parse(entry.breakStartedAt)) / 1000) : 0;
    next.entry = { ...entry, onBreak: false, breakStartedAt: null, closedBreakSeconds: (entry.closedBreakSeconds ?? 0) + open };
    next.state = 'in';
  } else if (action === 'check-out' && entry) {
    const open = entry.onBreak && entry.breakStartedAt ? Math.max(0, (at - Date.parse(entry.breakStartedAt)) / 1000) : 0;
    next.entry = { ...entry, out: iso, onBreak: false, breakStartedAt: null, closedBreakSeconds: (entry.closedBreakSeconds ?? 0) + open };
    next.state = 'done';
  } else return payload;
  return next;
}

/** A streak worth celebrating right after an on-time check-in, or the very first check-in in Pulse. */
export function celebration(payload) {
  if (!payload?.streak) return null;
  if (payload.streak.firstCheckIn) return 'Your first check-in with Pulse. Welcome aboard!';
  const n = payload.streak.onTime;
  return STREAK_MILESTONES.includes(n) ? `${n} on-time days in a row. Lovely rhythm!` : null;
}

function greeting(minutes, first) {
  const part = minutes < 300 ? 'Up late' : minutes < 720 ? 'Good morning' : minutes < 1020 ? 'Good afternoon' : 'Good evening';
  return first ? `${part}, ${first}` : part;
}

/**
 * Everything a surface needs to draw the companion at instant `at` (milliseconds on the server's clock).
 * `options.celebrate` forces the celebration pose (set briefly after a milestone check-in).
 */
export function deriveView(payload, at = Date.now(), options = {}) {
  if (!payload) return { state: 'loading', mood: 'idle', title: 'Waking up…', subtitle: '', greeting: '', timer: null, chip: { tone: 'neutral', text: 'Connecting' }, actions: [], showModes: false, footer: '', next: null, waiting: null, late: 0 };
  if (payload.attendanceEnabled !== true) return { state: 'disabled', mood: 'idle', title: 'Attendance is off for your organisation', subtitle: '', greeting: '', timer: null, chip: { tone: 'neutral', text: 'Attendance off' }, actions: [], showModes: false, footer: '', next: null, waiting: null, late: 0, pending: false };
  const offset = payload.utcOffsetMinutes ?? 330;
  const minutes = wallMinutes(at, offset);
  const night = minutes >= 22 * 60 || minutes < 6 * 60;
  const shift = payload.shift ?? { start: '10:00', end: '19:00', graceMinutes: 0, workingDay: true };
  const onTimeBy = shift.onTimeBy ?? addClock(shift.start, shift.graceMinutes ?? 0);
  const startAt = Date.parse(payload.shiftStartsAt ?? ''), endAt = Date.parse(payload.shiftEndsAt ?? '');
  const entry = payload.entry, live = liveSeconds(entry, at), state = payload.state;
  const first = payload.person?.firstName ?? '';
  const mode = entry?.mode ? MODES[entry.mode] ?? entry.mode : null;
  const next = payload.nextShift ? `Next shift ${payload.nextShift.date === payload.today ? 'today' : shortDay(payload.nextShift.date)} at ${friendlyClock(payload.nextShift.start)}` : null;
  const waiting = payload.waiting?.count ? { count: payload.waiting.count, href: payload.waiting.href ?? '/me', label: `${payload.waiting.count} ${payload.waiting.count === 1 ? 'request is' : 'requests are'} waiting for you` } : null;
  const footer = shift.workingDay ? `Shift ${friendlyClock(shift.start)} – ${friendlyClock(shift.end)} · on time until ${friendlyClock(onTimeBy)}` : 'Not a working day for your shift';
  const base = { state, greeting: greeting(minutes, first), footer, next, waiting, late: entry?.late ?? 0, pending: !!payload.pending, showModes: false };
  const act = (id, label, primary = false) => ({ id, label, primary });

  if (state === 'in') {
    return { ...base, mood: options.celebrate ? 'celebrate' : 'in', title: options.celebrate ? 'Checked in. Nice!' : 'You’re checked in',
      subtitle: options.celebrate && celebration(payload) ? celebration(payload) : entry?.late ? `In at ${clockOf(entry.in, offset)} · ${duration(entry.late * 60)} after the shift start` : `In at ${clockOf(entry.in, offset)}${live.breakTotal >= 60 ? ` · ${duration(live.breakTotal)} on breaks` : ''}`,
      timer: { seconds: live.worked, display: stopwatch(live.worked), label: 'worked today', running: true },
      chip: { tone: entry?.late ? 'warning' : 'success', text: `Checked in${mode ? ` · ${mode}` : ''}` },
      actions: [act('break-start', 'Break'), act('check-out', 'Check out')] };
  }
  if (state === 'break') {
    return { ...base, mood: 'break', title: 'On a break', subtitle: `Worked ${duration(live.worked)} so far. Take your time.`,
      timer: { seconds: live.onBreak, display: stopwatch(live.onBreak), label: 'on this break', running: true },
      chip: { tone: 'info', text: 'On a break' },
      actions: [act('break-end', 'Back', true), act('check-out', 'Check out')] };
  }
  if (state === 'done') {
    return { ...base, mood: night ? 'sleepy' : 'done', title: 'Done for today', subtitle: `${duration(live.worked)} worked${entry?.out ? ` · out at ${clockOf(entry.out, offset)}` : ''}. See you tomorrow!`,
      timer: { seconds: live.worked, display: stopwatch(live.worked), label: 'worked today', running: false },
      chip: { tone: 'neutral', text: 'Checked out' },
      actions: [act('check-in', 'Check in again')] };
  }
  if (state === 'leave' || state === 'holiday' || state === 'off') {
    const why = state === 'leave' ? 'You’re on leave today' : state === 'holiday' ? (payload.holiday ? `${payload.holiday} · holiday` : 'Holiday today') : 'Your day off';
    return { ...base, mood: night ? 'sleepy' : 'idle', title: why, subtitle: 'Enjoy it. Check in only if you are working.',
      timer: null, chip: { tone: 'neutral', text: state === 'leave' ? 'On leave' : state === 'holiday' ? 'Holiday' : 'Day off' },
      actions: [act('check-in', 'Check in anyway')], showModes: true };
  }
  // Not checked in yet.
  const beforeStart = Number.isFinite(startAt) && at < startAt;
  const soon = Number.isFinite(startAt) && at >= startAt - 45 * 60000 && at < startAt + 15 * 60000;
  const pastGrace = Number.isFinite(startAt) && at > startAt + (shift.graceMinutes ?? 0) * 60000;
  const afterEnd = Number.isFinite(endAt) && at > endAt;
  // PRESENCE-ONBOARD: the server noticed the person at an office and asks "Check in?" on every surface.
  const arrived = payload.arrival && shift.workingDay ? (payload.arrival.office ? `You’re at ${payload.arrival.office}` : 'You’re at the office') : null;
  const title = arrived ?? (afterEnd ? 'Shift is over' : soon ? 'Ready when you are' : beforeStart ? 'Not checked in yet' : pastGrace ? 'Not checked in yet' : 'Ready when you are');
  const subtitle = arrived ? 'Pulse noticed your arrival. One tap checks you in.' : afterEnd ? 'No check-in today. Working late? Check in to log it.'
    : beforeStart ? `Your shift starts at ${friendlyClock(shift.start)}. On time until ${friendlyClock(onTimeBy)}.`
    : pastGrace ? `The shift started at ${friendlyClock(shift.start)}. Checking in now marks you late.` : `On time until ${friendlyClock(onTimeBy)}.`;
  const countdown = beforeStart ? Math.floor((startAt - at) / 1000) : 0;
  return { ...base, mood: arrived ? 'waking' : night && !soon ? 'sleepy' : soon ? 'waking' : 'idle', title, subtitle,
    timer: beforeStart && countdown <= 12 * 3600 ? { seconds: countdown, display: stopwatch(countdown), label: 'until your shift', running: true } : null,
    chip: { tone: pastGrace && !afterEnd ? 'warning' : 'neutral', text: 'Not checked in' },
    actions: [act('check-in', 'Check in', true)], showModes: true };
}

function clockOf(iso, offset) {
  const m = wallMinutes(Date.parse(iso), offset);
  return friendlyClock(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
}

/** Tray / badge text: the shortest honest summary of the day. */
export function badge(payload, at = Date.now()) {
  if (!payload) return { text: '', tone: 'neutral', title: 'Pulse · not connected' };
  if (payload.attendanceEnabled !== true) return { text: '', tone: 'neutral', title: 'Attendance is off for your organisation' };
  const live = liveSeconds(payload.entry, at);
  if (payload.state === 'in') return { text: `${Math.floor(live.worked / 3600)}:${String(Math.floor(live.worked / 60) % 60).padStart(2, '0')}`, tone: 'success', title: `Pulse · checked in · ${duration(live.worked)} worked` };
  if (payload.state === 'break') return { text: 'BRK', tone: 'info', title: `Pulse · on a break · ${duration(live.onBreak)}` };
  if (payload.state === 'done') return { text: '✓', tone: 'neutral', title: `Pulse · done for today · ${duration(live.worked)} worked` };
  if (payload.state === 'out' && payload.shift?.workingDay) return { text: 'IN?', tone: 'warning', title: 'Pulse · not checked in yet' };
  return { text: '', tone: 'neutral', title: 'Pulse · day off' };
}
