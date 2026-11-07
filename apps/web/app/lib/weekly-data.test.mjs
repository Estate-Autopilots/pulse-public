import assert from "node:assert/strict";
import test from "node:test";
import { formatWeek, formatWeekDate, getLeadershipPods, getLatestLeadershipWeek, getPod, getRecentDeliveries, latestWeek } from "./weekly-data.mjs";

test("latest week is selected from weeks that have delivery data", () => {
  assert.equal(latestWeek(["2026-W40", "2026-W41", null]), "2026-W41");
  assert.equal(getLatestLeadershipWeek(), "2026-W41");
  assert.equal(formatWeekDate("2026-W41"), "Oct 5, 2026");
  assert.equal(formatWeek("2026-W41"), "Week of Oct 5, 2026");
  assert.equal(latestWeek([]), null);
});

test("pod summaries stay scoped and aggregate only project delivery counts", () => {
  assert.deepEqual(getPod("pod-north").response.projects.map(({ projectName }) => projectName), ["Amber House", "Cedar Court"]);
  assert.equal(getPod("unknown"), null);
  assert.deepEqual(getLeadershipPods().map(({ id, deliveries, current }) => [id, deliveries, current]), [["pod-north", 5, true], ["pod-south", null, false]]);
  assert.ok(getPod("pod-north").response.projects.every((project) => !("byUploaderAccount" in project)));
});

test("recent deliveries use the selected week and disclose no uploader identity in the view model", () => {
  const rows = getRecentDeliveries("2026-W41");
  assert.deepEqual(rows.map(({ fileName }) => fileName), ["amber-house-final-cut.mp4", "amber-house-teaser.mp4"]);
  assert.ok(rows.every(({ projectName, deliveredAt }) => projectName && deliveredAt));
  assert.ok(rows.every((row) => !("uploaderAccount" in row)));
});
