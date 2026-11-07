// BUGKIT-TELEMETRY: the friction detectors, the prompt's limits, the picker's element description and replay masking.
import assert from "node:assert/strict";
import test from "node:test";
import { backLoopDetector, componentOf, describeElement, privateScreen, promptGate, rageDetector, replayText, stableSelector } from "./friction.mjs";

test("a rage click is three clicks within a second on the same spot, once per burst", () => {
  const rage = rageDetector();
  assert.equal(rage(100, 100, 0), 0);
  assert.equal(rage(102, 101, 200), 0);
  assert.equal(rage(101, 99, 400), 3);
  assert.equal(rage(100, 100, 500), 0, "the same burst fires once");
  const calm = rageDetector();
  assert.equal(calm(10, 10, 0) + calm(10, 10, 700) + calm(10, 10, 1500), 0, "slower than a second is not rage");
  const spread = rageDetector();
  assert.equal(spread(0, 0, 0) + spread(200, 0, 100) + spread(400, 0, 200), 0, "different spots are not rage");
});

test("going back three times within 20 s is a back-and-forth", () => {
  const back = backLoopDetector();
  assert.equal(back(0), false); assert.equal(back(5000), false); assert.equal(back(9000), true);
  assert.equal(back(10_000), false, "it starts counting again");
  const slow = backLoopDetector();
  assert.equal(slow(0) || slow(15_000) || slow(30_000), false);
});

test("the soft prompt shows at most once every 10 minutes, 3 times a day, and not for 2 hours after Not now", () => {
  const box = new Map();
  const store = { get: (k) => box.get(k) ?? null, set: (k, v) => box.set(k, v) };
  const gate = promptGate(store);
  const t0 = 1_000_000_000;
  assert.equal(gate.may(t0), true);
  gate.shown(t0);
  assert.equal(gate.may(t0 + 5 * 60_000), false);
  assert.equal(gate.may(t0 + 11 * 60_000), true);
  gate.shown(t0 + 11 * 60_000); gate.shown(t0 + 22 * 60_000);
  assert.equal(gate.may(t0 + 40 * 60_000), false, "three a day");
  assert.equal(gate.may(t0 + 25 * 3600_000), true, "a new day");
  gate.dismissed(t0 + 25 * 3600_000);
  assert.equal(gate.may(t0 + 26 * 3600_000), false);
  assert.equal(gate.may(t0 + 28 * 3600_000), true);
  const broken = promptGate({ get: () => "{not json", set: () => {} });
  assert.equal(broken.may(t0), true, "unreadable storage never blocks or throws");
});

// A tiny element tree, enough for the picker's description.
function el(tag, attrs = {}, children = [], text = "") {
  const node = { tagName: tag.toUpperCase(), attrs, children, parentElement: null, textContent: text,
    getAttribute: (n) => (n in attrs ? attrs[n] : null), childElementCount: children.length,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 120, height: 32 }),
    closest(sel) { for (let n = this; n; n = n.parentElement) { if (sel.split(",").some((s) => s.includes("data-private") ? "data-private" in n.attrs : s.includes("data-redact") ? "data-redact" in n.attrs : false)) return n; } return null; } };
  for (const c of children) c.parentElement = node;
  return node;
}

test("a picked element gets a selector that finds it again, a label, a box, never a typed value", () => {
  const save = el("button", { class: "ui-module__x1Y__btn" }, [], "Save");
  const other = el("button", {}, [], "Cancel");
  const form = el("form", { "data-testid": "leave-form" }, [other, save]);
  el("main", {}, [form]);
  assert.equal(stableSelector(save), '[data-testid="leave-form"] > button.btn:nth-of-type(2)');
  const d = describeElement(save, { innerWidth: 1440, innerHeight: 900, scrollY: 0, location: { href: "http://pulse.invalid/leave" } });
  assert.equal(d.label, "Save");
  assert.deepEqual(d.box, { x: 10, y: 20, w: 120, h: 32 });
  assert.equal(d.vw, 1440);
  const field = el("input", { name: "reason", value: "my secret words", placeholder: "Why" });
  el("form", { id: "leaveForm" }, [field]);
  const f = describeElement(field, { innerWidth: 390, innerHeight: 800, scrollY: 0, location: { href: "http://pulse.invalid/" } });
  assert.equal(f.label, "reason");
  assert.doesNotMatch(JSON.stringify(f), /secret words/);
  const salary = el("span", {}, [], "Rs 85,000");
  el("div", { "data-private": "" }, [salary]);
  assert.doesNotMatch(JSON.stringify(describeElement(salary, { innerWidth: 1, innerHeight: 1, scrollY: 0, location: { href: "http://pulse.invalid/" } })), /85,000/);
});

test("the component name comes from React's fiber when it survived the build", () => {
  const node = el("button");
  node.__reactFiber$abc = { type: "button", return: { type: function LeaveForm() {}, return: null } };
  assert.equal(componentOf(node), "LeaveForm");
  const minified = el("button");
  minified.__reactFiber$x = { type: "button", return: { type: function a() {}, return: null } };
  assert.equal(componentOf(minified), null);
});

test("replays hide every word on money and personal screens, and contact details everywhere", () => {
  assert.equal(privateScreen("https://pulse.example/finance/payables"), true);
  assert.equal(privateScreen("/people/3f2a?tab=overview"), true);
  assert.equal(privateScreen("/hr?tab=payroll"), true);
  assert.equal(privateScreen("/tasks"), false);
  assert.equal(replayText("Asha Vivim owes 12", { screenPrivate: true }), "**** ***** **** **");
  assert.equal(replayText("Salary", { inPrivate: true }), "******");
  assert.equal(replayText("Write to someone@example.test or +1 555 010 0199"), "Write to ******************** or +* *** *** ****");
  assert.equal(replayText("Total ₹1,25,000 due"), "Total ₹*,**,*** due");
  assert.equal(replayText("Open tasks"), "Open tasks");
});
