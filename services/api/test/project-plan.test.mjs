import assert from "node:assert/strict";
import test from "node:test";
import { bandwidth, codeMatches, creatives, formula, planState, promiseOf, rolesOf, stepDay, whyNot } from "../dist/project-plan.js";

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

// PM-BUILD-1 (2252): a plan on clocks. Generic words; the shape of a format-3 template.
const C = {
  ...T, format: 3, milestones: { adsLive: "G2" },
  clocks: [{ key: "start", label: "Paid", day: -3 }, { key: "day0", label: "Ready", step: "G1" }, { key: "live", label: "Live", step: "G2" }],
  windows: [{ key: "claim", label: "Claim window", from: "live", start: 30, end: 45 }],
  steps: [
    { id: "I1", stage: 0, title: "Brief received", type: "task", kind: "task", from: "start", start: 0, end: 2, owner: "Lead", clientInput: true, packages: { a: "yes" } },
    { id: "G1", stage: 0, title: "Ready", type: "gate", kind: "gate", from: "start", start: 3, end: 3, owner: "Lead", clientInput: false, packages: { a: "yes" }, after: ["I1"] },
    { id: "M1", stage: 1, title: "Make", type: "task", kind: "task", from: "day0", start: 1, end: 5, owner: "Maker", clientInput: false, packages: { a: "yes" }, after: ["G1"] },
    { id: "S1", stage: 1, title: "Set up the channel", type: "ongoing", kind: "ongoing", from: "day0", start: 4, end: 6, owner: "Lead", clientInput: false, packages: { a: "yes" } },
    { id: "G2", stage: 2, title: "Live", type: "milestone", kind: "milestone", from: "day0", start: 6, end: 8, owner: "Lead", clientInput: false, packages: { a: "yes" }, gateInputs: ["M1", "S1"] },
    { id: "L1", stage: 2, title: "Tell the client", type: "task", kind: "task", from: "live", start: 0, end: 9, owner: "Lead", clientInput: false, packages: { a: "yes" }, after: ["G2"] },
  ],
};

test("before day 0 the day counts from the start on the template's scale; a step on an unrecorded clock says where it sits", () => {
  const p = { ...plan, kickoff: "2026-11-10" };
  const tasks = [task("1", "I1", "s0", "done", "2026-11-12"), task("2", "G1", "s0", "open", "2026-11-13"), task("3", "M1", "s1", "open", null), task("4", "S1", "s1", "open", null), task("5", "G2", "s2", "open", null)];
  const s = planState(C, p, tasks, "2026-11-11");
  assert.equal(s.clocks.dayN, -2); assert.equal(s.clocks.fromDay0, false);
  assert.deepEqual(s.clocks.gates.map((g) => [g.key, g.open, g.on]), [["day0", 0, null], ["live", 2, null]]);
  assert.equal(s.clocks.gates[0].planned, "2026-11-13");
  assert.deepEqual(stepDay(C, p, C.steps[2]), { label: "Day 1 → Day 5", start: null, due: null, from: "day0" });
  assert.deepEqual(stepDay(C, p, C.steps[0]), { label: "Day -3 → Day -1", start: "2026-11-10", due: "2026-11-12", from: "start" });
  assert.equal(stepDay(C, p, C.steps[5]).label, "Live + 0 → + 9");
});

test("running work is never late; going live dates its windows; an ongoing input counts once it runs", () => {
  const p = { ...plan, kickoff: "2026-11-01", day0On: "2026-11-04", day0By: "Asha", liveOn: "2026-11-12", liveBy: "Asha" };
  const tasks = [task("1", "I1", "s0", "done", "2026-11-03"), task("2", "G1", "s0", "done", "2026-11-04"), task("3", "M1", "s1", "done", "2026-11-09"),
    task("4", "S1", "s1", "in_progress", "2026-11-10"), task("5", "G2", "s2", "done", "2026-11-12"), task("6", "L1", "s2", "open", "2026-11-13")];
  const s = planState(C, p, tasks, "2026-11-20");
  assert.equal(s.clocks.dayN, 16); assert.equal(s.clocks.liveDay, 8);
  assert.deepEqual(s.running, ["4"]); assert.equal(s.late, 1);
  assert.deepEqual(s.stages.map((x) => [x.late, x.running]), [[0, 0], [0, 1], [1, 0], [0, 0], [0, 0], [0, 0]]);
  assert.deepEqual(s.clocks.gates[1].inputs.map((x) => [x.id, x.state]), [["M1", "done"], ["S1", "running"]]);
  assert.deepEqual(s.clocks.windows, [{ key: "claim", label: "Claim window", opens: "2026-12-12", closes: "2026-12-27" }]);
  assert.equal(s.adsLiveOn, "2026-11-12");
  assert.equal(s.next.step, "L1");
});

// PM-BUILD-2 (2310): what was bought, by whom, and what we promised.
test("catalogue codes match like the database's LIKE; a step not bought, a condition, nobody in the role", () => {
  assert.equal(codeMatches(["EA-P2-MV-%"], "ea-p2-mv-std"), true);
  assert.equal(codeMatches(["EA-P2-MV-%"], "EA-P2-VOV"), false);
  assert.equal(codeMatches(["T.X"], "TAX"), false, "a dot is a dot, not any letter");
  assert.equal(codeMatches(["T_X"], "TAX"), true);
  const T = { ...C, steps: [{ id: "V", stage: 1, title: "Video", kind: "task", owner: "Maker + Lead", start: 0, end: 2, clientInput: false, packages: { a: "yes" }, lines: ["T-VID-%"] },
    { id: "W", stage: 1, title: "Web", kind: "task", owner: "Maker", start: 0, end: 2, clientInput: false, packages: { a: "yes" }, lines: ["T-WEB"] },
    { id: "T", stage: 1, title: "Testimonials", kind: "task", owner: "Maker", start: 0, end: 2, clientInput: false, packages: { a: "yes" }, when: "realBuyers" },
    { id: "A", stage: 1, title: "Access", kind: "task", owner: "Coordinator", start: 0, end: 2, clientInput: false, packages: { a: "yes" } },
    { id: "F", stage: 1, title: "Film", kind: "task", owner: "Lead", start: 0, end: 2, clientInput: false, packages: { a: "optional" } }] };
  const p = { ...plan, lines: [{ code: "T-VID-STD", qty: 2, on: "2026-11-02" }], roles: { Coordinator: { none: true } }, conditions: {} };
  assert.deepEqual(T.steps.map((s) => whyNot(T, p, s)), [null, "not_bought", "condition", "role", "not_sold"]);
  assert.equal(whyNot(T, { ...p, lines: [] }, T.steps[1]), null, "nothing coded: the package decides, as before");
  assert.equal(whyNot(T, { ...p, lines: [{ code: "svc-old-reel", qty: 1, on: null }] }, T.steps[1]), null, "codes the template does not know: the package decides");
  assert.equal(whyNot(T, { ...p, conditions: { realBuyers: true } }, T.steps[2]), null);
});

test("an add-on counts from its own purchase day", () => {
  const T = { ...C, clocks: [...C.clocks, { key: "bought", label: "Bought on" }] };
  const s = { id: "F", stage: 1, title: "Film", kind: "task", owner: "Lead", start: 2, end: 20, from: "bought", clientInput: false, packages: { a: "optional" }, lines: ["T-FILM"] };
  const d = stepDay(T, { ...plan, lines: [{ code: "T-FILM", qty: 1, on: "2026-12-01" }] }, s);
  assert.deepEqual([d.label, d.start, d.due], ["Bought on + 2 → + 20", "2026-12-03", "2026-12-21"]);
});

test("worked-out numbers come from the template's formulas, never eval", () => {
  assert.equal(formula("bookings * visitsPerBooking", { bookings: 4, visitsPerBooking: 10 }), 40);
  assert.equal(formula("visits / (quality / 100)", { visits: 40, quality: 25 }), 160);
  assert.equal(formula("a / b", { a: 1, b: 0 }), null, "no dividing by zero");
  assert.equal(formula("a * missing", { a: 2 }), null, "a missing input gives no number");
  assert.equal(formula("process.exit(1)", {}), null, "names and sums only");
  assert.equal(formula("-(a - 3) * 2", { a: 1 }), 4);
  const def = { inputs: [{ key: "goal", label: "Goal", kind: "text" }, { key: "bookings", label: "Bookings a month" }, { key: "quality", label: "Quality", kind: "percent" }, { key: "leadsDay", label: "Leads a day promised" }],
    constants: { perBooking: 10 }, outputs: [{ key: "visits", label: "Visits a month", formula: "bookings * perBooking" }, { key: "leads", label: "Leads a month", formula: "visits / (quality / 100)" },
      { key: "day", label: "Leads a day needed", formula: "leads / 30", compare: "leadsDay" }] };
  const p = promiseOf(def, { values: { goal: "Sell out", bookings: 4, quality: 30, leadsDay: 5 }, confirmedAt: "2026-11-10", pending: { values: { goal: "Sell out", bookings: 6, quality: 30, leadsDay: 5 }, by: "x", at: "2026-11-12" } });
  assert.deepEqual(p.outputs.map((o) => o.value), [40, 133.3, 4.4]);
  assert.deepEqual(p.outputs[2].compare, { key: "leadsDay", label: "Leads a day promised", value: 5 });
  assert.deepEqual(p.pending.changed, ["bookings"]);
  assert.deepEqual(p.pending.outputs.map((o) => o.value), [60, 200, 6.7]);
  assert.equal(promiseOf(undefined, {}), null);
  assert.equal(promiseOf(def, undefined).set, false);
});

test("who does what: the roles the plan's open steps need, holders and nobody", () => {
  const T = { ...C, roles: [{ label: "Lead", lead: true }, { label: "Maker" }, { label: "Client", client: true }] };
  const tasks = [{ ...task("1", "I1", "s0", "open", null), role: "Maker", whoId: null }, { ...task("2", "I2", "s0", "open", null), role: "Maker", whoId: "p1" },
    { ...task("3", "M1", "s1", "open", null), role: "Client", whoId: null }, { ...task("4", "S1", "s1", "cancelled", null), role: "Coordinator", whoId: null },
    { ...task("5", "G1", "s0", "open", null), role: "Lead", whoId: "lead" }];
  const r = rolesOf(T, { ...plan, roles: { Coordinator: { none: true, closed: ["4"] }, Maker: { person: "p1" } } }, tasks);
  assert.deepEqual(r.map((x) => [x.role, x.open, x.nobody, x.left, x.holder, x.none]), [["Lead", 1, 0, 0, "lead", false], ["Maker", 2, 1, 0, "p1", false], ["Coordinator", 0, 0, 1, null, true]]);
  assert.deepEqual(r.map((x) => x.named), [false, true, false], "the lead's role stands for its one doer, not named");
});
