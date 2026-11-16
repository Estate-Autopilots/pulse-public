// A synthetic day for "Try it without signing in", screenshots and tests. Clearly labelled, never sent anywhere.
import { applyLocal } from './view.js';

const IST = 330;
/** YYYY-MM-DD and an instant for HH:MM on the organisation's clock, on the day containing `at`. */
function istDay(at) { return new Date(at + IST * 60000).toISOString().slice(0, 10); }
function istInstant(date, hhmm) { return Date.parse(`${date}T${hhmm}:00+05:30`); }

/**
 * A /companion-shaped payload for one state: 'out' | 'in' | 'break' | 'done' | 'off' | 'leave' | 'holiday'.
 * `options`: { first: true } (first check-in), { onTime: n } (streak), { waiting: n } (manager), { late: minutes }.
 */
export function demoPayload(state = 'out', at = Date.now(), options = {}) {
  const today = istDay(at);
  const start = istInstant(today, '10:00'), end = istInstant(today, '19:00');
  const iso = (ms) => new Date(ms).toISOString();
  const tomorrow = istDay(at + 86400000);
  const inAt = Math.min(at - 60000, start + (options.late ?? -4) * 60000);
  const base = {
    demo: true, attendanceEnabled: true, person: { id: 'demo', name: 'Pip Demo', firstName: 'Pip' }, now: iso(at), today, clock: '', timezone: 'Asia/Kolkata', utcOffsetMinutes: IST,
    shift: { start: '10:00', end: '19:00', graceMinutes: 15, onTimeBy: '10:15', workingDay: !['off', 'holiday'].includes(state), mode: 'office' },
    shiftStartsAt: iso(start), shiftEndsAt: iso(end), state, holiday: state === 'holiday' ? 'Diwali' : null, entry: null,
    nextShift: { date: at < start ? today : tomorrow, start: '10:00', startsAt: iso(at < start ? start : istInstant(tomorrow, '10:00')) },
    upcoming: [1, 2, 3].map((d) => { const date = istDay(at + d * 86400000); return { date, start: '10:00', startsAt: iso(istInstant(date, '10:00')) }; }),
    streak: { onTime: options.onTime ?? 4, firstCheckIn: !!options.first },
    waiting: options.waiting ? { count: options.waiting, href: '/me' } : null,
    presence: { autoCheckIn: false, offices: [{ id: 'demo-office', name: 'Demo office', lat: 0.5, lng: 0.5, radius: 150, wifi: [{ ssid: 'Demo-WiFi', bssids: ['a4:2b:b0:11:22:33'] }] }], sites: [] },
  };
  if (state === 'in' || state === 'break' || state === 'done') {
    let p = applyLocal({ ...base, state: 'out' }, 'check-in', inAt, { mode: 'office' });
    p.entry.late = Math.max(0, Math.round((inAt - start) / 60000) > 15 ? Math.round((inAt - start) / 60000) : 0);
    if (state === 'break') p = applyLocal(p, 'break-start', at - 12 * 60000);
    if (state === 'done') p = applyLocal(p, 'check-out', Math.min(at - 60000, Math.max(inAt + 60000, end + 7 * 60000)));
    return { ...p, pending: false, entry: { ...p.entry, closedBreakSeconds: state === 'in' ? 25 * 60 : p.entry.closedBreakSeconds } };
  }
  return base;
}

/** A local stand-in for the gateway client so the demo responds to clicks. */
export function demoClient(initial = 'out') {
  let payload = demoPayload(initial);
  return {
    demo: true,
    companion: async () => ({ ...payload, now: new Date().toISOString() }),
    act: async (action, extra = {}) => { payload = { ...applyLocal(payload, action, Date.now(), extra), pending: false }; return { ok: true }; },
    signOut: async () => {},
  };
}
