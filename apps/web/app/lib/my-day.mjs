// TASKUX (owner, 2 Nov 2026): My day across a Pulse account's organisations. The API reads each seat inside its own
// organisation (services/api/src/my-day.ts); this file turns those seats into one day: which section each task is in,
// the order within it, how much time is planned and spent per company and workstream, which company needs attention
// first, and whether the day's and the week's targets are met. Pure functions, so they are unit-tested.

const OPEN = new Set(["open", "in_progress", "blocked", "unknown"]);
const FINISHED = new Set(["done", "in_review", "accepted"]);
const RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

/** COMPANY-MARKS (owner, 4 Nov 2026): how a company is marked: its own square logo (`mark`, an address), and its set
 *  brand colour (`color`, a validated #rrggbb) for its stripes and its initials tile. Nothing is made up from its name:
 *  without a brand colour the page uses one neutral colour. */
export function brandOf(seat) {
  const accent = seat?.accent;
  return { color: typeof accent === "string" && /^#[0-9a-f]{6}$/i.test(accent) ? accent : null, mark: typeof seat?.mark === "string" && seat.mark.startsWith("/api/") ? seat.mark : null };
}

/** "45 min", "1 h", "2 h 30 min". */
export function minutesText(m) {
  const n = Math.max(0, Math.round(Number(m) || 0));
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60), r = n % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** Minutes since midnight in a time zone (for the part of a running clock that falls today). */
export function minutesIntoDay(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timeZone || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
    const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return get("hour") * 60 + get("minute");
  } catch { return 0; }
}

/** Minutes a running clock adds to today (never more than today so far, never more than Pulse's 10-hour cap). */
export function runningToday(timer, now, timeZone) {
  if (!timer?.startedAt) return 0;
  const elapsed = Math.floor((now - Date.parse(timer.startedAt)) / 60000);
  return Math.max(0, Math.min(elapsed, minutesIntoDay(now, timeZone), 600));
}

/** Which part of the day a task belongs to. */
export function sectionOf(t, today, weekEnd) {
  if (FINISHED.has(t.status)) return "done";
  if (!OPEN.has(t.status)) return null;
  if (t.status === "in_progress") return "doing";
  if (t.dueOn && t.dueOn < today) return "overdue";
  const timed = !!t.dueTime && t.dueTime !== "18:00" && t.dueTime !== "00:00" && t.dueTime !== "23:59";
  if (t.dueOn === today) return timed ? "scheduled" : "today";
  if (t.startsOn && t.startsOn <= today && (!t.dueOn || t.dueOn <= weekEnd)) return "today";
  if (t.workOn === today) return "today";
  if (t.status === "blocked") return "waiting";
  if ((t.dueOn && t.dueOn <= weekEnd) || (t.workOn && t.workOn <= weekEnd) || (t.startsOn && t.startsOn <= weekEnd)) return "week";
  if (!t.dueOn && (t.priority === "urgent" || t.priority === "high")) return "priority";
  return null;
}

export const SECTIONS = [
  { key: "doing", label: "Doing now", hint: "In progress" },
  { key: "overdue", label: "Overdue", hint: "Past their due day" },
  { key: "scheduled", label: "At a set time today", hint: "Calls and meetings with a time" },
  { key: "today", label: "Today", hint: "Due or planned for today" },
  { key: "waiting", label: "Waiting", hint: "Waiting for a reply, on hold or blocked" },
  { key: "week", label: "Later this week", hint: "Due by Sunday" },
  { key: "priority", label: "High priority, no date", hint: "Give these a day" },
  { key: "done", label: "Done today", hint: "Finished today" },
];

const byPriorityThenTime = (a, b) => (RANK[a.priority] ?? 2) - (RANK[b.priority] ?? 2)
  || String(a.dueOn ?? "9999").localeCompare(String(b.dueOn ?? "9999")) || String(a.dueTime ?? "").localeCompare(String(b.dueTime ?? ""))
  || String(a.title).localeCompare(String(b.title));
const byTime = (a, b) => String(a.dueTime ?? "").localeCompare(String(b.dueTime ?? "")) || byPriorityThenTime(a, b);
const weekEndOf = (weekStart) => new Date(Date.parse(`${weekStart}T00:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10);

/** One company's figures for the day. */
function companyOf(seat, items, now) {
  const mine = items.filter((i) => i.org === seat.org);
  const count = (k) => mine.filter((i) => i.section === k).length;
  const planned = mine.filter((i) => ["doing", "overdue", "scheduled", "today", "done"].includes(i.section)).reduce((n, i) => n + (i.estimateMinutes || 0), 0);
  const running = runningToday(seat.timer, now, seat.timeZone);
  const actual = (seat.timeToday ?? []).reduce((n, g) => n + (g.minutes || 0), 0) + running;
  const week = (seat.counts?.minutesWeek ?? 0) + running;
  const tg = seat.targets ?? {};
  const targets = {
    day: tg.dailyMinutes ? { target: tg.dailyMinutes, actual, met: actual >= tg.dailyMinutes } : null,
    week: tg.weeklyMinutes ? { target: tg.weeklyMinutes, actual: week, met: week >= tg.weeklyMinutes } : null,
    tasks: tg.tasksPerWeek ? { target: tg.tasksPerWeek, actual: seat.counts?.doneWeek ?? 0, met: (seat.counts?.doneWeek ?? 0) >= tg.tasksPerWeek, unit: tg.unit ?? null } : null,
    own: !!tg.own,
  };
  const urgent = mine.filter((i) => ["today", "scheduled", "doing", "overdue"].includes(i.section) && (i.priority === "urgent" || i.priority === "high")).length;
  const behind = [targets.day, targets.week].filter((t) => t && !t.met).length;
  const attention = count("overdue") * 3 + urgent * 2 + count("today") + count("scheduled") + count("doing") + (behind ? 1 : 0);
  return {
    org: seat.org, name: seat.name, handle: seat.handle ?? null, current: !!seat.current, ok: seat.ok !== false, ...brandOf(seat),
    overdue: count("overdue"), today: count("today") + count("scheduled"), doing: count("doing"), waiting: count("waiting"), week: count("week"), done: count("done"),
    planned, actual, running, attention, urgent, targets, undated: seat.counts?.undated ?? 0, doneToday: seat.counts?.doneToday ?? 0,
  };
}

/** The whole day from the API's seats. `only`: the organisations to show (empty or missing: all). */
export function buildDay(data, now = Date.now(), only = []) {
  const seats = (data?.seats ?? []);
  const items = [];
  for (const seat of seats) {
    if (!seat.ok) continue;
    const weekEnd = weekEndOf(seat.weekStart ?? seat.today);
    for (const t of seat.tasks ?? []) {
      const section = sectionOf(t, seat.today, weekEnd);
      if (!section) continue;
      items.push({ ...t, section, org: seat.org, orgName: seat.name, current: !!seat.current, ...brandOf(seat),
        running: seat.timer?.taskId === t.id });
    }
  }
  const companies = seats.map((s) => s.ok ? companyOf(s, items, now) : { org: s.org, name: s.name, current: !!s.current, ok: false, ...brandOf(s), attention: -1 })
    .sort((a, b) => (b.attention - a.attention) || (a.current === b.current ? 0 : a.current ? -1 : 1) || a.name.localeCompare(b.name));
  const shown = only?.length ? items.filter((i) => only.includes(i.org)) : items;
  const sections = SECTIONS.map((s) => ({ ...s, items: shown.filter((i) => i.section === s.key).sort(s.key === "scheduled" ? byTime : byPriorityThenTime) }))
    .filter((s) => s.items.length);
  const timerSeat = seats.find((s) => s.ok && s.timer);
  const timer = timerSeat ? { ...timerSeat.timer, org: timerSeat.org, orgName: timerSeat.name, current: !!timerSeat.current, ...brandOf(timerSeat),
    minutes: Math.max(0, Math.floor((now - Date.parse(timerSeat.timer.startedAt)) / 60000)) } : null;
  const inView = (c) => !only?.length || only.includes(c.org);
  const sum = (k) => companies.filter((c) => c.ok && inView(c)).reduce((n, c) => n + (c[k] || 0), 0);
  return { sections, companies, timer, streams: streamsOf(seats.filter((s) => s.ok && (!only?.length || only.includes(s.org))), items, now),
    totals: { overdue: sum("overdue"), today: sum("today"), doing: sum("doing"), done: sum("done"), planned: sum("planned"), actual: sum("actual") },
    focus: focusOf(items.filter((i) => !only?.length || only.includes(i.org))) };
}

/** Time today by company and workstream (a project's stakeholder; its project when it has none): planned and spent. */
export function streamsOf(seats, items, now = Date.now()) {
  const map = new Map();
  const at = (seat, stream) => {
    const key = `${seat.org}|${stream}`;
    if (!map.has(key)) map.set(key, { key, org: seat.org, orgName: seat.name, ...brandOf(seat), stream, planned: 0, actual: 0 });
    return map.get(key);
  };
  for (const seat of seats) {
    for (const g of seat.timeToday ?? []) at(seat, g.workstream || g.projectName || "No project").actual += g.minutes || 0;
    if (seat.timer) {
      const task = (seat.tasks ?? []).find((t) => t.id === seat.timer.taskId);
      at(seat, seat.timer.workstream || task?.workstream || task?.projectName || "No project").actual += runningToday(seat.timer, now, seat.timeZone);
    }
    for (const i of items.filter((x) => x.org === seat.org && ["doing", "overdue", "scheduled", "today", "done"].includes(x.section) && x.estimateMinutes)) {
      at(seat, i.workstream || i.projectName || "No project").planned += i.estimateMinutes;
    }
  }
  return [...map.values()].filter((s) => s.planned || s.actual).sort((a, b) => Math.max(b.planned, b.actual) - Math.max(a.planned, a.actual) || a.stream.localeCompare(b.stream));
}

/** The few things to do first: overdue and urgent work, then today's by priority (at most `n`). */
export function focusOf(items, n = 3) {
  const score = (i) => (i.section === "overdue" ? 0 : i.section === "doing" ? 1 : i.section === "scheduled" ? 2 : i.section === "today" ? 3 : 9) * 10 + (RANK[i.priority] ?? 2);
  return items.filter((i) => ["overdue", "doing", "scheduled", "today"].includes(i.section)).sort((a, b) => score(a) - score(b) || byPriorityThenTime(a, b)).slice(0, n);
}

/** Where a task opens: here when it is in the organisation now open; otherwise after switching there. */
export function taskHref(item) {
  return `/tasks/${item.id}`;
}
