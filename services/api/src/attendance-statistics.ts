/** Read-only statistics, v1. HR role/shift caps are not approved (E06).
 * Keep source punches and payroll separate. A partially resolved day is not a sample day. */
export const ATTENDANCE_FILTER = { version: "provisional-v1", provisional: true, maxMinutes: 720 } as const;
type Stamp = string | Date;
export type Session = { id: string; personId: string; date: string; in: Stamp; out: Stamp | null; missedOut: boolean;
  worked: number; pendingCorrection?: boolean; breaks: { in: Stamp; out: Stamp | null }[] };
export const REASONS = {
  invalid_time: "Times need review", out_before_in: "Check-out precedes check-in", future_time: "Recorded time is in the future",
  missed_out: "Check-out needs correction", open_session: "Session not yet closed", pending_correction: "Correction awaiting a decision",
  long_session: "Over the provisional 12-hour session bound", overlapping_sessions: "Sessions overlap",
  invalid_break: "Break times need review", overlapping_breaks: "Breaks overlap", long_day: "Over the provisional 12-hour daily bound",
} as const;
export type Reason = keyof typeof REASONS;
export type Eligibility = { eligible: boolean; minutes: number | null; reasons: Reason[]; labels: string[] };
export type AttendanceDay = Eligibility & { date: string; personId: string; sessions: number; flaggedCount: number; recordedMinutes: number };
const stamp = (s: Stamp) => s instanceof Date ? s.getTime() : Date.parse(s);
const overlap = (a: number, b: number, c: number, d: number) => a < d && c < b;

/** Shared by self, profile, team summaries and HR dashboard; no database writes. */
export function attendanceStatistics(entries: Session[], now = Date.now()) {
  const sessions = new Map<string, Eligibility>();
  for (const e of entries) {
    const reasons = new Set<Reason>(), start = stamp(e.in), end = e.out === null ? now : stamp(e.out);
    if (!Number.isFinite(start) || !Number.isFinite(end)) reasons.add("invalid_time");
    if (end < start) reasons.add("out_before_in");
    if (start > now || end > now) reasons.add("future_time");
    if (e.missedOut) reasons.add("missed_out");
    if (e.out === null) reasons.add("open_session");
    if (e.pendingCorrection) reasons.add("pending_correction");
    if (end - start > ATTENDANCE_FILTER.maxMinutes * 60000) reasons.add("long_session");
    for (const other of entries) {
      if (other.id !== e.id && other.personId === e.personId && overlap(start, end, stamp(other.in), other.out === null ? now : stamp(other.out))) reasons.add("overlapping_sessions");
    }
    let breakMs = 0;
    for (const [i, b] of e.breaks.entries()) {
      const a = stamp(b.in), z = b.out === null ? now : stamp(b.out);
      if (!Number.isFinite(a) || !Number.isFinite(z) || (b.out === null && e.out !== null) || z < a || a < start || z > end) reasons.add("invalid_break");
      for (const other of e.breaks.slice(i + 1)) if (overlap(a, z, stamp(other.in), other.out === null ? now : stamp(other.out))) reasons.add("overlapping_breaks");
      breakMs += z - a;
    }
    const minutes = Math.round((end - start - breakMs) / 60000);
    if (!Number.isFinite(minutes) || minutes < 0) reasons.add("invalid_break");
    sessions.set(e.id, { eligible: reasons.size === 0, minutes: reasons.size ? null : minutes, reasons: [...reasons], labels: [...reasons].map(r => REASONS[r]) });
  }
  const groups = new Map<string, Session[]>();
  for (const e of entries) { const key = `${e.personId}:${e.date}`; groups.set(key, [...(groups.get(key) ?? []), e]); }
  const days = new Map<string, AttendanceDay>();
  for (const [key, rows] of groups) {
    const reasons = new Set(rows.flatMap(e => sessions.get(e.id)!.reasons));
    const minutes = rows.reduce((n, e) => n + (sessions.get(e.id)!.minutes ?? 0), 0);
    if (!reasons.size && minutes > ATTENDANCE_FILTER.maxMinutes) {
      reasons.add("long_day");
      for (const e of rows) sessions.set(e.id, { eligible: false, minutes: null, reasons: ["long_day"], labels: [REASONS.long_day] });
    }
    days.set(key, { date: rows[0].date, personId: rows[0].personId, sessions: rows.length,
      eligible: reasons.size === 0, minutes: reasons.size ? null : minutes, reasons: [...reasons], labels: [...reasons].map(r => REASONS[r]),
      flaggedCount: rows.filter(e => !sessions.get(e.id)!.eligible).length,
      recordedMinutes: rows.filter(e => e.out !== null).reduce((n, e) => n + e.worked, 0) });
  }
  return { sessions, days };
}

/** Coverage is eligible recorded person-days / all recorded person-days, not an attendance rate. */
export function attendanceSummary(days: AttendanceDay[], from: string, to: string) {
  const eligible = days.filter(d => d.eligible), workedMinutes = eligible.reduce((n, d) => n + d.minutes!, 0);
  return { filter: ATTENDANCE_FILTER, from, to, recordedDays: days.length, eligibleDays: eligible.length,
    flaggedCount: days.reduce((n, d) => n + d.flaggedCount, 0), excludedDays: days.length - eligible.length,
    coverage: days.length ? eligible.length / days.length : null, workedMinutes,
    recordedMinutes: days.reduce((n, d) => n + d.recordedMinutes, 0),
    averageMinutes: eligible.length ? Math.round(workedMinutes / eligible.length) : null };
}
