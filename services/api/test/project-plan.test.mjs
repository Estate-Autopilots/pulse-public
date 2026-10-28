import assert from "node:assert/strict";
import test from "node:test";
import { bandwidth, creatives, planState } from "../dist/project-plan.js";

const T = {
  key: "t", name: "Plan", stages: [0, 1, 2, 3, 4, 5].map((n) => ({ n, key: `s${n}`, label: `Stage ${n}` })),
  packages: [{ key: "a", label: "A" }], categories: [{ key: "big", label: "Big", units: 1 }, { key: "small", label: "Small", units: 0.4 }],
  bandwidth: { role: "Lead", short: "L", healthy: [6, 7], max: 8 }, milestones: { adsLive: "L1", foundation: "F1", script: "S1" },
  creativeColumns: ["Script", "Making", "Review", "Ready", "Live"],
  steps: [
    { id: "G1", stage: 0, title: "G1 Handover: done", kind: "gate", start: 0, end: 0, owner: "Lead", clientInput: false, packages: { a: "yes" } },
    { id: "S1", stage: 2, title: "Scripts", kind: "task", start: 1, end: 4, owner: "Writer", clientInput: true, packages: { a: "yes" } },
    { id: "V1", stage: 2, title: "Video", kind: "task", start: 2, end: 8, owner: "Video", clientInput: false, packages: { a: "yes" }, asset: "MV" },
    { id: "L1", stage: 4, title: "Live", kind: "milestone", start: 10, end: 12, owner: "Ads", clientInput: false, packages: { a: "yes" } },
    { id: "F1", stage: 5, title: "Foundation", kind: "milestone", start: 30, end: 30, owner: "Lead", clientInput: false, packages: { a: "yes" } },
  ],
};
const plan = { templateKey: "t", package: "a", category: "big", kickoff: "2026-10-01" };
const task = (id, step, phase, status, due, extra = {}) => ({ id, title: `${step} x`, step, phase, status, due, start: null, doneOn: null, who: null, whoId: null, role: null, source: "template", ...extra });

test("the stage is the first one with open dated work; days in stage count from the last finished earlier step", () => {
  const tasks = [task("1", "G1", "s0", "done", "2026-10-01", { doneOn: "2026-10-02" }), task("2", "S1", "s2", "open", "2026-10-05"), task("3", "V1", "s2", "open", "2026-10-09"),
    task("4", "L1", "s4", "open", "2026-10-13"), task("5", "F1", "s5", "open", "2026-10-31")];
  const s = planState(T, plan, tasks, "2026-10-10");
  assert.equal(s.stage, 2); assert.equal(s.stageLabel, "Stage 2"); assert.equal(s.daysInStage, 8); assert.equal(s.dayN, 9);
  assert.equal(s.progress, 20); assert.equal(s.next.step, "S1"); assert.equal(s.next.late, true);
  assert.equal(s.adsLiveOn, null); assert.equal(s.adsPlanned, "2026-10-13");
  assert.equal(s.gates[0].done, true); assert.equal(s.gates[0].short, "G1 Handover");
});

test("the foundation check is at risk when ads are not live and it is close; a stuck gate is one open 3+ days past due", () => {
  const tasks = [task("1", "G1", "s0", "open", "2026-10-01"), task("4", "L1", "s4", "open", "2026-10-13"), task("5", "F1", "s5", "open", "2026-10-31")];
  const s = planState(T, plan, tasks, "2026-10-25");
  assert.equal(s.foundationLeft, 6); assert.equal(s.foundationRisk, true); assert.equal(s.stuckGate, true);
});

test("bandwidth reads healthy, at the maximum and over; creatives get asset codes and columns", () => {
  assert.deepEqual(bandwidth(T, 6.4), { units: 6.4, state: "healthy" });
  assert.equal(bandwidth(T, 7.6).state, "max"); assert.equal(bandwidth(T, 8.2).state, "over"); assert.equal(bandwidth(T, 2).state, "room");
  const c = creatives(T, [task("2", "S1", "s2", "done", null), task("3", "V1", "s2", "in_review", null), task("6", "V1", "s2", "open", null)], false);
  assert.deepEqual(c.map((x) => [x.code, x.column]), [["MV-01", "Review"], ["MV-02", "Making"]]);
});
