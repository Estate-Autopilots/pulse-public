import test from "node:test";
import assert from "node:assert/strict";
import { busyMinutes, calEvent, companyHours, countByKind, dayWords, hoursWords, inRange, lastDayToEnd, movedStart, shown, startView, statusTone, timeOf, wallClock, weekOf } from "./calendar.mjs";

test("FIX-PR-CALENDAR: an item is cleaned, kept to wall-clock text and given a stable id per source and kind", () => {
  const e = calEvent({ id: "p1", kind: "post", title: "  Why deals   die ", start: "2026-11-10T12:30:00", href: "/pr?post=p1", thumb: "/api/v0/pr/flow/files/x", editable: true });
  assert.deepEqual(e, { id: "pulse:post:p1", kind: "post", source: "pulse", title: "Why deals die", start: "2026-11-10T12:30", allDay: false, href: "/pr?post=p1", thumb: "/api/v0/pr/flow/files/x", editable: true });
  // A day alone is all day; the end is the last day, kept only when it is not before the start.
  assert.equal(calEvent({ kind: "leave", title: "Example leave", start: "2026-11-11", end: "2026-11-13" }).end, "2026-11-13");
  assert.equal(calEvent({ kind: "leave", title: "Example leave", start: "2026-11-11", end: "2026-11-09" }).end, undefined);
  // Nothing to draw: no title, a bad date; an unknown kind is "event", an unknown source is Pulse.
  assert.equal(calEvent({ title: "", start: "2026-11-10" }), null);
  assert.equal(calEvent({ title: "x", start: "10/11/2026" }), null);
  assert.equal(calEvent({ title: "x", start: "2026-02-30" }), null);
  assert.equal(calEvent({ kind: "party", title: "x", start: "2026-11-10" }).kind, "event");
  // Outside items with no two-way sync (Microsoft, LinkedIn) never move by dragging, and only same-site links and Pulse's own pictures are kept.
  const g = calEvent({ source: "microsoft", kind: "meeting", title: "Example call", start: "2026-11-10T09:00", editable: true, href: "https://evil.example/x", thumb: "https://evil.example/p.png" });
  assert.equal(g.editable, false);
  assert.equal(g.href, undefined);
  assert.equal(g.thumb, undefined);
  assert.equal(calEvent({ title: "x", start: "2026-11-10", href: "//evil.example" }).href, undefined);
});

test("FIX-PR-CALENDAR: wall-clock text in the company's zone, whatever the machine's zone", () => {
  assert.equal(wallClock("2026-11-10T07:00:00Z", "Asia/Kolkata"), "2026-11-10T12:30");
  assert.equal(wallClock("2026-11-10T23:30:00Z", "Asia/Kolkata"), "2026-11-11T05:00");
  assert.equal(wallClock("2026-11-10T07:00:00Z", "Europe/London"), "2026-11-10T07:00");
  assert.equal(wallClock("not a time", "Asia/Kolkata"), null);
});

test("FIX-PR-CALENDAR: filters, counts, times, drags and the first view", () => {
  const list = [
    { kind: "task", title: "B task", start: "2026-11-12" },
    { kind: "post", title: "A post", start: "2026-11-10T12:30" },
    { kind: "meeting", title: "A meeting", start: "2026-11-10T09:00" },
    { kind: "post", title: "bad", start: "nope" },
  ];
  assert.deepEqual(shown(list).map((e) => e.title), ["A meeting", "A post", "B task"]);
  assert.deepEqual(shown(list, ["post"]).map((e) => e.title), ["A post"]);
  assert.deepEqual(countByKind(list), { meeting: 1, event: 0, task: 1, milestone: 0, post: 1, leave: 0, attendance: 0 });
  assert.equal(timeOf(calEvent(list[1])), "12:30");
  assert.equal(timeOf(calEvent(list[0])), "");
  assert.equal(lastDayToEnd("2026-11-30"), "2026-12-01");
  assert.equal(movedStart(calEvent(list[1]), "2026-11-14"), "2026-11-14T12:30");
  assert.equal(movedStart(calEvent(list[1]), "2026-11-14", "18:00"), "2026-11-14T18:00");
  assert.equal(movedStart(calEvent(list[0]), "2026-11-14", "18:00"), "2026-11-14");
  assert.equal(movedStart(calEvent(list[0]), "14 Nov"), null);
  assert.equal(startView(undefined, true), "list");
  assert.equal(startView(undefined, false), "month");
  assert.equal(startView("week", true), "week");
  assert.equal(startView("year", false), "month");
});

test("FIX-PR-CALENDAR: a day in plain words, the same in every zone", () => {
  assert.equal(dayWords("2026-11-13"), "Fri 13 Nov");
  assert.equal(dayWords("2026-11-13T15:00"), "Fri 13 Nov");
  assert.equal(dayWords("2026-02-30"), "");
});

test("FIX-PR-CALENDAR: a status waits (amber) or is settled (green)", () => {
  for (const w of ["Review", "Waiting for an OK", "Late"]) assert.equal(statusTone(w), "warn", w);
  for (const w of ["Approved", "Scheduled", "Done"]) assert.equal(statusTone(w), "good", w);
  // Time at work is not a warning (CALENDAR-HUB): "Checked in" / "Checked out" stay neutral.
  for (const w of ["Checked in", "Checked out"]) assert.equal(statusTone(w), "", w);
  assert.equal(statusTone("To do"), "");
  assert.equal(statusTone(undefined), "");
});

test("FIX-PR-CALENDAR: counts follow the days a view shows", () => {
  assert.equal(inRange({ title: "x", start: "2026-11-10T09:00" }, "2026-11-09", "2026-11-15"), true);
  assert.equal(inRange({ title: "x", start: "2026-11-16" }, "2026-11-09", "2026-11-15"), false);
  assert.equal(inRange({ kind: "leave", title: "x", start: "2026-11-14", end: "2026-11-17" }, "2026-11-16", "2026-11-22"), true);
  assert.equal(inRange({ title: "", start: "2026-11-10" }, "2026-11-09", "2026-11-15"), false);
});

// CALENDAR-HUB: which company takes which day and hours.
test("busyMinutes counts overlaps once and keeps to the day", () => {
  const items = [
    { kind: "attendance", title: "At work", start: "2026-11-13T09:00", end: "2026-11-13T17:00" },
    { kind: "meeting", title: "Inside work", start: "2026-11-13T10:00", end: "2026-11-13T11:00" },
    { kind: "event", title: "Evening", start: "2026-11-13T19:00", end: "2026-11-14T01:00" },
    { kind: "task", title: "Due, no end", start: "2026-11-13T18:00" },
    { kind: "leave", title: "All day", start: "2026-11-13", allDay: true },
  ];
  assert.equal(busyMinutes(items, "2026-11-13"), 8 * 60 + 30 + 5 * 60);
  assert.equal(busyMinutes(items, "2026-11-14"), 60);
  assert.equal(busyMinutes(items, "bad"), 0);
});
test("companyHours sums each company and gives each its own colour", () => {
  const days = weekOf("2026-11-13");
  assert.deepEqual(days, ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
  const r = companyHours([
    { org: "a", name: "A", accent: "#0d9488", items: [{ kind: "meeting", title: "m", start: "2026-11-09T10:00", end: "2026-11-09T12:00" }] },
    { org: "b", name: "B", accent: "#0D9488", items: [{ kind: "event", title: "e", start: "2026-11-15T09:00", end: "2026-11-15T09:30" }] },
    { org: "c", name: "C", items: [] },
  ], days);
  assert.deepEqual(r.rows.map((x) => [x.name, x.minutes, x.color]), [["A", 120, "#0D9488"], ["B", 30, "#6B4CF0"], ["C", 0, "#D97706"]]);
  assert.equal(r.total, 150);
  assert.equal(r.rows[0].byDay["2026-11-09"], 120);
});
test("hoursWords says hours in plain words", () => {
  assert.deepEqual([0, 2, 45, 60, 90, 125, 170, 600, 1908].map(hoursWords), ["0h", "0h", "45m", "1h", "1h 30m", "2h 5m", "2h 50m", "10h", "31h 50m"]);
});
test("a Google event the API marks editable can be dragged; a LinkedIn one cannot", () => {
  assert.equal(calEvent({ kind: "event", source: "google", title: "g", start: "2026-11-13T10:00", editable: true }).editable, true);
  assert.equal(calEvent({ kind: "event", source: "linkedin", title: "l", start: "2026-11-13T10:00", editable: true }).editable, false);
});
