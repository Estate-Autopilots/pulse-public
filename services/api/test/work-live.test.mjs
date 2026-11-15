// WORK-SPINE round 2: which open Work page a change touches (migration 2070's NOTIFY pulse_work notes).
import assert from "node:assert/strict";
import test from "node:test";
import { parseNote, touches } from "../dist/work-live.js";

const ORG = "00000000-0000-4000-8000-0000000000a1", P1 = "00000000-0000-4000-8000-0000000000b1", P2 = "00000000-0000-4000-8000-0000000000b2";
const G = "00000000-0000-4000-8000-0000000000c1", ME = "00000000-0000-4000-8000-0000000000d1", YOU = "00000000-0000-4000-8000-0000000000d2";
const T = "00000000-0000-4000-8000-0000000000e1";
const task = (ref, who = "", t = T) => ({ kind: "t", ref, who, task: t });

test("a note reads as organisation, kind, project or goal, person and task; anything else is ignored", () => {
  assert.deepEqual(parseNote(`${ORG}:t:${P1}:${ME}:${T}`), { org: ORG, note: { kind: "t", ref: P1, who: ME, task: T } });
  assert.deepEqual(parseNote(`${ORG}:g:${G}::`), { org: ORG, note: { kind: "g", ref: G, who: "", task: "" } });
  assert.deepEqual(parseNote(`${ORG}:p:${P1}`), { org: ORG, note: { kind: "p", ref: P1, who: "", task: "" } });
  for (const bad of ["", "x:t:1", `${ORG}:z:${P1}`, `${ORG}`]) assert.equal(parseNote(bad), null, bad);
});

test("a project page hears its own tasks and the project itself, not another project's or a goal's", () => {
  const s = { scope: "project", id: P1 };
  assert.ok(touches(s, task(P1), ME));
  assert.ok(touches(s, { kind: "p", ref: P1, who: "", task: "" }, ME));
  assert.ok(!touches(s, task(P2), ME));
  assert.ok(!touches(s, { kind: "g", ref: G, who: "", task: "" }, ME));
  assert.ok(!touches(s, task(""), ME), "a task with no project is on no project's page");
});

test("a goal page hears the goal and the tasks of the projects it holds", () => {
  const s = { scope: "goal", id: G };
  assert.ok(touches(s, { kind: "g", ref: G, who: "", task: "" }, ME, new Set([P1])));
  assert.ok(touches(s, task(P1), ME, new Set([P1])));
  assert.ok(!touches(s, task(P2), ME, new Set([P1])));
  assert.ok(!touches(s, { kind: "g", ref: "00000000-0000-4000-8000-0000000000c2", who: "", task: "" }, ME, new Set([P1])));
});

test("my work hears the tasks that are mine; a task page hears only itself; the lists hear the work", () => {
  assert.ok(touches({ scope: "me", id: null }, task(P1, ME), ME));
  assert.ok(!touches({ scope: "me", id: null }, task(P1, YOU), ME));
  assert.ok(!touches({ scope: "me", id: null }, task(P1, ""), ME), "a task with nobody on it is on no one's My work");
  assert.ok(touches({ scope: "projects", id: null }, task("", ""), ME), "the company-wide lists still hear it");
  assert.ok(touches({ scope: "task", id: T }, task(P2, YOU), ME));
  assert.ok(!touches({ scope: "task", id: T }, task(P2, YOU, "00000000-0000-4000-8000-0000000000e2"), ME));
  assert.ok(touches({ scope: "projects", id: null }, task(P2, YOU), ME));
  assert.ok(!touches({ scope: "projects", id: null }, { kind: "g", ref: G, who: "", task: "" }, ME));
  assert.ok(touches({ scope: "goals", id: null }, { kind: "g", ref: G, who: "", task: "" }, ME));
});
