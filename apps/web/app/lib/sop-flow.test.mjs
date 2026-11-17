import { test } from "node:test";
import assert from "node:assert/strict";
import { flowEdges, flowSummary, hoursText, layoutFlow } from "./sop-flow.mjs";

const steps = [
  { id: "a", title: "Handover", role: "PGS", phase: "Phase 1" },
  { id: "b", title: "Research meeting", role: "Creative Strategist", phase: "Phase 1" },
  { id: "c", title: "Brand alignment", role: "Graphic Designer", phase: "Phase 1" },
  { id: "d", title: "Client review", role: "PGS", kind: "approval", phase: "Phase 2", next: [{ to: "e", label: "Approved" }, { to: "c", label: "Send back" }] },
  { id: "e", title: "Launch", role: "PGS", phase: "Phase 2" },
];

test("steps go on to the next one unless they say where; an end step stops", () => {
  assert.deepEqual(flowEdges(steps).map((e) => `${e.from}>${e.to}`), ["a>b", "b>c", "c>d", "d>e", "d>c"]);
  assert.deepEqual(flowEdges([{ id: "x", title: "x", kind: "end" }, { id: "y", title: "y" }]), []);
  assert.deepEqual(flowEdges([{ id: "x", title: "x", next: [{ to: "x" }, { to: "gone" }] }]), [], "no loops on itself, no missing steps");
});

test("lanes follow the roles in order; columns follow the flow; phases do not overlap", () => {
  const L = layoutFlow(steps);
  assert.deepEqual(L.lanes.map((l) => l.label), ["PGS", "Creative Strategist", "Graphic Designer"]);
  const col = Object.fromEntries(L.nodes.map((n) => [n.id, n.col]));
  assert.deepEqual(col, { a: 0, b: 1, c: 2, d: 3, e: 4 });
  const p1 = L.phases.find((p) => p.label === "Phase 1"), p2 = L.phases.find((p) => p.label === "Phase 2");
  assert.ok(p1.x1 < p2.x0, "phase 2 starts right of phase 1");
  const same = L.nodes.filter((n) => n.lane === "r:pgs").map((n) => n.y);
  assert.equal(new Set(same).size, 1, "one PGS row");
});

test("a change of lane is a handoff; going back is a loop over the top", () => {
  const L = layoutFlow(steps);
  const by = Object.fromEntries(L.edges.map((e) => [`${e.from}>${e.to}`, e]));
  assert.equal(by["a>b"].handoff, true);
  assert.equal(by["d>e"].handoff, false);
  assert.equal(by["d>c"].back, true);
  assert.equal(by["d>c"].label, "Send back");
  assert.match(by["d>c"].d, /^M[\d.]+ [\d.]+V/, "starts by going up");
  assert.ok(L.width > 0 && L.height > 0);
});

test("two steps in one lane and column stack; branches sit in the next column", () => {
  const L = layoutFlow([{ id: "a", title: "Check", role: "PM", kind: "decision", next: [{ to: "b", label: "Yes" }, { to: "c", label: "No" }] }, { id: "b", title: "Do", role: "PM", next: [] }, { id: "c", title: "Fix", role: "PM", next: [] }]);
  const b = L.nodes.find((n) => n.id === "b"), c = L.nodes.find((n) => n.id === "c");
  assert.equal(b.col, 1); assert.equal(c.col, 1, "both branches right after the decision");
  assert.notEqual(b.y, c.y, "stacked, not on top of each other");
  assert.ok(L.lanes[0].h > 120, "the lane grew for two rows");
});

test("summary and hours in words", () => {
  assert.equal(flowSummary(steps), "5 steps · 3 roles · 4 handoffs · 1 check");
  assert.equal(flowSummary([{ id: "a", title: "x" }]), "1 step");
  assert.equal(hoursText(0.5), "30 min"); assert.equal(hoursText(2), "2 h"); assert.equal(hoursText(36), "1.5 d"); assert.equal(hoursText(48), "2 d"); assert.equal(hoursText(null), null);
});
