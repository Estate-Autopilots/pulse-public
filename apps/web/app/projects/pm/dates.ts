// PM-UI: the one place PM screens do date arithmetic and formatting. Every date is a calendar day `YYYY-MM-DD`; the
// formatters use a fixed locale and zone (en-IN, Asia/Kolkata), so the server and the browser print the same words
// (no hydration mismatch). Never `new Date()` for "today": view models carry `today`.
import type { IsoDate, IsoDateTime } from "./contract/shared";

const DAY = 86_400_000;
const parse = (d: IsoDate) => { const [y, m, n] = d.split("-").map(Number); return Date.UTC(y, m - 1, n); };
const iso = (ms: number): IsoDate => new Date(ms).toISOString().slice(0, 10);
/** Midday in India on that day, so the zone can never move it to a neighbouring date. */
const atNoonIst = (d: IsoDate) => new Date(parse(d) + 6.5 * 3_600_000);

/** Whole days from `a` to `b` (positive when b is later). Calendar days. */
export function daysBetween(a: IsoDate, b: IsoDate): number { return Math.round((parse(b) - parse(a)) / DAY); }
/** The day `n` days after `d` (n may be negative). */
export function addDays(d: IsoDate, n: number): IsoDate { return iso(parse(d) + n * DAY); }

const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", ...o });
const LONG = fmt({ weekday: "short", day: "numeric", month: "short" });
const SHORT = fmt({ day: "numeric", month: "short" });
const TIME = fmt({ hour: "numeric", minute: "2-digit" });

/** "Sat, 21 Nov" */
export const fmtDay = (d: IsoDate) => LONG.format(atNoonIst(d));
/** "21 Nov" */
export const fmtDayShort = (d: IsoDate) => SHORT.format(atNoonIst(d));
/** "5:00 pm" (a due time). */
export const fmtTime = (t: IsoDateTime) => TIME.format(new Date(t));
/** "11–14 Nov", "25 Nov–4 Dec", or one day when start = end. */
export function fmtRange(start: IsoDate, end: IsoDate): string {
  if (start === end) return fmtDayShort(start);
  const [a, b] = [fmtDayShort(start), fmtDayShort(end)];
  return start.slice(0, 7) === end.slice(0, 7) ? `${a.split(" ")[0]}–${b}` : `${a}–${b}`;
}
/** Plural days in words: "1 day", "3 days". */
export const nDays = (n: number) => `${n} ${Math.abs(n) === 1 ? "day" : "days"}`;
/** Relative to today: "today", "tomorrow", "yesterday", "in 9 days", "2 days ago". */
export function relDays(d: IsoDate, today: IsoDate): string {
  const n = daysBetween(today, d);
  return n === 0 ? "today" : n === 1 ? "tomorrow" : n === -1 ? "yesterday" : n > 0 ? `in ${nDays(n)}` : `${nDays(-n)} ago`;
}
/** Days a step is past due (0 when not late). SPEC §3.1: due < today. Calendar days (canon: due 19 Nov on 21 Nov = 2). */
export const daysLate = (due: IsoDate | null | undefined, today: IsoDate) => (due ? Math.max(0, daysBetween(due, today)) : 0);
