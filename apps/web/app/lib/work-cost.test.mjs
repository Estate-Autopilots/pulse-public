// FIX-PEOPLE-MONEY C5: Work and cost's arithmetic on synthetic people and AI employees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aiCost, payRate, peopleCost, projectCost, tokensText } from "./work-cost.mjs";

const payroll = [{ month: "2026-06", total: 600000, people: 10 }, { month: "2026-07", total: 704000, people: 11 }];

test("the rate is the latest payroll month's average: per person a month and an hour", () => {
  const r = payRate(payroll);
  assert.equal(r.month, "2026-07");
  assert.equal(r.monthly, 64000);
  assert.equal(r.hourly, 64000 / 176);
  assert.equal(payRate([]), null);
});

test("people: tasks others accepted in the last weeks, their share of pay per task; robots left out", () => {
  const people = [
    { id: "a", name: "Kedab Mifos", role: "Editor", values: [0, 0, 0, 0, 0, 3, 4, 5, 2] },
    { id: "b", name: "Diya Nair", role: "PGS", values: [0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { id: "c", name: "QOGI ramis aliga", role: "admin", values: [9, 9, 9, 9, 9, 9, 9, 9, 9] },
  ];
  const p = peopleCost(people, payRate(payroll), 2);
  assert.deepEqual(p.rows.map((r) => [r.name, r.tasks]), [["Kedab Mifos", 7], ["Diya Nair", 0]]);
  const share = 64000 * 14 / 30;
  assert.equal(p.rows[0].perTask, share / 7);
  assert.equal(p.rows[1].perTask, null, "no tasks: no cost per task");
  assert.equal(p.tasks, 7);
  assert.equal(p.cost, 704000 * 14 / 30);
  assert.equal(p.perTask, share * 1 / 7, "the average over the people with tasks");
  assert.equal(p.busy, 1);
  assert.equal(p.idle, 1);
  assert.equal(peopleCost(people, null, 2).perTask, null, "without payroll, no rupees");
});

test("AI: accepted tasks, tokens per task, and rupees only with a price", () => {
  const agents = [{ id: "x", name: "Accounts Assistant (AI)", title: "Accounts", accepted: 4, given: 6, returned: 1, tokens: 80000 }, { id: "y", name: "Creative Strategist (AI)", accepted: 0, tokens: 0 }];
  const a = aiCost(agents);
  assert.equal(a.rows[0].perTask, 20000);
  assert.equal(a.rows[0].inrPerTask, null);
  assert.equal(a.tasks, 4);
  assert.equal(aiCost(agents, 0.0002).rows[0].inrPerTask, 4);
  assert.deepEqual([tokensText(1234567), tokensText(85000), tokensText(900), tokensText(null)], ["1.2\u00a0M", "85\u00a0k", "900", "—"]);
});

test("projects: a person's share split over all their tasks, AI tasks in tokens, the costliest project first", () => {
  const tasks = [
    { projectId: "p1", project: "Skyview Estates launch", who: "a", ai: false, tokens: 0 },
    { projectId: "p1", project: "Skyview Estates launch", who: "a", ai: false, tokens: 0 },
    { projectId: "p2", project: "Harbor Builders site visits", who: "a", ai: false, tokens: 0 },
    { projectId: "p2", project: "Harbor Builders site visits", who: "x", ai: true, tokens: 5000 },
    { projectId: null, project: null, who: "a", ai: false, tokens: 0 },
  ];
  const r = projectCost(tasks, payRate(payroll), 30);
  assert.deepEqual(r.map((p) => [p.name, p.people, p.ai, p.tokens]), [["Skyview Estates launch", 2, 0, 0], ["Harbor Builders site visits", 1, 1, 5000]]);
  assert.equal(r.length, 2, "a task without a project makes no row");
  assert.equal(r[0].cost, 64000 * 2 / 4, "but it counts when a person's share is split over their tasks");
  assert.equal(r[1].cost, 64000 / 4);
  assert.equal(projectCost(tasks, null, 30)[0].cost, null);
});

test("projects in step with the cards: only the people and AI employees shown count, at the card's own pay per task", () => {
  const tasks = [
    { projectId: "p1", project: "Skyview Estates launch", who: "a", ai: false, tokens: 0 },
    { projectId: "p1", project: "Skyview Estates launch", who: "ramis", ai: false, tokens: 0 },
    { projectId: "p2", project: "Harbor Builders site visits", who: "x", ai: true, tokens: 5000 },
    { projectId: "p2", project: "Harbor Builders site visits", who: "other-ai", ai: true, tokens: 9000 },
    { projectId: "p3", project: "QA only", who: "ramis", ai: false, tokens: 0 },
  ];
  const r = projectCost(tasks, payRate(payroll), 28, { people: new Map([["a", 3218]]), ai: new Set(["x"]) });
  assert.deepEqual(r.map((p) => [p.name, p.people, p.ai, p.tokens, p.cost]), [["Skyview Estates launch", 1, 0, 0, 3218], ["Harbor Builders site visits", 0, 1, 5000, 0]]);
});
