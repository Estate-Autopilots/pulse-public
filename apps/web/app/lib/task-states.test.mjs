import test from "node:test";
import assert from "node:assert/strict";
import { TASK_STATES, isClosed, isDone, isSetAside, milestone, progressOf, stateOf, streakOf } from "./task-states.mjs";

test("Not applicable is closed but never done", () => {
  assert.equal(isClosed("not_applicable"), true);
  assert.equal(isDone("not_applicable"), false);
  assert.equal(isSetAside("not_applicable"), true);
  assert.equal(stateOf("not_applicable").label, "Not applicable");
  for (const s of ["done", "accepted", "in_review"]) assert.equal(isDone(s), true, s);
  for (const s of ["open", "in_progress", "blocked", "unknown"]) assert.equal(isClosed(s), false, s);
  assert.equal(stateOf("something-new"), TASK_STATES.unknown);
});

test("each open and closed state reads differently", () => {
  const labels = ["open", "in_progress", "blocked", "done", "not_applicable", "cancelled"].map((s) => stateOf(s).label);
  assert.equal(new Set(labels).size, labels.length);
});

test("progress leaves Not applicable and Cancelled out of both sides", () => {
  const p = progressOf([{ status: "done" }, { status: "open" }, { status: "not_applicable" }, { status: "cancelled" }, { status: "accepted" }]);
  assert.deepEqual({ done: p.done, total: p.total, setAside: p.setAside, open: p.open }, { done: 2, total: 3, setAside: 2, open: 1 });
  assert.equal(progressOf([{ status: "not_applicable" }]).ratio, 0);
  assert.equal(progressOf([{ status: "done" }, { status: "not_applicable" }]).ratio, 1);
});

test("milestones fire once, on the round number crossed", () => {
  assert.equal(milestone(4, 5), 5);
  assert.equal(milestone(5, 6), null);
  assert.equal(milestone(9, 30), 10);
  assert.equal(milestone(0, 0), null);
  assert.equal(milestone(0.4, 0.5, [0.25, 0.5, 0.75, 1]), 0.5);
});

test("a streak counts back from the latest month; a month without data neither breaks nor extends it", () => {
  assert.equal(streakOf([{ month: "2026-11", hit: null }, { month: "2026-10", hit: true }, { month: "2026-09", hit: true }, { month: "2026-08", hit: false }, { month: "2026-07", hit: true }]), 2);
  assert.equal(streakOf([{ month: "2026-09", hit: true }, { month: "2026-11", hit: true }, { month: "2026-10", hit: true }]), 3);
  assert.equal(streakOf([{ month: "2026-11", hit: false }, { month: "2026-10", hit: true }]), 0);
  assert.equal(streakOf([]), 0);
});
