// R51: days, weeks, due times and clocks count in the company's own time zone (pulse.org.time_zone, set in the setup
// wizard; EA's is India's, so EA's days do not move). The database functions already do (0179, 0299); this is the
// API's half. Nothing here names a zone: test/org-time.test.mjs fails if an API source does.
import type { PoolClient } from "pg";

/** The request company's zone inside SQL, evaluated once per statement (an init plan, not once per row). */
export const ORG_TZ = "(select pulse.org_time_zone())";

/** The request company's IANA zone name ("UTC" when no company is in scope). */
export async function orgZone(c: Pick<PoolClient, "query">): Promise<string> {
  return (await c.query<{ z: string }>("select pulse.org_time_zone() z")).rows[0].z;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();
const partFormats = new Map<string, Intl.DateTimeFormat>();
const format = (cache: Map<string, Intl.DateTimeFormat>, zone: string, make: () => Intl.DateTimeFormat) => {
  let f = cache.get(zone);
  if (!f) { f = make(); cache.set(zone, f); }
  return f;
};

/** The calendar day (YYYY-MM-DD) an instant falls on in a zone. */
export function zoneDay(zone: string, at: Date | string | number = Date.now()): string {
  return format(dayFormats, zone, () => new Intl.DateTimeFormat("en-CA", { timeZone: zone })).format(new Date(at));
}

/** How far a zone's wall clock is ahead of UTC at an instant, in milliseconds. */
function offsetMs(zone: string, at: number): number {
  const parts = format(partFormats, zone, () => new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })).formatToParts(new Date(at));
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}

/** The instant a zone's wall clock shows `time` (HH:MM) on `day`; 00:00 by default (the day's start). */
export function zoneTime(day: string, zone: string, time = "00:00"): Date {
  const wall = Date.parse(`${day}T${time}:00Z`);
  const first = wall - offsetMs(zone, wall);
  return new Date(wall - offsetMs(zone, first));
}
