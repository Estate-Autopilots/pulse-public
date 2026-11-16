import test from "node:test";
import assert from "node:assert/strict";
import { brandOf, buildDay, focusOf, minutesText, runningToday, sectionOf } from "./my-day.mjs";

const task = (over) => ({ id: over.id ?? over.title, title: "x", status: "open", stage: null, priority: "normal", dueAt: null, dueOn: null, dueTime: null, workOn: null, startsOn: null,
  estimateMinutes: null, projectId: null, projectName: null, projectColor: null, workstream: null, parentId: null, repeats: null, doneAt: null, minutesToday: 0, ...over });
const TODAY = "2026-11-04", WEEK_END = "2026-11-08";

test("each task lands in one part of the day", () => {
  assert.equal(sectionOf(task({ dueOn: "2026-11-02" }), TODAY, WEEK_END), "overdue");
  assert.equal(sectionOf(task({ dueOn: TODAY, dueTime: "18:00" }), TODAY, WEEK_END), "today");
  assert.equal(sectionOf(task({ dueOn: TODAY, dueTime: "11:30" }), TODAY, WEEK_END), "scheduled");
  assert.equal(sectionOf(task({ status: "in_progress", dueOn: "2026-11-01" }), TODAY, WEEK_END), "doing");
  assert.equal(sectionOf(task({ dueOn: "2026-11-07" }), TODAY, WEEK_END), "week");
  assert.equal(sectionOf(task({ startsOn: "2026-11-03", dueOn: "2026-11-06" }), TODAY, WEEK_END), "today");
  assert.equal(sectionOf(task({ status: "blocked", stage: "waiting" }), TODAY, WEEK_END), "waiting");
  assert.equal(sectionOf(task({ priority: "urgent" }), TODAY, WEEK_END), "priority");
  assert.equal(sectionOf(task({ status: "done", doneAt: "2026-11-04T05:00:00Z" }), TODAY, WEEK_END), "done");
  assert.equal(sectionOf(task({ status: "cancelled" }), TODAY, WEEK_END), null);
  assert.equal(sectionOf(task({ dueOn: "2026-11-20" }), TODAY, WEEK_END), null);
});

test("time reads in minutes and hours", () => {
  assert.equal(minutesText(45), "45 min");
  assert.equal(minutesText(60), "1 h");
  assert.equal(minutesText(150), "2 h 30 min");
  assert.equal(minutesText(-3), "0 min");
});

test("a running clock counts only today's part, at most ten hours", () => {
  const now = Date.parse("2026-11-04T06:30:00Z"); // 12:00 in Kolkata
  assert.equal(runningToday({ startedAt: "2026-11-04T06:00:00Z" }, now, "Asia/Kolkata"), 30);
  assert.equal(runningToday({ startedAt: "2026-11-03T12:00:00Z" }, now, "Asia/Kolkata"), 600);
  assert.equal(runningToday({ startedAt: "2026-11-04T06:00:00Z" }, Date.parse("2026-11-04T05:00:00Z"), "UTC"), 0);
  assert.equal(runningToday(null, now, "UTC"), 0);
});

const seat = (org, name, over = {}) => ({ org, name, handle: null, kind: "staff", current: false, ok: true, today: TODAY, weekStart: "2026-11-02", timeZone: "UTC", accent: null,
  tasks: [], timer: null, timeToday: [], timeWeek: [], targets: { dailyMinutes: null, weeklyMinutes: null, own: false, tasksPerWeek: null, unit: null },
  counts: { minutesWeek: 0, doneToday: 0, doneWeek: 0, undated: 0 }, ...over });

test("one day across companies: sections, attention, planned against actual, targets", () => {
  const now = Date.parse("2026-11-04T10:00:00Z");
  const data = { generatedAt: "", more: 0, seats: [
    seat("a", "Sakobe Studio", { current: true, tasks: [
      task({ id: "a1", title: "Edit podcast", dueOn: TODAY, priority: "high", estimateMinutes: 90, workstream: "Podcast" }),
      task({ id: "a2", title: "Reel for client", dueOn: TODAY, estimateMinutes: 60, projectName: "Client X" }),
    ], timeToday: [{ projectId: "p", projectName: "Client X", workstream: null, color: null, minutes: 30 }], targets: { dailyMinutes: 120, weeklyMinutes: null, own: true, tasksPerWeek: null, unit: null } }),
    seat("b", "Sales Co", { tasks: [
      task({ id: "b1", title: "Call leads", dueOn: "2026-11-03", priority: "urgent", estimateMinutes: 60, workstream: "Sales" }),
      task({ id: "b2", title: "Demo", dueOn: TODAY, dueTime: "15:00", estimateMinutes: 30, workstream: "Sales" }),
      task({ id: "b3", title: "Send proposal", status: "in_progress", estimateMinutes: 45, workstream: "Sales" }),
    ], timer: { taskId: "b3", title: "Send proposal", startedAt: "2026-11-04T09:30:00Z", projectId: null, workstream: "Sales" },
      targets: { dailyMinutes: 240, weeklyMinutes: 1200, own: false, tasksPerWeek: 10, unit: "calls" }, counts: { minutesWeek: 300, doneToday: 0, doneWeek: 4, undated: 2 } }),
    seat("c", "Atlas Crest", { ok: false }),
  ] };
  const day = buildDay(data, now);
  assert.deepEqual(day.sections.map((s) => s.key), ["doing", "overdue", "scheduled", "today"]);
  assert.deepEqual(day.sections.find((s) => s.key === "today").items.map((i) => i.id), ["a1", "a2"]);
  assert.equal(day.sections.find((s) => s.key === "overdue").items[0].orgName, "Sales Co");
  // Sales Co has an overdue urgent call: it needs attention first; the unreadable seat comes last.
  assert.deepEqual(day.companies.map((c) => c.org), ["b", "a", "c"]);
  const b = day.companies[0], a = day.companies[1];
  assert.equal(b.planned, 135); assert.equal(b.actual, 30); assert.equal(b.running, 30);
  assert.deepEqual(b.targets.day, { target: 240, actual: 30, met: false });
  assert.deepEqual(b.targets.week, { target: 1200, actual: 330, met: false });
  assert.deepEqual(b.targets.tasks, { target: 10, actual: 4, met: false, unit: "calls" });
  assert.equal(a.planned, 150); assert.equal(a.actual, 30); assert.equal(a.targets.day.met, false);
  assert.equal(day.timer.org, "b"); assert.equal(day.timer.minutes, 30);
  assert.equal(day.totals.planned, 285); assert.equal(day.totals.actual, 60); assert.equal(day.totals.overdue, 1);
  // Time by company and workstream: Sales 135 planned, 30 running; Podcast 90 planned; Client X 60 planned, 30 spent.
  assert.deepEqual(day.streams.map((s) => [s.orgName, s.stream, s.planned, s.actual]), [
    ["Sales Co", "Sales", 135, 30], ["Sakobe Studio", "Podcast", 90, 0], ["Sakobe Studio", "Client X", 60, 30]]);
  // A filter keeps one company's items and totals.
  const onlyA = buildDay(data, now, ["a"]);
  assert.deepEqual(onlyA.sections.flatMap((s) => s.items.map((i) => i.org)), ["a", "a"]);
  assert.equal(onlyA.totals.planned, 150);
  assert.deepEqual(focusOf(day.sections.flatMap((s) => s.items)).map((i) => i.id), ["b1", "b3", "b2"]);
});

const SALES_CO = "Sales Co";
test("a company is marked by its own logo and brand colour, never a colour made up from its name", () => {
  assert.deepEqual(brandOf({ accent: "#7a3db8", mark: "/api/v0/tasks/my-day/mark/a?v=2" }), { color: "#7a3db8", mark: "/api/v0/tasks/my-day/mark/a?v=2" });
  assert.deepEqual(brandOf({ accent: "purple", mark: "https://elsewhere.example/x.svg" }), { color: null, mark: null });
  assert.deepEqual(brandOf({}), { color: null, mark: null });
  const day = buildDay({ generatedAt: "2026-11-04T06:00:00Z", seats: [
    { org: "a", name: "Riverside", ok: true, today: "2026-11-04", accent: "#1f6f5c", mark: "/api/v0/tasks/my-day/mark/a?v=1", tasks: [{ id: "a1", title: "Edit", status: "open", priority: "normal", dueOn: "2026-11-04" }] },
    { org: "b", name: SALES_CO, ok: false, mark: null },
  ] }, Date.parse("2026-11-04T06:00:00Z"));
  const item = day.sections.flatMap((s) => s.items)[0];
  assert.equal(item.mark, "/api/v0/tasks/my-day/mark/a?v=1"); assert.equal(item.color, "#1f6f5c"); assert.equal("hue" in item, false);
  assert.deepEqual(day.companies.map((c) => [c.org, c.color, c.mark]), [["a", "#1f6f5c", "/api/v0/tasks/my-day/mark/a?v=1"], ["b", null, null]]);
  assert.equal(buildDay(null).sections.length, 0);
});
