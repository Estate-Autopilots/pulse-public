import { test } from "node:test";
import assert from "node:assert/strict";
import { dayDone, levelOf, levelSpan, rupees, streakOf, trendOf, trendText } from "./game.mjs";

test("levels grow a little longer each time and report progress into the level", () => {
  assert.equal(levelSpan(1), 100); assert.equal(levelSpan(2), 150);
  assert.deepEqual(levelOf(0), { level: 1, into: 0, span: 100, toNext: 100, pct: 0 });
  assert.equal(levelOf(99).level, 1);
  assert.equal(levelOf(100).level, 2);
  assert.deepEqual(levelOf(320), { level: 3, into: 70, span: 200, toNext: 130, pct: 0.35 });
  assert.equal(levelOf(-5).level, 1); assert.equal(levelOf(Number.NaN).level, 1);
});

test("a streak counts days in a row and is not lost before today ends", () => {
  const today = "2026-11-09";
  assert.deepEqual(streakOf(["2026-11-09", "2026-11-08", "2026-11-07"], today), { days: 3, today: true });
  assert.deepEqual(streakOf(["2026-11-08", "2026-11-07"], today), { days: 2, today: false });
  assert.deepEqual(streakOf(["2026-11-06"], today), { days: 0, today: false });
  assert.deepEqual(streakOf([], today), { days: 0, today: false });
  assert.equal(streakOf(["2026-11-09", "2026-11-09", "2026-11-08"], today).days, 2);
});

test("a work-day streak skips the weekend without breaking", () => {
  // 9 Nov 2026 is a Monday; Friday 6 Nov and Thursday 5 Nov were done.
  assert.equal(streakOf(["2026-11-06", "2026-11-05"], "2026-11-09", { weekends: false }).days, 2);
  assert.equal(streakOf(["2026-11-06", "2026-11-05"], "2026-11-09").days, 0);
});

test("trends say whether the change is good", () => {
  assert.deepEqual(trendOf(112, 100), { pct: 12, dir: "up", good: true });
  assert.deepEqual(trendOf(80, 100, "down"), { pct: -20, dir: "down", good: true });
  assert.deepEqual(trendOf(5, 0), { pct: null, dir: "up", good: true });
  assert.equal(trendText(trendOf(112, 100)), "+12%"); assert.equal(trendText(trendOf(92, 100)), "−8%"); assert.equal(trendText(trendOf(0, 0)), "Same");
});

test("the day's ring says what is done in plain words", () => {
  assert.deepEqual(dayDone(3, 7), { pct: 3 / 7, words: "3 of 7 done", all: false });
  assert.deepEqual(dayDone(7, 7), { pct: 1, words: "All done today", all: true });
  assert.equal(dayDone(0, 0).words, "Nothing planned yet");
});

test("money reads in lakh and crore", () => {
  assert.equal(rupees(45000), "₹45,000"); assert.equal(rupees(420000), "₹4.2 L"); assert.equal(rupees(11000000), "₹1.1 Cr");
});
