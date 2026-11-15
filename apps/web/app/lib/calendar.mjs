// FIX-PR-CALENDAR (owner, 10 Nov 2026: "ONE calendar component used in PR Studio, My day, meetings, leaves and tasks"):
// the pure part of the one calendar (kit/calendar). Everything on it is a CalEvent: what it is (kind), where it lives
// (source: Pulse today; Google, Microsoft and LinkedIn later, read-only until a two-way sync exists), and its time as
// wall-clock text in the company's (or brand's) own time zone. The component draws that text as it is (FullCalendar in
// UTC mode), so nothing depends on the browser's clock, zone or locale (R51, the CI's toLocaleString rule).

/** What a calendar item is. The colour and icon come from the kind, the same on every screen. */
// CALENDAR-HUB (owner, 13 Nov 2026, P2.1): project milestones and time at work join; "event" is the person's own
// (made here from a slot, or from their Google Calendar).
export const KINDS = ["meeting", "event", "task", "milestone", "post", "leave", "attendance"];
export const KIND_WORDS = { post: "Posts", meeting: "Meetings", leave: "Leave", task: "Tasks due", event: "Events", milestone: "Milestones", attendance: "At work" };
export const KIND_ONE = { post: "Post", meeting: "Meeting", leave: "Leave", task: "Task due", event: "Event", milestone: "Milestone", attendance: "At work" };
/** Colours per kind (light; the CSS mixes them for dark mode). Posts violet, meetings sky blue, leave amber, tasks teal,
 *  events royal blue (green read as "done"), milestones pink, time at work slate. */
export const KIND_COLOR = { post: "#6B4CF0", meeting: "#0EA5E9", leave: "#D97706", task: "#0D9488", event: "#2563EB", milestone: "#DB2777", attendance: "#64748B" };
/** Where an item lives. Only Pulse's own items move by dragging; the others are shown, and open where they live. */
export const SOURCES = ["pulse", "google", "microsoft", "linkedin"];
export const SOURCE_WORDS = { pulse: "Pulse", google: "Google Calendar", microsoft: "Microsoft Outlook", linkedin: "LinkedIn" };
export const CAL_VIEWS = ["month", "week", "day", "list"];
export const CAL_VIEW_WORDS = { month: "Month", week: "Week", day: "Day", list: "Agenda" };
/** FullCalendar's view names for ours. */
export const FC_VIEW = { month: "dayGridMonth", week: "timeGridWeek", day: "timeGridDay", list: "listWeek" };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
// A real day: 30 February does not parse and roll over into March.
const realDay = (s) => { const t = Date.parse(`${s.slice(0, 10)}T00:00:00Z`); return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s.slice(0, 10); };
export const isDay = (s) => typeof s === "string" && DAY.test(s) && realDay(s);
export const isStamp = (s) => typeof s === "string" && STAMP.test(s) && realDay(s) && Number(s.slice(11, 13)) < 24 && Number(s.slice(14, 16)) < 60;

/** The wall-clock day and time of an instant in a time zone ("2026-11-10T12:30"), for the API's timestamps. */
export function wallClock(instant, timeZone) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** A clean CalEvent, or null when it cannot be drawn (no title, no valid start, an end before its start). */
export function calEvent(e) {
  if (!e || typeof e !== "object") return null;
  const kind = KINDS.includes(e.kind) ? e.kind : "event";
  const source = SOURCES.includes(e.source) ? e.source : "pulse";
  const title = String(e.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const allDay = e.allDay === true || isDay(e.start);
  const start = allDay ? String(e.start ?? "").slice(0, 10) : String(e.start ?? "").slice(0, 16);
  if (!title || !(allDay ? isDay(start) : isStamp(start))) return null;
  let end = e.end ? (allDay ? String(e.end).slice(0, 10) : String(e.end).slice(0, 16)) : undefined;
  if (end !== undefined && (!(allDay ? isDay(end) : isStamp(end)) || end < start)) end = undefined;
  return {
    id: `${source}:${kind}:${String(e.id ?? title).slice(0, 120)}`, kind, source, title, start, ...(end ? { end } : {}), allDay,
    ...(typeof e.href === "string" && /^\/(?![/\\])/.test(e.href) ? { href: e.href } : {}),
    ...(typeof e.thumb === "string" && /^\/api\/v0\//.test(e.thumb) ? { thumb: e.thumb } : {}),
    ...(e.meta ? { meta: String(e.meta).slice(0, 160) } : {}),
    ...(e.status ? { status: String(e.status).slice(0, 40) } : {}),
    ...(e.who ? { who: String(e.who).slice(0, 120) } : {}),
    ...(e.note ? { note: String(e.note).slice(0, 400) } : {}),
    // Pulse's own items, and the person's own Google events (changed in Google first), move when the API says so.
    editable: (source === "pulse" || source === "google") && e.editable === true,
    ...(e.slot === true ? { slot: true } : {}),
    ...(e.externalId ? { externalId: String(e.externalId).slice(0, 200) } : {}),
  };
}

/** Leave and other all-day spans: FullCalendar's end day is exclusive, ours is the last day. */
export function lastDayToEnd(day) {
  if (!isDay(day)) return undefined;
  const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The items to draw: clean, the chosen kinds only, in time order. */
export function shown(events, kinds) {
  const on = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null;
  return (Array.isArray(events) ? events : []).map(calEvent).filter((e) => e && (!on || on.has(e.kind)))
    .sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}

/** Counts per kind, for the filter chips. */
export function countByKind(events) {
  const out = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const e of Array.isArray(events) ? events : []) { const c = calEvent(e); if (c) out[c.kind] += 1; }
  return out;
}

/** "12:30" from a wall-clock stamp, "" for an all-day item. */
export const timeOf = (e) => (e && !e.allDay && typeof e.start === "string" && e.start.length >= 16 ? e.start.slice(11, 16) : "");

/** The new wall-clock start after a drag, keeping the item's own minutes when it lands on a whole hour of a month day. */
export function movedStart(e, toDay, toTime) {
  if (!isDay(toDay)) return null;
  if (e.allDay) return toDay;
  const t = typeof toTime === "string" && /^\d{2}:\d{2}$/.test(toTime) ? toTime : timeOf(e) || "09:00";
  return `${toDay}T${t}`;
}

/** The view a screen opens on: what the person chose, else a list on a phone and a month on a computer. */
export function startView(chosen, narrow) {
  return CAL_VIEWS.includes(chosen) ? chosen : narrow ? "list" : "month";
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Fri 13 Nov" for a day or a wall-clock stamp, without the browser's locale or zone. */
export function dayWords(s) {
  const day = typeof s === "string" ? s.slice(0, 10) : "";
  if (!isDay(day)) return "";
  const d = new Date(`${day}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

/** A status's colour: "warn" while it waits on someone (review, an OK, late), "good" once it is settled. */
export function statusTone(status) {
  const w = String(status ?? "").toLowerCase();
  // "Needs a check" warns; "Checked in" / "Checked out" (time at work) do not.
  if (/review|waiting|late|needs|\bcheck\b|pending|stuck/.test(w)) return "warn";
  if (/approved|done|posted|measured|scheduled|booked|recorded/.test(w)) return "good";
  return "";
}

/** Whether an item touches the days from..to (inclusive), for counts of what a view shows. */
export function inRange(e, from, to) {
  const c = calEvent(e);
  if (!c || !isDay(from) || !isDay(to)) return false;
  const start = c.start.slice(0, 10), end = (c.end ?? c.start).slice(0, 10);
  return start <= to && end >= from;
}

// ------------------------------------------------------------------------------------------------ CALENDAR-HUB: companies
/** Colours for companies with no brand colour of their own, in order (teal, violet, amber, sky, pink, slate). */
export const COMPANY_COLORS = ["#0D9488", "#6B4CF0", "#D97706", "#0EA5E9", "#DB2777", "#64748B", "#16A34A", "#9333EA"];
/** A company's colour: its brand colour when it has one that no earlier company took, else the next free one. */
export function companyColors(companies) {
  const used = new Set(), out = [];
  for (const c of Array.isArray(companies) ? companies : []) {
    const own = typeof c?.accent === "string" && /^#[0-9a-f]{6}$/i.test(c.accent) ? c.accent.toUpperCase() : null;
    const pick = own && !used.has(own) ? own : COMPANY_COLORS.find((x) => !used.has(x)) ?? COMPANY_COLORS[out.length % COMPANY_COLORS.length];
    used.add(pick); out.push(pick);
  }
  return out;
}
const mins = (stamp) => Date.parse(`${stamp}:00Z`) / 60_000;
/** The minutes of one day that timed items take, overlaps counted once (a meeting inside time at work is not twice). */
export function busyMinutes(items, day) {
  if (!isDay(day)) return 0;
  const d0 = mins(`${day}T00:00`), d1 = d0 + 1440;
  const spans = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const e = calEvent(raw);
    if (!e || e.allDay) continue;
    const s = mins(e.start), f = e.end ? mins(e.end) : s + 30;
    const a = Math.max(s, d0), b = Math.min(f, d1);
    if (b > a) spans.push([a, b]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  let total = 0, cs = -1, ce = -1;
  for (const [a, b] of spans) {
    if (a > ce) { if (ce > cs) total += ce - cs; cs = a; ce = b; } else ce = Math.max(ce, b);
  }
  if (ce > cs) total += ce - cs;
  return Math.round(total);
}
/** Each company's minutes per day and in all over the days given, with its colour. */
export function companyHours(companies, days) {
  const list = Array.isArray(companies) ? companies : [];
  const colors = companyColors(list);
  const rows = list.map((c, i) => {
    const byDay = Object.fromEntries((days ?? []).map((d) => [d, busyMinutes(c?.items, d)]));
    return { org: String(c?.org ?? i), name: String(c?.name ?? "Company"), color: colors[i], byDay, minutes: Object.values(byDay).reduce((a, b) => a + b, 0) };
  });
  return { rows, total: rows.reduce((a, r) => a + r.minutes, 0) };
}
/** Hours one way everywhere, to the nearest 5 minutes: "0h", "45m", "1h", "2h 50m", "31h 50m". */
export function hoursWords(minutes) {
  const m = Math.max(0, Math.round((Number(minutes) || 0) / 5) * 5);
  const h = Math.floor(m / 60), r = m % 60;
  return h && r ? `${h}h ${r}m` : h ? `${h}h` : `${r}m`.replace(/^0m$/, "0h");
}
/** The 7 days of the week (Monday first) that hold a day. */
export function weekOf(day) {
  if (!isDay(day)) return [];
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, i) => { const x = new Date(d); x.setUTCDate(d.getUTCDate() - back + i); return x.toISOString().slice(0, 10); });
}
