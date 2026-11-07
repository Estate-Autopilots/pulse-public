import assert from "node:assert/strict";
import test from "node:test";
import { addDays, bestTime, captionToCopy, dayTitle, dow, linesOf, monthGrid, nextAction, nextStage, num, range, rhythm, rowsOf, step, tagsIn, weekDays, weekStart, weekTitle } from "./pr-flow.mjs";

test("days, weeks and month pages are plain strings, Monday first", () => {
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(dow("2026-11-10"), 2);
  assert.equal(dow("2026-11-15"), 7);
  assert.equal(weekStart("2026-11-15"), "2026-11-09");
  assert.deepEqual(weekDays("2026-11-12").slice(0, 2), ["2026-11-09", "2026-11-10"]);
  const g = monthGrid("2026-11-20");
  assert.equal(g[0], "2026-10-26");
  assert.equal(g.length % 7, 0);
  assert.ok(g.includes("2026-11-30"));
  assert.equal(dayTitle("2026-11-10"), "Tue 10 Nov");
  assert.equal(weekTitle("2026-12-02"), "30 Nov – 6 Dec 2026");
  assert.deepEqual(range("week", "2026-11-12"), { from: "2026-11-09", to: "2026-11-15" });
  assert.equal(step("month", "2026-12-15", 1), "2027-01-01");
  assert.equal(step("day", "2026-12-31", 1), "2027-01-01");
});

test("the board's next step names one action, and an OK blocks posting", () => {
  assert.equal(nextStage("review"), "approved");
  assert.equal(nextStage("measured"), null);
  assert.deepEqual(nextAction({ stage: "scheduled" }, false), { to: "posted", label: "Mark posted" });
  assert.deepEqual(nextAction({ stage: "scheduled" }, true), { to: null, label: "Get their OK first" });
  assert.equal(nextAction({ stage: "posted" }, false).label, "Log the numbers");
});

test("the strategy's rhythm says what to post where on a day", () => {
  const channels = [{ key: "linkedin", days: [2, 4], times: ["08:30", "12:30"] }, { key: "whatsapp_status", days: [4], times: ["20:30"] }];
  assert.deepEqual(rhythm(channels, "2026-11-12"), [{ channel: "linkedin", time: "08:30" }, { channel: "whatsapp_status", time: "20:30" }]);
  assert.deepEqual(rhythm(channels, "2026-11-14"), []);
  assert.equal(bestTime(channels, "linkedin"), "08:30");
  assert.equal(bestTime(channels, "x"), null);
});

test("captions copy with their hashtags once", () => {
  assert.equal(captionToCopy("Hello #Example", ["#Example", "#Synthetic"]), "Hello #Example\n\n#Synthetic");
  assert.deepEqual(tagsIn("a #One and #Two, #One"), ["#One", "#Two"]);
  assert.equal(num(1234567), "1,234,567");
});

test("strategy lines round-trip", () => {
  const rows = [{ name: "Build log", about: "Real numbers — real receipts" }, { name: "Lessons", about: "" }];
  const text = linesOf(rows, ["name", "about"]);
  assert.deepEqual(rowsOf(text, ["name", "about"]), [{ name: "Build log", about: "Real numbers — real receipts" }, { name: "Lessons", about: "" }]);
});
