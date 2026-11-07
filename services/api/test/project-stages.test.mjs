import assert from "node:assert/strict";
import test from "node:test";
import { planState } from "../dist/project-plan.js";
import { STARTERS, startersFor } from "../dist/project-starters.js";
import { loadOf, needsAct } from "../dist/project-stages.js";

// PROJECTS-STAGES (owner, 4 Nov 2026): the starters every company can take, the delay roll-up rule and each person's load.
test("every starter is a whole delivery template the plan engine reads", () => {
  assert.ok(STARTERS.length >= 6);
  const keys = new Set();
  for (const s of STARTERS) {
    assert.match(s.key, /^[a-z0-9-]{2,40}$/); assert.ok(!keys.has(s.key)); keys.add(s.key);
    const t = { key: s.key, name: s.name, ...s.template };
    assert.deepEqual(t.stages.map((x) => x.n), t.stages.map((_, i) => i), `${s.key}: stages count from 0`);
    const ids = new Set();
    for (const st of t.steps) {
      assert.ok(!ids.has(st.id), `${s.key}: ${st.id} once`); ids.add(st.id);
      assert.ok(t.stages.some((x) => x.n === st.stage), `${s.key}: ${st.id} on a stage`);
      assert.ok(st.end === null || st.end >= st.start, `${s.key}: ${st.id} ends after it starts`);
      for (const p of t.packages) assert.ok(["yes", "no", "optional"].includes(st.packages[p.key]), `${s.key}: ${st.id} says if ${p.key} has it`);
    }
    assert.ok(t.steps.some((x) => x.owner === t.bandwidth.role), `${s.key}: the lead owns a step`);
    for (const m of Object.values(t.milestones)) if (typeof m === "string") assert.ok(ids.has(m), `${s.key}: milestone ${m} is a step`);
    // Laid out from a kick-off with nothing done: stage 0, the first step next, no risk words.
    const tasks = t.steps.filter((x) => x.packages.standard === "yes").map((x, i) => ({ id: String(i), title: `${x.id} ${x.title}`, step: x.id, phase: `s${x.stage}`, status: "open",
      due: x.end === null ? null : new Date(Date.parse("2026-11-01T00:00:00Z") + x.end * 86400000).toISOString().slice(0, 10), start: null, doneOn: null, who: null, whoId: null, role: x.owner, source: "template" }));
    const st = planState(t, { templateKey: s.key, package: "standard", category: "standard", kickoff: "2026-11-01" }, tasks, "2026-11-01");
    assert.equal(st.stage, 0, s.key); assert.equal(st.foundationRisk, false); assert.ok(st.next, s.key);
  }
});

test("a company's own industry comes first and what it has is marked", () => {
  const list = startersFor("consulting", ["simple-project"]);
  assert.equal(list[0].key, "consulting-engagement"); assert.equal(list[0].suggested, true);
  assert.equal(list.find((x) => x.key === "simple-project").adopted, true);
  assert.equal(startersFor(null, []).every((x) => !x.suggested), true);
});

test("a delay waits on the lead until they act; a chase comes back on an answer or after 2 days; an escalation goes to its person", () => {
  const now = Date.parse("2026-11-04T10:00:00Z");
  const d = { id: "d", taskId: "t", whoId: "doer", answeredAt: null, action: null, actedAt: null, escalatedId: null, canAct: true };
  assert.equal(needsAct(d, "lead", now), true);
  assert.equal(needsAct({ ...d, canAct: false }, "doer", now), false);
  const chased = { ...d, action: "chased", actedAt: "2026-11-03T10:00:00Z" };
  assert.equal(needsAct(chased, "lead", now), false);
  assert.equal(needsAct({ ...chased, answeredAt: "2026-11-03T12:00:00Z" }, "lead", now), true);
  assert.equal(needsAct({ ...chased, actedAt: "2026-11-01T09:00:00Z" }, "lead", now), true);
  const up = { ...d, action: "escalated", actedAt: "2026-11-04T09:00:00Z", escalatedId: "boss" };
  assert.equal(needsAct(up, "lead", now), false); assert.equal(needsAct(up, "boss", now), true);
});

test("load: late first, then the most open work, with bars against the busiest person; nobody idle without work is listed", () => {
  const r = (id, open, late, week, leads = 0, stages = 0) => ({ id, name: id, role: null, pod: null, open, late, week, inProjects: open, leads, stages });
  const out = loadOf([r("asha", 10, 0, 2), r("ravi", 4, 1, 1), r("idle", 0, 0, 0), r("lead", 0, 0, 0, 2, 1), r("full", 6, 0, 5)]);
  assert.deepEqual(out.map((x) => x.id), ["ravi", "asha", "full", "lead"]);
  assert.deepEqual(out.map((x) => x.state), ["late", "ok", "full", "free"]);
  assert.equal(out[1].share, 100); assert.equal(out[0].share, 40);
});
