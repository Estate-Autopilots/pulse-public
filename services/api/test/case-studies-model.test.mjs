// CASE-STUDIES (1966): the journey's protocol and the suggested-goal rules (goal-rules-v1) on synthetic numbers only.
import assert from "node:assert/strict";
import test from "node:test";
import { CHECK_IDS, ENGINE, STAGES, journeyDay, nextStep, rupees, seriesOf, stageDone, suggest, suggestAll } from "../dist/case-studies-model.js";
import { goalBody, lastMonths, monthsFrom } from "../dist/case-studies.js";

const months = (vals) => vals.map((value, i) => ({ month: `2026-${String(i + 1).padStart(2, "0")}`, value }));

test("the protocol: 8 stages in the owner's order, every step id unique", () => {
  assert.deepEqual(STAGES.map((s) => s.label), ["Convince", "Trust & data", "Understand", "Podcasts", "Their own AI", "Insights & goals", "Onboarding", "Price"]);
  assert.equal(new Set(CHECK_IDS).size, CHECK_IDS.length);
  assert.ok(STAGES.every((s) => s.checks.length >= 3));
});

test("a stage is done only when every step is ticked; next step is the first open one", () => {
  const s = STAGES[0];
  assert.equal(stageDone(s, { "convince.offer": true, "convince.demo": true }), false);
  assert.equal(stageDone(s, { "convince.offer": true, "convince.demo": true, "convince.yes": true }), true);
  assert.equal(nextStep(1, { "convince.offer": true }), "Show them a demo they love");
  assert.equal(nextStep(1, { "convince.offer": true, "convince.demo": true, "convince.yes": true }), 'Mark "Convince" done');
  assert.equal(nextStep(9, {}), null);
});

test("journey day counts from 1 and says how far past 45", () => {
  assert.deepEqual(journeyDay("2026-11-10", "2026-11-10"), { day: 1, of: 45, over: 0 });
  assert.deepEqual(journeyDay("2026-11-10", "2026-12-24"), { day: 45, of: 45, over: 0 });
  assert.deepEqual(journeyDay("2026-11-10", "2026-12-31"), { day: 52, of: 45, over: 7 });
});

test("grow: the owner's example, ₹10 L a month → ₹10–15 L", () => {
  const s = suggest("revenue", months([900000, 950000, 1000000, 1000000, 1000000, 1000000]));
  assert.equal(s.verdict, "grow"); assert.equal(s.baseline, 1000000); assert.equal(s.low, 1000000); assert.equal(s.high, 1500000);
  assert.equal(s.engine, ENGINE); assert.match(s.reasons[0], /₹10 L a month/);
});

test("recover: far below the best month aims back toward it (₹4–7 L now, ₹18 L before)", () => {
  const s = suggest("revenue", months([1800000, 1500000, 1200000, 700000, 500000, 400000]));
  assert.equal(s.verdict, "recover"); assert.equal(s.baseline, 533000); assert.equal(s.low, 800000); assert.equal(s.high, 1600000); assert.equal(s.peak, 1800000);
});

test("steady: falling 10% or more stops the fall first", () => {
  const s = suggest("clients", months([10, 10, 10, 8, 8, 8]));
  assert.equal(s.verdict, "steady"); assert.equal(s.low, 8); assert.equal(s.high, 10); assert.equal(s.trend, -0.2);
});

test("need data: fewer than 3 months, or nothing in the last 3", () => {
  assert.equal(suggest("leads", months([40, 50])).verdict, "need_data");
  assert.equal(suggest("leads", months([40, 0, 0, 0])).verdict, "need_data");
  assert.equal(suggest("leads", months([null, 30, null])).verdict, "need_data");
});

test("counts always give a range of at least one", () => {
  const s = suggest("clients", months([1, 1, 1]));
  assert.equal(s.low, 1); assert.equal(s.high, 2);
});

test("lead flow: enough leads to reach the clients target at today's rate", () => {
  const all = suggestAll(seriesOf([
    { month: "2026-06", revenue: 400000, clients: 4, leads: 40 }, { month: "2026-07", revenue: 400000, clients: 4, leads: 40 }, { month: "2026-08", revenue: 400000, clients: 4, leads: 40 }]));
  const [, clients, leads] = all;
  assert.equal(clients.high, 6);
  assert.equal(leads.high, 60);
  assert.ok(leads.reasons.some((r) => /10 leads for each client/.test(r)));
});

test("₹ in lakh and crore", () => {
  assert.equal(rupees(85000), "₹85,000"); assert.equal(rupees(420000), "₹4.2 L"); assert.equal(rupees(15000000), "₹1.5 Cr");
});

test("typed months are checked and sorted", () => {
  assert.deepEqual(monthsFrom([{ month: "2026-08", revenue: "420000", clients: 6, leads: "" }, { month: "2026-07", revenue: null }]).map((m) => m.month), ["2026-07", "2026-08"]);
  assert.throws(() => monthsFrom([{ month: "2026-13" }]));
  assert.throws(() => monthsFrom([{ month: "2026-08" }, { month: "2026-08" }]));
  assert.throws(() => monthsFrom([{ month: "2026-08", revenue: -1 }]));
});

test("last 12 full months end with last month", () => {
  const m = lastMonths("2026-11-10");
  assert.equal(m.length, 12); assert.equal(m[0], "2025-11"); assert.equal(m[11], "2026-10");
});

test("a goal from a suggestion: a company goal for the month a year ahead", () => {
  const s = suggest("revenue", months([1000000, 1000000, 1000000]));
  const g = goalBody(s, "Example Co", "2026-11-10");
  assert.equal(g.level, "company"); assert.equal(g.kind, "money"); assert.equal(g.targetValue, 1500000); assert.equal(g.startValue, 1000000);
  assert.equal(g.targetOn, "2027-11-30"); assert.match(g.title, /^Example Co: Revenue of ₹10 L–₹15 L a month$/);
  assert.throws(() => goalBody(suggest("leads", months([1])), null, "2026-11-10"));
});
