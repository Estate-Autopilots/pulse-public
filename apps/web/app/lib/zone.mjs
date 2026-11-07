// R51: the company's calendar on the web. The root layout provides the company's IANA zone per request (useOrgZone in
// app/org-code.tsx; orgZone() in lib/brand-server.ts for server pages). Pure functions, so a server render and the
// browser give the same day. EA's zone is India's, so EA's days do not move.

/** The install company's zone, used only when the brand cannot be read (EA's, as before R51). */
export const FALLBACK_ZONE = "Asia/Kolkata";

const days = new Map(), parts = new Map();
const fmt = (cache, zone, make) => { let f = cache.get(zone); if (!f) { f = make(); cache.set(zone, f); } return f; };

/** The calendar day (YYYY-MM-DD) an instant falls on in a zone. */
export function zoneDay(zone, at = Date.now()) {
  return fmt(days, zone, () => new Intl.DateTimeFormat("en-CA", { timeZone: zone })).format(new Date(at));
}

/** How far a zone's wall clock is ahead of UTC at an instant, in milliseconds. */
function offset(zone, ms) {
  const p = Object.fromEntries(fmt(parts, zone, () => new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }))
    .formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant a zone's wall clock shows `time` (HH:MM) on `day`; 00:00 by default (the day's start). */
export function zoneTime(day, zone, time = "00:00") {
  const wall = Date.parse(`${day}T${time}:00Z`);
  return new Date(wall - offset(zone, wall - offset(zone, wall)));
}

/** The weekday (0 Sunday … 6 Saturday) of a calendar day. */
export const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();
