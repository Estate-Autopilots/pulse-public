// What the one-tap check-in control shows for a day: the same states and words on every Pulse surface (header,
// phone, desktop panel, Chrome, Pip). Pure: the day from GET /api/v0/companion, the clock and any saved taps.
import { liveSeconds } from '@pulse/companion';

const pad = (n) => String(n).padStart(2, '0');
/** "4:07" (hours:minutes) for a running clock. */
export const hm = (seconds) => { const m = Math.max(0, Math.floor(seconds / 60)); return `${Math.floor(m / 60)}:${pad(m % 60)}`; };
/** Owner workbench (21 Oct 2026): durations in words ("32m", "8h 32m"), so the chip never reads like a clock. */
export const dur = (seconds) => { const m = Math.max(0, Math.floor(seconds / 60)); return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`; };
/** "4 h 07 min" or "35 min" for sentences. */
export const words = (seconds) => { const m = Math.max(0, Math.round(seconds / 60)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${pad(m % 60)} min` : ''}`; };
// EST-1196: the break ends with "End break" on every surface (it said "Back", which read like navigation).
export const ACTION_LABEL = { 'check-in': 'Check in', 'break-start': 'Break', 'break-end': 'End break', 'check-out': 'Check out' };

/**
 * @param {import('../lib/companion-day').CompanionDay | null} payload
 * @param {number} at server-corrected now (ms)
 * @param {{ state: string }[]} [records] saved taps from attendance-recovery
 * @param {{ online?: boolean, tapped?: boolean }} [env] `tapped`: a tap is on its way to Pulse (EST-1195: it shows at once)
 */
export function checkinView(payload, at, records = [], env = {}) {
  if (!payload || payload.attendanceEnabled !== true) return { show: false };
  const queued = records.filter((r) => r.state === 'queued').length;
  const entry = payload.entry;
  const live = liveSeconds(entry, at);
  const office = payload.arrival?.office ?? null;
  const base = { show: true, worked: live.worked, onBreak: live.onBreak, arrival: payload.state === 'out' && payload.arrival ? { office, at: payload.arrival.at } : null };
  if (queued) return { ...base, state: 'pending', tone: 'neutral', label: env.online === false ? 'Saved · will sync' : 'Saving…', short: env.online === false ? 'Saved' : '…',
    title: env.online === false ? 'Your tap is saved on this device and syncs when you are back online (within three hours).' : 'Waiting for Pulse to confirm', actions: [] };
  // EST-1195: a tap on its way to Pulse that is not saved yet: it shows at once, and never claims to be saved.
  if (env.tapped) return { ...base, state: 'pending', tone: 'neutral', label: 'Saving…', short: '…', title: 'Sending your tap to Pulse', actions: [] };
  const endsAt = Date.parse(payload.shiftEndsAt);
  // POLISH-1: a check-out forgotten yesterday. A session still open from an earlier day (on a day shift), or running
  // far past the shift, is not shown as time worked: it asks plainly, and the fix goes through the correction flow.
  const fix = (payload.state === 'in' || payload.state === 'break') && entry ? forgotten(payload, entry, at) : null;
  if (fix) return { ...base, state: 'stale', tone: fix.pending ? 'neutral' : 'attention', label: fix.pending ? 'Check-out time sent' : `Since ${fix.since}`, short: fix.pending ? 'Sent' : 'Check out?',
    title: fix.pending ? `You sent the time you left (${fix.since} session). Your manager or HR approves it.` : `Still checked in since ${fix.since}. Check out at the right time?`,
    fix, actions: !fix.pending ? [{ id: 'check-out', label: 'Check out now' }]
      // Sent: a working day can start (Pulse proposes closing the open session; HR reviews it with the correction).
      : fix.date < payload.today && payload.shift.workingDay ? [{ id: 'check-in', label: 'Check in for today', primary: true }] : [] };
  // POLISH-2: a session Pulse closed for review (nobody checked out): today's control stays as it is, and its menu
  // asks for the time they left (the same correction as a forgotten check-out).
  const u = payload.unresolved;
  // ATT: Pulse's one question about this session, when the signals conflict: "Yes, I left at 18:40" / "Still working".
  const ask = payload.question && entry && payload.question.entryId === entry.id ? payload.question : null;
  const q = ask ? { entryId: ask.entryId, kind: ask.kind, leftAt: clock(ask.leftAt, payload), office: ask.office ?? null,
    label: ask.kind === 'left_early' ? 'Done for the day?' : 'Still working?', short: ask.kind === 'left_early' ? 'Done?' : 'Working?',
    title: `You left ${ask.office ?? 'the office'} at ${clock(ask.leftAt, payload)}.` } : null;
  const later = u && !u.correctionPending ? { ...base, fix: closedFix(payload, u) } : base;
  switch (payload.state) {
    case 'out': {
      if (!payload.shift.workingDay) return { show: false };
      const late = at > Date.parse(payload.shiftStartsAt) + payload.shift.graceMinutes * 60000;
      return { ...later, state: 'out', tone: base.arrival ? 'attention' : 'action', label: 'Check in', short: 'Check in',
        title: base.arrival ? `You’re at ${office ?? 'the office'}. One tap checks you in.` : late ? `Your shift started at ${payload.shift.start}. Check in now.` : `Check in by ${payload.shift.onTimeBy} to be on time.`,
        actions: [{ id: 'check-in', label: 'Check in', primary: true }] };
    }
    case 'in': {
      // POLISH-2 (QA-E2E P1-12): a check-in after the shift ended is work after hours, not a forgotten check-out: no
      // "Your shift ended" the moment it starts (it comes AFTER_SHIFT_HOURS later, if they are still checked in).
      const began = Date.parse(entry?.in ?? ''), afterShift = Number.isFinite(endsAt) && began >= endsAt;
      const over = Number.isFinite(endsAt) && at > (afterShift ? began + AFTER_SHIFT_HOURS * 3600000 : endsAt + 30 * 60000);
      // ATT: with automatic check-out on, Pulse checks the person out when they leave: past the shift is not a question.
      const auto = payload.presence?.autoCheckOut === true;
      if (q) return { ...later, state: 'in', tone: 'attention', label: q.label, short: q.short, title: q.title, question: q,
        actions: [{ id: 'break-start', label: 'Break' }, { id: 'check-out', label: 'Check out' }] };
      return { ...later, state: 'in', tone: over && !auto ? 'attention' : 'success', label: `${dur(live.worked)} worked`, short: dur(live.worked),
        title: over ? `Your shift ended at ${payload.shift.end}. ${auto ? 'Pulse checks you out when you leave.' : 'Check out when you leave.'}` : afterShift ? `Checked in at ${clock(entry.in, payload)}, after your shift · ${words(live.worked)} worked`
          : `Checked in at ${clock(entry.in, payload)} · ${words(live.worked)} worked${entry.inVia === 'auto' ? ' (automatically)' : ''}`,
        actions: [{ id: 'break-start', label: 'Break' }, { id: 'check-out', label: 'Check out', primary: over && !auto }] };
    }
    case 'break': if (q) return { ...later, state: 'break', tone: 'attention', label: q.label, short: q.short, title: q.title, question: q,
      actions: [{ id: 'break-end', label: 'End break', primary: true }, { id: 'check-out', label: 'Check out' }] };
      return { ...later, state: 'break', tone: live.onBreak > 60 * 60 ? 'attention' : 'warning', label: `On break ${dur(live.onBreak)}`, short: dur(live.onBreak),
      title: `On break for ${words(live.onBreak)} · ${words(live.worked)} worked today`,
      actions: [{ id: 'break-end', label: 'End break', primary: true }, { id: 'check-out', label: 'Check out' }] };
    // POLISH-2: a day with less than a minute recorded read "0:00", like a stopped clock.
    case 'done': return { ...later, state: 'done', tone: 'neutral', label: live.worked >= 60 ? dur(live.worked) : 'Done', short: live.worked >= 60 ? dur(live.worked) : 'Done',
      title: `Done for today · ${words(live.worked)} worked${entry?.out ? `, out at ${clock(entry.out, payload)}${entry.outVia === 'auto' ? ` (Pulse checked you out ${entry.outReason === 'left' ? 'when you left' : entry.outReason === 'last_activity' ? 'at your last activity' : 'at the end of your shift'})` : ''}` : ''}`,
      actions: payload.shift.workingDay ? [{ id: 'check-in', label: 'Check in again' }] : [] };
    default: return { show: false };
  }
}
const minutes = (hhmm) => { const [h, m] = String(hhmm ?? '').split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null; };
const dayBefore = (day) => new Date(Date.parse(`${day}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
/** Hours after a check-in made after the shift ended before Pulse asks about checking out. */
export const AFTER_SHIFT_HOURS = 4;
/** Hours past the shift's length after which an open session counts as a forgotten check-out. */
export const FORGOTTEN_AFTER_HOURS = 4;
/**
 * A forgotten check-out, or null: the session began on an earlier day and the shift does not run overnight, or it has
 * run more than the shift's length plus FORGOTTEN_AFTER_HOURS. `suggested` is the time to send (the shift's end, or an
 * hour after a check-in that came after it); the person can change it before sending.
 */
export function forgotten(payload, entry, at) {
  const start = minutes(payload.shift?.start), end = minutes(payload.shift?.end);
  const overnight = start !== null && end !== null && end <= start;
  const length = start !== null && end !== null ? ((end - start + 1440) % 1440 || 1440) : 9 * 60;
  const began = Date.parse(entry.in); if (!Number.isFinite(began)) return null;
  const earlierDay = !!entry.date && !!payload.today && entry.date < payload.today;
  const tooLong = at - began > (length + FORGOTTEN_AFTER_HOURS * 60) * 60000;
  if (!(earlierDay && !overnight) && !tooLong) return null;
  const inAt = clock(entry.in, payload), inMin = minutes(inAt);
  const day = entry.date === payload.today ? 'today' : entry.date === dayBefore(payload.today) ? 'yesterday' : DAY.format(new Date(`${entry.date}T12:00:00Z`));
  const after = end !== null && inMin !== null && (overnight || end > inMin) ? end : Math.min(23 * 60 + 59, (inMin ?? 0) + 60);
  const suggested = `${pad(Math.floor(after / 60))}:${pad(after % 60)}`;
  return { since: `${day} ${inAt}`, date: entry.date, entryId: entry.id ?? null, in: inAt, suggested, pending: !!entry.correctionPending };
}
/** The fix for a session Pulse closed for review: the day, the check-in and the time Pulse noted (to change and send). */
export function closedFix(payload, u) {
  const inAt = clock(u.in, payload);
  const day = u.date === payload.today ? 'today' : u.date === dayBefore(payload.today) ? 'yesterday' : DAY.format(new Date(`${u.date}T12:00:00Z`));
  return { since: `${day} ${inAt}`, day, date: u.date, entryId: u.entryId, in: inAt, suggested: clock(u.proposedEnd, payload) || inAt, pending: !!u.correctionPending, closed: true };
}
/** "09:58" on the organisation's clock, whatever the device's time zone. */
export function clock(iso, payload) {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return '';
  const local = new Date(t + (payload?.utcOffsetMinutes ?? 330) * 60000);
  return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}
