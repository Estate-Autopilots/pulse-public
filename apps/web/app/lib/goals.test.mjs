// FOUNDATIONS: the words a goal card says (lib/goals.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { dueWords, groupGoals, levelWords, percent, progressWords, tone } from "./goals.mjs";

const base = { id: "g1", level: "person", title: "Ship 20 reels", why: null, ownerId: "me", owner: "Asha", teamId: null, team: null, parentId: null, parent: null,
  targetOn: null, measure: null, status: "active", createdBy: "me", createdAt: "", updatedAt: "", doneAt: null, canEdit: true,
  progress: { progress: 0, measure: null, work: null, tasks: 0, tasksDone: 0, projects: 0, subGoals: 0, late: false, basis: "none" } };
const goal = (over) => ({ ...base, ...over, progress: { ...base.progress, ...(over.progress ?? {}) } });

test("percent is a whole number between 0 and 100", () => {
  assert.equal(percent(0.256), 26);
  assert.equal(percent(1.4), 100);
  assert.equal(percent(-1), 0);
  assert.equal(percent(null), 0);
});

test("progress words follow what the goal counts", () => {
  assert.equal(progressWords(goal({})), "No work under it yet");
  assert.equal(progressWords(goal({ progress: { tasks: 4, tasksDone: 1 } })), "1 of 4 tasks done");
  assert.equal(progressWords(goal({ progress: { tasks: 1, tasksDone: 0, subGoals: 2 } })), "0 of 1 task done · 2 smaller goals");
  assert.equal(progressWords(goal({ measure: { label: "clients signed", start: 0, target: 12, current: 3 } })), "3 of 12 clients signed");
  assert.equal(progressWords(goal({ measure: { label: "revenue (lakh)", start: 0, target: 150000, current: 2.5 } })), "2.5 of 1,50,000 revenue (lakh)");
  assert.equal(progressWords(goal({ status: "done" })), "Done");
  assert.equal(progressWords(goal({ status: "dropped" })), "Dropped");
});

test("level words use the company's own word for a team", () => {
  assert.equal(levelWords(goal({ level: "company" })), "Company goal");
  assert.equal(levelWords(goal({ level: "team", team: "Studio" })), "Studio goal");
  assert.equal(levelWords(goal({ level: "team" }), { team: "Pod" }), "Pod goal");
  assert.equal(levelWords(goal({})), "Asha's goal");
});

test("due words count days from the company's today", () => {
  assert.equal(dueWords(null, "2026-11-06"), null);
  assert.equal(dueWords("2026-11-06", "2026-11-06"), "Due today");
  assert.match(dueWords("2026-11-07", "2026-11-06"), /^1 day left/);
  assert.match(dueWords("2026-11-01", "2026-11-06"), /^5 days past/);
  assert.match(dueWords("2027-03-31", "2026-11-06"), /^By 31 Mar 2027$/);
  assert.match(dueWords("2026-11-01", "2026-11-06", "done"), /^Target/);
});

test("goals group into company, team, yours and your people's", () => {
  const g = groupGoals([goal({ id: "a", level: "company" }), goal({ id: "b", level: "team", team: "Studio" }), goal({ id: "c" }), goal({ id: "d", ownerId: "other" })], "me");
  assert.deepEqual(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map((x) => x.id)])), { company: ["a"], team: ["b"], mine: ["c"], people: ["d"] });
  assert.equal(tone(goal({ progress: { late: true } })), "late");
  assert.equal(tone(goal({ status: "done" })), "done");
});

// ------------------------------------------------------------------------------------------------ GOALS-2
import { amountWords, byDeadline, headline, health, healthCount, monthBars, nextAction, pace, paceLine, readAmount, rupees, shortDate, splitGoals, streak, timeGone } from "./goals.mjs";

const sg = (over) => ({ ...goal({}), kind: "count", source: "manual", startsOn: "2026-10-01", steps: [], auto: null, history: [], nextTask: null, ...over,
  progress: { ...base.progress, ...(over.progress ?? {}) } });
const money = (over = {}) => sg({ kind: "money", title: "Collect ₹25 L", targetOn: "2026-12-31", startsOn: "2026-10-01",
  measure: { label: "rupees", start: 0, target: 2500000, current: 1640000 }, progress: { progress: 0.656, basis: "measure" }, ...over });

test("rupees in lakh and crore", () => {
  assert.equal(rupees(45000), "₹45,000");
  assert.equal(rupees(1640000), "₹16.4 L");
  assert.equal(rupees(2500000), "₹25 L");
  assert.equal(rupees(125000), "₹1.25 L");
  assert.equal(rupees(11000000), "₹1.1 Cr");
  assert.equal(rupees(1640000, true), "₹16,40,000");
  assert.equal(rupees(-150000), "-₹1.5 L");
  assert.equal(rupees(0), "₹0");
});

test("typed amounts understand lakh, crore and thousands", () => {
  assert.equal(readAmount("25 L"), 2500000);
  assert.equal(readAmount("₹25,00,000"), 2500000);
  assert.equal(readAmount("1.2 cr"), 12000000);
  assert.equal(readAmount("50k"), 50000);
  assert.equal(readAmount("12"), 12);
  assert.equal(readAmount("abc"), null);
  assert.equal(readAmount(""), null);
});

test("health follows the rules: on track, at risk, behind", () => {
  // 92 days, half gone on 15 Nov (45 of 91 days ≈ 0.49).
  const g = (p) => money({ progress: { progress: p } });
  assert.equal(health(g(0.45), "2026-11-15").key, "on");      // 4 points behind
  assert.equal(health(g(0.30), "2026-11-15").key, "risk");    // 19 points behind
  assert.equal(health(g(0.10), "2026-11-15").key, "behind");  // 39 points behind
  assert.equal(health(g(0.90), "2027-01-05").key, "behind");  // the date has passed
  assert.equal(health(g(1), "2026-11-15").key, "hit");
  assert.equal(health(money({ status: "done" }), "2026-11-15").key, "done");
  assert.equal(health(money({ targetOn: null }), "2026-11-15").key, "none");
  assert.equal(health(g(0), "2026-10-01").key, "start");      // day one: nothing is expected yet, and nothing is done
  assert.equal(health(g(0.02), "2026-10-03").key, "on");       // the first week, something done
});

test("health is pace: nothing done after the first week is behind, not on track (UI-SWEEP)", () => {
  // The owner's case: ₹0 of ₹25 L, 51 days left. Started 1 Oct: 40 of 91 days gone, so ₹11 L was due by now.
  assert.equal(health(money({ progress: { progress: 0 } }), "2026-11-10").key, "behind");
  // Started 7 Nov (3 days ago): too early to judge, and nothing done yet.
  assert.equal(health(money({ startsOn: "2026-11-07", progress: { progress: 0 } }), "2026-11-10").key, "start");
  // Started 20 Oct: 21 of 72 days gone (29%); 20% done is 68% of the way it should be, 26% is 89%, 27% is 93%.
  assert.equal(health(money({ startsOn: "2026-10-20", progress: { progress: 0.20 } }), "2026-11-10").key, "risk");
  assert.equal(health(money({ startsOn: "2026-10-20", progress: { progress: 0.26 } }), "2026-11-10").key, "risk");
  assert.equal(health(money({ startsOn: "2026-10-20", progress: { progress: 0.27 } }), "2026-11-10").key, "on");
  assert.equal(health(money({ startsOn: "2026-10-20", progress: { progress: 0.10 } }), "2026-11-10").key, "behind");
  assert.equal(timeGone(money({}), "2026-09-01"), 0);
});

test("pace says where the number is heading and what a week needs", () => {
  const p = pace(money({}), "2026-11-15");
  assert.ok(p && p.hits, "₹16.4 L in 45 days heads past ₹25 L in 91");
  assert.match(p.sentence, /^On track to hit ₹\d+(\.\d+)? L by 31 Dec\.$/);
  const slow = pace(money({ measure: { label: "rupees", start: 0, target: 2500000, current: 500000 } }), "2026-11-15");
  assert.ok(slow && !slow.hits);
  assert.match(slow.sentence, /^At this pace: ₹10.1 L by 31 Dec\. Aim for ₹\d+(\.\d+)? L a week\.$/);
  const fresh = pace(money({ measure: { label: "rupees", start: 0, target: 2500000, current: 0 } }), "2026-11-15");
  assert.match(fresh.sentence, /^To hit ₹25 L by 31 Dec, aim for ₹\d/);
  assert.equal(pace(sg({}), "2026-11-15"), null);
});

test("the next thing to do comes from the checklist, the work, then the number", () => {
  const today = "2026-11-15";
  assert.deepEqual(nextAction(sg({ steps: [{ id: "a", title: "Book the name", done: true }, { id: "b", title: "File the forms", done: false }] }), today),
    { label: "File the forms", href: "/goals/g1" });
  assert.deepEqual(nextAction(sg({ nextTask: { id: "t1", title: "Call Coral Developers", dueOn: null } }), today), { label: "Call Coral Developers", href: "/tasks/t1" });
  assert.equal(nextAction(money({ history: [{ on: "2026-11-01", value: 100 }] }), today).label, "Update the number");
  assert.equal(nextAction(money({ history: [{ on: "2026-11-14", value: 100 }] }), today), null);
  assert.equal(nextAction(sg({}), today).label, "Link a project or task");
  assert.equal(nextAction(money({ targetOn: "2026-11-01" }), today).label, "Move the date or close it");
  assert.equal(nextAction(money({ status: "done" }), today), null);
});

test("a streak counts weeks in a row in which the number went up", () => {
  const history = [{ on: "2026-10-20", value: 10 }, { on: "2026-10-28", value: 20 }, { on: "2026-11-04", value: 30 }, { on: "2026-11-12", value: 40 }];
  assert.equal(streak(money({ history }), "2026-11-15"), 4);
  assert.equal(streak(money({ history }), "2026-11-20"), 4);   // this week has nothing yet; last week counts
  assert.equal(streak(money({ history }), "2026-11-30"), 0);
  assert.equal(streak(money({ history: [{ on: "2026-11-12", value: 40 }, { on: "2026-11-13", value: 30 }] }), "2026-11-15"), 1);
});

test("money bars come from Billing's months, or from how the typed number grew", () => {
  const auto = { value: 900, series: [{ key: "2026-10", value: 500 }, { key: "2026-11", value: 400 }], items: [], from: "2026-10-01", to: "2026-11-15" };
  assert.deepEqual(monthBars(money({ source: "billing_received", auto })).map((b) => [b.label, b.value]), [["Oct", 500], ["Nov", 400]]);
  const history = [{ on: "2026-10-10", value: 300000 }, { on: "2026-10-30", value: 700000 }, { on: "2026-11-10", value: 1640000 }];
  assert.deepEqual(monthBars(money({ history })).map((b) => b.value), [700000, 940000]);
  const line = paceLine(money({ history }), "2026-11-15");
  assert.equal(line.actual[0].value, 0);
  assert.equal(line.actual.at(-1).on, "2026-11-15");
  assert.equal(line.forecast.length, 2);
});

test("lists split company and mine, sorted by the nearest deadline", () => {
  const a = sg({ id: "a", level: "company", targetOn: "2027-01-31", title: "A" });
  const b = sg({ id: "b", level: "team", targetOn: "2026-11-30", title: "B" });
  const c = sg({ id: "c", level: "person", ownerId: "me", targetOn: null, title: "C" });
  const d = sg({ id: "d", level: "person", ownerId: "me", targetOn: "2026-12-01", title: "D" });
  const e = sg({ id: "e", level: "person", ownerId: "other", targetOn: "2026-12-01", title: "E" });
  const s = splitGoals([a, b, c, d, e], "me");
  assert.deepEqual(s.company.map((x) => x.id), ["b", "a"]);
  assert.deepEqual(s.mine.map((x) => x.id), ["d", "c"]);
  assert.deepEqual(s.people.map((x) => x.id), ["e"]);
  assert.deepEqual(byDeadline([sg({ id: "x", status: "done", targetOn: "2026-01-01" }), d]).map((x) => x.id), ["d", "x"]);
  assert.deepEqual(healthCount([money({ progress: { progress: 0.45 } }), money({ progress: { progress: 0.1 } })], "2026-11-15"), { on: 1, risk: 0, behind: 1 });
});

test("the headline says the number the way the goal counts it", () => {
  assert.deepEqual(headline(money({})), { now: "₹16.4 L", of: "of ₹25 L" });
  assert.deepEqual(headline(sg({ kind: "clients", measure: { label: "paying clients", start: 0, target: 10, current: 6 } })), { now: "6", of: "of 10 paying clients" });
  assert.deepEqual(headline(sg({ kind: "milestone", steps: [{ id: "a", title: "x", done: true }, { id: "b", title: "y", done: false }] })), { now: "1", of: "of 2 steps" });
  assert.equal(amountWords(sg({ source: "checkins" }), 72.4), "72%");
  assert.equal(shortDate("2027-03-31", "2026-11-08"), "31 Mar 2027");
  assert.equal(shortDate("2026-12-31", "2026-11-08"), "31 Dec");
});

test("an older goal gets its kind from what it counts and safe defaults", async () => {
  const { screenGoal } = await import("./goals.mjs");
  const old = goal({ measure: { label: "rupees collected", start: 0, target: 2500000, current: 100 }, createdAt: "2026-11-01 10:00:00+00" });
  const s = screenGoal(old);
  assert.equal(s.kind, "money"); assert.equal(s.source, "manual"); assert.equal(s.startsOn, "2026-11-01");
  assert.deepEqual([s.steps, s.history, s.auto, s.nextTask], [[], [], null, null]);
  assert.equal(screenGoal(goal({ measure: { label: "paying clients", start: 0, target: 3, current: 1 } })).kind, "clients");
  assert.equal(screenGoal(goal({ measure: { label: "calls", start: 0, target: 3, current: 1 } })).kind, "count");
  assert.equal(screenGoal(goal({})).kind, "custom");
  assert.equal(screenGoal({ ...goal({}), kind: "milestone", steps: [{ id: "a", title: "x", done: false }] }).kind, "milestone");
});

test("no forecast before a week (or a tenth of the goal's time) has gone", () => {
  // Started yesterday with 6 of 10 already counted: not "on track to hit 504".
  const g = sg({ kind: "clients", startsOn: "2026-11-08", targetOn: "2027-01-31", measure: { label: "paying clients", start: 0, target: 10, current: 6 }, progress: { progress: 0.6 } });
  const p = pace(g, "2026-11-09");
  assert.equal(p.early, true); assert.equal(p.hits, false);
  assert.match(p.sentence, /^To hit 10 by 31 Jan 2027, aim for /);
  assert.deepEqual(paceLine(g, "2026-11-09").forecast, []);
  assert.equal(pace(money({}), "2026-11-15").early, false);
});
