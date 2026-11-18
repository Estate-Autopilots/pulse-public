// FOCUS (1845): the allocator's rules on synthetic accounts, companies and lanes (fake names only).
import assert from "node:assert/strict";
import test from "node:test";
import { burn, plan, room, score, timeCriticality, todaysWeights } from "../dist/focus-plan.js";

const NOW = new Date("2026-11-09T04:00:00Z"); // 09:30 in India
const inH = (h) => new Date(NOW.getTime() + h * 3600_000).toISOString();
const settings = { reserve5h: 20, reserve7d: 15, autoWeights: true };
const companies = [
  { key: "alpha", name: "Alpha Fake Co", weight: 30 },
  { key: "beta", name: "Beta Fake Co", weight: 25 },
  { key: "gamma", name: "Gamma Fake Co", weight: 5 },
];
const sub = (key, used5h, resets5h, extra = {}) => ({ key, name: `Fake ${key}`, kind: "ai", companies: [], tiers: ["T0", "T1", "T2", "T3"], cost: "sunk", status: "ok",
  latest: { "5h": { usedPct: used5h, resetsAt: inH(resets5h) }, "7d": { usedPct: 10, resetsAt: inH(100) } }, ...extra });
const lane = (key, company, extra = {}) => ({ key, title: `Fake lane ${key}`, company, value: 5, size: "M", need: "T2", status: "ready", ...extra });

test("time criticality rises inside 3 days and is 10 when late", () => {
  assert.equal(timeCriticality(null, NOW), 0);
  assert.equal(timeCriticality("2026-11-01", NOW), 10);
  assert.ok(timeCriticality("2026-11-10", NOW) > timeCriticality("2026-11-15", NOW));
  assert.equal(timeCriticality("2026-12-30", NOW), 0);
});

test("today's weights keep the owner's order, rise for a deadline, fall when blocked, and add to 100", () => {
  const lanes = [lane("a1", "alpha", { blockedBy: "Company registration" }), lane("a2", "alpha", { blockedBy: "Company registration" }),
    lane("b1", "beta", { dueOn: "2026-11-10" }), lane("g1", "gamma")];
  const w = todaysWeights(companies, lanes, NOW);
  const by = Object.fromEntries(w.map((x) => [x.key, x]));
  assert.equal(by.alpha.base, 50);
  assert.ok(by.alpha.today < by.alpha.base && /blocked/.test(by.alpha.why));
  assert.ok(by.beta.today > by.beta.base && /deadline/.test(by.beta.why));
  assert.ok(Math.abs(w.reduce((s, x) => s + x.today, 0) - 100) <= 2);
  // Switched off: today's weights are the owner's.
  assert.deepEqual(todaysWeights(companies, lanes, NOW, false).map((x) => x.today), todaysWeights(companies, lanes, NOW, false).map((x) => x.base));
});

test("the score is WSJF times the company's weight", () => {
  assert.ok(score(lane("x", "alpha", { size: "S" }), 30, NOW) > score(lane("x", "alpha", { size: "XL" }), 30, NOW));
  assert.ok(score(lane("x", "alpha", { urgent: true }), 30, NOW) > score(lane("x", "alpha"), 30, NOW));
  assert.ok(score(lane("x", "alpha"), 30, NOW) > score(lane("x", "alpha"), 5, NOW));
});

test("the rivokeb is kept for urgent work only", () => {
  const a = sub("one", 70, 2);
  assert.equal(room(a, settings, false, NOW), 10);
  assert.equal(room(a, settings, true, NOW), 30);
  // A window past its reset is full again.
  assert.equal(room(sub("two", 99, -1), settings, false, NOW), 75);
});

test("a blocked lane gets no account and its blocker is listed once", () => {
  const p = plan({ companies, settings, accounts: [sub("one", 10, 3)], lanes: [lane("a1", "alpha", { blockedBy: "Company registration" }), lane("a2", "alpha", { blockedBy: "Company registration" })] }, NOW);
  assert.equal(p.placed.length, 0);
  assert.deepEqual(p.blocked, [{ blocker: "Company registration", lanes: ["a1", "a2"], company: "alpha" }]);
});

test("policy, tiers, warm accounts and paid credit decide the account", () => {
  const accounts = [
    sub("own-beta", 10, 3, { companies: ["beta"] }),
    sub("warm", 40, 3),
    sub("cold", 10, 3),
    { key: "credit", name: "Fake credit", kind: "api", companies: [], tiers: ["T0", "T1"], cost: "metered", status: "ok", latest: { balance: { amount: 12 } } },
  ];
  const p = plan({ companies, settings, accounts, lanes: [lane("a1", "alpha", { account: "warm" }), lane("a2", "alpha", { need: "T0", size: "S" })] }, NOW);
  const by = Object.fromEntries(p.placed.map((x) => [x.lane, x]));
  assert.equal(by.a1.account, "warm", "stays on the warm account");
  assert.equal(by.a2.account, "credit", "easy work goes to paid credit");
  assert.ok(!p.placed.some((x) => x.account === "own-beta"), "an account for another company is never used");
});

test("with no room, the lane waits for the account that refills first, and urgent work may use the rivokeb", () => {
  const accounts = [sub("full", 75, 1.5), sub("later", 79, 4)];
  const p = plan({ companies, settings, accounts, lanes: [lane("a1", "alpha"), lane("a2", "alpha", { urgent: true, size: "S" })] }, NOW);
  assert.equal(p.waiting.length, 1);
  assert.equal(p.waiting[0].lane, "a1");
  assert.match(p.waiting[0].reason, /Fake full refills in 1 h 30 min/);
  assert.equal(p.placed[0].lane, "a2");
});

test("burn adds each rise in % used to the company that did the work", () => {
  const accounts = [{ key: "one", ownCompany: "alpha" }];
  const s = (h, used, company = null) => ({ account: "one", at: inH(h), win: "5h", usedPct: used, company });
  const out = burn([s(-3, 10), s(-2, 25), s(-1, 40, "beta"), s(-0.5, 5)], accounts, NOW);
  const by = Object.fromEntries(out.map((x) => [x.company, x.hours.reduce((a, b) => a + b, 0)]));
  assert.deepEqual(by, { alpha: 15, beta: 15 });
});
