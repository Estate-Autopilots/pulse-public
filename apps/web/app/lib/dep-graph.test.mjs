import test from "node:test";
import assert from "node:assert/strict";
import { criticalPath, downstream, focusSet, readyNow, upstream, waitingCounts } from "./dep-graph.mjs";

// A synthetic chain: register -> tax id -> bank -> store account; tax id -> sales tax; a side task that is done.
const n = (key, state, minutes) => ({ key, state, minutes });
const nodes = [n("task:a", "active", 120), n("task:b", "open"), n("task:c", "open"), n("goal:d", "open"), n("project:e", "open", 600), n("task:f", "done")];
const edges = [
  { id: "1", from: "task:a", to: "task:b" }, { id: "2", from: "task:b", to: "task:c" }, { id: "3", from: "task:c", to: "goal:d" },
  { id: "4", from: "task:b", to: "project:e" }, { id: "5", from: "task:f", to: "task:a", done: true },
];

test("upstream and downstream follow the chain both ways", () => {
  assert.deepEqual([...upstream(edges, "goal:d")].sort(), ["task:a", "task:b", "task:c", "task:f"]);
  assert.deepEqual([...downstream(edges, "task:b")].sort(), ["goal:d", "project:e", "task:c"]);
  assert.deepEqual([...focusSet(edges, "task:c", "up")].sort(), ["task:a", "task:b", "task:c", "task:f"]);
  assert.deepEqual([...focusSet(edges, "task:c", "both")].sort(), ["goal:d", "task:a", "task:b", "task:c", "task:f"]);
});

test("the critical path is the heaviest chain of unfinished work", () => {
  const cp = criticalPath(nodes, edges);
  // a(120) + b(60) + e(600) outweighs a + b + c + d (300).
  assert.deepEqual(cp.nodes, ["task:a", "task:b", "project:e"]);
  assert.deepEqual(cp.edges, ["1", "4"]);
});

test("finished work is not on the critical path, and a lone task makes none", () => {
  assert.deepEqual(criticalPath([n("task:x", "done"), n("task:y", "open")], [{ id: "9", from: "task:x", to: "task:y", done: true }]), { nodes: [], edges: [] });
});

test("ready now and waiting counts ignore finished links", () => {
  assert.deepEqual(readyNow(nodes, edges), []);
  assert.deepEqual(readyNow([n("task:p", "open"), n("task:q", "open")], [{ id: "1", from: "task:p", to: "task:q" }]), ["task:p"]);
  assert.equal(waitingCounts(edges).get("task:a"), undefined);
  assert.equal(waitingCounts(edges).get("task:c"), 1);
});
