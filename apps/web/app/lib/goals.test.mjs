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
