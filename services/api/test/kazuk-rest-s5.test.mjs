import assert from "node:assert/strict";
import test from "node:test";
import { adminPath, devTask, statusFilter } from "../dist/bug-routing.js";

test("the dev inbox filters by one status, every open one by default, or all", () => {
  assert.equal(statusFilter("fixed"), "fixed");
  assert.equal(statusFilter("all"), "all");
  assert.equal(statusFilter(undefined), "open");
  assert.equal(statusFilter("'; drop table"), "open");
});

test("the dev team's task carries only what was routed, and the way back to the original", () => {
  const org = "0f4c2d6e-aaaa-4bbb-8ccc-000000000001", rep = "0f4c2d6e-aaaa-4bbb-8ccc-000000000002";
  const t = devTask({ sourceOrgName: "Synthetic Co", sourceNumber: 7, title: "Bug on /tasks/:id", route: "/tasks/:id", severity: null, blocksWork: true,
    sourceOrg: org, sourceReport: rep, platform: "android", browser: null, errorCount: 2, callCount: 1 });
  assert.equal(t.title, "Synthetic Co bug #7: Bug on /tasks/:id");
  assert.equal(t.priority, "high", "stopping someone's work is urgent");
  assert.match(t.notes, /stopped their work/);
  assert.match(t.notes, /android · 2 errors · 1 failed calls/);
  assert.ok(t.notes.includes(adminPath(org, rep)));
  assert.equal(adminPath(org, rep), `/bugs/${org}/${rep}`);
  assert.equal(devTask({ sourceOrgName: "S", sourceNumber: 1, title: "x".repeat(300), route: "/", severity: "low", blocksWork: false, sourceOrg: org, sourceReport: rep,
    platform: "web", browser: "Chrome 141", errorCount: 0, callCount: 0 }).title.length, 200);
});
