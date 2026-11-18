import { test } from "node:test";
import assert from "node:assert/strict";
import { projectFacts, shortDay } from "./sold-projects.mjs";

test("a sold project reads as how far it is, its status and when it renews", () => {
  const p = { id: "p", name: "Test Realty growth", client: "Test Realty", clientId: null, status: "active", pgs: "Synthetic PGS", category: null, renewalOn: "2026-12-09",
    tasks: { total: 8, done: 2, overdue: 1 }, next: { title: "Ads live", dueOn: "2026-11-12" }, clientGroup: true };
  const f = projectFacts(p, "2026-11-09");
  assert.equal(f.percent, 25);
  assert.equal(f.status, "Running");
  assert.equal(f.renewal, "9 Dec (in 30 days)");
  assert.equal(f.nextDue, "12 Nov");
  assert.equal(projectFacts({ ...p, tasks: { total: 0, done: 0, overdue: 0 }, renewalOn: null, status: "onboarding" }, "2026-11-09").percent, 0);
  assert.equal(shortDay("2026-11-09T18:00:00Z"), "9 Nov");
});
