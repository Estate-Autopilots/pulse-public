import assert from "node:assert/strict";
import test from "node:test";
import { bandAt, bands, checkWire, convertersFor, dueDays, extent, fitView, layout, newId, NODE, portPoint, stepRuns, wireTo } from "./flow-canvas.mjs";

// FLOW-B: synthetic modules and a small process (no company data).
const M = (key, needs, makes, extra = {}) => ({ key, name: key, icon: "Square", engine: "live", needs: needs.map(([k, kind, more]) => ({ key: k, label: k, kind, ...more })), makes: makes.map(([k, kind]) => ({ key: k, label: k, kind })), ...extra });
const modules = [
  M("lead", [], [["lead", "contact"]]),
  M("meeting", [["who", "contact"]], [["talk", "talk"]]),
  M("transcribe", [["talk", "talk"]], [["doc", "doc"]], { converter: true }),
  M("doc", [["in", "doc", { required: true }]], [["doc", "doc"]]),
  M("review", [["what", "any"]], [["ok", "verdict"]]),
];
const byKey = Object.fromEntries(modules.map((m) => [m.key, m]));
const def = () => ({ stages: [{ key: "a", label: "Start" }, { key: "b", label: "Write" }, { key: "c", label: "Empty" }],
  steps: [{ id: "s1", module: "lead", stage: "a", pos: { x: 0, y: 0 } }, { id: "s2", module: "meeting", stage: "a", pos: { x: 0, y: 0 } }, { id: "s3", module: "doc", stage: "b", pos: { x: 0, y: 0 } },
    { id: "s4", module: "review", stage: "b", pos: { x: 0, y: 0 }, when: [{ field: "package", op: "in", values: ["growth", "sellout"] }] }],
  wires: [{ from: { step: "s1", port: "lead" }, to: { step: "s2", port: "who" } }, { from: { step: "s2", port: "talk" }, to: { step: "s3", port: "in" } }] });

test("a wire fits when the kinds match or either end takes anything; a misfit offers converters", () => {
  const d = def();
  assert.equal(checkWire(d, byKey, modules, d.wires[0]).ok, true);
  const bad = checkWire(d, byKey, modules, d.wires[1]);
  assert.equal(bad.ok, false);
  assert.equal(bad.why, "It makes a talk; this needs a document");
  assert.deepEqual(bad.converters, ["transcribe"]);
  assert.deepEqual(convertersFor(modules, "contact", "talk"), ["meeting"]);
});

test("wiring onto a step picks its first Needs that fits, and refuses a step that needs nothing", () => {
  const d = def();
  assert.deepEqual(wireTo(d, byKey, { step: "s3", port: "doc" }, "s4"), { ok: true, port: "what", fits: true, kind: "doc", need: "any" });
  assert.equal(wireTo(d, byKey, { step: "s2", port: "talk" }, "s1").ok, false);
  assert.equal(wireTo(d, byKey, { step: "s1", port: "lead" }, "s1").ok, false);
  const again = wireTo(d, byKey, { step: "s1", port: "lead" }, "s2");
  assert.equal(again.ok, false);
});

test("piled-up steps are laid out stage by stage, and bands follow their steps", () => {
  const d = layout(def(), byKey);
  const at = Object.fromEntries(d.steps.map((s) => [s.id, s.pos]));
  assert.ok(at.s2.x > at.s1.x, "a step fed by one in its own stage sits to its right");
  assert.ok(at.s3.x > at.s2.x, "the next stage is to the right");
  const list = bands(d, byKey);
  assert.deepEqual(list.map((b) => b.key), ["a", "b", "c"]);
  assert.equal(list[2].steps, 0);
  assert.ok(list[2].x >= list[1].x + list[1].w, "an empty stage keeps a place after the one before");
  assert.equal(bandAt(list, at.s3.x + 10), "b");
  const box = extent(d, byKey, list);
  assert.ok(box.w >= list[2].x + list[2].w - list[0].x);
  const v = fitView(box, { w: 800, h: 600 });
  assert.ok(v.k > 0 && v.k <= 1);
  assert.deepEqual(layout(d, byKey), d, "steps with places keep them");
});

test("ports sit on the card's edges, one row each", () => {
  const s = { id: "x", module: "doc", pos: { x: 100, y: 50 } };
  assert.deepEqual(portPoint(s, byKey.doc, "needs", "in"), { x: 100, y: 50 + NODE.head + NODE.row / 2 });
  assert.equal(portPoint(s, byKey.doc, "makes", "doc").x, 100 + NODE.w);
});

test("a variant switches steps off and picks due days", () => {
  const s4 = def().steps[3];
  assert.equal(stepRuns(s4, { package: "starter" }), false);
  assert.equal(stepRuns(s4, { package: "growth" }), true);
  assert.equal(stepRuns(s4, {}), true, "with no variant chosen every step shows");
  assert.equal(dueDays({ days: { starter: 4, growth: 5, sellout: 6 }, field: "package" }, { package: "growth" }), 5);
  assert.equal(dueDays({ days: 3 }, {}), 3);
  assert.equal(dueDays({ days: { starter: 4 } , field: "package" }, {}), null);
  assert.equal(newId(def()), "s5");
});
