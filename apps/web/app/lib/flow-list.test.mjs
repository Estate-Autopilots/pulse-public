// FLOW-D: the vertical flow's rules (flow-list.mjs): rows by depth, side by side, ways of a Decide, insert / beside /
// append / remove / swap keep the order.
import assert from "node:assert/strict";
import test from "node:test";
import { addBeside, appendTo, insertAfter, removeStep, rows, swap, wayOf } from "./flow-list.mjs";

const mod = (key, makes = [{ key: "done", label: "Done", kind: "any" }]) => ({ key, name: key, needs: [{ key: "in", label: "In", kind: "any", many: true }], makes });
const byKey = { checklist: mod("checklist"), decision: mod("decision", [{ key: "yes", label: "Yes", kind: "verdict" }, { key: "no", label: "Otherwise", kind: "verdict" }]),
  start: { key: "start", name: "start", needs: [], makes: [{ key: "client", label: "Client", kind: "contact" }] },
  "block:task": { key: "block:task", name: "Task", icon: "x", needs: [], makes: [] }, "block:decide": { key: "block:decide", name: "Decide", icon: "x", needs: [], makes: [] }, "block:start": { key: "block:start", name: "Start", icon: "x", needs: [], makes: [] } };
const T = (id, stage = null) => ({ id, module: "checklist", block: "task", stage, settings: {} });
const S = (id) => ({ id, module: "start", block: "start", stage: null, settings: {} });
const D = (id) => ({ id, module: "decision", block: "decide", stage: null, settings: {} });
const w = (a, ap, b) => ({ from: { step: a, port: ap }, to: { step: b, port: "in" } });
const ids = (def) => rows(def, byKey).flatMap((g) => g.rows.map((r) => r.map((s) => s.id).join("|")));

test("rows: one under another, side by side when they wait for the same step", () => {
  const def = { stages: [], steps: [S("a"), T("b"), T("c"), T("d")], wires: [w("a", "client", "b"), w("a", "client", "c"), w("b", "done", "d"), w("c", "done", "d")] };
  assert.deepEqual(ids(def), ["a", "b|c", "d"]);
});

test("insert after: the new step comes between a step and what waited for it", () => {
  let def = { stages: [], steps: [S("a"), T("b")], wires: [w("a", "client", "b")] };
  def = insertAfter(def, byKey, "a", T("x"));
  assert.deepEqual(ids(def), ["a", "x", "b"]);
  def = addBeside(def, byKey, "x", T("y"));
  assert.deepEqual(ids(def), ["a", "x|y", "b"]);
  def = removeStep(def, byKey, "x");
  assert.deepEqual(ids(def), ["a", "y", "b"]);
  def = removeStep(def, byKey, "y");
  assert.deepEqual(ids(def), ["a", "b"], "taking a step out keeps the order");
});

test("a Decide: each way has its steps; appending after it waits on either way", () => {
  let def = { stages: [], steps: [S("a"), D("d")], wires: [w("a", "client", "d")] };
  def = insertAfter(def, byKey, "d", T("y"), "yes");
  def = insertAfter(def, byKey, "d", T("n"), "no");
  assert.equal(wayOf(def, byKey, "y").label, "Yes"); assert.equal(wayOf(def, byKey, "n").label, "Otherwise");
  def = appendTo(def, byKey, null, T("z"));
  assert.deepEqual(ids(def), ["a", "d", "y|n", "z"]);
  assert.ok(def.wires.some((x) => x.from.step === "y" && x.to.step === "z") && def.wires.some((x) => x.from.step === "n" && x.to.step === "z"));
});

test("append to a stage: after its last steps; the next stage waits for the new step", () => {
  let def = { stages: [{ key: "s1", label: "One" }, { key: "s2", label: "Two" }], steps: [T("a", "s1"), T("b", "s2")], wires: [w("a", "done", "b")] };
  def = appendTo(def, byKey, "s1", T("x"));
  assert.deepEqual(rows(def, byKey).map((g) => g.rows.map((r) => r.map((s) => s.id).join("|"))), [["a", "x"], ["b"]]);
  assert.ok(def.wires.some((x) => x.from.step === "x" && x.to.step === "b") && !def.wires.some((x) => x.from.step === "a" && x.to.step === "b"));
});

test("swap: a step moves up past the one before it", () => {
  let def = { stages: [], steps: [S("s"), T("a"), T("b"), T("c")], wires: [w("s", "client", "a"), w("a", "done", "b"), w("b", "done", "c")] };
  def = swap(def, byKey, "b", "up");
  assert.deepEqual(ids(def), ["s", "b", "a", "c"]);
  def = swap(def, byKey, "b", "down");
  assert.deepEqual(ids(def), ["s", "a", "b", "c"]);
});
