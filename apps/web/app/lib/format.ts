import type { Period } from "./api";

const TZ = "Asia/Kolkata";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });
const isoDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
const at = (value: string) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+05:30` : value);

const isoDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : isoDayFmt.format(at(value));
export const day = (value: string) => { const d = isoDay(value); return `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`; };
export const dayYear = (value: string) => `${day(value)} ${isoDay(value).slice(0, 4)}`;
/** UI-POLISH-3: "24 Oct 2026" for a day or a timestamp that may be missing or malformed: nothing gives `missing`,
 *  something that is not a date comes back as it is (dayYear would throw on it). */
export const dayYearOr = (value: string | null | undefined, missing = "—") => {
  if (!value) return missing;
  return Number.isFinite(Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value)) ? dayYear(value) : value;
};
export const longDay = (value: string) => `${WEEKDAYS[new Date(`${isoDay(value)}T00:00:00Z`).getUTCDay()]} ${day(value)}`;
export const time = (value: string) => timeFmt.format(at(value));
export const dayTime = (value: string) => `${day(value)}, ${time(value)}`;
export const count = (value: number) => value.toLocaleString("en-IN");
export const plural = (value: number, one: string, many = `${one}s`) => `${count(value)} ${value === 1 ? one : many}`;
export const shiftDay = (value: string, days: number) => new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/** ISO week containing a calendar date, independent of the server's local timezone. */
export function isoWeek(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Return Monday for an API-provided ISO week. */
export function isoWeekMonday(week: string) {
  const [year, number] = week.split("-W").map(Number);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  return new Date(Date.UTC(year, 0, 4 - ((jan4.getUTCDay() + 6) % 7) + (number - 1) * 7)).toISOString().slice(0, 10);
}

export function isoWeekLabel(week: string) {
  const monday = isoWeekMonday(week);
  return `Week ${week.slice(-2)} · ${range(monday, shiftDay(monday, 6))}`;
}

export function currentIsoWeek() {
  return isoWeek(isoDayFmt.format(new Date()));
}

/** "4 min ago", "3 h ago", "yesterday", then a date. */
export function ago(value: string, now: number = Date.now()) {
  const minutes = Math.max(0, Math.round((now - at(value).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  if (minutes < 2880) return "yesterday";
  if (minutes < 60 * 24 * 60) return `${Math.round(minutes / 1440)} days ago`;
  return dayYear(value);
}

/** Feed timestamp: the time for today, otherwise the day. */
export function when(value: string, today: string) {
  return isoDay(value) === today ? time(value) : day(value);
}

export function range(from: string, to: string) {
  if (from === to) return dayYear(from);
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  return `${sameMonth ? Number(from.slice(8)) : day(from)} – ${dayYear(to)}`;
}

export function periodLabel(period: Period) {
  if (period.kind === "this") return "This week";
  if (period.kind === "last") return "Last week";
  return period.week ? `Week ${Number(period.week.slice(-2))}` : range(period.from, period.to);
}

/** Weekly targets can only be compared to delivery totals covering exactly seven days. */
export function isSevenDayPeriod(period: Pick<Period, "from" | "to">) {
  const from = Date.parse(`${period.from}T00:00:00Z`);
  const to = Date.parse(`${period.to}T00:00:00Z`);
  return Number.isFinite(from) && Number.isFinite(to) && to - from === 6 * 86400000;
}

/** Query string that carries the selected period to another page or the API. */
export function periodQuery(period: Period, extra: Record<string, string | undefined> = {}) {
  const q = new URLSearchParams();
  if (period.kind === "last") q.set("period", "last");
  else if (period.kind !== "this") { q.set("from", period.from); q.set("to", period.to); }
  for (const [key, value] of Object.entries(extra)) if (value) q.set(key, value);
  const text = q.toString();
  return text ? `?${text}` : "";
}

export type PeriodParams = { week?: string; period?: string; from?: string; to?: string };
export function apiPeriod(params: PeriodParams, extra: Record<string, string | undefined> = {}) {
  const q = new URLSearchParams();
  for (const key of ["week", "period", "from", "to"] as const) { const value = params[key]; if (typeof value === "string" && value) q.set(key, value); }
  for (const [key, value] of Object.entries(extra)) if (value) q.set(key, value);
  const text = q.toString();
  return text ? `?${text}` : "";
}

/** EA folder names read "#7 - Name | Client | Place | Month | Tier": the first part is the title. */
export function projectParts(name: string) {
  const parts = name.split("|").map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
  const title = (parts[0] ?? name).replace(/^#\d+\s*-\s*/, "").replace(/\s+\)/g, ")");
  return { title: title || name, meta: parts.slice(1).join(" · ") };
}

export function accountLabel(d: { sharedLogin: boolean; identityVerified: boolean }) {
  return d.sharedLogin ? "Shared login" : d.identityVerified ? "Verified" : "Unverified";
}

/** Round an axis maximum up to a clean number with four even steps. */
export function niceMax(value: number) {
  if (value <= 4) return 4;
  const step = Math.pow(10, Math.floor(Math.log10(value / 4)));
  const unit = (step >= 10 ? [1, 2, 2.5, 3, 4, 5, 10] : [1, 2, 3, 4, 5, 10]).find((m) => m * step * 4 >= value) ?? 10;
  return unit * step * 4;
}

/** The staff ID shown to people: user number 7 reads "EA-P007" (UX-TENANT: the company's own code, from useOrgCode). */
export const userId = (no: number | null, code = "EA") => no ? `${code}-P${String(no).padStart(3, "0")}` : null;
