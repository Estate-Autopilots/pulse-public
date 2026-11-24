import assert from "node:assert/strict";
import test from "node:test";
import { judge } from "../dist/project-health.js";

const base = { open: 3, late: 0, blocked: 0, soon: 0, noOwner: 0, noDue: 0, waitingClient: 0, dueOn: null };
const T = "2026-10-27";

test("a project with nothing late or blocked is on track", () => {
  assert.deepEqual(judge(base, T).health, "on_track");
  assert.equal(judge(base, T).why, "On track");
});

test("blocked beats waiting, waiting beats late, late beats due soon (worst first)", () => {
  const blocked = judge({ ...base, blocked: 1, late: 2 }, T), waiting = judge({ ...base, waitingClient: 1, late: 5 }, T);
  const late = judge({ ...base, late: 3 }, T), soon = judge({ ...base, soon: 1 }, T);
  assert.equal(blocked.health, "blocked"); assert.equal(waiting.health, "waiting"); assert.equal(late.health, "at_risk"); assert.equal(soon.health, "watch");
  assert.ok(blocked.score > waiting.score && waiting.score > late.score && late.score > soon.score);
  assert.match(blocked.why, /1 blocked · 2 late/);
});

test("a project past its end date is at risk; no due day alone is only a note", () => {
  assert.equal(judge({ ...base, dueOn: "2026-10-01" }, T).health, "at_risk");
  const r = judge({ ...base, noDue: 4 }, T);
  assert.equal(r.health, "on_track"); assert.equal(r.why, "4 with no due day");
});

// PM-BUILD-3: the project as one card (SPEC v1.1 health, first match wins, with a reason; phases; next step; clock line).
import { pmCard, pmClocks, workDays, PM_RANK, phaseName } from "../dist/project-health.js";
const TPL = {
  key: "t", name: "T", packages: [{ key: "p", label: "P" }], categories: [], bandwidth: { role: "PGS", short: "PGS", healthy: [1, 2], max: 3 }, milestones: { adsLive: "J3" },
  stages: [{ n: 0, key: "s0", label: "Stage 0 · Onboarding" }, { n: 1, key: "s1", label: "Phase 1 · Project Brand Blueprint™" }, { n: 2, key: "s2", label: "Phase 3 · Buyer Journey" }],
  clocks: [{ key: "start", label: "Invoice paid", day: -7 }, { key: "day0", label: "Inputs complete", step: "O14" }, { key: "live", label: "Ads live", step: "J3" }],
  roles: [{ label: "PGS", lead: true }, { label: "Video Editor" }, { label: "Client", client: true }],
  steps: [
    { id: "O1", stage: 0, title: "O1 Paid invoice", kind: "auto", type: "auto", start: 0, end: 0, owner: "Vitals OS", clientInput: false, packages: { p: "yes" } },
    { id: "O5", stage: 0, title: "O5 Brochure and floor plans", kind: "task", start: 1, end: 3, owner: "Client", clientInput: true, packages: { p: "yes" } },
    { id: "O14", stage: 0, title: "O14 Input-complete declared — Day 0. Every input held", kind: "gate", type: "gate", start: 7, end: 7, owner: "PGS", clientInput: false, packages: { p: "yes" }, after: ["O5"] },
    { id: "P1", stage: 1, title: "P1 Market research", kind: "task", from: "day0", start: 1, end: 3, owner: "PGS", clientInput: false, packages: { p: "yes" } },
    { id: "C20", stage: 1, title: "C20 Model-led video drafted", kind: "task", from: "day0", start: 4, end: 8, owner: "Video Editor", role: "Video Editor", clientInput: false, packages: { p: "yes" } },
    { id: "J3", stage: 2, title: "J3 Campaigns live", kind: "milestone", type: "milestone", from: "day0", start: 15, end: 21, owner: "PGS", clientInput: false, packages: { p: "yes" } },
  ],
};
const K = "2026-11-14"; // invoice paid (Saturday); Day 0 planned 21 Nov, ads live planned 12 Dec
const PROJ = { id: "11111111-1111-1111-1111-111111111111", title: "Aranya Heights", status: "active", kind: "client_work", leadId: "lead", startsOn: null, dueOn: null, lastActivity: "2026-11-20", open: 4, late: 0, waitingClient: 0, next: null };
const task = (id, over = {}) => ({ id: `t-${id}`, title: TPL.steps.find((s) => s.id === id).title, step: id, phase: null, status: "open", due: null, start: null, doneOn: null, who: "Kavya", whoId: "lead", role: "PGS", source: "plan", ...over });
const plan = (over = {}) => ({ templateKey: "t", package: "p", category: null, kickoff: K, ...over });
const steps0 = () => [task("O1", { status: "done", due: K }), task("O5", { due: "2026-11-17", start: "2026-11-15", role: "Client", who: null, whoId: null }), task("O14", { due: "2026-11-21" }), task("P1"), task("C20", { role: "Video Editor", who: "Rifob", whoId: "rifob" }), task("J3")];
const card = (tasks, today, over = {}, moves = []) => pmCard({ ...PROJ, ...over }, today, { hasTemplate: true, plan: { t: TPL, plan: plan(over.plan), tasks, moves } });

test("PM card: no plan or no lead is Needs setup, never On track", () => {
  const r = pmCard(PROJ, "2026-11-21", { hasTemplate: true, plan: null });
  assert.equal(r.health, "needs_setup"); assert.equal(r.reason, "no plan yet");
  assert.equal(pmCard({ ...PROJ, leadId: null }, "2026-11-21", { hasTemplate: true, plan: null }).reason, "no lead yet");
  const i = pmCard({ ...PROJ, kind: "internal", leadId: null }, "2026-11-21", { hasTemplate: true, plan: null });
  assert.equal(i.health, "needs_setup"); assert.equal(i.reason, "no lead yet");
  assert.equal(card(steps0(), "2026-11-15", { leadId: null }).health, "needs_setup");
});

test("PM card: clocks have planned days; the line adds up (day + days left = plan length)", () => {
  const c = pmClocks(TPL, plan(), steps0());
  assert.equal(c.on.day0, "2026-11-21"); assert.equal(c.on.live, "2026-12-12"); assert.equal(c.happened.day0, false);
  const r = card(steps0(), "2026-11-15");
  assert.equal(r.line, "Inputs complete by 21 Nov · Ads live 12 Dec");
  const moved = pmClocks(TPL, plan({ clockPlan: { day0: "2026-11-24" } }), steps0());
  assert.equal(moved.on.day0, "2026-11-24"); assert.equal(moved.on.live, "2026-12-15");
});

test("PM card: nothing started is Not started; a waiting client is never the team's lateness", () => {
  const r = card(steps0(), "2026-11-15");
  assert.equal(r.health, "not_started");
  // The client's brochure is 3 working days past its day and the team has started: waiting on client, not late.
  const t = steps0(); t[2] = task("O14", { due: "2026-11-21", status: "in_progress" });
  const w = card(t, "2026-11-20");
  assert.equal(w.health, "waiting_client"); assert.match(w.reason, /^brochure, 3 days$/);
  // The Day-0 gate is late but the client holds it: still waiting on client.
  assert.equal(card(t, "2026-11-25").health, "waiting_client");
});

test("PM card: a team step late 1-3 working days is At risk, more is Late; a gate late is Late", () => {
  const t = steps0(); t[1] = task("O5", { status: "done", due: "2026-11-17", role: "Client" }); t[2] = task("O14", { due: "2026-11-21", status: "in_progress" });
  const risk = card(t, "2026-11-23"); // Mon: Sat 21 → 1 working day
  assert.equal(risk.health, "late"); assert.equal(risk.reason, "Input-complete declared · 1 day late"); // a gate
  const u = [...t]; u[2] = task("O14", { status: "done", due: "2026-11-21" }); u[3] = task("P1", { due: "2026-11-19", status: "in_progress" });
  const r2 = card(u, "2026-11-21", { plan: { day0On: "2026-11-21" } });
  assert.equal(r2.health, "at_risk"); assert.equal(r2.reason, "Market research · 2 days late"); assert.equal(r2.next.title, "Market research"); assert.equal(r2.next.late, 2);
  assert.equal(card(u, "2026-11-26", { plan: { day0On: "2026-11-21" } }).health, "late");
});

test("PM card: a team-side slip is At risk with the days; a client delay is not", () => {
  const t = steps0(); t[1] = task("O5", { status: "done", due: "2026-11-17", role: "Client" }); t[2] = task("O14", { status: "done", due: "2026-11-21" }); t[4] = task("C20", { due: "2026-11-30", role: "Video Editor", who: "Rifob", whoId: "rifob" });
  const us = card(t, "2026-11-22", { plan: { day0On: "2026-11-21" } }, [{ taskId: "t-C20", days: 3, side: "us" }]);
  assert.equal(us.health, "at_risk"); assert.equal(us.reason, "model-led video drafted moved 3 days");
  assert.equal(card(t, "2026-11-22", { plan: { day0On: "2026-11-21" } }, [{ taskId: "t-C20", days: 3, side: "client" }]).health, "on_track");
});

test("PM card: phases name the current one; paused wins; working days skip Sundays; the list order", () => {
  const r = card(steps0(), "2026-11-15");
  assert.deepEqual(r.phases.map((p) => p.label), ["Onboarding", "Project Brand Blueprint", "Buyer Journey"]);
  assert.equal(r.current, 0);
  assert.equal(card(steps0(), "2026-11-15", { status: "paused" }).health, "paused");
  assert.equal(workDays("2026-11-19", "2026-11-21"), 2); assert.equal(workDays("2026-11-21", "2026-11-23"), 1); assert.equal(workDays("2026-11-21", "2026-11-21"), 0);
  assert.ok(PM_RANK.late < PM_RANK.at_risk && PM_RANK.at_risk < PM_RANK.waiting_client && PM_RANK.waiting_client < PM_RANK.on_track);
  assert.equal(phaseName("Phase 2 · Creative Assets™"), "Creative Assets");
});

import { pmStepState } from "../dist/project-health.js";
test("PM step words: Your turn only for the named reviewer; a client's step is Client late, never the team's", () => {
  const o = { me: "me", today: "2026-11-21", due: "2026-11-19", planned: false, client: false, waitsOn: null, running: false };
  assert.equal(pmStepState({ status: "in_review", whoId: "rifob", reviewerId: "me" }, o).word, "Your turn");
  assert.equal(pmStepState({ status: "in_review", whoId: "rifob", reviewerId: "tara" }, o).word, "In review");
  const late = pmStepState({ status: "open", whoId: "rifob" }, o);
  assert.equal(late.word, "To do"); assert.equal(late.late, 2); assert.equal(late.clientLate, 0);
  const client = pmStepState({ status: "open", whoId: null }, { ...o, client: true });
  assert.equal(client.word, "Waiting on client"); assert.equal(client.late, 0); assert.equal(client.clientLate, 2);
  assert.equal(pmStepState({ status: "open", whoId: "rifob" }, { ...o, planned: true }).late, 0); // a planned date is never late
  assert.equal(pmStepState({ status: "open", whoId: "rifob" }, { ...o, waitsOn: "Shoot day" }).word, "Waiting on “Shoot day”");
  assert.equal(pmStepState({ status: "done", whoId: "rifob" }, o).word, "Done");
  assert.equal(pmStepState({ status: "done", whoId: "rifob", reviewerId: "me" }, o).word, "Your turn");   // waits for my OK
  assert.equal(pmStepState({ status: "done", whoId: "rifob", reviewerId: "tara" }, o).word, "Done");
});
